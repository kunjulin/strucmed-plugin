// 附件容器（attachbox 控制項、巨集 LLMATTACH／ATTACHTRANSCRIBE、函數 ATTACHTEXT／ATTACHCOUNT）：node --test test/attachbox.test.mjs
// 對照平台 web/js/attachbox.js、web/js/TempHtml.js calcSetval（strucmed PR #242～#254）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ws, flagsFile, t, TOOL_DEFS, store, model, lint, exp;
const setFlags = o => fs.writeFileSync(flagsFile, JSON.stringify(o));
const errOf = fn => { try { fn(); } catch (e) { return e; } assert.fail('應該拋錯'); };
const codes = r => r.findings.map(f => f.code);

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-attach-'));
  process.env.STRUCMED_WORKSPACE = ws;
  flagsFile = path.join(ws, 'flags.json');
  process.env.STRUCMED_FLAGS = flagsFile;
  setFlags({ attachBox: true });
  TOOL_DEFS = (await import('../src/tools.mjs')).TOOLS;
  t = Object.fromEntries(TOOL_DEFS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  model = await import('../src/model.mjs');
  lint = await import('../src/scriptlint.mjs');
  exp = await import('../src/export.mjs');
});
after(() => { delete process.env.STRUCMED_FLAGS; fs.rmSync(ws, { recursive: true, force: true }); });

function baseDraft() {
  const { draft_id } = t.form_create({ name: '附件測試', dept_no: 'TEST0' });
  const a1 = t.form_add_area({ draft_id, title: '附件' }).area_itemid;
  const box = t.form_add_control({ draft_id, area_itemid: a1, label_text: '附件：', control: { datatype: 'attachbox', datavalue: '請放入影像或報告' } }).itemid;
  const out = t.form_add_control({ draft_id, area_itemid: a1, label_text: '結果：', control: { datatype: 'textarea' } }).itemid;
  return { draft_id, a1, box, out };
}
const controlsOf = draft_id => {
  const m = new Map();
  for (const a of model.toFormJson(store.loadDraft(draft_id), 'test')) for (const n of a.item || []) if (n && n.itemid !== undefined) m.set(String(n.itemid), n);
  return m;
};

test('flag 關：不接受 attachbox（E_FEATURE_DISABLED）、巨集與函數視為未開放；工具清單依 flag 列出', () => {
  setFlags({ attachBox: false });
  const { draft_id } = t.form_create({ name: 'x', dept_no: 'TEST0' });
  const a1 = t.form_add_area({ draft_id, title: 'a' }).area_itemid;
  const e = errOf(() => t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'attachbox' } }));
  assert.equal(e.code, 'E_FEATURE_DISABLED');
  assert.deepEqual(codes(lint.lintMacro('LLMATTACH(4,"x")')), ['E_FEATURE_DISABLED']);
  assert.deepEqual(codes(lint.lintMacro('ATTACHTRANSCRIBE(2)')), ['E_FEATURE_DISABLED']);
  assert.ok(codes(lint.lintFormula('ATTACHCOUNT(2)')).includes('E_FEATURE_DISABLED'));
  const add = TOOL_DEFS.find(x => x.name === 'form_add_control');
  assert.ok(!add.inputSchema.properties.control.properties.datatype.enum.includes('attachbox'));
  assert.match(add.description, /需 feature flag attachBox，目前未開啟/);
  setFlags({ attachBox: true });
  assert.ok(add.inputSchema.properties.control.properties.datatype.enum.includes('attachbox'));
  assert.match(add.description, /flag attachBox 已開啟/);
});

