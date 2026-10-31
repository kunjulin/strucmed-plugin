// 字典助手（plugin 3.7.0）的離線部分：memo 新欄位、form_fields、dictionary_suggest、dictionary_memo_check
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dc from '../src/dictcomment.mjs';
import { compareUnits } from '../src/units.mjs';
import { unitOf } from '../src/dictsuggest.mjs';

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

test('dictionary_suggest confidence: same name in scope without conflict is high; other sites and conflicts are not', () => {
  seedIndex();
  const pick = (r, id) => r.candidates.find(c => c.id === id);
  const kg = t.dictionary_suggest({ field: { caption: '體重(kg)：', datatype: 'numberbox' }, include_other: true });
  assert.equal(pick(kg, 'D-SYS').confidence, 'high');
  assert.equal(pick(kg, 'D-OWN').confidence, 'high', 'no memo means nothing conflicts');
  assert.notEqual(pick(kg, 'D-FAR').confidence, 'high', 'another site is never picked automatically');
  const lb = t.dictionary_suggest({ field: { caption: '體重(lb)', datatype: 'numberbox' } });
  assert.notEqual(pick(lb, 'D-SYS').confidence, 'high', 'a different unit is not the same field');
  const text = t.dictionary_suggest({ field: { caption: '體重', datatype: 'textbox' } });
  assert.notEqual(pick(text, 'D-SYS').confidence, 'high');
  assert.equal(pick(t.dictionary_suggest({ field: { caption: '體重磅', datatype: 'numberbox' } }), 'D-LB').confidence, 'high');
  assert.notEqual(pick(t.dictionary_suggest({ field: { caption: '體重磅數', datatype: 'numberbox' } }), 'D-LB').confidence, 'high', 'a partial name match needs a person');
});

test('form_validate: W_DICT_CANDIDATE_EXISTS when a planned new dictionary already has a confident match', () => {
  seedIndex();
  const { draft_id } = t.form_create({ name: '先找再建', dept_no: 'TEST0' });
  const { area_itemid } = t.form_add_area({ draft_id, title: '評估' });
  t.form_add_control({ draft_id, area_itemid, label_text: '體重(kg)', control: { datatype: 'numberbox', dictionary: { name: 'NEW_BW', comment: '體重' } } });
  t.form_add_control({ draft_id, area_itemid, label_text: '握力測試', control: { datatype: 'numberbox', dictionary: { name: 'NEW_GRIP', comment: '握力' } } });
  const found = t.form_validate({ draft_id }).warnings.filter(w => w.code === 'W_DICT_CANDIDATE_EXISTS');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /NEW_BW/);
  assert.match(found[0].message, /體重/);
  fs.rmSync(store.workspace().dictFile);
  assert.equal(t.form_validate({ draft_id }).warnings.some(w => w.code === 'W_DICT_CANDIDATE_EXISTS'), false, 'no index, nothing to compare');
});

