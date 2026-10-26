import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, buildIndex, resolve, deptTypes, search } from '../src/dictionary.mjs';
import * as dc from '../src/dictcomment.mjs';
import { buildArtifacts } from '../src/export.mjs';
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

test('unsupported datatypes are rejected; v0.2 types require their script (action scripts may be filled in later)', () => {
  assert.throws(() => buildControl(1, { datatype: 'imgbox' }), /不支援新增/);
  assert.equal(buildControl(1, { datatype: 'action' }).actionScript, '', '試用回饋 #6：先留空，form_validate 報 E_ACTION_EMPTY');
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
    { id: 'c', dicType: 'OTHER', dicName: 'Y' }, { id: 'd', dicType: '33F0', dicName: 'Z' },
    { id: 'e', dicType: '33F00', dicName: 'W' }, { id: 'f', dicType: '33F00', dicName: 'W' } ] };
  // docs/14：不同層級同名 → 體系優先並警告；同一層級同名才拒絕
  const x = resolve(idx, { name: 'X' }, '33F00');
  assert.equal(x.entry.id, 'b');
  assert.ok(x.warnings.some(w => w.startsWith('W_DICT_PREFER_SYSTEM')));
  assert.throws(() => resolve(idx, { name: 'W' }, '33F00'), /2 筆/);
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

// ── docs/14：字典 JSON 說明 ─────────────────────────────────
test('dictcomment: legacy plain text is desc; build keeps plain text until memo/fhir appear; canonical key order', () => {
  assert.deepEqual(dc.parse('有無跌倒').desc, '有無跌倒');
  assert.equal(dc.parse('有無跌倒').isJson, false);
  assert.equal(dc.build({ desc: '有無跌倒' }), '有無跌倒');
  const s = dc.build({ alias_of: 'X1', memo: { unit: 'kg', meaning: '體重' }, desc: '體重' });
  assert.equal(s, '{"v":1,"desc":"體重","memo":{"meaning":"體重","unit":"kg"},"alias_of":"X1"}');
  assert.ok(s.startsWith('{"v":1,"desc":'), 'desc first so old screens stay readable');
  const tricky = dc.build({ desc: '含逗號, 引號" 反斜線\\', memo: { calx: 'BMI=體重/(身高/100)^2' } });
  assert.deepEqual(dc.parse(tricky).memo, { calx: 'BMI=體重/(身高/100)^2' });
  assert.equal(dc.parse('{"v":1,"desc":"斷').broken, true, 'CSV-truncated JSON is flagged');
  // v 必須是數值 1（與平台 DictComment.Parse、字典頁、編輯器一致）：其他版本當純文字、原文保留，不算斷欄
  for (const other of ['{"v":2,"desc":"新版"}', '{"v":"1","desc":"字串版"}', '{"v":null,"desc":"空"}']) {
    const p = dc.parse(other);
    assert.deepEqual([p.isJson, p.broken, p.desc], [false, false, other], other);
    assert.equal(dc.isJson(other), false);
  }
  assert.equal(dc.parse('{"v":1.0,"desc":"浮點"}').isJson, true);
  assert.throws(() => dc.build({ desc: '第一行\n第二行' }), /換行/);
  assert.throws(() => dc.build({ desc: 'x', memo: { foo: 'bar' } }), /未知欄位/);
  assert.throws(() => dc.build({ desc: 'x', memo: { meaning: '測'.repeat(300), llm: '測'.repeat(300), scope: '測'.repeat(300), calx: '測'.repeat(300), range: '測'.repeat(300), unit: '測'.repeat(300), type: '測'.repeat(300) } }), /過長/);
  assert.deepEqual(dc.mergeMemo({ unit: 'kg', range: '0-300' }, { range: '', asr: ['BW'] }), { unit: 'kg', asr: ['BW'] });
});

