// 表單 JS 增益集：白名單片段（docs/13 D1／D2／D4）。flag 關／開、七種樣板的渲染、參數檢查、CUSTOMFUNC 受控放行、禁用 token 掃描、匯出、雜湊比對。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../src/server.mjs');
let ws, flagsFile, t, store, model, snip;

const setFlag = on => fs.writeFileSync(flagsFile, JSON.stringify({ formScript: on }));
const setFlags = o => fs.writeFileSync(flagsFile, JSON.stringify(o));
const errOf = fn => { try { fn(); } catch (e) { return e; } assert.fail('應該拋錯'); };

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-script-'));
  process.env.STRUCMED_WORKSPACE = ws;
  flagsFile = path.join(ws, 'flags.json');
  process.env.STRUCMED_FLAGS = flagsFile;
  setFlag(true);
  t = Object.fromEntries((await import('../src/tools.mjs')).TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  model = await import('../src/model.mjs');
  snip = await import('../src/script-snippets.mjs');
});
after(() => { delete process.env.STRUCMED_FLAGS; fs.rmSync(ws, { recursive: true, force: true }); });

// 身高／體重／BMI 的小表單：區塊 1（#2 身高、#3 體重）、區塊 4（#5 BMI 計算式）、formtable 6
function form() {
  const { draft_id } = t.form_create({ name: '片段測試', dept_no: 'TEST0' });
  const a1 = t.form_add_area({ draft_id, title: '測量' }).area_itemid;
  const h = t.form_add_control({ draft_id, area_itemid: a1, label_text: '身高：', control: { datatype: 'numberbox' } }).itemid;
  const w = t.form_add_control({ draft_id, area_itemid: a1, label_text: '體重：', control: { datatype: 'numberbox' } }).itemid;
  const a2 = t.form_add_area({ draft_id, title: '結果' }).area_itemid;
  const bmi = t.form_add_control({ draft_id, area_itemid: a2, label_text: 'BMI：', control: { datatype: 'label' } }).itemid;
  t.form_update_control({ draft_id, itemid: bmi, changes: { label_format: 'formula', formula: `ROUND(A${w} / (A${h} / 100) ^ 2, 1)` } });
  const tb = t.form_add_area({ draft_id, type: 'formtable' }).area_itemid;
  return { draft_id, a1, a2, h, w, bmi, tb };
}
const js = draft_id => model.toFormJson(store.loadDraft(draft_id), 'strucmed-skill v9 test').find(x => x.itemtype === 'javascript').content;

test('flag 關：工具不列出、呼叫回 E_FEATURE_DISABLED；flag 開：列出', async () => {
  const { draft_id } = form();
  setFlag(false);
  assert.equal(errOf(() => t.form_set_script({ draft_id, snippets: [] })).code, 'E_FEATURE_DISABLED');
  assert.equal(errOf(() => t.form_script_preview({ draft_id })).code, 'E_FEATURE_DISABLED');
  const list = async () => {
    const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, STRUCMED_SITE: 'offline' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const rl = readline.createInterface({ input: proc.stdout });
    const got = new Promise(res => rl.on('line', l => { const m = JSON.parse(l); if (m.id === 2) res(m.result.tools.map(x => x.name)); }));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    const names = await got; proc.kill(); return names;
  };
  assert.ok(!(await list()).includes('form_set_script'), 'flag 關不列出');
  setFlag(true);
  assert.ok((await list()).includes('form_set_script'), 'flag 開列出');
});