test('formula_check reads the dictionary memo of what it references', () => {
  seedIndex();
  const idx = store.loadDictIndex();
  idx.entries.push(...[
    { id: 'D-HT', dicType: 'TEST0', dicName: '身高', dicComment: dc.build({ desc: '身高', memo: { type: 'numberbox', unit: 'm', range: '0.3-2.5', calx: 'BMI 的分母' } }), createDate: '20250101' },
    { id: 'D-NOTE', dicType: 'TEST0', dicName: '備註', dicComment: dc.build({ desc: '備註', memo: { type: 'textarea' } }), createDate: '20250101' }
  ].map(x => dc.fromItem(x, 'TEST0')));
  store.saveDictIndex(idx);
  const { draft_id } = t.form_create({ name: '補述檢查', dept_no: 'TEST0' });
  const { area_itemid } = t.form_add_area({ draft_id, title: '評估' });
  const add = (label_text, id, datatype = 'numberbox') => t.form_add_control({ draft_id, area_itemid, label_text, control: { datatype, tocalc: true, dictionary: { id } } }).itemid;
  const bw = add('體重', 'D-SYS'), ht = add('身高(cm)', 'D-HT'), old = add('舊體重', 'D-OWN'), note = add('備註', 'D-NOTE', 'textarea');
  const check = (text, extra = {}) => t.formula_check({ kind: 'formula', text, draft_id, ...extra });
  const warned = r => codes(r.warnings);

  const bmi = check(`A${bw} / (A${ht} / 100) ^ 2`, { samples: [{ values: { [`A${bw}`]: 500, [ht]: 170 } }, { values: { [`A${bw}`]: 65, [ht]: 1.7 } }] });
  assert.deepEqual(bmi.ref_dictionary[`A${bw}`], { dictionary: '體重', unit: 'kg', range: '0-300', type: 'numberbox', calx: 'BMI 的分子', llm: '體重（kg，數字）' });
  assert.equal(bmi.ref_dictionary[`A${ht}`].calx, 'BMI 的分母');
  assert.ok(warned(bmi).includes('W_REF_UNIT_MISMATCH'), 'caption says cm, memo says m');
  const out = bmi.warnings.filter(w => w.code === 'W_SAMPLE_OUT_OF_RANGE');
  assert.equal(out.length, 2, 'weight 500 and height 170; the second sample is fine');
  assert.equal(bmi.ok, true, 'memo findings warn, they never block');

  assert.ok(warned(check(`A${old} + 1`)).includes('W_REF_NO_MEMO'));
  assert.ok(warned(check(`A${note} + 1`)).includes('W_REF_TYPE_MISMATCH'));
  assert.equal(warned(check(`IF(A${note} = "x", 1, 0)`)).includes('W_REF_TYPE_MISMATCH'), false, 'comparing text is fine');
  assert.equal(warned(check(`A${bw} + 1`, { samples: [{ values: { [`A${bw}`]: 65 } }] })).some(c => /^W_(REF|SAMPLE)/.test(c)), false);

  fs.rmSync(store.workspace().dictFile);
  const bare = check(`A${old} + 1`);
  assert.equal(bare.ref_dictionary, undefined, 'without an index the old behaviour stays');
  assert.equal(warned(bare).includes('W_REF_NO_MEMO'), false);
});

test('compareUnits: spellings of one unit match, convertible units give the factor, others are not guessed', () => {
  for (const [a, b] of [['kg', '公斤'], ['Kg', 'KG'], ['㎏', 'kg'], ['mL', 'cc'], ['毫升', 'ml'], ['mmHg', '毫米汞柱'], ['bpm', '次/分'], ['°C', '℃'], ['kg/m²', 'kg/m2'], ['MG／DL', 'mg/dL'], ['歲', '年'], ['自訂', '自訂']]) {
    assert.deepEqual(compareUnits(a, b), { kind: 'same' }, `${a} ${b}`);
  }
  assert.deepEqual(compareUnits('cm', 'm'), { kind: 'convertible', factor: 0.01 });
  assert.deepEqual(compareUnits('公尺', '公分'), { kind: 'convertible', factor: 100 });
  assert.deepEqual(compareUnits('g/dL', 'mg/dL'), { kind: 'convertible', factor: 1000 });
  assert.equal(compareUnits('mg/dL', 'mmol/L').kind, 'different', 'needs the substance');
  assert.equal(compareUnits('kg', 'cm').kind, 'different');
  assert.equal(compareUnits('Cel', 'kg').kind, 'different');
  assert.equal(compareUnits('分', 'min').kind, 'unknown', 'a score and minutes look alike');
  assert.equal(compareUnits('IU', 'U').kind, 'unknown');
});

test('dictionary_suggest: asr equal to the caption counts as the name; aliases help but stop at medium; units compare by meaning', () => {
  seedIndex();
  const idx = store.loadDictIndex();
  idx.entries.push(...[
    { id: 'D-BH', dicType: 'TEST0', dicName: '身高', dicComment: dc.build({ desc: '身高', memo: { type: 'numberbox', unit: '公分', asr: ['BH', '身長'] } }), createDate: '20250101' }
  ].map(x => dc.fromItem(x, 'TEST0')));
  store.saveDictIndex(idx);
  const pick = (r, id) => r.candidates.find(c => c.id === id);
  const byAsr = pick(t.dictionary_suggest({ field: { caption: 'BH(cm)', datatype: 'numberbox' } }), 'D-BH');
  assert.equal(byAsr.confidence, 'high');
  assert.ok(byAsr.reasons.some(r => /別名/.test(r)) && byAsr.reasons.some(r => /單位相同/.test(r)), JSON.stringify(byAsr.reasons));
  assert.equal(t.dictionary_suggest({ field: { caption: '受測者長度' } }).candidates.some(c => c.id === 'D-BH' && c.confidence === 'high'), false);
  const viaAlias = pick(t.dictionary_suggest({ field: { caption: '受測者長度', datatype: 'numberbox', aliases: ['身長'] } }), 'D-BH');
  assert.equal(viaAlias.confidence, 'medium');
  assert.ok(viaAlias.reasons.some(r => /別名「身長」/.test(r)));
  assert.notEqual(pick(t.dictionary_suggest({ field: { caption: '身高(m)', datatype: 'numberbox' } }), 'D-BH').confidence, 'high', 'convertible still stores a different number');
});

