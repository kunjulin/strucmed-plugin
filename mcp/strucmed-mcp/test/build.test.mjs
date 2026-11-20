// form_build（批次建置）：一次呼叫建完整張表單，內部就是依序呼叫 form_create／form_add_area／form_add_control／form_update_control，
// 所以結果、警告與錯誤碼必須與逐筆呼叫完全相同；中途失敗時 draft 留在明確狀態並回報已建到哪裡。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ws, t, store;

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-build-'));
  process.env.STRUCMED_WORKSPACE = ws;
  process.env.STRUCMED_RUNTIME_WEB_CACHE = 'none';
  fs.writeFileSync(path.join(ws, 'dict.csv'),
    '"id","dicType","dictName","dicComment","createUser","createDate"\r\n' +
    '"bld-id-1","TEST","BLD_HEIGHT","身高","U1","2026-01-01"\r\n');
  t = Object.fromEntries((await import('../src/tools.mjs')).TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  t.dictionary_load({ csv_path: 'dict.csv', dept_no: 'TEST0' });
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

// 示範表單：身高、體重、BMI、分級，加一個進一步選項與一顆 LLM 按鈕
const SPEC = name => ({
  create: { name, dept_no: 'TEST0' },
  areas: [{ id: 'A1', title: '身體測量', visible_title: true, controls: [
    { id: 'C1', label_text: '身高：', control: { datatype: 'numberbox', unit: 'cm', dictionary: { name: 'BLD_HEIGHT' } } },
    { id: 'C2', label_text: '體重：', control: { datatype: 'numberbox', unit: 'kg', dictionary: { name: 'BLD_WEIGHT_NEW', comment: '體重' } } },
    { id: 'C3', label_text: 'BMI：', control: { datatype: 'label', format: 'formula', formula: 'ROUND({C2} / (({C1} / 100) * ({C1} / 100)), 1)' } },
    { id: 'C4', label_text: '分級：', control: { datatype: 'label', format: 'formula', formula: 'IF({C3} < 18.5, "過輕", IF({C3} < 24, "正常", "過重"))' } },
    { id: 'C5', label_text: '曾跌倒：', control: { datatype: 'radiobutton', row: 2, options: [{ value: '有', further: ['{C6}'] }, '無'] } },
    { id: 'C6', label_text: '次數：', control: { datatype: 'numberbox' } },
    { id: 'C7', control: { datatype: 'action2', action_name: 'AI 摘要', action_id: '{C8}', action_script: '"身高 " + {C1} + " 體重 " + {C2}' } },
    { id: 'C8', label_text: '摘要：', control: { datatype: 'textarea' } }
  ] }]
});
// 同一張表單，逐筆呼叫（agents/form-builder.md 現在的做法）
function oneByOne(name) {
  const { draft_id } = t.form_create({ name, dept_no: 'TEST0' });
  const w = [];
  const { area_itemid } = t.form_add_area({ draft_id, title: '身體測量', visible_title: true });
  const add = (label_text, control) => { const r = t.form_add_control({ draft_id, area_itemid, label_text, control }); w.push(...r.warnings); return r.itemid; };
  const c1 = add('身高：', { datatype: 'numberbox', unit: 'cm', dictionary: { name: 'BLD_HEIGHT' } });
  const c2 = add('體重：', { datatype: 'numberbox', unit: 'kg', dictionary: { name: 'BLD_WEIGHT_NEW', comment: '體重' } });
  const c3 = add('BMI：', { datatype: 'label', format: 'formula' });
  const c4 = add('分級：', { datatype: 'label', format: 'formula' });
  // 參照之後才建的欄位：itemid 依建立順序分配，所以 builder 用對照表換算（further、action_id 都是）
  const c5 = add('曾跌倒：', { datatype: 'radiobutton', row: 2, options: [{ value: '有', further: [c4 + 2] }, '無'] });
  const c6 = add('次數：', { datatype: 'numberbox' });
  const c7 = add(undefined, { datatype: 'action2', action_name: 'AI 摘要', action_id: c6 + 2 });
  add('摘要：', { datatype: 'textarea' });
  t.form_update_control({ draft_id, itemid: c3, changes: { label_format: 'formula', formula: `ROUND(A${c2} / ((A${c1} / 100) * (A${c1} / 100)), 1)` } });
  t.form_update_control({ draft_id, itemid: c4, changes: { label_format: 'formula', formula: `IF(A${c3} < 18.5, "過輕", IF(A${c3} < 24, "正常", "過重"))` } });
  t.form_update_control({ draft_id, itemid: c7, changes: { action_script: `"身高 " + A${c1} + " 體重 " + A${c2}` } });
  return { draft_id, warnings: w };
}
const shape = id => { const { draft_id, created, updated, ...rest } = store.loadDraft(id); return rest; };

test('一次呼叫建完整張表單：mapping、第二輪回填、form_validate 都在同一個結果裡', () => {
  const r = t.form_build(SPEC('批次 BMI'));
  assert.equal(r.calls, 13, 'form_create 1＋區塊 1＋控制項 8＋第二輪 3（兩條公式＋一段巨集腳本）');
  assert.deepEqual(r.mapping, { A1: 1, C1: 2, C2: 3, C3: 4, C4: 5, C5: 6, C6: 7, C7: 8, C8: 9 });
  assert.equal(r.areas.length, 1);
  assert.equal(r.controls.length, 8);
  assert.equal(r.controls[0].dicid, 'bld-id-1', '綁到既有字典');
  assert.ok(r.warnings.some(w => w.startsWith('W_NEW_DICTIONARY')), '警告原樣保留');
  assert.equal(r.validate.valid, true);
  assert.deepEqual(r.validate.errors, []);
  // 參照：穩定 ID 換成實際 itemid
  const d = store.loadDraft(r.draft_id);
  const by = n => d.areas[0].items.find(x => Number(x.itemid) === n);
  assert.equal(by(4).formula, 'ROUND(A3 / ((A2 / 100) * (A2 / 100)), 1)');
  assert.equal(by(5).formula, 'IF(A4 < 18.5, "過輕", IF(A4 < 24, "正常", "過重"))');
  assert.equal(by(6).option[0].further, '7', 'further 解得開');
  assert.equal(by(8).actionID, '9', 'action_id 指到之後才建的欄位');
  assert.equal(by(8).actionScript, '"身高 " + A2 + " 體重 " + A3');
  // 公式與巨集都排在第二輪
  assert.deepEqual(r.filled.map(f => f.itemid), [4, 5, 8]);
  assert.ok(r.filled.every(f => f.tool === 'form_update_control'));
});

test('結果與逐筆呼叫相同：draft 內容與警告一字不差', () => {
  const batch = t.form_build(SPEC('比對用'));
  const single = oneByOne('比對用');
  assert.deepEqual(shape(batch.draft_id), shape(single.draft_id), 'draft 內容相同');
  assert.deepEqual([...batch.warnings].sort(), [...single.warnings].sort(), '警告相同');
});

test('未知鍵回 E_UNKNOWN_KEY（與逐筆呼叫同一個碼、同一句話），什麼都不建', () => {
  const before = fs.readdirSync(path.join(ws, '.strucmed', 'drafts')).length;
  const bad = (spec, re) => assert.throws(() => t.form_build(spec), e => { assert.equal(e.code, 'E_UNKNOWN_KEY'); assert.match(e.message, re); return true; });
  bad({ create: { name: 'x', dept_no: 'TEST0' }, areas: [{ caption: '標題' }] }, /areas\[0\]/);
  bad({ create: { name: 'x', dept_no: 'TEST0' }, areas: [{ title: 'a', controls: [{ datatype: 'textbox' }] }] }, /areas\[0\]\.controls\[0\]/);
  bad({ create: { name: 'x', dept_no: 'TEST0' }, areas: [{ title: 'a', controls: [{ control: { datatype: 'textbox', caption: 'x' } }] }] }, /control/);
  bad({ create: { name: 'x', dept_no: 'TEST0', folder: 'usr' }, areas: [{ title: 'a' }] }, /create/);
  bad({ create: { name: 'x', dept_no: 'TEST0' }, areas: [{ title: 'a' }], updates: [{ itemid: 2, caption: 'x' }] }, /updates\[0\]/);
  assert.equal(fs.readdirSync(path.join(ws, '.strucmed', 'drafts')).length, before, '沒有建出新的 draft');
});

test('解不開的穩定 ID 參照當下就回 E_INVALID_INPUT 並列出來', () => {
  assert.throws(() => t.form_build({ create: { name: '壞參照', dept_no: 'TEST0' },
    areas: [{ id: 'A1', title: 'a', controls: [{ id: 'C1', control: { datatype: 'label', format: 'formula', formula: '{C9} + 1' } }] }] }),
  e => { assert.equal(e.code, 'E_INVALID_INPUT'); assert.match(e.message, /\{C9\}/); assert.deepEqual(e.details.known, ['A1', 'C1']); return true; });
});

test('create 與 draft_id 擇一；draft_id 續建時 itemid 接續', () => {
  assert.throws(() => t.form_build({ areas: [{ title: 'a' }] }), { code: 'E_INVALID_INPUT' });
  const first = t.form_build({ create: { name: '續建', dept_no: 'TEST0' }, areas: [{ id: 'A1', title: '第一段', controls: [{ id: 'C1', label_text: 'x：', control: { datatype: 'textbox' } }] }] });
  assert.throws(() => t.form_build({ draft_id: first.draft_id, create: { name: 'x', dept_no: 'TEST0' }, areas: [{ title: 'a' }] }), { code: 'E_INVALID_INPUT' });
  const more = t.form_build({ draft_id: first.draft_id, areas: [{ id: 'A2', title: '第二段', controls: [{ id: 'C2', label_text: 'y：', control: { datatype: 'textbox' } }] }],
    updates: [{ id: 'C2', changes: { required: true } }, { itemid: 2, label_text: 'x2：' }] });
  assert.deepEqual(more.mapping, { A2: 3, C2: 4 });
  assert.equal(more.draft_id, first.draft_id);
  const f = t.form_fields({ draft_id: first.draft_id }).fields;
  assert.deepEqual(f.map(x => x.caption), ['x2', 'y']);
  assert.equal(f.find(x => x.itemid === 4).required, true, 'updates 以穩定 ID 指定');
});

test('中途失敗：錯誤碼沿用原本那個 tool，details.build 寫出已建到哪裡與剩下要補什麼，draft 保留', () => {
  const spec = SPEC('會失敗');
  // 第二輪回填時公式語法有錯 → form_update_control 當下拒絕（不是延後到 form_validate 的參照類錯誤）
  spec.areas[0].controls[3].control.formula = 'NOTAFUNC(1) +';
  let e0;
  assert.throws(() => t.form_build(spec), e => { e0 = e; return true; });
  assert.equal(e0.code, 'E_INVALID_INPUT', '與逐筆呼叫 form_update_control 同一個錯誤碼');
  const b = e0.details.build;
  assert.ok(Array.isArray(e0.details.errors), '原本 tool 的 details 保留');
  assert.match(e0.message, /form_build：失敗在第二輪回填/);
  assert.equal(b.failed_at.phase, 'updates');
  assert.match(b.failed_at.where, /controls\[3\]（C4）/);
  assert.equal(b.built.controls.length, 8, '八個控制項都已建好');
  assert.equal(b.mapping.C8, 9);
  assert.ok(b.pending_updates.length >= 1, '剩下要補的逐筆列出（args 可以原樣再呼叫）');
  assert.ok(b.pending_updates.every(x => x.args && x.args.draft_id === b.draft_id));
  assert.match(b.next, /不要整張重來/);
  // draft 真的留在那個狀態：已建的在、沒補的公式還空著
  const d = store.loadDraft(b.draft_id);
  assert.equal(d.areas.length, 1);
  assert.equal(d.areas[0].items.filter(x => x.itemid).length, 8);
  assert.equal(d.areas[0].items.find(x => Number(x.itemid) === 5).formula, '', '失敗那一條沒有寫進去');
  assert.equal(d.areas[0].items.find(x => Number(x.itemid) === 4).formula, 'ROUND(A3 / ((A2 / 100) * (A2 / 100)), 1)', '前面成功的保留');
  // 照 next 做：補完就通過
  for (const p of b.pending_updates) t[p.tool](p.args.changes && p.args.changes.formula ? { ...p.args, changes: { ...p.args.changes, formula: 'A4 + 1' } } : p.args);
  assert.equal(t.form_validate({ draft_id: b.draft_id }).valid, true);
});

test('建立區塊失敗時：階段是 areas，built 只有已建的，錯誤碼仍是原本那個', () => {
  let e0;
  assert.throws(() => t.form_build({ create: { name: '區塊失敗', dept_no: 'TEST0' },
    areas: [{ id: 'A1', title: '好的' }, { id: 'A2', type: 'form2', title: '不支援' }] }),
  e => { e0 = e; return true; });
  assert.equal(e0.code, 'E_UNSUPPORTED_DATATYPE');
  assert.equal(e0.details.build.failed_at.phase, 'areas');
  assert.match(e0.details.build.failed_at.where, /areas\[1\]（A2）/);
  assert.deepEqual(e0.details.build.built.areas.map(x => x.id), ['A1']);
});

test('embed 的 outputs 指向之後才建的欄位時自動排到第二輪（form_update_area）', () => {
  const r = t.form_build({ create: { name: '嵌入', dept_no: 'TEST0' }, areas: [
    { id: 'A1', type: 'embed', title: '決策支援', url: 'https://assistantai.cgmh.org.tw/ERCDSS/', height: 'fill', outputs: { risk: '{C1}' } },
    { id: 'A2', title: '結果', controls: [{ id: 'C1', label_text: '風險：', control: { datatype: 'textbox' } }] }
  ] });
  assert.ok(r.filled.some(f => f.tool === 'form_update_area' && f.itemid === 1), 'outputs 第二輪補上');
  assert.equal(store.loadDraft(r.draft_id).areas[0].area.outputs.risk, 3);
  assert.deepEqual(r.validate.errors, []);
});

test('skip_validate：不跑 form_validate', () => {
  const r = t.form_build({ create: { name: '不驗證', dept_no: 'TEST0' }, areas: [{ title: 'a', controls: [{ label_text: 'x：', control: { datatype: 'textbox' } }] }], skip_validate: true });
  assert.equal(r.validate, undefined);
});
