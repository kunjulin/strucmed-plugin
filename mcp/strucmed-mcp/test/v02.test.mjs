// v0.2：計算式、巨集、HIS 參照
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../src/calx.mjs';
import { BUILTIN } from '../src/calx-catalog.mjs';
import { lintFormula, lintMacro, lintHisQuery, lintPrompt, platformSplit } from '../src/scriptlint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const codes = r => r.findings.map(f => f.code);
let ws, t, store, model;

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-v02-'));
  process.env.STRUCMED_WORKSPACE = ws;
  const { TOOLS } = await import('../src/tools.mjs');
  t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  model = await import('../src/model.mjs');
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

test('calx: acceptance matches real Calx 2.2.8 on its known quirks', () => {
  // 以下結果都在 tools/v0-harness/calx-parity.html 以真實 Calx 實測
  for (const ok of ['A1 > 3', 'A1>=3', 'A1<>3', 'IF(A1 > 3, "hi", \'lo\')', 'IF(A1> 3, 1, 0)', 'IF((A1)>3, 1, 0)', '50%', '0.5*A1',
    'SUM(A1:A3)', 'SUM([1,2,3])', '[1;2]', 'TRUE', 'true', 'NULL', 'foo', 'sum(1,2)', 'IF(1;2;3)', '--A1', '2^-1', '12:30', '3:30 PM',
    '$A$1', '#sheet!A1', 'LEN("中文")', 'T("x")', 'LOG10(100)', 'CONCATENATE("(", A1, ")")', 'IF(A1 > 3,\n  "multi",\n  "line")']) {
    assert.ok(check(ok).ok, `should accept: ${ok}`);
  }
  for (const bad of ['A1>3', '3>A1', 'IF(A1>3, 1, 0)', 'A1 == 3', '"a" & "b"', '.5', '3.', 'A1%', '(1+2)%', '(1+2', '1+2)',
    '"unterminated', '中文', '1 2', '1,2', '1e3', 'A1 NOT 3', 'A1!=3', '{1}', 'A1 @ 2']) {
    assert.equal(check(bad).ok, false, `should reject: ${bad}`);
  }
  assert.match(check('A5>3').message, /加空白/);
  assert.match(check('"a" & "b"').message, /CONCATENATE/);
});

