// 字典助手（plugin 3.7.0）的離線部分：memo 新欄位、form_fields、dictionary_suggest、dictionary_memo_check
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dc from '../src/dictcomment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let ws, t, store;
const codes = list => list.map(w => w.code || String(w).split('：')[0]);

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-dictassist-'));
  process.env.STRUCMED_WORKSPACE = ws;
  const { TOOLS } = await import('../src/tools.mjs');
  t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  fs.copyFileSync(path.join(HERE, 'fixtures/existing-form.json'), path.join(ws, 'src.json'));
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

// 本機索引：TEST0 科部；體系（ES）字典 D-SYS 與本科 D-OWN 同名「體重」；他體系 D-FAR
function seedIndex(extra = {}) {
  const entries = [
    { id: 'D-SYS', dicType: 'ES', dicName: '體重', dicComment: dc.build({ desc: '體重（kg）', memo: { type: 'numberbox', unit: 'kg', range: '0-300', llm: '體重（kg，數字）', calx: 'BMI 的分子' } }), createDate: '20250101' },
    { id: 'D-OWN', dicType: 'TEST0', dicName: '體重', dicComment: '舊的體重', createDate: '20260101' },
    { id: 'D-LB', dicType: 'TEST0', dicName: '體重磅', dicComment: dc.build({ desc: '體重（磅）', memo: { type: 'numberbox', unit: 'lb' } }), createDate: '20240101' },
    { id: 'D-FALL', dicType: 'TEST0', dicName: '跌倒史', dicComment: dc.build({ desc: '過去一年跌倒', memo: { type: 'radiobutton', range: '有／無' } }), createDate: '20240101' },
    { id: 'D-FAR', dicType: 'XZZ00', dicName: '體重', dicComment: '別院體重', createDate: '20240101' }
  ].map(d => ({ ...dc.fromItem(d, 'TEST0') }));
  store.saveDictIndex({ loadedAt: new Date().toISOString(), source: 'test', deptNo: 'TEST0', hasIds: true, entries, deleted: 0, warnings: [], duplicates: [], ...extra });
}

test('memo keys: func／usecase／interop are accepted and serialized after range; old sites drop them', () => {
  assert.deepEqual(dc.MEMO_KEYS.slice(0, 7), ['meaning', 'type', 'unit', 'range', 'func', 'usecase', 'interop']);
  const raw = dc.build({ desc: 'x', memo: { scope: '門診', interop: 'kg', usecase: '初診', func: '輸入', range: '0-300', meaning: '體重' } });
  assert.equal(raw, '{"v":1,"desc":"x","memo":{"meaning":"體重","range":"0-300","func":"輸入","usecase":"初診","interop":"kg","scope":"門診"}}');
  // 既有補述（沒有新鍵）的鍵順序不變，etag 也不變
  const legacy = dc.build({ desc: 'x', memo: { scope: 's', asr: ['a'], meaning: 'm' } });
  assert.equal(legacy, '{"v":1,"desc":"x","memo":{"meaning":"m","asr":["a"],"scope":"s"}}');
  assert.deepEqual(dc.restrictMemo({ meaning: 'm', func: 'f', interop: 'i' }, null), { memo: { meaning: 'm' }, dropped: ['func', 'interop'] });
  assert.deepEqual(dc.restrictMemo({ func: 'f' }, dc.MEMO_KEYS), { memo: { func: 'f' }, dropped: [] });
});