test('dictcomment: FHIR validation and type hints', () => {
  const ok = dc.validateFhir([{ res: 'Observation', path: "Observation.component.where(code.coding.code='8480-6').valueQuantity", code: 'http://loinc.org|8480-6', ucum: 'mm[Hg]' }], 'numberbox');
  assert.equal(ok.fhir.length, 1);
  assert.deepEqual(ok.warnings, []);
  assert.throws(() => dc.validateFhir([{ res: 'Observation', path: 'Condition.code' }]), e => e.code === 'E_INVALID_FHIR');
  assert.throws(() => dc.validateFhir([{ res: 'observation', path: 'observation' }]), e => e.code === 'E_INVALID_FHIR');
  assert.throws(() => dc.validateFhir([{ res: 'Observation', path: 'Observation.value;drop' }]), e => e.code === 'E_INVALID_FHIR');
  assert.throws(() => dc.validateFhir([{ res: 'Condition', path: 'Condition.code', code: 'http://example.org|X' }]), /白名單/);
  assert.equal(dc.validateFhir([{ res: 'Condition', path: 'Condition.code', code: 'http://cgmh.org.tw/fhir/CodeSystem/dx|A1' }]).fhir.length, 1);
  assert.equal(dc.validateFhir([{ res: 'Condition', path: 'Condition.code', code: 'http://hl7.org/fhir/sid/icd-10-cm|E11.9' }]).fhir.length, 1);
  assert.match(dc.validateFhir([{ res: 'Observation', path: 'Observation.valueString' }], 'numberbox').warnings[0], /^W_FHIR_TYPE_MISMATCH/);
  assert.deepEqual(dc.validateFhir([{ res: 'Observation', path: 'Observation.valueBoolean' }], 'checkbox').warnings, []);
});

