// v0.2：計算式、巨集、HIS 參照
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../src/calx.mjs';
import { BUILTIN } from '../src/calx-catalog.mjs';
import { lintFormula, lintMacro, lintHisQuery, lintPrompt, platformSplit, legacySplit } from '../src/scriptlint.mjs';

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
    ['1', { datatype: 'textarea', tocalc: true }], ['2', { datatype: 'textbox', tocalc: true, datavalue: 'nemotron35' }],
    ['3', { datatype: 'numberbox', tocalc: true }], ['4', { datatype: 'textbox', tocalc: true, datavalue: 'gpt4' }]]);
  const ctx = { controls };
  // 平台 20261124b 起看引號（kunjulin/strucmed#264）；舊版 runtime 只算括號 → 只提醒部署
  assert.deepEqual(platformSplit('MACRO(1, "a,b"), SETVALUEBYID(3, 1)').steps, ['MACRO(1, "a,b")', 'SETVALUEBYID(3, 1)']);
  assert.deepEqual(codes(lintMacro('MACRO(1, "(x"), SETVALUEBYID(3, 1)', ctx)), ['W_MACRO_SPLIT_NEEDS_DEPLOY']);
  const ok = lintMacro('LLMQUERY(1, CONCATENATE("摘要：", A3), "nemotron35"), MACRO(3, 1 + 1), SETVALUEBYID(3, 2)', ctx);
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
  assert.deepEqual(codes(lintMacro('LLMQUERY(1, "x", A2)', ctx)), ['W_LLM_MODEL_GATEWAY_ONLY'], '模型取自欄位預設值 nemotron35');
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", A4)', ctx)).includes('E_LLM_MODEL_UNKNOWN'), '欄位預設值 gpt4 不在清單');
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", "tw")', { ...ctx, policy: { llm_models: ['', 'nemotron35'] } })).includes('E_LLM_MODEL_POLICY'));
  assert.ok(codes(lintMacro('LLMvision(2, "看圖", "gemma3")', ctx)).includes('E_MACRO_TARGET_TYPE'), 'LLMvision 只能寫入 textarea');
  assert.ok(codes(lintMacro('LLMvision(1, "看圖", "tw")', ctx)).includes('E_LLM_MODEL_UNKNOWN'), 'tw 不是影像模型');
  // Nemotron 3.5 Super VL（平台 20261124，只經 LlmGateway）：認得代號、提醒只經 Gateway
  for (const m of ['nemotron35', 'tnemotron35', 'tnemotron35-low', 'tnemotron35-medium', 'tnemotron35-high']) {
    assert.deepEqual(codes(lintMacro(`LLMQUERY(1, "x", "${m}")`, ctx)), ['W_LLM_MODEL_GATEWAY_ONLY'], m);
  }
  assert.deepEqual(codes(lintMacro('LLMvision(1, "看圖", "nemotron35")', ctx)).filter(c => c !== 'W_VISION_NO_FOLLOWUP'), ['W_LLM_MODEL_GATEWAY_ONLY']);
  assert.ok(codes(lintMacro('LLMvision(1, "看圖", "tnemotron35")', ctx)).includes('E_LLM_MODEL_UNKNOWN'), 'LLMvision 沒有思考版');
  const gwNemo = [{ id: 'Nemotron-3.5-Super-VL', status: 'active', vision: true }];
  assert.deepEqual(codes(lintMacro('LLMQUERY(1, "x", "tnemotron35")', { ...ctx, policy: { gateway_models: gwNemo } })), ['W_LLM_MODEL_GATEWAY_ONLY']);
  assert.ok(codes(lintMacro('LLMvision(1, "看圖", "nemotron35")', { ...ctx, policy: { gateway_models: [{ id: 'gemma3:12b' }] } })).includes('E_LLM_MODEL_NOT_ON_GATEWAY'));
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
  const gwOnly = ['W_LLM_MODEL_GATEWAY_ONLY'];
  assert.deepEqual(codes(lintMacro('LLMQUERY(1, "x", "nemotron35")', ctx)), gwOnly, '沒有欄位參照不檢查');
  assert.deepEqual(codes(lintMacro('LLMQUERY(1, IF(LEN(A3) < 10, "not available", CONCATENATE("Only based on the records below, answer only: ", A3)), "nemotron35")', ctx)), gwOnly);
  assert.ok(codes(lintMacro('LLMQUERY(1, CONCATENATE("只根據下列紀錄，無資料回 not available：", A3), "nemotron35")', ctx)).includes('W_PROMPT_NO_GUARD'));
  assert.ok(!codes(lintMacro('LLMQUERY(1, CONCATENATE("只根據下列紀錄，無資料回 not available：", A3), "nemotron35")', ctx)).includes('W_PROMPT_NO_SCOPE'));
  assert.ok(codes(lintMacro('LLMQUERY(1, IF(LEN(A3) < 10, "x", CONCATENATE("摘要：", A3)), "nemotron35")', ctx)).includes('W_PROMPT_NO_SCOPE'));
  assert.ok(codes(lintMacro('LLMQUERY(1, CONCATENATE("摘要：", GETTEXT()), "nemotron35")', ctx)).includes('W_PROMPT_NO_GUARD'), 'GETTEXT 也算帶入資料');
  // LLMvision 之後沒有 LLMQUERY 接力
  assert.ok(codes(lintMacro('LLMvision(1, "只描述影像所見", "gemma3_12b")', ctx)).includes('W_VISION_NO_FOLLOWUP'));
  assert.ok(!codes(lintMacro('LLMvision(1, "只描述影像所見", "gemma3_12b"), LLMQUERY(1, IF(LEN(A1) < 10, "not available", CONCATENATE("只根據下列描述整理，只提供答案：", A1)), "nemotron35")', ctx)).includes('W_VISION_NO_FOLLOWUP'));
  // AI 資料流要列出整份報告與識別資料，不能只列 A<n>
  const bulk = lintMacro('LLMQUERY(1, CONCATENATE("摘要：", A3, GETTEXT()), "nemotron35")', ctx);
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
    action_script: `LLMQUERY(${note}, CONCATENATE("BMI=", A${bmi}, "；請用一句話摘要"), "nemotron35"), MACRO(${note}, CONCATENATE(A${note}, "（AI 產生，請查核）"))` });
  assert.ok(btn.ai.length === 1 && btn.ai[0].model === 'nemotron35');
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
  assert.match(man, /nemotron35/);
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