test('form_add_control attachbox：欄位與編輯器存下的相同（tocalc false、五種類型、8 項、20 頁）', () => {
  const { draft_id, box } = baseDraft();
  const n = controlsOf(draft_id).get(String(box));
  assert.equal(n.datatype, 'attachbox');
  assert.equal(n.type, 'attachbox');
  assert.equal(n.tocalc, false);
  assert.equal(n.required, false);
  assert.equal(n.dicrole, 'nohis');
  assert.equal(n.datavalue, '請放入影像或報告');
  assert.equal(n.attachkinds, 'image,pdf,sheet,text,audio');
  assert.equal(n.attachmax, 8);
  assert.equal(n.attachpages, 20);
  // 編輯器存下的實際鍵（院外站台 2026-11-15 的測試表單）都在
  for (const k of ['datavalue', 'dictionary', 'dicid', 'dicrole', 'tag', 'formula', 'format', 'hisquery', 'hisQueryTitle', 'tocalc', 'toSAS', 'fromdict', 'efontcolor', 'efontsize', 'ebackcolor',
    'textareaHeight', 'required', 'furActionID', 'type', 'id', 'itemid', 'panelId', 'datatype', 'attachkinds', 'attachmax', 'multiple', 'datagroup', 'option', 'text', 'attachpages']) assert.ok(k in n, k);
  const v = t.form_validate({ draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test('attach_kinds／attach_max／attach_pages：正規化與範圍；只適用附件容器', () => {
  const { draft_id, a1, box, out } = baseDraft();
  const b2 = t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'attachbox', attach_kinds: 'audio, image', attach_max: 3, attach_pages: 100 } }).itemid;
  let n = controlsOf(draft_id).get(String(b2));
  assert.equal(n.attachkinds, 'image,audio', '依固定順序');
  assert.equal(n.attachmax, 3);
  assert.equal(n.attachpages, 100);
  t.form_update_control({ draft_id, itemid: box, changes: { attach_kinds: ['pdf'], attach_max: 30, datavalue: '只收 PDF' } });
  n = controlsOf(draft_id).get(String(box));
  assert.deepEqual([n.attachkinds, n.attachmax, n.attachpages, n.datavalue], ['pdf', 30, 20, '只收 PDF']);
  const bad = c => errOf(() => t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'attachbox', ...c } })).code;
  assert.equal(bad({ attach_kinds: 'video' }), 'E_INVALID_INPUT');
  assert.equal(bad({ attach_kinds: [] }), 'E_INVALID_INPUT');
  assert.equal(bad({ attach_max: 31 }), 'E_INVALID_INPUT');
  assert.equal(bad({ attach_pages: 0 }), 'E_INVALID_INPUT');
  assert.equal(bad({ required: true }), 'E_INVALID_INPUT');
  assert.equal(bad({ tocalc: true }), 'E_INVALID_INPUT');
  assert.equal(bad({ dictionary: { name: '附件' } }), 'E_INVALID_INPUT');
  assert.equal(errOf(() => t.form_update_control({ draft_id, itemid: out, changes: { attach_max: 3 } })).code, 'E_INVALID_INPUT');
  assert.equal(errOf(() => t.form_update_control({ draft_id, itemid: box, changes: { required: true } })).code, 'E_INVALID_INPUT');
  assert.equal(errOf(() => t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'textbox', attach_max: 3 } })).code, 'E_INVALID_INPUT');
});

test('附件容器不能放動態表格', () => {
  const { draft_id } = baseDraft();
  const tb = t.form_add_area({ draft_id, type: 'table1', titles: ['項目'] }).area_itemid;
  const e = errOf(() => t.form_add_control({ draft_id, area_itemid: tb, cell: { index: 0 }, control: { datatype: 'attachbox' } }));
  assert.equal(e.code, 'E_UNSUPPORTED_DATATYPE');
  assert.match(e.message, /附件容器不能放在動態表格/);
});