test('dictcomment: level relative to dept and etag', () => {
  assert.deepEqual(['33F00', '33F0', '33F', '3F', 'System', 'XX'].map(t => dc.level(t, '33F00')), ['own', 'sub', 'dpt', 'sys', 'system', 'other']);
  assert.equal(dc.etag(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('dictcomment: sys mark (system manager promotion) parses, serializes after desc, and makes the dictionary level sys for the whole system', () => {
  const raw = dc.build({ desc: '體重', memo: { unit: 'kg' }, sys: { code: '3F', by: 'ADM01', at: '2026-10-27T01:00:00Z', extra: 'x' } });
  assert.equal(raw, '{"v":1,"desc":"體重","sys":{"code":"3F","by":"ADM01","at":"2026-10-27T01:00:00Z"},"memo":{"unit":"kg"}}');
  assert.deepEqual(dc.parse(raw).sys, { code: '3F', by: 'ADM01', at: '2026-10-27T01:00:00Z' });
  assert.equal(dc.build({ desc: '只有標記', sys: { code: '3F' } }), '{"v":1,"desc":"只有標記","sys":{"code":"3F"}}', 'a mark alone turns plain text into JSON');
  for (const bad of [{ code: '3F0' }, { code: '' }, { by: 'x' }, 'ZZ', null]) assert.equal(dc.parse(JSON.stringify({ v: 1, desc: 'x', sys: bad })).sys, null, JSON.stringify(bad));
  // 升級不改 dicType：同體系他科看到 sys、其他體系仍是 other、原科部自己也算體系
  assert.equal(dc.level('33F10', '43F20', '3F'), 'sys');
  assert.equal(dc.level('33F10', '33F10', '3F'), 'sys');
  assert.equal(dc.level('33F10', '35A00', '3F'), 'other');
  assert.equal(dc.level('33F10', '43F20'), 'other');
  assert.equal(dc.fromItem({ id: 'a', dicType: '33F10', dicName: 'BW', dicComment: raw }, '43F20').level, 'sys');
  assert.equal(dc.summary(raw).sys.code, '3F');
  // 舊的升級申請紀錄仍可讀取，不報錯
  assert.equal(dc.parse('{"v":1,"desc":"x","promote":{"to":"3F","by":"U1","status":"pending"}}').promote.status, 'pending');
});

test('dictionary resolve/search: a marked dictionary of another dept in the same system is in scope and bound before own-dept ones', () => {
  const idx = { deptNo: '43F20', entries: [
    { id: 'own1', dicType: '43F20', dicName: 'BW', dicComment: '本科' },
    { id: 'mark1', dicType: '33F10', dicName: 'BW', dicComment: dc.build({ desc: '體重', sys: { code: '3F', by: 'ADM01' } }) },
    { id: 'other1', dicType: '35A00', dicName: 'BW', dicComment: dc.build({ desc: '他體系', sys: { code: '5A' } }) } ] };
  const r = search(idx, 'BW', '43F20', 'exact');
  assert.deepEqual(r.map(e => [e.id, e.level, e.deptMatch]), [['mark1', 'sys', true], ['own1', 'own', true], ['other1', 'other', false]]);
  const b = resolve(idx, { name: 'BW' }, '43F20');
  assert.equal(b.entry.id, 'mark1');
  assert.ok(b.warnings.some(w => w.startsWith('W_DICT_PREFER_SYSTEM')));
  assert.equal(resolve({ deptNo: '43F20', entries: idx.entries.filter(e => e.id === 'other1') }, { name: 'BW' }, '43F20').kind, 'pending', 'another system is out of scope');
});

test('dictionary search: system first, fuzzy matches desc and memo; alias_of rebinds; CSV JSON breakage warns', () => {
  const idx = { deptNo: '33F00', entries: [
    { id: 'own1', dicType: '33F00', dicName: 'BW', dicComment: '本科' },
    { id: 'sys1', dicType: '3F', dicName: 'BW', dicComment: dc.build({ desc: '體重', memo: { asr: ['body weight'] } }) },
    { id: 'old1', dicType: '33F', dicName: 'WT_OLD', dicComment: dc.build({ desc: '舊體重', alias_of: 'sys1' }) } ] };
  const r = search(idx, 'body weight', '33F00');
  assert.deepEqual(r.map(e => e.id), ['sys1'], 'memo.asr is searchable');
  assert.deepEqual(search(idx, 'BW', '33F00', 'exact').map(e => e.id), ['sys1', 'own1'], 'system level first');
  const a = resolve(idx, { id: 'old1' }, '33F00');
  assert.equal(a.entry.id, 'sys1');
  assert.ok(a.warnings.some(w => w.startsWith('W_DICT_ALIAS')));
  const csv = 'id,dicType,dictName,dicComment,createUser,createDate\n1,33F00,A,{"v":1,"desc":"x","memo":{"unit":"kg"}},U,d\n';
  const bi = buildIndex(csv, '33F00', 'x.csv');
  assert.ok(bi.warnings.some(w => w.startsWith('W_DICT_CSV_JSON_BROKEN')), JSON.stringify(bi.warnings));
});

test('export: new dictionaries carry desc+memo as dictionary JSON in the package', () => {
  const t = buildControl(2, { datatype: 'numberbox', minval: 0, maxval: 300 });
  t.dictionary = 'TEST_BW'; t.dicid = ''; t.dicrole = 'tohis';
  const d = draftWith([{ datatype: 'text', datavalue: '體重' }, t]);
  d.pendingDictionaries = [{ name: 'TEST_BW', comment: '體重（kg）', memo: { unit: 'kg' } }];
  d.nextItemId = 3;
  const { pkg } = buildArtifacts(d, { entries: [] });
  const x = pkg.dictionaries.find(z => z.dicName === 'TEST_BW');
  assert.deepEqual(JSON.parse(x.dicComment), { v: 1, desc: '體重（kg）', memo: { unit: 'kg' } });
});

test('dictcomment: characters the warehouse cannot store (emoji) are rejected; Simplified Chinese and punctuation are fine', () => {
  // 正式倉儲實測：emoji 被存成「？」；体、引號、反斜線、換行完整保留
  assert.throws(() => dc.build({ desc: '體重😀' }), e => e.code === 'E_INVALID_INPUT' && /😀/.test(e.message));
  assert.throws(() => dc.build({ desc: '體重', memo: { asr: ['BW😀'] } }), e => e.code === 'E_INVALID_INPUT');
  assert.throws(() => dc.build({ desc: '體重', fhir: [{ res: 'Observation', path: 'Observation.valueQuantity', display: 'weight😀' }] }), e => e.code === 'E_INVALID_INPUT');
  assert.throws(() => dc.checkStorable('a\uD83D', '字典名稱'), /無效字元/);
  assert.equal(dc.build({ desc: '体重, 引號" 反斜線\\' }), '体重, 引號" 反斜線\\');
  // 上標「²」：正式倉儲實測被換掉並吃掉後面的字元，整段 JSON 損毀 → 擋下，訊息指出字元與碼位
  assert.throws(() => dc.build({ desc: '身體質量指數', memo: { calx: 'BMI＝體重 ÷（身高 m）²' } }), e => e.code === 'E_INVALID_INPUT' && /²/.test(e.message) && /U\+00B2/.test(e.message));
  for (const bad of ['•', '・', '①', '\uE000']) assert.throws(() => dc.checkStorable('x' + bad), /Big5/, bad);
  assert.equal(dc.build({ desc: '握力（kg）', memo: { calx: 'BMI＝體重 ÷（身高 m）^2', range: '0-300 ±5 ℃ ㎏' } }).length > 0, true);
});