test('formula_check tells units apart: same spelling is quiet, convertible gives the factor, unknown says so', () => {
  seedIndex();
  const idx = store.loadDictIndex();
  idx.entries.push(...[
    { id: 'D-G', dicType: 'TEST0', dicName: '血糖', dicComment: dc.build({ desc: '血糖', memo: { type: 'numberbox', unit: 'mg/dL' } }), createDate: '20250101' },
    { id: 'D-X', dicType: 'TEST0', dicName: '活性', dicComment: dc.build({ desc: '活性', memo: { type: 'numberbox', unit: 'IU' } }), createDate: '20250101' }
  ].map(x => dc.fromItem(x, 'TEST0')));
  store.saveDictIndex(idx);
  const { draft_id } = t.form_create({ name: '單位', dept_no: 'TEST0' });
  const { area_itemid } = t.form_add_area({ draft_id, title: '評估' });
  const add = (label_text, id) => t.form_add_control({ draft_id, area_itemid, label_text, control: { datatype: 'numberbox', tocalc: true, dictionary: { id } } }).itemid;
  const zh = add('體重(公斤)', 'D-SYS'), gram = add('體重(g)', 'D-SYS'), sugar = add('血糖(mmol/L)', 'D-G'), act = add('活性(U)', 'D-X');
  const unitWarnings = id => t.formula_check({ kind: 'formula', text: `A${id} + 1`, draft_id }).warnings.filter(w => /^W_REF_UNIT/.test(w.code));
  assert.deepEqual(unitWarnings(zh), []);
  const [conv] = unitWarnings(gram);
  assert.equal(conv.code, 'W_REF_UNIT_MISMATCH');
  assert.match(conv.message, /1 g = 0\.001 kg/);
  assert.match(unitWarnings(sugar)[0].message, /不是同一種量/);
  assert.equal(unitWarnings(act)[0].code, 'W_REF_UNIT_UNKNOWN');
  const memoCheck = t.dictionary_memo_check({ memo: { unit: '公斤', type: 'numberbox' }, draft_id, itemid: zh });
  assert.equal(codes(memoCheck.warnings).includes('W_MEMO_UNIT_MISMATCH'), false);
});

test('unitOf: finds what the table knows, including vital signs, and leaves ordinary brackets alone', () => {
  const cases = { '脈搏(次/分)': '次/分', '呼吸（次/分鐘）：': '次/分鐘', '體溫(℃)': '℃', '體溫 ℃': '℃', 'SpO2 %': '%', '呼吸速率 次/分': '次/分', '手術時間(分鐘)': '分鐘',
    'eGFR(ml/min/1.73m²)': 'ml/min/1.73m²', '尿量(cc/hr)': 'cc/hr', 'WBC(10^3/uL)': '10^3/uL', '體重(kg)：': 'kg', '體重（公斤）': '公斤', '體重 kg': 'kg', 'INR': '', '血壓(右側)': '', '過敏史(有無)': '' };
  for (const [caption, unit] of Object.entries(cases)) assert.equal(unitOf(caption), unit, caption);
  assert.deepEqual(compareUnits('次/分', 'bpm'), { kind: 'same' });
  assert.deepEqual(compareUnits('cc/hr', 'mL/h'), { kind: 'same' });
  assert.deepEqual(compareUnits('mL/min', 'mL/h'), { kind: 'convertible', factor: 60 });
  assert.deepEqual(compareUnits('10³/μL', '10^9/L'), { kind: 'same' });
  assert.deepEqual(compareUnits('10^3/uL', '/uL'), { kind: 'convertible', factor: 1000 });
  assert.equal(compareUnits('mg/kg', 'mg').kind, 'different');
});