test('form_fields: captions, references, AI roles and derived func from the form itself', () => {
  seedIndex();
  const { draft_id } = t.form_import({ source_path: 'src.json', name: '解析', dept_no: 'TEST0' });
  const r = t.form_fields({ draft_id });
  const f = id => r.fields.find(x => x.itemid === id);
  assert.equal(f(2).caption, '體重');
  assert.match(f(2).derived.func, /計算式輸入（被 BMI 引用）/);
  assert.deepEqual(f(2).refs_in.map(x => x.kind), ['formula']);
  assert.match(f(4).derived.func, /^計算結果：ROUND\(A2/);
  assert.deepEqual(f(4).refs_out.filter(x => x.kind === 'formula').map(x => x.to_caption).sort(), ['身高', '體重']);
  assert.match(f(8).derived.func, /巨集寫入目標/);
  assert.match(f(6).derived.func, /選項連動顯示（由 過敏 控制）/);
  assert.deepEqual(f(5).options, ['無', '有']);
  assert.equal(r.stats.controls, r.fields.length);
  const only = t.form_fields({ draft_id, only: 'dictionary' });
  assert.ok(only.fields.every(x => x.dictionary));
  assert.deepEqual(t.form_fields({ draft_id, itemids: [3] }).fields.map(x => x.itemid), [3]);
});

test('dictionary_suggest: system first, unit and type compatibility, usage count, cite snippets', () => {
  seedIndex({ usage: { scannedAt: '2026-10-27T02:00:00Z', counts: { 'D-SYS': 12, 'D-OWN': 1 } } });
  const r = t.dictionary_suggest({ field: { caption: '體重(kg)：', datatype: 'numberbox', intent: 'BMI 計算' } });
  assert.equal(r.field.unit, 'kg', 'unit taken from the caption');
  assert.deepEqual(r.candidates.slice(0, 2).map(c => c.id), ['D-SYS', 'D-OWN']);
  const top = r.candidates[0];
  assert.ok(top.reasons.some(x => /單位相同/.test(x)) && top.reasons.some(x => /12 張表單在用/.test(x)) && top.reasons.some(x => /層級：體系/.test(x)), top.reasons.join(' | '));
  assert.deepEqual(top.cite.bind, { dictionary: { id: 'D-SYS' } });
  assert.equal(top.cite.prompt, '體重（kg，數字）');
  assert.equal(top.cite.calx, 'BMI 的分子');
  const lb = r.candidates.find(c => c.id === 'D-LB');
  assert.ok(lb && lb.reasons.some(x => /單位不同/.test(x)) && lb.score < top.score);
  assert.ok(!r.candidates.some(c => c.id === 'D-FAR'), 'other systems only with include_other');
  assert.ok(t.dictionary_suggest({ field: { caption: '體重' }, include_other: true }).candidates.some(c => c.id === 'D-FAR' && c.level === 'other'));
  assert.ok(codes(t.dictionary_suggest({ field: { caption: '血型' } }).warnings).includes('W_NO_CANDIDATE'));
  // 從 draft：A<itemid> 引用片段
  const { draft_id } = t.form_import({ source_path: 'src.json', name: '找字典', dept_no: 'TEST0' });
  const d = t.dictionary_suggest({ draft_id, itemid: 2 });
  assert.equal(d.candidates[0].cite.ref, 'A2');
});

test('dictionary_memo_check: merge with existing, field consistency, missing angles, PHI and Big5', () => {
  seedIndex();
  const { draft_id } = t.form_import({ source_path: 'src.json', name: '檢查', dept_no: 'TEST0' });
  const ok = t.dictionary_memo_check({ dic_id: 'D-SYS', memo: { meaning: '病人當次體重', func: 'BMI 計算式的輸入', usecase: '門診初診', interop: 'kg，1 位小數' } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.merged.unit, 'kg', 'existing keys kept');
  assert.equal(ok.merged.func, 'BMI 計算式的輸入');
  assert.ok(!codes(ok.warnings).includes('W_MEMO_INCOMPLETE'));
  const bad = t.dictionary_memo_check({ draft_id, itemid: 2, memo: { type: 'textbox', unit: 'lb', range: '0-500' } });
  const w = codes(bad.warnings);
  assert.ok(w.includes('W_MEMO_TYPE_MISMATCH') && w.includes('W_MEMO_INCOMPLETE') && w.includes('W_MEMO_NO_FUNC'), JSON.stringify(bad.warnings));
  const opts = t.dictionary_memo_check({ draft_id, itemid: 5, memo: { range: '有' } });
  assert.ok(codes(opts.warnings).includes('W_MEMO_OPTIONS_MISSING'));
  const phi = t.dictionary_memo_check({ memo: { meaning: '例如 A123456789 的體重' } });
  assert.equal(phi.ok, false);
  assert.ok(codes(phi.errors).includes('E_PHI_SUSPECT'));
  const emoji = t.dictionary_memo_check({ memo: { meaning: '體重😀' } });
  assert.equal(emoji.ok, false);
  const unknown = t.dictionary_memo_check({ memo: { color: 'red' } });
  assert.equal(unknown.ok, false);
  const long = t.dictionary_memo_check({ memo: { usecase: '字'.repeat(301) } });
  assert.equal(long.ok, false);
});
