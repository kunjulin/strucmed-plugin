import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, buildIndex, resolve, deptTypes } from '../src/dictionary.mjs';
import { buildControl, DATATYPES_V01 } from '../src/model.mjs';
import { validateDraft } from '../src/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G1 = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/editor-g1-keys.json'), 'utf8')).shapes;

test('each v0.1 control has exactly the key set the real editor produces after load (F = G1)', () => {
  const samples = {
    selection: { options: ['a'] }, combobox: { options: ['a'] }, radiobutton: { options: ['a'] },
    checkbox: { options: ['a'] }, submenu: { options: ['-a'] }
  };
  for (const dt of DATATYPES_V01) {
    const o = buildControl(7, { datatype: dt, ...(samples[dt] || {}) });
    assert.deepEqual(Object.keys(o).sort(), G1[dt], `key set mismatch for ${dt}`);
    assert.equal(o.id, 'ctrl_7');
    assert.equal(o.type, dt);
  }
});

test('unsupported datatypes are rejected; v0.2 types require their script', () => {
  assert.throws(() => buildControl(1, { datatype: 'imgbox' }), /不支援新增/);
  assert.throws(() => buildControl(1, { datatype: 'action' }), /action_script/);
  assert.throws(() => buildControl(1, { datatype: 'label', format: 'formula' }), /需要 formula/);
  assert.throws(() => buildControl(1, { datatype: 'action2', action_script: '"x"' }), /action_id/);
});

test('control input validation', () => {
  assert.throws(() => buildControl(1, { datatype: 'numberbox', minval: 5, maxval: 1 }), /minval/);
  assert.throws(() => buildControl(1, { datatype: 'radiobutton', options: [] }), /至少/);
  assert.throws(() => buildControl(1, { datatype: 'checkbox', options: ['x', 'x'] }), /重複/);
  assert.throws(() => buildControl(1, { datatype: 'submenu', options: ['no-dash'] }), /開頭/);
  const r = buildControl(3, { datatype: 'radiobutton', options: [{ value: '有', further: [4, 5] }, '無'] });
  assert.deepEqual(r.option, [{ value: '有', further: '4,5' }, { value: '無', further: '' }]);
  assert.equal(r.row, 2);
});

test('CSV: editor Export format, unescaped quotes, soft-deleted rows', () => {
  const csv = '"id","dicType","dictName","dicComment","createUser","createDate"\r\n' +
    '"id-1","TEST","FALL_HISTORY","跌倒史","U1","2026-01-01"\r\n' +
    '"id-2","TEST","__OLD","deleted","U1","2026-01-01"\r\n' +
    '"id-3","TES","SAY "HI" NOTE","has "quote" inside","U1","2026-01-01"\r\n';
  const idx = buildIndex(csv, 'TEST0', 't.csv');
  assert.equal(idx.hasIds, true);
  assert.equal(idx.deleted, 1);
  assert.equal(idx.entries.length, 2);
  assert.equal(idx.entries[1].dicName, 'SAY "HI" NOTE');
});

test('CSV: batch-export format has no ids and warns', () => {
  const idx = buildIndex('name,type,info,creator,createDate\n"A","TEST","x","U","d"\n', 'TEST0', 'b.csv');
  assert.equal(idx.hasIds, false);
  assert.match(idx.warnings[0], /沒有字典 id/);
});

test('parseCsv handles doubled quotes and BOM', () => {
  assert.deepEqual(parseCsv('﻿a,"b""c"\n'), [['a', 'b"c']]);
});

test('dictionary resolve follows the editor dept rule and refuses ambiguity', () => {
  assert.deepEqual(deptTypes('33F00'), ['33F00', '33F0', '33F', '3F']);
  const idx = { entries: [
    { id: 'a', dicType: '33F', dicName: 'X' }, { id: 'b', dicType: '3F', dicName: 'X' },
    { id: 'c', dicType: 'OTHER', dicName: 'Y' }, { id: 'd', dicType: '33F0', dicName: 'Z' } ] };
  assert.throws(() => resolve(idx, { name: 'X' }, '33F00'), /2 筆/);
  assert.equal(resolve(idx, { name: 'Z' }, '33F00').entry.id, 'd');
  assert.equal(resolve(idx, { name: 'Y' }, '33F00').kind, 'pending');
  assert.throws(() => resolve(idx, { id: 'nope' }, '33F00'), /不在/);
  assert.throws(() => resolve(null, { id: 'a' }, '33F00'), /尚未載入/);
});

function draftWith(items, areaOver = {}) {
  return { draft_id: 'd-000000000000', meta: { name: 'T', dept_no: 'TEST0', groups: [] }, pendingDictionaries: [],
    areas: [{ itemid: 1, authread: ['doctor'], authwrite: ['doctor'], gettext: true, return_text: true, hidden: false, items, ...areaOver }] };
}

test('validate: duplicate itemid, broken further/reference, unknown dicid, PHI', () => {
  const a = buildControl(2, { datatype: 'radiobutton', options: [{ value: '是', further: [9] }] });
  const b = buildControl(2, { datatype: 'textbox', reference: 8 });
  const c = buildControl(3, { datatype: 'textbox', datavalue: 'A123456789' });
  c.dicid = 'ghost'; c.dictionary = 'G'; c.dicrole = 'tohis';
  const v = validateDraft(draftWith([a, b, c]), { entries: [] });
  const codes = v.errors.map(e => e.code);
  assert.ok(codes.includes('E_DUP_ITEMID'));
  assert.ok(codes.includes('E_REF_BROKEN'));
  assert.ok(codes.includes('E_DICT_UNKNOWN_ID'));
  assert.ok(codes.includes('E_PHI_SUSPECT'));
  assert.equal(v.valid, false);
});

test('validate: area auth warns unless intent is declared (04 結論 4)', () => {
  const t = buildControl(2, { datatype: 'textbox' });
  const bad = validateDraft(draftWith([t], { authread: [], gettext: false }), null);
  assert.equal(bad.warnings.filter(w => w.code === 'W_AREA_AUTH').length, 2);
  const declared = validateDraft(draftWith([t], { authread: [], gettext: false, hidden: true, return_text: false }), null);
  assert.equal(declared.warnings.filter(w => w.code === 'W_AREA_AUTH').length, 0);
  assert.equal(declared.valid, true);
});