test('form_preview html writes the runtime data under .strucmed/preview; url comes from the harness, open works from anywhere', () => {
  const { draft_id } = t.form_create({ name: '預覽', dept_no: 'TEST0' });
  const { area_itemid: a } = t.form_add_area({ draft_id });
  t.form_add_control({ draft_id, area_itemid: a, label_text: 'x', control: { datatype: 'textbox' } });
  const r = t.form_preview({ draft_id, format: 'html' });
  assert.equal(r.url, null, '沒有 harness 的 server.json 時不猜埠');
  assert.ok(r.open.includes('scripts/preview.mjs') && r.open.includes(draft_id) && r.open.includes(`--workspace "${ws}"`), r.open);
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

// 巨集步驟與參數切分看引號：與平台 extractPiplineSteps 20261124b 相同（kunjulin/strucmed#264 的 tests/web-js/macro-args.test.mjs 同一組例子）
test('macro split: quotes protect commas and parentheses, same as the platform runtime', () => {
  const split = s => platformSplit(s).steps;
  assert.deepEqual(split('21, "read the numbers, and (if any) summarize", "gemma3_12b"'), ['21', '"read the numbers, and (if any) summarize"', '"gemma3_12b"']);
  assert.deepEqual(split("6, 'a, b', 'm'"), ['6', "'a, b'", "'m'"]);
  assert.deepEqual(split('"LLMQUERY(6, "x", "m")", "MACRO(7, 1)"'), ['"LLMQUERY(6, "x", "m")"', '"MACRO(7, 1)"'], '舊式以引號包住的步驟照樣切成兩步');
  assert.deepEqual(split(`"LLMQUERY(6, 'x, y', A2)", "MACRO(7, 1)"`), [`"LLMQUERY(6, 'x, y', A2)"`, '"MACRO(7, 1)"'], '舊式步驟內的單引號字串可以有逗號');
  assert.deepEqual(split('LLMQUERY(6, CONCATENATE("a, b", A2), "m"), MACRO(7, 1)'), ['LLMQUERY(6, CONCATENATE("a, b", A2), "m")', 'MACRO(7, 1)']);
  assert.deepEqual(split(`6, "patient's note, today", "m"`), ['6', `"patient's note, today"`, '"m"'], '雙引號字串內的單引號不算');
  assert.deepEqual(split('6, "say ""hi"", ok", "m"'), ['6', '"say ""hi"", ok"', '"m"'], '"" 是結束後立刻再開始，自然留在同一段');
  assert.deepEqual(split('6, "a \\"b, c", "m"'), ['6', '"a \\"b', 'c", "m"'], 'runtime 不認反斜線跳脫');
  assert.equal(platformSplit('LLMQUERY(6, "x').unterminated, true);
  // 舊版 runtime 的切法（只算括號）
  assert.deepEqual(legacySplit('6, "a, b", "m"').steps, ['6', '"a', 'b"', '"m"']);
});

test('macro lint: prompts may contain commas and parentheses inside quotes', () => {
  const controls = new Map([['21', { datatype: 'textarea', tocalc: true }], ['6', { datatype: 'textarea', tocalc: true }],
    ['7', { datatype: 'textbox', tocalc: true }], ['2', { datatype: 'textbox', tocalc: true, datavalue: 'nemotron35' }],
    ['12', { datatype: 'attachbox', tocalc: false }], ['13', { datatype: 'attachbox', tocalc: false }]]);
  const ctx = { controls };
  const errors = r => r.findings.filter(f => f.level === 'error').map(f => `${f.code} ${f.message}`);
  const deployed = { ...ctx, policy: { runtime_quote_aware_split: true } };
  // 只看切分相關的結果（提示詞設計的建議、LLMvision 接力另有測試）
  const codes = r => r.findings.map(f => f.code).filter(c => !/^W_PROMPT_|^W_VISION_NO_FOLLOWUP$|^W_LLM_MODEL_GATEWAY_ONLY$/.test(c));

  // 使用者回報的案例：原本回 E_FORMULA_SYNTAX（第 2 個參數字串沒有結束的引號）
  const vision = lintMacro('LLMvision(21, "a, b", "gemma3_12b"), LLMQUERY(6, CONCATENATE("整理, 摘要：", A21), "nemotron35")', ctx);
  assert.deepEqual(errors(vision), []);
  assert.deepEqual(codes(vision), ['W_MACRO_SPLIT_NEEDS_DEPLOY'], 'HIS 端還是舊版時提醒一次');
  assert.equal(vision.ai[0].model, 'gemma3_12b', '模型是第 3 個參數，沒有被逗號擠掉');
  assert.deepEqual(vision.ai[1].inputs, ['21']);
  assert.deepEqual(codes(lintMacro('LLMvision(21, "a, b", "gemma3_12b"), LLMQUERY(6, "x", "nemotron35")', deployed)), [], '部署後在 policy 關閉提醒');

  // 含括號的提示詞
  assert.deepEqual(codes(lintMacro('LLMQUERY(6, "1) list, 2) summarize (short)", "nemotron35")', deployed)), []);
  assert.deepEqual(codes(lintMacro('LLMvision(21, "read the numbers, and (if any) summarize", "gemma3_12b"), LLMQUERY(6, A21, "nemotron35")', deployed)), []);
  // LLMATTACH：提示詞的逗號不切開，"12,13" 是一個參數
  const attach = lintMacro('LLMATTACH(6, "summary, (short)", "gemma3_12b", "12,13")', { ...deployed, attachBox: true });
  assert.deepEqual(errors(attach), []);
  assert.deepEqual(attach.ai[0].attachments.map(b => b.itemid), [12, 13]);

  // 舊式以引號包住的步驟
  const old = lintMacro('"LLMQUERY(6, "x", "nemotron35")", "MACRO(7, 1)"', deployed);
  assert.deepEqual(codes(old), ['W_MACRO_QUOTED_STEP', 'W_MACRO_QUOTED_STEP']);
  assert.deepEqual(old.targets.sort(), ['6', '7']);
  assert.deepEqual(codes(lintMacro(`"LLMQUERY(6, 'x, y', A2)", "MACRO(7, 1)"`, deployed)), ['W_MACRO_QUOTED_STEP', 'W_MACRO_QUOTED_STEP']);
  assert.ok(codes(lintMacro(`"LLMQUERY(6, 'x, y', A2)", "MACRO(7, 1)"`, ctx)).includes('W_MACRO_SPLIT_NEEDS_DEPLOY'), '舊版 runtime 會切開步驟內的參數');
  // 舊式步驟裡又用同一種引號的字串，字串內的逗號落在引號外 → runtime 切錯
  assert.ok(codes(lintMacro('"MACRO(7, "a, b")"', deployed)).includes('E_MACRO_SPLIT'));

  // 雙引號內的單引號
  assert.deepEqual(codes(lintMacro(`LLMQUERY(6, "patient's note, today", "nemotron35")`, deployed)), []);
  assert.deepEqual(codes(lintMacro(`LLMQUERY(6, '他說"好", 然後離開', "nemotron35")`, deployed)), []);

  // "" 跳脫：runtime 切分留在同一個參數（不再是「沒有結束的引號」），但 Calx 不支援 → 語法錯誤並說明
  const esc = lintMacro('LLMQUERY(6, "say ""hi"", ok", "nemotron35")', deployed);
  assert.deepEqual(codes(esc), ['E_FORMULA_SYNTAX']);
  assert.match(esc.findings[0].message, /第 2 個參數/);
  assert.match(esc.findings[0].message, /不支援 "" 跳脫/);
  // \" 跳脫：Calx 認、runtime 切分不認 → 切法不同
  assert.ok(codes(lintMacro('LLMQUERY(6, "a \\"b, c\\" d", "nemotron35")', deployed)).includes('E_MACRO_SPLIT'));
  // 未結束的引號
  assert.ok(codes(lintMacro('LLMQUERY(6, "x, "nemotron35")', deployed)).includes('E_MACRO_SYNTAX'));
});

// ── 落日模型（qwen 系列，calx-catalog.mjs LLM_SUNSET；院方決定 2026-11-19）──
test('sunset models: qwen is recognised, not suggested; E_LLM_MODEL_SUNSET before the date, E_LLM_MODEL_DEPRECATED after', async () => {
  const { LLM_SUNSET, sunsetModel, sunsetPassed, LLM_MODELS, LLM_ALIASES } = await import('../src/calx-catalog.mjs');
  assert.equal(LLM_SUNSET.date, '2027-01-01');
  assert.equal(sunsetPassed('2026-12-31T23:59:59+08:00'), false);
  assert.equal(sunsetPassed('2027-01-01T00:00:00+08:00'), true);
  // 每個 qwen 別名都在落日表、都有 nemotron35 系列的替代寫法；替代寫法本身不是落日模型
  const qwen = Object.keys(LLM_MODELS).filter(k => /qwen/.test(k));
  assert.equal(qwen.length, 7);
  for (const k of qwen) {
    assert.match(sunsetModel(k).replacement, /^t?nemotron35(-low|-medium|-high)?$/, k);
    assert.equal(/^t/.test(k), /^t/.test(sunsetModel(k).replacement), `${k}：思考對思考、不思考對不思考`);
    assert.ok(sunsetModel(k).replacement in LLM_MODELS && !sunsetModel(sunsetModel(k).replacement));
  }
  for (const k of Object.keys(LLM_MODELS).filter(k => !/qwen/.test(k))) assert.equal(sunsetModel(k), null, k);
  assert.ok(sunsetModel('Qwen3.6:27B') && sunsetModel('QWEN3:32B'), '閘道 id 也認得');

  const controls = new Map([['1', { datatype: 'textarea', tocalc: true }], ['2', { datatype: 'textbox', tocalc: true, datavalue: 'qwen332b' }],
    ['12', { datatype: 'attachbox', tocalc: false }]]);
  const before = { controls, policy: { now: '2026-11-19T09:00:00+08:00' } };
  const after = { controls, policy: { now: '2027-01-01T00:00:00+08:00' } };
  const find = (r, code) => r.findings.find(f => f.code === code);
  const expected = { qwen3627b: 'nemotron35', qwen332b: 'nemotron35', tqwen3627b: 'tnemotron35', 'tqwen3627b-low': 'tnemotron35-low',
    'tqwen3627b-medium': 'tnemotron35-medium', 'tqwen3627b-high': 'tnemotron35-high', tqwen332b: 'tnemotron35' };
  for (const [m, to] of Object.entries(expected)) {
    const r = lintMacro(`LLMQUERY(1, "x", "${m}")`, before);
    const f = find(r, 'E_LLM_MODEL_SUNSET');
    assert.ok(f && f.level === 'error' && f.replacement === to, m);
    assert.match(f.message, /2027-01-01 自 LlmGateway 下架，院方建議不採用/);
    assert.ok(f.message.includes(`"${to}"`) && /只經院內 LlmGateway/.test(f.message), '附替代寫法與 Gateway 前提');
    assert.ok(!codes(r).includes('E_LLM_MODEL_UNKNOWN'), `${m} 仍是已知模型`);
    assert.equal(r.ai[0].model, m, 'AI 資料流照實列出');
    const late = lintMacro(`LLMQUERY(1, "x", "${m}")`, after);
    assert.ok(!codes(late).includes('E_LLM_MODEL_SUNSET'));
    assert.match(find(late, 'E_LLM_MODEL_DEPRECATED').message, /已於 2027-01-01 自 LlmGateway 下架/);
    assert.equal(find(late, 'E_LLM_MODEL_DEPRECATED').replacement, to);
  }
  // 舊別名（導向 qwen332b）、欄位預設值、大小寫、LLMATTACH 直接寫閘道 id
  assert.deepEqual(codes(lintMacro('LLMQUERY(1, "x", "70b")', before)).sort(), ['E_LLM_MODEL_SUNSET', 'W_LLM_MODEL_ALIAS']);
  assert.equal(LLM_ALIASES['gpt-oss-120b'], 'tqwen332b');
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", "gpt-oss-120b")', before)).includes('E_LLM_MODEL_SUNSET'));
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", A2)', before)).includes('E_LLM_MODEL_SUNSET'), '模型取自欄位預設值 qwen332b');
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", "QWEN3627B")', before)).includes('E_LLM_MODEL_SUNSET'));
  const attach = lintMacro('LLMATTACH(1, "x", "Qwen3.6:27B", "12")', before);
  assert.ok(codes(attach).includes('E_LLM_MODEL_SUNSET') && codes(attach).includes('W_LLM_MODEL_PASSTHROUGH'));
  // 還在閘道上（status 正常）也照樣回報；沒有 policy.now 時用現在時間
  assert.ok(codes(lintMacro('LLMQUERY(1, "x", "qwen3627b")', { controls, policy: { now: before.policy.now, gateway_models: [{ id: 'Qwen3.6:27B', status: '' }] } })).includes('E_LLM_MODEL_SUNSET'));
  const today = codes(lintMacro('LLMQUERY(1, "x", "qwen332b")', { controls }));
  assert.ok(today.includes(sunsetPassed() ? 'E_LLM_MODEL_DEPRECATED' : 'E_LLM_MODEL_SUNSET'));
  // 未知模型的「可用」清單不再列出 qwen
  const unknown = find(lintMacro('LLMQUERY(1, "x", "gpt4")', before), 'E_LLM_MODEL_UNKNOWN');
  assert.ok(!/qwen/i.test(unknown.message) && /nemotron35/.test(unknown.message), unknown.message);
  // 替代寫法只多一個既有的 Gateway 提醒
  assert.deepEqual(codes(lintMacro('LLMQUERY(1, "x", "tnemotron35-low")', before)), ['W_LLM_MODEL_GATEWAY_ONLY']);
});

test('sunset models: new or modified macros are rejected; untouched imported macros only warn (W_LLM_MODEL_SUNSET)', () => {
  // 新表單：寫入當下就拒絕
  const { draft_id } = t.form_create({ name: '落日新表單', dept_no: 'TEST0' });
  const { area_itemid: a } = t.form_add_area({ draft_id });
  const note = t.form_add_control({ draft_id, area_itemid: a, label_text: '摘要：', control: { datatype: 'textarea' } }).itemid;
  const script = m => `LLMQUERY(${note}, "請用一句話說明代謝症候群", "${m}")`;
  assert.throws(() => t.form_add_control({ draft_id, area_itemid: a, label_text: '', control: { datatype: 'action', action_name: '問', action_id: 0, action_script: script('qwen3627b') } }),
    e => e.code === 'E_INVALID_INPUT' && e.details.errors.some(x => x.code === 'E_LLM_MODEL_SUNSET' && x.replacement === 'nemotron35'));
  const btn = t.form_add_control({ draft_id, area_itemid: a, label_text: '', control: { datatype: 'action', action_name: '問', action_id: 0, action_script: script('nemotron35') } });
  assert.ok(btn.script_warnings.some(w => w.startsWith('W_LLM_MODEL_GATEWAY_ONLY')), '替代模型提醒只經 Gateway');
  assert.throws(() => t.form_update_control({ draft_id, itemid: btn.itemid, changes: { action_script: script('tqwen332b') } }),
    e => e.details.errors.some(x => x.code === 'E_LLM_MODEL_SUNSET' && x.replacement === 'tnemotron35'));

  // 改版既有表單：原表單的 qwen 巨集沒動到 → 只有 W_LLM_MODEL_SUNSET；動到就要一併換掉
  const text = JSON.stringify(model.toFormJson(store.loadDraft(draft_id), 'strucmed-skill test'));
  assert.ok(text.includes('nemotron35'));
  fs.writeFileSync(path.join(ws, 'qwen-src.json'), text.replaceAll('nemotron35', 'qwen3627b'));
  const imp = t.form_import({ source_path: 'qwen-src.json', name: '落日改版', dept_no: 'TEST0' });
  let old = null;
  const find = v => { if (!v || typeof v !== 'object') return; if (v.datatype === 'action' && /qwen3627b/.test(v.actionScript || '')) old = v; Object.values(v).forEach(find); };
  find(store.loadDraft(imp.draft_id).areas);
  assert.ok(old, '匯入的表單保留 qwen 巨集');
  const oldId = Number(old.itemid);
  const v = t.form_validate({ draft_id: imp.draft_id });
  assert.ok(!v.errors.some(e => /LLM_MODEL/.test(e.code)), JSON.stringify(v.errors));
  const w = v.warnings.find(x => x.code === 'W_LLM_MODEL_SUNSET');
  assert.ok(w && w.itemid === oldId && /"nemotron35"/.test(w.message) && /原表單既有/.test(w.message), JSON.stringify(v.warnings));
  assert.throws(() => t.form_update_control({ draft_id: imp.draft_id, itemid: oldId, changes: { action_name: '問 AI' } }),
    e => e.details.errors.some(x => x.code === 'E_LLM_MODEL_SUNSET'), '改到這顆巨集就要換模型');
  const fixed = t.form_update_control({ draft_id: imp.draft_id, itemid: oldId, changes: { action_name: '問 AI', action_script: script('nemotron35') } });
  assert.ok(fixed);
  const v2 = t.form_validate({ draft_id: imp.draft_id });
  assert.ok(![...v2.errors, ...v2.warnings].some(x => /LLM_MODEL_SUNSET/.test(x.code)));
});