test('LLMATTACH：語法、目標、容器來源、AI 資料流', () => {
  const { draft_id, a1, box, out } = baseDraft();
  const ctx = { controls: controlsOf(draft_id) };
  let r = lint.lintMacro(`LLMATTACH(${out},"請將附件內容摘要輸出", "", "${box}")`, ctx);
  assert.deepEqual(codes(r), []);
  assert.deepEqual(r.targets, [String(out)]);
  assert.equal(r.ai.length, 1);
  assert.equal(r.ai[0].kind, 'LLMATTACH');
  assert.equal(r.ai[0].model, '');
  assert.deepEqual(r.ai[0].attachments, [{ itemid: box, kinds: ['image', 'pdf', 'sheet', 'text', 'audio'] }]);
  assert.match(r.ai[0].sources.join('｜'), new RegExp(`附件容器 #${box} 的內容（影像、PDF、Excel／CSV、文字、音檔）`));
  assert.match(r.ai[0].sources.join('｜'), /音檔會先送語音服務轉成逐字稿/);
  // 省略容器＝表單上所有容器；多個容器可以寫 "2,5" 或分開寫
  r = lint.lintMacro(`LLMATTACH(${out},"x")`, ctx);
  assert.deepEqual(r.ai[0].attachments.map(b => b.itemid), [box]);
  const b2 = t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'attachbox', attach_kinds: 'sheet,text' } }).itemid;
  const ctx2 = { controls: controlsOf(draft_id) };
  for (const s of [`"${box},${b2}"`, `${box},${b2}`, `"${box} ${b2}"`]) {
    r = lint.lintMacro(`LLMATTACH(${out},"x","",${s})`, ctx2);
    assert.deepEqual(codes(r), [], s);
    assert.deepEqual(r.ai[0].attachments.map(b => b.itemid), [box, b2], s);
  }
  // 錯誤：參數不足、目標型別、容器 id 不是數字、不是容器、不存在、後面有多餘文字
  assert.deepEqual(codes(lint.lintMacro(`LLMATTACH(${out})`, ctx2)), ['E_MACRO_SYNTAX']);
  assert.ok(codes(lint.lintMacro(`LLMATTACH(${box},"x")`, ctx2)).includes('E_MACRO_TARGET_TYPE'));
  assert.deepEqual(codes(lint.lintMacro(`LLMATTACH(${out},"x","",A${box})`, ctx2)), ['E_ATTACH_SOURCE']);
  assert.deepEqual(codes(lint.lintMacro(`LLMATTACH(${out},"x","","${out}")`, ctx2)), ['E_ATTACH_SOURCE']);
  assert.deepEqual(codes(lint.lintMacro(`LLMATTACH(${out},"x","","99")`, ctx2)), ['E_REF_BROKEN']);
  assert.ok(codes(lint.lintMacro(`LLMATTACH(${out},"x") + 1`, ctx2)).includes('E_MACRO_TRAILING'));
  // 表單沒有容器
  const none = new Map([[String(out), ctx2.controls.get(String(out))]]);
  assert.deepEqual(codes(lint.lintMacro(`LLMATTACH(${out},"x")`, { controls: none })), ['E_ATTACH_SOURCE']);
  // 大小寫錯
  assert.ok(codes(lint.lintMacro(`Llmattach(${out},"x")`, ctx2)).includes('E_MACRO_STEP_CASE'));
  // 提示詞帶識別資料照樣警告
  assert.ok(codes(lint.lintMacro(`LLMATTACH(${out},CONCAT("病歷號", G_CHTNO()))`, ctx2)).includes('W_AI_IDENTIFIER'));
});