test('catalog: builtin list matches the vendored Calx (when the platform clone exists)', { skip: !fs.existsSync(path.join(HERE, '../../../repo/strucmed/web/assets/js/vendor/jquery-calx-2.2.8 min.js')) }, () => {
  const src = fs.readFileSync(path.join(HERE, '../../../repo/strucmed/web/assets/js/vendor/jquery-calx-2.2.8 min.js'), 'utf8');
  const names = new Set([...src.matchAll(/([A-Z][A-Z0-9_]*):function\(/g)].map(m => m[1]));
  assert.deepEqual([...names].sort(), [...BUILTIN].sort());
});

test('formula lint: functions, references, runtime replacement', () => {
  const controls = new Map([['1', { datatype: 'numberbox', tocalc: true }], ['2', { datatype: 'numberbox', tocalc: false }], ['3', { datatype: 'label', tocalc: true }]]);
  const ctx = { controls, self: 3 };
  assert.deepEqual(codes(lintFormula('ROUND(A1 / 2, 1)', ctx)), []);
  assert.ok(codes(lintFormula('NOPE(A1)', ctx)).includes('E_FORMULA_UNKNOWN_FUNCTION'));
  assert.ok(codes(lintFormula('HISQUERY("1,x")', ctx)).includes('E_FORMULA_MACRO_ONLY'));
  assert.ok(codes(lintFormula('SETVALUEBYID(1, 2)', ctx)).includes('E_FORMULA_MACRO_ONLY'));
  assert.ok(codes(lintFormula('CUSTOMFUNC("alert")', ctx)).includes('E_FORBIDDEN_FUNCTION'));
  assert.ok(codes(lintFormula('CONCATENATE("MACRO(", A1)', ctx)).includes('E_FORMULA_REPLACED'));   // 連字串內也會被換掉
  assert.ok(codes(lintFormula('A1 + abc', ctx)).includes('E_FORMULA_UNDEFINED_VARIABLE'));
  assert.ok(codes(lintFormula('A2 + 1', ctx)).includes('E_FORMULA_REF_NOT_CALC'));
  assert.ok(codes(lintFormula('A9 + 1', ctx)).includes('E_REF_BROKEN'));
  assert.ok(codes(lintFormula('A3 + 1', ctx)).includes('E_FORMULA_CYCLE'));
  assert.ok(codes(lintFormula('B1 + 1', ctx)).includes('E_FORMULA_REF'));
  assert.ok(codes(lintFormula('$A$1 + 1', ctx)).includes('E_FORMULA_REF'));
  assert.ok(codes(lintFormula('CONCATENATE("HbA1c ", A1)', ctx)).length === 0, 'HbA1c 不是 A1 樣式');
  assert.ok(codes(lintFormula('CONCATENATE("A1c ", A1)', ctx)).includes('W_RENUMBER_STRING'));
  assert.ok(codes(lintFormula('MEDIAN(A1, 2)', ctx)).includes('W_FORMULA_FN_NEEDS_DEPLOY'));
  assert.deepEqual(codes(lintFormula('MEDIAN(A1, 2)', { ...ctx, policy: { runtime_has_numeral_jstat: true } })), []);
  assert.ok(codes(lintFormula('CHECKREQUIRED("OFF")', ctx)).includes('W_SETTING_FUNCTION'));
});

test('macro lint: step splitting, step commands, models, targets', () => {
  const controls = new Map([
    ['1', { datatype: 'textarea', tocalc: true }], ['2', { datatype: 'textbox', tocalc: true, datavalue: 'qwen332b' }],
    ['3', { datatype: 'numberbox', tocalc: true }], ['4', { datatype: 'textbox', tocalc: true, datavalue: 'gpt4' }]]);
  const ctx = { controls };
  // 平台只算括號，不理會引號
  assert.deepEqual(platformSplit('MACRO(1, "a,b"), SETVALUEBYID(3, 1)').steps, ['MACRO(1, "a,b")', 'SETVALUEBYID(3, 1)']);
  assert.ok(codes(lintMacro('MACRO(1, "(x"), SETVALUEBYID(3, 1)', ctx)).includes('E_MACRO_SPLIT'));
  const ok = lintMacro('LLMQUERY(1, CONCATENATE("摘要：", A3), "qwen332b"), MACRO(3, 1 + 1), SETVALUEBYID(3, 2)', ctx);
  assert.deepEqual(ok.findings.filter(f => f.level === 'error'), []);
  assert.deepEqual(ok.targets.sort(), ['1', '3']);
  assert.deepEqual(ok.ai[0].inputs, ['3']);
  assert.ok(codes(lintMacro('LLMVISION(1, "看圖")', ctx)).includes('E_MACRO_STEP_CASE'));
  assert.ok(codes(lintMacro('macro(1, 2)', ctx)).includes('E_MACRO_STEP_CASE'));
  assert.ok(codes(lintMacro('llmquery(1, "x")', ctx)).includes('W_LLM_NOT_AWAITED'));
  assert.ok(codes(lintMacro('IF(A3 > 1, LLMQUERY(1, "x"), 0)', ctx)).includes('W_LLM_NOT_AWAITED'));
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", "qwen")', ctx)).includes('E_LLM_MODEL_UNKNOWN'));
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", "gemma4_31b")', ctx)).includes('E_LLM_MODEL_UNKNOWN'));
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", tw)', ctx)).includes('E_LLM_MODEL_UNQUOTED'));
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", "70b")', ctx)).includes('W_LLM_MODEL_ALIAS'));
  assert.deepEqual(codes(lintMacro('LLMQUERY(1, "x", A2)', ctx)), [], '模型取自欄位預設值 qwen332b');
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", A4)', ctx)).includes('E_LLM_MODEL_UNKNOWN'), '欄位預設值 gpt4 不在清單');
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", "tw")', { ...ctx, policy: { llm_models: ['', 'qwen332b'] } })).includes('E_LLM_MODEL_POLICY'));
  assert.ok(codes(lintMacro('LLMvision(2, "看圖", "gemma3")', ctx)).includes('E_MACRO_TARGET_TYPE'), 'LLMvision 只能寫入 textarea');
  assert.ok(codes(lintMacro('LLMvision(1, "看圖", "tw")', ctx)).includes('E_LLM_MODEL_UNKNOWN'), 'tw 不是影像模型');
  assert.ok(codes(lintMacro('VOICETOTEXT(1, "GOOGLE")', ctx)).includes('E_ASR_PROVIDER'));
  assert.ok(codes(lintMacro('LLMQUERY(9, "x")', ctx)).includes('E_REF_BROKEN'));
  assert.ok(codes(lintMacro('MACRO(IF(A3 > 1, 1, 3), 2)', ctx)).includes('E_MACRO_SYNTAX'), 'MACRO 目標不能含逗號');
  assert.ok(codes(lintMacro('MACRO(1, 2) + 1', ctx)).includes('E_MACRO_TRAILING'));
  assert.ok(codes(lintMacro('HISQUERY("3,Procedure.InName(P.Q).AddParameter(A=1,B=2).GetValueByName(X)")', ctx)).includes('E_HISQUERY_PAIR'));
  assert.ok(codes(lintMacro('OPENURL("https://example.org")', ctx)).includes('E_FORBIDDEN_FUNCTION'));
  assert.ok(codes(lintMacro('"SETVALUEBYID(3, 1)"', ctx)).includes('W_MACRO_QUOTED_STEP'));
  assert.deepEqual(codes(lintPrompt('IF(LEN(A1) < 10, "not available", CONCATENATE("只根據下列紀錄摘要，只提供答案：", A1))', ctx)), []);
  // prompt 設計檢查（PromptPatterns.md §5）：只對帶入資料的 prompt 檢查，兩條都是警告
  const bare = lintPrompt('CONCATENATE("請摘要：", A1)', ctx);
  assert.deepEqual(codes(bare).sort(), ['W_PROMPT_NO_GUARD', 'W_PROMPT_NO_SCOPE']);
  assert.ok(bare.findings.every(f => f.level === 'warn'));
  assert.deepEqual(codes(lintPrompt('"Please explain metabolic syndrome"', ctx)), [], '純問答不檢查');
  assert.deepEqual(codes(lintMacro('LLMQUERY(1, "x", "qwen332b")', ctx)), [], '沒有欄位參照不檢查');
  assert.deepEqual(codes(lintMacro('LLMQUERY(1, IF(LEN(A3) < 10, "not available", CONCATENATE("Only based on the records below, answer only: ", A3)), "qwen3627b")', ctx)), []);
  assert.ok(codes(lintMacro('LLMQUERY(1, CONCATENATE("只根據下列紀錄，無資料回 not available：", A3), "qwen3627b")', ctx)).includes('W_PROMPT_NO_GUARD'));
  assert.ok(!codes(lintMacro('LLMQUERY(1, CONCATENATE("只根據下列紀錄，無資料回 not available：", A3), "qwen3627b")', ctx)).includes('W_PROMPT_NO_SCOPE'));
  assert.ok(codes(lintMacro('LLMQUERY(1, IF(LEN(A3) < 10, "x", CONCATENATE("摘要：", A3)), "qwen3627b")', ctx)).includes('W_PROMPT_NO_SCOPE'));
  assert.ok(codes(lintMacro('LLMQUERY(1, CONCATENATE("摘要：", GETTEXT()), "qwen3627b")', ctx)).includes('W_PROMPT_NO_GUARD'), 'GETTEXT 也算帶入資料');
  // LLMvision 之後沒有 LLMQUERY 接力
  assert.ok(codes(lintMacro('LLMvision(1, "只描述影像所見", "gemma3_12b")', ctx)).includes('W_VISION_NO_FOLLOWUP'));
  assert.ok(!codes(lintMacro('LLMvision(1, "只描述影像所見", "gemma3_12b"), LLMQUERY(1, IF(LEN(A1) < 10, "not available", CONCATENATE("只根據下列描述整理，只提供答案：", A1)), "qwen332b")', ctx)).includes('W_VISION_NO_FOLLOWUP'));
  // AI 資料流要列出整份報告與識別資料，不能只列 A<n>
  const bulk = lintMacro('LLMQUERY(1, CONCATENATE("摘要：", A3, GETTEXT()), "qwen3627b")', ctx);
  assert.deepEqual(bulk.ai[0].inputs, ['3']);
  assert.match(bulk.ai[0].sources[0], /^GETTEXT\(\)/);
  assert.ok(codes(lintMacro('LLMQUERY(1, CONCATENATE(G_CHTNO(), GETTEXT()))', ctx)).includes('W_AI_IDENTIFIER'));
  assert.ok(codes(lintPrompt('CONCATENATE(G_USERNM(), A1)', ctx)).includes('W_AI_IDENTIFIER'));
});

test('HIS query lint', () => {
  assert.deepEqual(codes(lintHisQuery('Procedure.InName(PKG.GET_AGE).GetValueByName(AGE)')), ['W_PATIENT_DATA_READ']);
  assert.deepEqual(codes(lintHisQuery('LABDATA.InDays(30).InName(HbA1c).GetLatestString')), ['W_PATIENT_DATA_READ']);
  assert.ok(codes(lintHisQuery('LABDATA.InDays(365).GetAllString')).includes('E_HISQUERY_INDAYS'));
  assert.ok(codes(lintHisQuery('OPDDATA.InDays(30)')).includes('E_HISQUERY_NO_GETTER'));
  assert.ok(codes(lintHisQuery('FOO.GetAllString')).includes('E_HISQUERY_SYNTAX'));
  assert.ok(codes(lintHisQuery('Procedure.GetValueByName(X)')).includes('E_HISQUERY_SYNTAX'));
});

test('tools: build a form with formula, HIS query, macro and LLM button', () => {
  const { draft_id } = t.form_create({ name: 'V02 計算與巨集', dept_no: 'TEST0' });
  const { area_itemid: a } = t.form_add_area({ draft_id });
  const add = (label_text, control) => t.form_add_control({ draft_id, area_itemid: a, label_text, control });
  const h = add('身高(cm)：', { datatype: 'numberbox', minval: 50, maxval: 250 }).itemid;
  const w = add('體重(kg)：', { datatype: 'numberbox', minval: 1, maxval: 300 }).itemid;
  const bmi = add('BMI：', { datatype: 'label', format: 'formula', formula: `IF(A${h} > 0, ROUND(A${w} / POWER(A${h} / 100, 2), 1), "")` }).itemid;
  add('年齡：', { datatype: 'label', format: 'hisquery', hisquery: 'Procedure.InName(PKG.GET_AGE).GetValueByName(AGE)', his_query_title: 'patient.age' });
  const note = add('摘要：', { datatype: 'textarea' }).itemid;
  const btn = add('', { datatype: 'action', action_name: '產生摘要', action_id: note,
    action_script: `LLMQUERY(${note}, CONCATENATE("BMI=", A${bmi}, "；請用一句話摘要"), "qwen332b"), MACRO(${note}, CONCATENATE(A${note}, "（AI 產生，請查核）"))` });
  assert.ok(btn.ai.length === 1 && btn.ai[0].model === 'qwen332b');
  add('LLM：', { datatype: 'action2', action_name: '問 AI', action_id: note, action_script: `CONCATENATE("BMI 是 ", A${bmi})` });
  add('觸發：', { datatype: 'textbox', fur_action_id: btn.itemid });

  // 語法錯誤當下拒絕，draft 不變
  const before = JSON.stringify(store.loadDraft(draft_id).areas);
  assert.throws(() => add('壞：', { datatype: 'label', format: 'formula', formula: `A${h}>3` }), /計算式／巨集有錯誤/);
  assert.throws(() => add('壞：', { datatype: 'action', action_script: 'OPENURL("https://x")' }), /計算式／巨集有錯誤/);
  assert.equal(JSON.stringify(store.loadDraft(draft_id).areas), before);
  // 參照類錯誤延後回報
  const later = add('稍後：', { datatype: 'label', format: 'formula', formula: 'A999 + 1' });
  assert.ok(later.deferred_errors.some(x => x.startsWith('E_REF_BROKEN')));
  let v = t.form_validate({ draft_id });
  assert.ok(v.errors.some(e => e.code === 'E_REF_BROKEN'));
  t.form_update_control({ draft_id, itemid: later.itemid, changes: { formula: `A${bmi} * 2` } });
  v = t.form_validate({ draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.stats.formulas, 2);
  assert.equal(v.stats.macros, 2);
  assert.equal(v.ai.length, 2);
  assert.ok(v.warnings.some(x => x.code === 'W_AI_DATAFLOW'));
  assert.ok(v.warnings.some(x => x.code === 'W_RENUMBER_MACRO'));

  // 循環參照
  t.form_update_control({ draft_id, itemid: bmi, changes: { formula: `A${later.itemid} + 1` } });
  v = t.form_validate({ draft_id });
  assert.ok(v.errors.some(e => e.code === 'E_FORMULA_CYCLE'));
  t.form_update_control({ draft_id, itemid: bmi, changes: { formula: `ROUND(A${w} / POWER(A${h} / 100, 2), 1)` } });

  // 巨集的目標不能直接刪除
  assert.throws(() => t.form_remove_control({ draft_id, itemid: note }), /仍被參照/);

  // 型別檢查：修改工具只接受對應的 datatype
  assert.throws(() => t.form_update_control({ draft_id, itemid: h, changes: { formula: '1' } }), /只適用 label/);
  assert.throws(() => t.form_update_control({ draft_id, itemid: bmi, changes: { action_script: '1' } }), /只適用 action/);

  // 產出的物件欄位集合 = 編輯器載入後的欄位集合（F = G1 的前提）
  const shapes = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/editor-g1-keys.json'), 'utf8')).shapes;
  const d = store.loadDraft(draft_id);
  for (const item of d.areas[0].items.filter(x => x.itemid !== undefined)) {
    assert.deepEqual(Object.keys(item).sort(), [...shapes[item.datatype]].sort(), `${item.datatype} #${item.itemid}`);
  }

  // 輸出：manifest 列出 AI 資料流
  const plan = t.form_export({ draft_id });
  const r = t.form_export({ draft_id, confirm_token: plan.confirm_token });
  const man = fs.readFileSync(path.join(ws, r.files.manifest), 'utf8');
  assert.match(man, /## 計算式與巨集/);
  assert.match(man, /### AI 資料流（2 個步驟）/);
  assert.match(man, /qwen332b/);
  assert.match(man, /不要按「重新編號」/);
});

test('re-revising a tool output keeps a single generated-by marker', () => {
  const { draft_id } = t.form_create({ name: '標記來源', dept_no: 'TEST0' });
  const { area_itemid: a } = t.form_add_area({ draft_id });
  t.form_add_control({ draft_id, area_itemid: a, label_text: 'x', control: { datatype: 'textbox' } });
  const form = model.toFormJson(store.loadDraft(draft_id), 'strucmed-skill v9 old');
  form.find(x => x.itemtype === 'javascript').content += '\nvar keep = 1;';
  fs.writeFileSync(path.join(ws, 'marked.json'), JSON.stringify(form));
  const r = t.form_import({ source_path: 'marked.json', name: '標記改版', dept_no: 'TEST0' });
  const js = model.toFormJson(store.loadDraft(r.draft_id), 'strucmed-skill v9 new').find(x => x.itemtype === 'javascript').content;
  assert.equal((js.match(/generated-by/g) || []).length, 1);
  assert.match(js, /v9 new\nvar keep = 1;$/);
});

test('form_preview html writes the runtime data under .strucmed/preview and returns the local URL', () => {
  const { draft_id } = t.form_create({ name: '預覽', dept_no: 'TEST0' });
  const { area_itemid: a } = t.form_add_area({ draft_id });
  t.form_add_control({ draft_id, area_itemid: a, label_text: 'x', control: { datatype: 'textbox' } });
  const r = t.form_preview({ draft_id, format: 'html' });
  assert.equal(r.url, `http://127.0.0.1:8765/__preview/${draft_id}`);
  const file = path.join(ws, r.file);
  assert.ok(file.startsWith(path.join(ws, '.strucmed', 'preview')), '只寫在 .strucmed/preview（已 gitignore）');
  const form = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(form, model.toFormJson(store.loadDraft(draft_id), 'x').map(x => x.itemtype === 'javascript' ? form.find(y => y.itemtype === 'javascript') : x));
  const outDir = path.join(ws, 'output');
  assert.ok(!fs.existsSync(outDir) || !fs.readdirSync(outDir).some(f => f.startsWith('預覽')), '預覽不產生可匯入的輸出檔');
  assert.match(t.form_preview({ draft_id }).content, /^表單：預覽/);
});

test('tools: formula_check without a draft', () => {
  const r = t.formula_check({ kind: 'formula', text: 'A1>3' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /加空白/);
  const m = t.formula_check({ kind: 'macro', text: 'LLMQUERY(5, CONCATENATE("x", A2), "tw"), SETVALUEBYID(6, 1)' });
  assert.equal(m.ok, true);
  assert.deepEqual(m.targets.sort(), ['5', '6']);
  assert.deepEqual(m.refs, ['A2']);
  assert.equal(t.formula_check({ kind: 'hisquery', text: 'OPDDATA.InDays(30).GetLatestString' }).ok, true);
});

test('v1 revision: editing an existing formula is checked at error level; untouched problems stay warnings', () => {
  fs.copyFileSync(path.join(HERE, 'fixtures/existing-form.json'), path.join(ws, 'src.json'));
  const r = t.form_import({ source_path: 'src.json', name: '改版 v02', dept_no: 'TEST0' });
  const d = store.loadDraft(r.draft_id);
  let label = null;
  const walk = v => { if (!v || typeof v !== 'object') return; if (Array.isArray(v)) return v.forEach(walk); if (v.datatype === 'label' && v.formula && !label) label = v; Object.values(v).forEach(walk); };
  walk(d.areas);
  assert.ok(label, 'fixture 需要有計算式');
  assert.throws(() => t.form_update_control({ draft_id: r.draft_id, itemid: Number(label.itemid), changes: { formula: 'A1 & A2' } }), /計算式／巨集有錯誤/);
  t.form_update_control({ draft_id: r.draft_id, itemid: Number(label.itemid), changes: { formula: 'A99999 + 1' } });
  const v = t.form_validate({ draft_id: r.draft_id });
  assert.ok(v.errors.some(e => e.code === 'E_REF_BROKEN' && e.itemid === Number(label.itemid)), '改過的計算式 → error');
});

test('pending dictionaries: binding an existing id, unbinding, or removing the control drops the name from pendingDictionaries', () => {
  // 線上實測（T1）發現：綁回既有字典後 online_template_create 仍回 E_DICT_PENDING
  store.saveDictIndex({ loadedAt: new Date().toISOString(), source: 'test', deptNo: 'TEST0', hasIds: true, deleted: 0, warnings: [], duplicates: [],
    entries: [{ id: 'dic-existing-1', dicType: 'TEST0', dicName: 'FALL_HX', dicComment: '', createUser: '', createDate: '' }] });
  const { draft_id } = t.form_create({ name: '待新建字典清理', dept_no: 'TEST0' });
  const { area_itemid: a } = t.form_add_area({ draft_id });
  const add = (label_text, name) => t.form_add_control({ draft_id, area_itemid: a, label_text, control: { datatype: 'textbox', dictionary: { name } } }).itemid;
  const c1 = add('一：', 'NEW_ONE'), c2 = add('二：', 'NEW_TWO'), c3 = add('三：', 'NEW_THREE'), c4 = add('四：', 'NEW_ONE');
  const pending = () => store.loadDraft(draft_id).pendingDictionaries.map(p => p.name);
  assert.deepEqual(pending(), ['NEW_ONE', 'NEW_TWO', 'NEW_THREE']);
  // #c1 改綁既有 id：NEW_ONE 仍被 #c4 用 → 留著
  const r = t.form_update_control({ draft_id, itemid: c1, changes: { dictionary: { id: 'dic-existing-1' } } });
  assert.equal(r.dicid, 'dic-existing-1');
  assert.deepEqual(pending(), ['NEW_ONE', 'NEW_TWO', 'NEW_THREE']);
  // #c4 也改綁 → NEW_ONE 沒人用了
  t.form_update_control({ draft_id, itemid: c4, changes: { dictionary: { id: 'dic-existing-1' } } });
  assert.deepEqual(pending(), ['NEW_TWO', 'NEW_THREE']);
  // #c2 解除綁定
  t.form_update_control({ draft_id, itemid: c2, changes: { dictionary: {} } });
  assert.deepEqual(pending(), ['NEW_THREE']);
  // 移除 #c3（兩段式）
  const plan = t.form_remove_control({ draft_id, itemid: c3 });
  t.form_remove_control({ draft_id, itemid: c3, confirm_token: plan.confirm_token });
  assert.deepEqual(pending(), []);
  const v = t.form_validate({ draft_id });
  assert.equal(v.stats.dict_new, 0);
  assert.equal(v.stats.dict_bound, 2);
  store.saveDictIndex(null);
});