test('S1 style：主題＋規則渲染成一個 <style>，控制項層級加 !important；JS 區塊有標記與片段清單', () => {
  const { draft_id, a1, h, tb } = form();
  assert.equal(js(draft_id).split('\n').length, 1, '沒有片段時只有標記行');
  const r = t.form_set_script({ draft_id, snippets: [{ id: 'look', template: 'style', params: { theme: 'clean', rules: [
    { scope: `area:${a1}`, css: { 'background-color': '#fff8d6', 'border-left': '4px solid #d9a300', padding: '4px 8px' } },
    { scope: `control:${h}`, css: { 'font-size': '18px', 'font-weight': 'bold', width: '6em' } },
    { scope: `area:${tb} table`, css: { border: '1px solid lightgray' } },
    { scope: 'form', css: { margin: '0 auto' } } ] } }] });
  assert.equal(r.snippets.length, 1);
  assert.equal(r.snippets[0].template, 'style');
  assert.deepEqual(r.snippets[0].affects.sort(), [a1, h, tb].sort());
  assert.match(r.rendered, /function sm_style_add\(css\)/);
  assert.match(r.rendered, /\.area\{margin-bottom:12px/, '主題 CSS');
  assert.match(r.rendered, new RegExp(`\\.area\\[itemid='${a1}'\\]\\{background-color:#fff8d6;border-left:4px solid #d9a300;padding:4px 8px\\}`));
  assert.match(r.rendered, new RegExp(`\\[itemid='${h}'\\]\\{font-size:18px !important;font-weight:bold;width:6em\\}`), '控制項的 font-size 加 !important，width 不加');
  assert.match(r.rendered, new RegExp(`\\.area\\[itemid='${tb}'\\] table td\\{border:1px solid lightgray\\}`));
  assert.match(r.rendered, /\.body-content\{margin:0 auto\}/);
  assert.doesNotThrow(() => new Function(r.rendered), '渲染後的 JS 可解析');
  const content = js(draft_id);
  assert.match(content, /^\/\/ generated-by: strucmed-skill v9 test\n\/\/ strucmed-skill snippets=\[style#look\] sha256=[0-9a-f]{12}\n/);
  assert.ok(content.includes(r.rendered));
  const p = t.form_script_preview({ draft_id });
  assert.equal(p.rendered, r.rendered);
  assert.equal(p.sha256, r.sha256);
  assert.deepEqual(p.findings, []);
  assert.ok(p.themes.some(x => x.id === 'zebra-table'));
  const v = t.form_validate({ draft_id });
  assert.equal(v.valid, true);
  assert.ok(v.warnings.some(w => w.code === 'W_FORM_SCRIPT' && w.message.includes('style#look')));
  assert.equal(v.stats.snippets, 1);
});

test('S1 style：參數錯誤一律拒絕且不改 draft（屬性、值、scope、不存在的區塊、url(）', () => {
  const { draft_id, a1 } = form();
  const bad = (params, code, re) => {
    const e = errOf(() => t.form_set_script({ draft_id, snippets: [{ template: 'style', params }] }));
    assert.equal(e.code, 'E_INVALID_INPUT');
    assert.ok(e.details.errors.some(x => x.code === code && re.test(x.message)), JSON.stringify(e.details.errors));
    assert.equal(store.loadDraft(draft_id).script, undefined, 'draft 沒有被改');
  };
  bad({ rules: [{ scope: 'form', css: { display: 'none' } }] }, 'E_INVALID_INPUT', /不接受屬性「display」/);
  bad({ rules: [{ scope: 'form', css: { background: 'url(http://x/y.png)' } }] }, 'E_INVALID_INPUT', /不在白名單/);
  bad({ rules: [{ scope: 'form', css: { color: 'red; position:fixed' } }] }, 'E_INVALID_INPUT', /不在白名單/);
  bad({ rules: [{ scope: 'form', css: { width: 'expression(alert(1))' } }] }, 'E_INVALID_INPUT', /不在白名單/);
  bad({ rules: [{ scope: '.area', css: { color: 'red' } }] }, 'E_INVALID_INPUT', /scope 必須是/);
  bad({ rules: [{ scope: 'area:99', css: { color: 'red' } }] }, 'E_REF_BROKEN', /區塊 #99 不存在/);
  bad({ rules: [{ scope: `control:${a1}`, css: { color: 'red' } }] }, 'E_REF_BROKEN', /控制項 #1 不存在/);
  bad({ theme: 'dark' }, 'E_INVALID_INPUT', /theme 必須是/);
  bad({}, 'E_INVALID_INPUT', /至少要有一個/);
  bad({ theme: 'clean', extra: 1 }, 'E_INVALID_INPUT', /不認識 extra/);
  const e = errOf(() => t.form_set_script({ draft_id, snippets: [{ template: 'css', params: {} }] }));
  assert.ok(e.details.errors.some(x => /template 必須是/.test(x.message)));
});

test('S4 guard：渲染成事件綁定＋載入後執行一次；條件經 lint；訊息字元受限', () => {
  const { draft_id, h, w, bmi } = form();
  const r = t.form_set_script({ draft_id, snippets: [{ id: 'bmi-high', template: 'guard', params: {
    sources: [h, w], condition: `AND(A${h} > 0, A${w} > 0, A${w} / (A${h} / 100) ^ 2 > 35)`, message: 'BMI 超過 35，請確認身高體重', highlight: [h, w] } }] });
  assert.equal(r.snippets[0].template, 'guard');
  assert.deepEqual(r.snippets[0].affects.sort(), [h, w].sort());
  assert.match(r.rendered, /\.sm-guard\{background-color:#ffd8d8 !important/, 'guard 的樣式');
  assert.match(r.rendered, /function sm_guard_bmi_high\(\)/);
  assert.match(r.rendered, new RegExp(`\\$\\(targetid\\)\\.calx\\('evaluate', "AND\\(A${h} > 0`));
  assert.match(r.rendered, /errormessage\("BMI 超過 35，請確認身高體重"\)/);
  assert.match(r.rendered, new RegExp(`\\$\\(document\\)\\.on\\('keyup change blur', "\\[itemid='${h}'\\],\\[itemid='${w}'\\]"`));
  assert.match(r.rendered, /toggleClass\('sm-guard', hit\)/);
  assert.match(r.rendered, /if \(hit && !sm_guard_bmi_high_last\) errormessage/, '只在狀態變成有問題時提示一次');
  assert.match(r.rendered, /clearTimeout\(sm_guard_bmi_high_t\)/, '事件去抖');
  assert.match(r.rendered, /ck_getDocDone === true/);
  assert.match(r.rendered, /ck_hasPatient === false && n <= 58/, '沒有病人（預覽）時 1 秒後執行');
  assert.doesNotThrow(() => new Function(r.rendered));
  assert.deepEqual(snip.scanTokens(r.rendered), []);
  assert.ok(t.form_validate({ draft_id }).valid);

  const bad = (params, code, re) => {
    const e = errOf(() => t.form_set_script({ draft_id, snippets: [{ template: 'guard', params }] }));
    assert.ok(e.details.errors.some(x => x.code === code && re.test(x.message)), JSON.stringify(e.details.errors));
  };
  bad({ sources: [h], condition: 'A99 > 1', message: 'x' }, 'E_REF_BROKEN', /A99 不存在/);
  bad({ sources: [99], condition: `A${h} > 1`, message: 'x' }, 'E_REF_BROKEN', /sources 的 #99/);
  bad({ sources: [h], condition: `LLMQUERY("gpt", A${h})`, message: 'x' }, 'E_FORMULA_REPLACED', /LLMQUERY/);
  bad({ sources: [h], condition: `SETVALUEBYID(${bmi}, 1)`, message: 'x' }, 'E_FORMULA_MACRO_ONLY', /巨集專用/);
  bad({ sources: [h], condition: `OPENURL("http://x")`, message: 'x' }, 'E_FORBIDDEN_FUNCTION', /OPENURL/);
  bad({ sources: [h], condition: `A${h} > 1`, message: '<script>alert(1)</script>' }, 'E_INVALID_INPUT', /message 含不接受的字元/);
  bad({ sources: [h], condition: `A${h} > 1`, message: '請改 ck_LLMapiUrl' }, 'E_INVALID_INPUT', /message 含不接受的字/);
  bad({ sources: [h], condition: `A${h} > 1`, message: '' }, 'E_INVALID_INPUT', /message 必填/);
  bad({ sources: [h], condition: `A${h} > 1` }, 'E_INVALID_INPUT', /message 必填/);
  // 原本的片段還在
  assert.equal(t.form_script_preview({ draft_id }).snippets[0].id, 'bmi-high');
});

test('禁用 token 掃描：每一類都擋，字串字面值與註解不算', () => {
  const hit = s => snip.scanTokens(s).map(f => f.message);
  for (const code of ['$.ajax({})', 'fetch("/x")', 'new XMLHttpRequest()', 'window.open("x")', 'var a = location.href', 'boundAsync.x()',
    'var t = IOTjson.chtno', 'S_USERID()', 'ck_LLMapiUrl = "http://evil"', 'ck_AUTOupload += 1', 'SaveDoc()', 'LoadDoc(1)', 'HISquery("x")', 'LLMquery()',
    'GetValueAll()', 'SetValue(1)', 'PanelAdd()', 'RenderData(x)', 'eval("1")', 'new Function("1")', 'setTimeout("x()", 1)', 'el.innerHTML = 1', 'window["eval"]',
    'String.fromCharCode(1)', 'atob("x")', 'var s = "\\x41"', 'localStorage.x', 'document.cookie'])
    assert.ok(hit(code).length, `應擋下：${code}`);
  assert.deepEqual(hit("var s = 'fetch(1) location'; // $.ajax\n/* eval( */ SetValueByID(1, 2); ck_getDocDone === true; errormessage(s)"), [], '字串、註解與允許的函數不算');
  assert.equal(snip.stripLiterals(`a("x\\"y") + 'z'`), 'a("") + ""');
});

test('片段參照的控制項：form_remove_control 阻擋；直接改 draft 刪掉後 form_validate 回 E_REF_BROKEN；清除片段後 JS 區塊只剩標記', () => {
  const { draft_id, a1, h } = form();
  const x = t.form_add_control({ draft_id, area_itemid: a1, label_text: '腰圍：', control: { datatype: 'numberbox' } }).itemid;
  const a3 = t.form_add_area({ draft_id, title: '空區塊' }).area_itemid;
  t.form_set_script({ draft_id, snippets: [{ template: 'guard', params: { sources: [h, x], condition: `A${x} > 200`, message: '腰圍超過 200' } },
    { template: 'style', params: { rules: [{ scope: `area:${a3}`, css: { 'background-color': 'lightblue' } }] } }] });
  const e = errOf(() => t.form_remove_control({ draft_id, itemid: x }));
  assert.equal(e.code, 'E_REF_BROKEN');
  assert.deepEqual(e.details.blockers, [{ target: x, from: 'snippet:s1', kind: 'snippet:guard' }]);
  const ea = errOf(() => t.form_remove_area({ draft_id, itemid: a3 }));
  assert.equal(ea.code, 'E_REF_BROKEN');
  assert.deepEqual(ea.details.blockers, [{ from: 'snippet:s2', kind: 'snippet:style' }]);
  // 繞過工具直接拿掉控制項（例如舊版 draft）：驗證仍抓得到
  const d = store.loadDraft(draft_id);
  const area = d.areas.find(a => Number(a.itemid) === a1);
  area.items = area.items.filter(n => Number(n.itemid) !== x);
  store.saveDraft(d);
  const v = t.form_validate({ draft_id });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => e.code === 'E_REF_BROKEN' && e.message.includes(`#${x}`)));
  t.form_set_script({ draft_id, snippets: [] });
  assert.equal(store.loadDraft(draft_id).script, undefined);
  assert.equal(js(draft_id).split('\n').length, 1);
  assert.ok(t.form_validate({ draft_id }).valid);
});

test('flag 事後關閉：form_validate 回錯誤、form_export 拒絕；flag 開時匯出計畫與 manifest 原樣列出 JS', () => {
  const { draft_id, a1 } = form();
  t.form_set_script({ draft_id, snippets: [{ template: 'style', params: { rules: [{ scope: `area:${a1}`, css: { 'background-color': 'lightyellow' } }] } }] });
  setFlag(false);
  const v = t.form_validate({ draft_id });
  assert.ok(v.errors.some(e => e.code === 'E_FEATURE_DISABLED'));
  assert.equal(errOf(() => t.form_export({ draft_id })).code, 'E_INVALID_INPUT');
  setFlag(true);
  const p = t.form_export({ draft_id });
  assert.deepEqual(p.plan.script.snippets, ['style#s1：樣式：1 條規則']);
  assert.match(p.plan.script.rendered, /background-color:lightyellow/);
  const out = t.form_export({ draft_id, confirm_token: p.confirm_token });
  const manifest = fs.readFileSync(path.join(ws, out.files.manifest), 'utf8');
  assert.match(manifest, /## 表單 JS（白名單片段，1 個，sha256 [0-9a-f]{12}）/);
  assert.match(manifest, /```js\n\/\/ snippet s1 \(style\)|```js\nfunction sm_style_add/);
  const htm = fs.readFileSync(path.join(ws, out.files.htm), 'utf8');
  assert.ok(htm.includes('sm_style_add'), '.htm 的 tempdata 含渲染後的 JS');
});

test('改版 draft：原表單 JS 在前、片段在後，標記行只有一行', () => {
  const { draft_id } = form();
  const src = model.toFormJson(store.loadDraft(draft_id), 'strucmed-skill v9 old');
  src.find(x => x.itemtype === 'javascript').content += '\nfunction keep() { return 1; }';
  fs.writeFileSync(path.join(ws, 'src.json'), JSON.stringify(src));
  const r = t.form_import({ source_path: 'src.json', name: '改版', dept_no: 'TEST0' });
  t.form_set_script({ draft_id: r.draft_id, snippets: [{ template: 'style', params: { theme: 'compact' } }] });
  const content = js(r.draft_id);
  const lines = content.split('\n');
  assert.equal(lines.filter(l => l.startsWith('// generated-by:')).length, 1);
  assert.ok(content.indexOf('function keep()') < content.indexOf('// strucmed-skill snippets=[style#s1]'));
});

// ── D2：S2 derive、S3 lookup、S5 required、CUSTOMFUNC 受控放行、W_CUSTOM_JS_FINDINGS ──

test('S2 derive：sources 改值或開文件後把運算式結果寫進非 label 欄位；目標不能是 label、自己或動態表格', () => {
  const { draft_id, a2, h, w, bmi } = form();
  const cat = t.form_add_control({ draft_id, area_itemid: a2, label_text: '分類：', control: { datatype: 'textbox' } }).itemid;
  const r = t.form_set_script({ draft_id, snippets: [{ id: 'bmi-cat', template: 'derive', params: {
    sources: [h, w], target: cat, expr: `IF(A${w} / (A${h} / 100) ^ 2 >= 27, "肥胖", "正常")`, when: 'both' } }] });
  assert.equal(r.snippets[0].template, 'derive');
  assert.deepEqual(r.snippets[0].affects.sort(), [h, w, cat].sort());
  assert.match(r.snippets[0].summary, /連動寫值：#.* 改值後與開文件時把 IF\(/);
  assert.match(r.rendered, /function sm_derive_bmi_cat\(\)/);
  assert.match(r.rendered, new RegExp(`if \\(String\\(v\\) !== String\\(cur === undefined \\|\\| cur === null \\? '' : cur\\)\\) SetValueByID\\(${cat}, v\\);`), '值沒變不寫');
  assert.match(r.rendered, new RegExp(`\\$\\(document\\)\\.on\\('keyup change blur', "\\[itemid='${h}'\\],\\[itemid='${w}'\\]"`));
  assert.match(r.rendered, /ck_getDocDone === true/);
  assert.doesNotThrow(() => new Function(r.rendered));
  assert.deepEqual(snip.scanTokens(r.rendered), []);
  assert.ok(t.form_validate({ draft_id }).valid);
  // when 預設 change：沒有載入後執行
  const r2 = t.form_set_script({ draft_id, snippets: [{ template: 'derive', params: { sources: [h], target: cat, expr: `A${h} * 2` } }] });
  assert.doesNotMatch(r2.rendered, /ck_getDocDone/);
  assert.match(r2.snippets[0].summary, /改值後把/);
  const bad = (params, code, re) => {
    const e = errOf(() => t.form_set_script({ draft_id, snippets: [{ template: 'derive', params }] }));
    assert.ok(e.details.errors.some(x => x.code === code && re.test(x.message)), JSON.stringify(e.details.errors));
  };
  bad({ sources: [h], target: bmi, expr: `A${h}` }, 'E_REF_TYPE', /是 label，不能用 SetValueByID/);
  bad({ sources: [h], target: h, expr: `A${w}` }, 'E_INVALID_INPUT', /不能同時在 sources/);
  bad({ sources: [w], target: cat, expr: `CONCATENATE(A${cat}, "x")` }, 'E_INVALID_INPUT', /參照了 target 自己/);
  bad({ sources: [w], target: cat, expr: `A${h}`, when: 'later' }, 'E_INVALID_INPUT', /when 必須是/);
  bad({ sources: [w], target: cat, expr: `HISQUERY("x")` }, 'E_FORMULA_MACRO_ONLY', /巨集專用/);
  bad({ sources: [w], target: 99, expr: `A${h}` }, 'E_REF_BROKEN', /target 的 #99/);
  const tb = t.form_add_area({ draft_id, type: 'table1', titles: ['藥名'] }).area_itemid;
  const inTable = t.form_add_control({ draft_id, area_itemid: tb, control: { datatype: 'textbox' }, cell: { index: 0 } }).itemid;
  bad({ sources: [w], target: inTable, expr: `A${h}` }, 'E_MACRO_TARGET_TABLE', /在動態表格內/);
});

test('S3 lookup：對照表渲染成 sm_<name>；trigger customfunc 時巨集的 CUSTOMFUNC("sm_<name>") 放行，其他名稱與非字面值拒絕', () => {
  const { draft_id, a1, a2, h } = form();
  const drug = t.form_add_control({ draft_id, area_itemid: a1, label_text: '藥名：', control: { datatype: 'textbox' } }).itemid;
  const dose = t.form_add_control({ draft_id, area_itemid: a2, label_text: '劑量：', control: { datatype: 'textbox' } }).itemid;
  const r = t.form_set_script({ draft_id, snippets: [{ id: 'dose', template: 'lookup', params: {
    name: 'drug_dose', source: drug, table: { Aspirin: '100mg (qd)', Metformin: '500mg', 'Vit D3': 2000 }, target: dose,
    miss: { message: '查無此藥的常用劑量', value: '' }, trigger: 'customfunc' } }] });
  assert.match(r.rendered, /function sm_drug_dose\(\)/);
  assert.match(r.rendered, /var t = \{"Aspirin":"100mg \(qd\)","Metformin":"500mg","Vit D3":"2000"\};/);
  assert.match(r.rendered, new RegExp(`if \\(Object\\.prototype\\.hasOwnProperty\\.call\\(t, k\\)\\) \\{ SetValueByID\\(${dose}, t\\[k\\]\\); return t\\[k\\]; \\}`));
  assert.match(r.rendered, new RegExp(`SetValueByID\\(${dose}, ""\\); errormessage\\("查無此藥的常用劑量"\\);`));
  assert.doesNotMatch(r.rendered, /\$\(document\)\.on/, 'customfunc 不綁事件');
  assert.match(r.snippets[0].summary, /巨集 CUSTOMFUNC\("sm_drug_dose"\)/);
  assert.doesNotThrow(() => new Function(r.rendered));
  assert.deepEqual(snip.scanTokens(r.rendered), []);
  assert.deepEqual(snip.scriptFunctions(store.loadDraft(draft_id)), ['sm_drug_dose']);
  // 巨集可呼叫；formula_check 同一套
  const btn = t.form_add_control({ draft_id, area_itemid: a2, control: { datatype: 'action', action_name: '帶入劑量', action_script: `CUSTOMFUNC("sm_drug_dose")` } }).itemid;
  assert.ok(t.form_validate({ draft_id }).valid);
  assert.deepEqual(t.formula_check({ kind: 'macro', text: 'CUSTOMFUNC("sm_drug_dose")', draft_id }).errors, []);
  const codes = (kind, text) => { const r = t.formula_check({ kind, text, draft_id }); return [...r.errors, ...r.warnings].map(f => f.code); };
  assert.ok(codes('macro', 'CUSTOMFUNC("alert")').includes('E_CUSTOMFUNC_UNDEFINED'), '不是片段定義的函數（可延後：片段可以晚一點設）');
  assert.ok(codes('macro', `CUSTOMFUNC(A${drug})`).includes('E_FORBIDDEN_FUNCTION'), '非字串字面值');
  assert.ok(codes('formula', 'CUSTOMFUNC("sm_drug_dose")').includes('E_FORBIDDEN_FUNCTION'), '計算式不放行');
  assert.ok(codes('macro', 'CUSTOMFUNC("sm_drug_dose")').every(c => c !== 'E_FORBIDDEN_FUNCTION'));
  // 片段定義可以晚於巨集：名稱不存在時延後到 form_validate；非字面值與 flag 關閉當下拒絕
  t.form_update_control({ draft_id, itemid: btn, changes: { action_script: 'CUSTOMFUNC("sm_other")' } });
  const v0 = t.form_validate({ draft_id });
  assert.ok(v0.errors.some(x => x.code === 'E_CUSTOMFUNC_UNDEFINED' && /sm_drug_dose/.test(x.message) && /name「other」/.test(x.message)), JSON.stringify(v0.errors));
  const e = errOf(() => t.form_update_control({ draft_id, itemid: btn, changes: { action_script: `CUSTOMFUNC(A${drug})` } }));
  assert.ok(e.details.errors.some(x => x.code === 'E_FORBIDDEN_FUNCTION' && /字串字面值/.test(x.message)));
  t.form_update_control({ draft_id, itemid: btn, changes: { action_script: 'CUSTOMFUNC("sm_drug_dose")' } });
  setFlag(false);
  const e2 = errOf(() => t.form_update_control({ draft_id, itemid: btn, changes: { action_script: 'CUSTOMFUNC("sm_drug_dose")' } }));
  assert.ok(e2.details.errors.some(x => x.code === 'E_FORBIDDEN_FUNCTION' && /flag formScript/.test(x.message)));
  setFlag(true);
  // 片段清掉後，既有巨集的 CUSTOMFUNC 變成錯誤
  t.form_set_script({ draft_id, snippets: [] });
  const v = t.form_validate({ draft_id });
  assert.ok(v.errors.some(x => x.code === 'E_CUSTOMFUNC_UNDEFINED' && /目前沒有/.test(x.message)));
  // trigger change：綁事件、不是 customfunc 就不開放給巨集
  const r2 = t.form_set_script({ draft_id, snippets: [{ template: 'lookup', params: { name: 'drug_dose', source: drug, table: { A: '1' }, target: dose } }] });
  assert.match(r2.rendered, new RegExp(`\\$\\(document\\)\\.on\\('keyup change blur', "\\[itemid='${drug}'\\]"`));
  assert.deepEqual(snip.scriptFunctions(store.loadDraft(draft_id)), []);
  const bad = (params, code, re) => {
    const e = errOf(() => t.form_set_script({ draft_id, snippets: [{ template: 'lookup', params }] }));
    assert.ok(e.details.errors.some(x => x.code === code && re.test(x.message)), JSON.stringify(e.details.errors));
  };
  bad({ name: 'Drug-Dose', source: drug, table: { A: '1' }, target: dose }, 'E_INVALID_INPUT', /name 必填/);
  bad({ name: 'x1', source: drug, table: {}, target: dose }, 'E_INVALID_INPUT', /table 是空的/);
  bad({ name: 'x1', source: drug, table: { A: '<b>1</b>' }, target: dose }, 'E_INVALID_INPUT', /table「A」的值 含不接受的字元/);
  bad({ name: 'x1', source: drug, table: { A: '1' }, target: drug }, 'E_INVALID_INPUT', /不能是同一個欄位/);
  bad({ name: 'x1', source: drug, table: { A: '1' }, target: dose, miss: { note: 1 } }, 'E_INVALID_INPUT', /miss 不認識 note/);
  bad({ name: 'x1', source: drug, table: { A: '1' }, target: dose, trigger: 'blur' }, 'E_INVALID_INPUT', /trigger 必須是/);
  const dup = errOf(() => t.form_set_script({ draft_id, snippets: [
    { id: 'a', template: 'lookup', params: { name: 'same', source: drug, table: { A: '1' }, target: dose } },
    { id: 'b', template: 'lookup', params: { name: 'same', source: h, table: { A: '1' }, target: dose } }] }));
  assert.ok(dup.details.errors.some(x => /name「same」與另一個 lookup 片段重複/.test(x.message)));
});

test('S5 required：失焦仍空白時提示並標示；目標必須是必填欄位', () => {
  const { draft_id, a1, h } = form();
  const name = t.form_add_control({ draft_id, area_itemid: a1, label_text: '評估者：', control: { datatype: 'textbox', required: true } }).itemid;
  const r = t.form_set_script({ draft_id, snippets: [{ id: 'need', template: 'required', params: { targets: [name], message: '評估者必填' } }] });
  assert.match(r.rendered, /\.sm-guard\{background-color:#ffd8d8/, 'required 也帶 guard 的樣式');
  assert.match(r.rendered, new RegExp(`\\$\\(document\\)\\.on\\('focusout', "\\[itemid='${name}'\\]", function \\(\\) \\{`));
  assert.match(r.rendered, /var empty = !String\(txt === undefined \|\| txt === null \? '' : txt\)\.trim\(\) && !el\.find\('input:checked'\)\.length;/);
  assert.match(r.rendered, /el\.toggleClass\('sm-guard', empty\);\n  if \(empty\) errormessage\("評估者必填"\);/);
  assert.doesNotThrow(() => new Function(r.rendered));
  assert.deepEqual(snip.scanTokens(r.rendered), []);
  assert.equal(r.snippets[0].summary, `必填提示：#${name} 失焦仍空白時提示「評估者必填」`);
  const e = errOf(() => t.form_set_script({ draft_id, snippets: [{ template: 'required', params: { targets: [h], message: 'x' } }] }));
  assert.ok(e.details.errors.some(x => /#\d+ 不是必填欄位/.test(x.message)));
});

test('W_CUSTOM_JS_FINDINGS：原表單 JS 以同一套禁用 token 掃描，只告知；flag 關時只有 W_CUSTOM_JS', () => {
  const { draft_id } = form();
  const src = model.toFormJson(store.loadDraft(draft_id), 'strucmed-skill v9 old');
  src.find(x => x.itemtype === 'javascript').content += '\nfunction keep() { return fetch("http://x"); }\nck_LLMapiUrl = "http://evil";';
  fs.writeFileSync(path.join(ws, 'src2.json'), JSON.stringify(src));
  const r = t.form_import({ source_path: 'src2.json', name: '改版 2', dept_no: 'TEST0' });
  const v = t.form_validate({ draft_id: r.draft_id });
  const w = v.warnings.find(x => x.code === 'W_CUSTOM_JS_FINDINGS');
  assert.ok(w && /「fetch\(」（連外（fetch））/.test(w.message) && /「ck_LLMapiUrl =」（runtime 設定賦值）/.test(w.message), JSON.stringify(v.warnings));
  assert.ok(v.warnings.some(x => x.code === 'W_CUSTOM_JS'));
  assert.ok(v.valid, '只告知不擋');
  setFlag(false);
  const v2 = t.form_validate({ draft_id: r.draft_id });
  assert.ok(!v2.warnings.some(x => x.code === 'W_CUSTOM_JS_FINDINGS'));
  assert.ok(v2.warnings.some(x => x.code === 'W_CUSTOM_JS'));
  setFlag(true);
  assert.deepEqual(snip.scanCustomJs('var a = 1; SetValueByID(1, 2);'), []);
});

test('verifyScriptBlock：標記行之後的程式碼雜湊相符；人工改過不符；沒有標記回 null', () => {
  const { draft_id, a1 } = form();
  t.form_set_script({ draft_id, snippets: [{ template: 'style', params: { rules: [{ scope: `area:${a1}`, css: { 'background-color': 'lightyellow' } }] } }] });
  const content = js(draft_id);
  const ok = snip.verifyScriptBlock(content);
  assert.equal(ok.matches, true);
  assert.deepEqual(ok.snippets, ['style#s1']);
  assert.equal(snip.verifyScriptBlock(content + '\n').matches, true, '尾端空白不算改');
  const bad = snip.verifyScriptBlock(content.replace('lightyellow', 'red'));
  assert.equal(bad.matches, false);
  assert.equal(bad.sha256, ok.sha256);
  assert.notEqual(bad.actual, ok.sha256);
  assert.equal(snip.verifyScriptBlock('// generated-by: x\nfunction f() {}'), null);
});

test('form_create options.hide_prev_icon → iot f_hideprevicon（S9 的替代：畫面開關走表單選項，不做 JS 樣板）', () => {
  const { draft_id } = t.form_create({ name: '選項', dept_no: 'TEST0', options: { hide_prev_icon: true, hide_preset: true } });
  t.form_add_area({ draft_id, title: 'x' });
  const iot = model.toFormJson(store.loadDraft(draft_id), 'v').find(x => x.itemtype === 'iot');
  assert.equal(iot.f_hideprevicon, true);
  assert.equal(iot.f_hidePreset, true);
  assert.equal(iot.f_hideAssist, false);
});

// ── D4：進階片段（flag formScriptAdvanced）S6 autorun、S7 table-rows ──

test('D4 flag formScriptAdvanced 關閉：autorun／table-rows 回 E_FEATURE_DISABLED；開啟後渲染；事後關閉 form_validate 回錯誤', () => {
  const { draft_id, a2, h, bmi } = form();
  const note = t.form_add_control({ draft_id, area_itemid: a2, label_text: '摘要：', control: { datatype: 'textarea' } }).itemid;
  const btn = t.form_add_control({ draft_id, area_itemid: a2, control: { datatype: 'action', action_name: '產生摘要', action_id: note,
    action_script: `LLMQUERY(${note}, CONCATENATE("BMI=", A${bmi}, "；請用一句話摘要"), "qwen332b")` } }).itemid;
  setFlags({ formScript: true });
  const e = errOf(() => t.form_set_script({ draft_id, snippets: [{ template: 'autorun', params: { action: btn } }] }));
  assert.equal(e.code, 'E_INVALID_INPUT');
  assert.ok(e.details.errors.some(x => x.code === 'E_FEATURE_DISABLED' && /formScriptAdvanced/.test(x.message)));
  assert.equal(store.loadDraft(draft_id).script, undefined);
  setFlags({ formScript: true, formScriptAdvanced: true });
  const r = t.form_set_script({ draft_id, snippets: [{ id: 'auto', template: 'autorun', params: { action: btn, only_if_empty: note } }] });
  assert.equal(r.snippets[0].advanced, true);
  assert.deepEqual(r.snippets[0].affects.sort(), [btn, note].sort());
  assert.match(r.snippets[0].summary, new RegExp(`開文件後自動執行巨集 #${btn}「產生摘要」（#${note} 已有值時不執行）；AI／查詢步驟 LLMQUERY→#${note} 會自動送出`));
  assert.match(r.rendered, /function sm_autorun_auto\(\)/);
  assert.match(r.rendered, new RegExp(`var cur = \\$\\(targetid\\)\\.calx\\('evaluate', "A${note}"\\);\\n  if \\(cur !== undefined && cur !== null && String\\(cur\\)\\.trim\\(\\) !== ''\\) return;\\n  performActionByID\\(${btn}\\);`));
  assert.match(r.rendered, /ck_getDocDone === true/);
  assert.doesNotThrow(() => new Function(r.rendered));
  assert.deepEqual(snip.scanTokens(r.rendered), []);
  assert.ok(r.warnings.some(w => /W_SCRIPT_AUTORUN/.test(w) && /verify-runtime 必跑/.test(w)));
  const v = t.form_validate({ draft_id });
  assert.ok(v.valid);
  assert.ok(v.warnings.some(w => w.code === 'W_FORM_SCRIPT' && /autorun#auto（進階）/.test(w.message)));
  assert.ok(v.warnings.some(w => w.code === 'W_SCRIPT_AUTORUN'));
  const p = t.form_export({ draft_id, overwrite: true });
  assert.deepEqual(p.plan.script.advanced, [`autorun#auto：${r.snippets[0].summary}`]);
  const bad = (params, code, re) => {
    const e = errOf(() => t.form_set_script({ draft_id, snippets: [{ template: 'autorun', params }] }));
    assert.ok(e.details.errors.some(x => x.code === code && re.test(x.message)), JSON.stringify(e.details.errors));
  };
  bad({ action: h }, 'E_REF_TYPE', /只能是巨集按鈕/);
  bad({ action: 99 }, 'E_REF_BROKEN', /action 的 #99/);
  bad({}, 'E_INVALID_INPUT', /action 必填/);
  // 事後關閉進階 flag：驗證回錯誤、匯出拒絕
  setFlags({ formScript: true });
  const v2 = t.form_validate({ draft_id });
  assert.ok(v2.errors.some(x => x.code === 'E_FEATURE_DISABLED' && /formScriptAdvanced/.test(x.message)));
  assert.equal(errOf(() => t.form_export({ draft_id })).code, 'E_INVALID_INPUT');
  setFlags({ formScript: true, formScriptAdvanced: true });
});

test('S7 table-rows：開文件後把 table1 補到指定列數並預填；只接受 table1；預填欄位要在該表格內', () => {
  const { draft_id, a1, h } = form();
  const tb = t.form_add_area({ draft_id, type: 'table1', titles: ['藥名', '劑量'] }).area_itemid;
  const c1 = t.form_add_control({ draft_id, area_itemid: tb, control: { datatype: 'textbox' }, cell: { index: 0 } }).itemid;
  const c2 = t.form_add_control({ draft_id, area_itemid: tb, control: { datatype: 'textbox' }, cell: { index: 1 } }).itemid;
  setFlags({ formScript: true, formScriptAdvanced: true });
  const r = t.form_set_script({ draft_id, snippets: [{ id: 'meds', template: 'table-rows', params: { table: tb, rows: { count: 3 }, prefill: { [c1]: ['Aspirin', 'Metformin', 'Vit D3'], [c2]: ['100mg', 500] } } }] });
  assert.equal(r.snippets[0].advanced, true);
  assert.deepEqual(r.snippets[0].affects.sort(), [tb, c1, c2].sort());
  assert.equal(r.snippets[0].summary, `動態表格加列：區塊 #${tb} 開文件時補到 3 列，預填 #${c1}、#${c2}`);
  assert.match(r.rendered, new RegExp(`var table = \\$\\(".area\\[itemid='${tb}'\\] table"\\)\\.first\\(\\);`));
  assert.match(r.rendered, /var want = 3;/);
  assert.match(r.rendered, /var have = table\.find\("tbody > tr\[rowid\]"\)\.filter\(function \(\) \{ return \$\(this\)\.attr\('rowid'\) !== '0'; \}\)\.length;/);
  assert.match(r.rendered, new RegExp(`var pre = \\{"${c1}":\\["Aspirin","Metformin","Vit D3"\\],"${c2}":\\["100mg","500"\\]\\};`));
  assert.match(r.rendered, /var rowIndex = TableRowAdd\(table\);/);
  assert.match(r.rendered, /if \(sub >= 0\) SetValueByID\(parseInt\(id, 10\), pre\[id\]\[i\], sub\);/);
  assert.doesNotMatch(r.rendered, /\$\(document\)\.on/, 'count 固定時不綁事件');
  assert.doesNotThrow(() => new Function(r.rendered));
  assert.deepEqual(snip.scanTokens(r.rendered), []);
  assert.ok(t.form_validate({ draft_id }).valid);
  const ec = errOf(() => t.form_remove_control({ draft_id, itemid: c1 }));
  assert.equal(ec.code, 'E_REF_BROKEN');
  assert.deepEqual(ec.details.blockers, [{ target: c1, from: 'snippet:meds', kind: 'snippet:table-rows' }]);
  // 列數來自欄位：改值後也補
  const r2 = t.form_set_script({ draft_id, snippets: [{ template: 'table-rows', params: { table: tb, rows: { source: h } } }] });
  assert.match(r2.rendered, new RegExp(`var r = \\$\\(targetid\\)\\.calx\\('evaluate', "A${h}"\\);\\n  var want = parseInt\\(r, 10\\);`));
  assert.match(r2.rendered, new RegExp(`\\$\\(document\\)\\.on\\('keyup change blur', "\\[itemid='${h}'\\]"`));
  assert.match(r2.snippets[0].summary, new RegExp(`補到 #${h} 的值那麼多列（改值後也補）`));
  const bad = (params, code, re) => {
    const e = errOf(() => t.form_set_script({ draft_id, snippets: [{ template: 'table-rows', params }] }));
    assert.ok(e.details.errors.some(x => x.code === code && re.test(x.message)), JSON.stringify(e.details.errors));
  };
  bad({ table: a1, rows: { count: 2 } }, 'E_REF_TYPE', /只有 table1/);
  bad({ table: 99, rows: { count: 2 } }, 'E_REF_BROKEN', /區塊 #99 不存在/);
  bad({ table: tb, rows: { count: 0 } }, 'E_INVALID_INPUT', /rows\.count 必須是 1–30/);
  bad({ table: tb, rows: { count: 2, source: h } }, 'E_INVALID_INPUT', /其中一種/);
  bad({ table: tb, rows: { source: c1 } }, 'E_INVALID_INPUT', /不能在動態表格內/);
  bad({ table: tb, rows: { count: 2 }, prefill: { [h]: ['1'] } }, 'E_INVALID_INPUT', new RegExp(`prefill 的 #${h} 不在表格`));
  bad({ table: tb, rows: { count: 2 }, prefill: { [c1]: 'x' } }, 'E_INVALID_INPUT', /必須是值的陣列/);
  bad({ table: tb, rows: { count: 2 }, prefill: { [c1]: ['<x>'] } }, 'E_INVALID_INPUT', /第 1 列 含不接受的字元/);
  setFlags({ formScript: true });
});