test('LLMATTACH 的模型：內建代號、原樣送出的名稱、Gateway 白名單、視覺能力', () => {
  const { draft_id, a1, box, out } = baseDraft();
  const textOnly = t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'attachbox', attach_kinds: 'sheet,text,audio' } }).itemid;
  const controls = controlsOf(draft_id);
  const run = (model, policy, src = box) => lint.lintMacro(`LLMATTACH(${out},"x",${model},"${src}")`, { controls, policy });
  assert.deepEqual(codes(run('"gemma3_12b"')), []);
  assert.deepEqual(codes(run('"medgemma"')), []);
  let r = run('"some-new-model"');
  assert.deepEqual(codes(r), ['W_LLM_MODEL_PASSTHROUGH'], '不在代號表不是錯誤：經 Gateway 原樣送出');
  assert.equal(r.ai[0].model, 'some-new-model');
  assert.ok(codes(run('gemma3')).includes('E_LLM_MODEL_UNQUOTED'));
  // Gateway 白名單快取：原樣送出的名稱要完全相同；內建代號對應到閘道模型
  const gateway_models = [{ id: 'gemma3:12b', status: 'active', vision: true }, { id: 'Vision-A', status: 'active', vision: true }, { id: 'Text-B', status: 'active', vision: false }, { id: 'Old-C', status: 'deprecated', vision: true }];
  assert.deepEqual(codes(run('""', { gateway_models })), []);
  assert.deepEqual(codes(run('"Vision-A"', { gateway_models })), ['W_LLM_MODEL_PASSTHROUGH']);
  assert.ok(codes(run('"vision-a"', { gateway_models })).includes('E_LLM_MODEL_NOT_ON_GATEWAY'), '大小寫不同就不是同一個模型');
  assert.ok(codes(run('"Old-C"', { gateway_models })).includes('E_LLM_MODEL_DEPRECATED'));
  assert.ok(codes(run('"medgemma"', { gateway_models })).includes('E_LLM_MODEL_NOT_ON_GATEWAY'));
  // 沒有視覺能力：容器會送影像 → 錯誤；只收文字類附件 → 只提醒
  assert.ok(codes(run('"Text-B"', { gateway_models })).includes('E_LLM_MODEL_NO_VISION'));
  r = run('"Text-B"', { gateway_models }, textOnly);
  assert.ok(codes(r).includes('W_LLM_MODEL_NO_VISION') && !codes(r).includes('E_LLM_MODEL_NO_VISION'));
  assert.ok(r.findings.every(f => !('novision' in f)));
  // 本院允許清單
  assert.ok(codes(run('"gemma3"', { llm_models: ['gemma3_12b'] })).includes('E_LLM_MODEL_POLICY'));
});

test('ATTACHTRANSCRIBE、ATTACHTEXT、ATTACHCOUNT', () => {
  const { draft_id, a1, box, out } = baseDraft();
  const img = t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'attachbox', attach_kinds: 'image' } }).itemid;
  const ctx = { controls: controlsOf(draft_id) };
  let r = lint.lintMacro(`ATTACHTRANSCRIBE(${box}),MACRO(${out}, ATTACHTEXT(${box}, "", 2000))`, ctx);
  assert.deepEqual(codes(r), []);
  assert.deepEqual(r.ai.map(x => x.kind), ['ATTACHTRANSCRIBE'], '取出文字寫進欄位不是 AI 步驟；轉寫是');
  assert.equal(r.ai[0].target, null);
  assert.match(r.ai[0].provider, /語音服務/);
  assert.deepEqual(codes(lint.lintMacro(`ATTACHTRANSCRIBE(${img})`, ctx)), ['W_ATTACH_NO_AUDIO']);
  assert.deepEqual(codes(lint.lintMacro('ATTACHTRANSCRIBE()', ctx)), [], '省略＝所有容器');
  assert.deepEqual(codes(lint.lintMacro(`ATTACHTRANSCRIBE(${out})`, ctx)), ['E_ATTACH_SOURCE']);
  // ATTACHTEXT 放在 LLMQUERY 的提示詞：列進 AI 資料流的來源
  r = lint.lintMacro(`LLMQUERY(${out}, CONCAT("只根據下列內容回答，無資料時回答 not available：", ATTACHTEXT(${box})), "gemma3")`, ctx);
  assert.ok(!codes(r).some(c => c.startsWith('E_')), JSON.stringify(r.findings));
  assert.match(r.ai[0].sources.join('｜'), /ATTACHTEXT\(\)：附件容器內/);
  // 計算式：ATTACHCOUNT 可以，ATTACHTEXT 不行；第一個參數要是容器
  assert.deepEqual(codes(lint.lintFormula(`IF(ATTACHCOUNT(${box}) > 0, "已附檔", "未附檔")`, ctx)), []);
  assert.deepEqual(codes(lint.lintFormula(`ATTACHTEXT(${box})`, ctx)), ['E_FORMULA_MACRO_ONLY']);
  assert.deepEqual(codes(lint.lintFormula(`ATTACHCOUNT(${out})`, ctx)), ['E_ATTACH_SOURCE']);
  assert.ok(codes(lint.lintFormula('ATTACHCOUNT(A2)', ctx)).includes('E_ATTACH_SOURCE'));
  assert.ok(codes(lint.lintFormula('ATTACHCOUNT(99)', ctx)).includes('E_REF_BROKEN'));
});

test('整張表單：巨集按鈕可以先建、容器後建（延後）；驗證、欄位對照、manifest 揭露', () => {
  const { draft_id } = t.form_create({ name: '核醫報告草稿', dept_no: 'TEST0' });
  const a1 = t.form_add_area({ draft_id, title: '附件' }).area_itemid;
  const out = t.form_add_control({ draft_id, area_itemid: a1, label_text: '草稿：', control: { datatype: 'textarea' } }).itemid;
  const btn = t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'action', action_name: '產生草稿', action_script: `LLMATTACH(${out},"請依附件寫出報告草稿","","${out + 2}")` } });
  assert.ok(btn.deferred_errors.some(x => /E_REF_BROKEN/.test(x)), '容器還沒建：延後');
  const box = t.form_add_control({ draft_id, area_itemid: a1, label_text: '附件：', control: { datatype: 'attachbox' } }).itemid;
  assert.equal(box, out + 2);
  const v = t.form_validate({ draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(v.warnings.some(w => w.code === 'W_AI_DATAFLOW'));
  assert.match(v.warnings.find(w => w.code === 'W_RENUMBER_MACRO').message, /附件容器 id/);
  assert.equal(v.ai.length, 1);
  assert.deepEqual(v.ai[0].attachments.map(b => b.itemid), [box]);
  const man = exp.scriptSection ? exp.scriptSection(store.loadDraft(draft_id), v) : '';
  if (man) assert.match(man, new RegExp(`LLMATTACH .*附件容器 #${box} 的內容`));
  const f = t.form_fields({ draft_id });
  const boxField = f.fields.find(x => x.itemid === box);
  assert.match(boxField.derived.func, /附件容器（可放入 image,pdf,sheet,text,audio，最多 8 項；內容不存檔、不進 HIS 文字）/);
  assert.ok(boxField.ai.some(x => /LLMATTACH.*把容器內的附件送給 LLM/.test(x)));
  assert.equal(boxField.dictionary, null);
  const tree = t.form_preview({ draft_id, format: 'tree' });
  const text = typeof tree === 'string' ? tree : tree.preview || tree.text || JSON.stringify(tree);
  assert.match(text, /附件容器/);
  assert.match(text, /不存檔/);
  // flag 事後關閉：本工具新增的容器與巨集不能輸出
  setFlags({ attachBox: false });
  const off = t.form_validate({ draft_id });
  assert.equal(off.valid, false);
  assert.ok(off.errors.some(e => e.code === 'E_FEATURE_DISABLED' && e.itemid === box));
  setFlags({ attachBox: true });
});

test('只有計算式用到容器（ATTACHCOUNT）也提醒不要重新編號', () => {
  const { draft_id, a1, box } = baseDraft();
  t.form_add_control({ draft_id, area_itemid: a1, label_text: '附件數：', control: { datatype: 'label', format: 'formula', formula: `ATTACHCOUNT(${box})` } });
  const v = t.form_validate({ draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(v.warnings.some(w => w.code === 'W_RENUMBER_MACRO'), '容器 id 是數字，重新編號不會更新');
});
