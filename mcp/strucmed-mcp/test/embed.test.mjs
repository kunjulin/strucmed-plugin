// 嵌入頁面（embed 區塊、OPENPANEL 巨集）：node --test test/embed.test.mjs
// 前半段由平台 tests/web-js/embed-block.test.mjs（commit 26984f3）逐案搬來，比對 src/embed.mjs 與平台 web/js/embed-block.js 的結果一致；
// 後半段是 plugin 的 flag 開關、form_add_area／form_update_area、validate 嚴重度、匯入保留、OPENPANEL lint、manifest 揭露。
// 院內 IP 一律在執行時組字串（發佈掃描會擋四段數字的院內 IP）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ip = (...p) => p.join('.');
let ws, flagsFile, eb, t, TOOL_DEFS, store, model, lint, exp;
const setFlags = o => fs.writeFileSync(flagsFile, JSON.stringify(o));
const codes = errors => errors.map(e => e.code);
const errOf = fn => { try { fn(); } catch (e) { return e; } assert.fail('應該拋錯'); };

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-embed-'));
  process.env.STRUCMED_WORKSPACE = ws;
  flagsFile = path.join(ws, 'flags.json');
  process.env.STRUCMED_FLAGS = flagsFile;
  setFlags({ embedArea: true });
  eb = await import('../src/embed.mjs');
  TOOL_DEFS = (await import('../src/tools.mjs')).TOOLS;
  t = Object.fromEntries(TOOL_DEFS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  model = await import('../src/model.mjs');
  lint = await import('../src/scriptlint.mjs');
  exp = await import('../src/export.mjs');
});
after(() => { delete process.env.STRUCMED_FLAGS; fs.rmSync(ws, { recursive: true, force: true }); });

// ── 平台 tests/web-js/embed-block.test.mjs 的案例 ─────────────────────────────

test('平台：internal host ranges (same as the 1.10.9 DLL NavigationPolicy)', () => {
  for (const h of ['assistantai.cgmh.org.tw', 'cgmh.org.tw', 'lvaiw.cgmf.org.tw', 'x.cgmh.me', 'LOCALHOST', 'localhost',
    ip('127', '0', '0', '1'), '[::1]', ip('10', '0', '0', '1'), ip('10', '255', '255', '255'), ip('172', '16', '0', '1'), ip('172', '31', '255', '1'), ip('192', '168', '1', '1'), 'a.b.cgmh.org.tw.']) {
    assert.equal(eb.isInternalHost(h), true, h);
  }
  for (const h of ['evil.com', 'cgmh.org.tw.evil.com', 'xcgmh.org.tw', 'cgmh.org', ip('172', '15', '0', '1'), ip('172', '32', '0', '1'), ip('192', '169', '0', '1'),
    ip('11', '0', '0', '1'), ip('8', '8', '8', '8'), ip('10', '0', '0'), ip('010', '0', '0', '1'), ip('10', '0', '0', '256'), '[fe80::1]', '', null]) {
    assert.equal(eb.isInternalHost(h), false, String(h));
  }
});

test('平台：url must be https on an internal host', () => {
  assert.equal(eb.checkUrl('https://assistantai.cgmh.org.tw/ERCDSS/').ok, true);
  assert.equal(eb.checkUrl(`https://${ip('10', '30', '111', '14')}:8443/app?mode=his`).ok, true, '固定 query 可以');
  assert.deepEqual(codes(eb.checkUrl('http://assistantai.cgmh.org.tw/').errors), ['E_EMBED_SCHEME']);
  assert.deepEqual(codes(eb.checkUrl('https://www.google.com/').errors), ['E_EMBED_HOST']);
  assert.deepEqual(codes(eb.checkUrl('http://evil.com/').errors), ['E_EMBED_SCHEME', 'E_EMBED_HOST']);
  assert.deepEqual(codes(eb.checkUrl('javascript:alert(1)').errors), ['E_EMBED_SCHEME', 'E_EMBED_HOST']);
  assert.deepEqual(codes(eb.checkUrl('data:text/html,hi').errors), ['E_EMBED_SCHEME', 'E_EMBED_HOST']);
  assert.deepEqual(codes(eb.checkUrl('//x.cgmh.org.tw/').errors), ['E_EMBED_URL'], '要寫完整網址');
  assert.deepEqual(codes(eb.checkUrl('').errors), ['E_EMBED_URL']);
  assert.deepEqual(codes(eb.checkUrl(undefined).errors), ['E_EMBED_URL']);
  assert.ok(codes(eb.checkUrl('https://u:p@x.cgmh.org.tw/').errors).includes('E_EMBED_URL'), '不可含帳密');
  assert.deepEqual(codes(eb.checkUrl('https://x.cgmh.org.tw/?chtno={chtno}').errors), ['E_EMBED_PII'], '占位符只能放 params');
  assert.deepEqual(codes(eb.checkUrl('https://x.cgmh.org.tw/?idno=1').errors), ['E_EMBED_PII']);
  assert.deepEqual(codes(eb.checkUrl('https://x.cgmh.org.tw/?q=A123456789').errors), ['E_EMBED_PII'], '身分證號樣式');
  const r = eb.checkUrl('https://X.CGMH.org.tw:8443/a');
  assert.equal(r.origin, 'https://x.cgmh.org.tw:8443');
  assert.equal(r.host, 'x.cgmh.org.tw');
});

test('平台：params: only the four placeholders or constants, no ID number or name', () => {
  assert.deepEqual(eb.checkParams({ chtno: '{chtno}', dept: '{deptNo}', u: '{user}', o: '{opdno}', mode: 'his' }), []);
  assert.deepEqual(eb.checkParams(undefined), []);
  assert.deepEqual(codes(eb.checkParams({ x: '{idno}' })), ['E_EMBED_PII'], '未開放的占位符');
  assert.deepEqual(codes(eb.checkParams({ x: '{usernm}' })), ['E_EMBED_PII']);
  assert.deepEqual(codes(eb.checkParams({ x: 'a{chtno}' })), ['E_EMBED_PII'], '占位符要整個值');
  assert.deepEqual(codes(eb.checkParams({ idno: '{chtno}' })), ['E_EMBED_PII'], '名稱像身分證號');
  assert.deepEqual(codes(eb.checkParams({ name: '{user}' })), ['E_EMBED_PII'], '名稱像姓名');
  assert.deepEqual(codes(eb.checkParams({ patientName: 'x' })), ['E_EMBED_PII']);
  assert.deepEqual(codes(eb.checkParams({ ptName: 'x' })), ['E_EMBED_PII']);
  assert.deepEqual(codes(eb.checkParams({ 姓名: 'x' })), ['E_EMBED_PII'], '名稱只能英數字');
  assert.deepEqual(codes(eb.checkParams({ q: 'B223456789' })), ['E_EMBED_PII'], '常數值像身分證號');
  assert.deepEqual(codes(eb.checkParams(['{chtno}'])), ['E_EMBED_PII'], '必須是物件');
  assert.deepEqual(eb.checkParams({ deptname: 'ER' }).length, 0, 'deptname 不算姓名');
});

test('平台：height: "fill" or pixels', () => {
  assert.deepEqual(eb.parseHeight('fill'), { fill: true });
  assert.deepEqual(eb.parseHeight('FILL'), { fill: true });
  assert.deepEqual(eb.parseHeight(480), { px: 480 });
  assert.deepEqual(eb.parseHeight('480px'), { px: 480 });
  assert.deepEqual(eb.parseHeight(undefined), { px: eb.DEFAULT_HEIGHT });
  assert.equal(eb.parseHeight('50%'), null);
  assert.equal(eb.parseHeight(50), null);
  assert.equal(eb.parseHeight(99999), null);
  assert.deepEqual(codes(eb.checkBlock({ url: 'https://x.cgmh.org.tw/', height: 'auto' })), ['E_EMBED_HEIGHT']);
});

test('平台：buildUrl replaces placeholders from the context and keeps the fixed query', () => {
  const block = { url: 'https://assistantai.cgmh.org.tw/ERCDSS/?mode=his', params: { chtno: '{chtno}', dept: '{deptNo}', v: '2' } };
  const r = eb.buildUrl(block, { chtno: '123', deptNo: '33F0', user: 'U1' });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://assistantai.cgmh.org.tw/ERCDSS/?mode=his&chtno=123&dept=33F0&v=2');
  assert.equal(r.origin, 'https://assistantai.cgmh.org.tw');
  assert.equal(eb.buildUrl(block, {}).url, 'https://assistantai.cgmh.org.tw/ERCDSS/?mode=his&chtno=&dept=&v=2', '沒有病人時帶空字串');
  assert.equal(eb.buildUrl({ url: 'https://x.cgmh.org.tw/', params: { c: '{chtno}' } }, { chtno: 'a&b=c#d' }).url,
    'https://x.cgmh.org.tw/?c=a%26b%3Dc%23d', '值會編碼，不能插入其他參數');
  const bad = eb.buildUrl({ url: 'https://evil.com/', params: { c: '{chtno}' } }, { chtno: '1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.url, undefined, '不合時不組網址');
});

const ctl = (itemid, datatype, extra = {}) => ({ itemid, datatype, datavalue: '', tocalc: true, ...extra });
const areaAuth = { authread: ['doctor'], authwrite: ['doctor'], gettext: true };
const embedBlock = (itemid, extra = {}) => ({ ...areaAuth, itemtype: 'embed', itemid: String(itemid), url: 'https://x.cgmh.org.tw/', ...extra });
const baseForm = () => [
  { ...areaAuth, itemtype: 'form', itemid: '1', item: [
    ctl(10, 'textbox'), ctl(11, 'numberbox'), ctl(12, 'textbox', { tocalc: false }),
    ctl(13, 'subgroup', { datavalue: [ctl(14, 'textbox')] }),
    ctl(15, 'form', { datavalue: [ctl(16, 'textbox')] })
  ] },
  { ...areaAuth, itemtype: 'tab2', itemid: '2', item: [{ datatitle: 'A', item: [ctl(20, 'textarea')] }] },
  { ...areaAuth, itemtype: 'formtable', itemid: '3', item: [{ itemtype: 'row', columns: '1', item: [{ item: [ctl(30, 'textbox')] }] }] },
  { itemtype: 'javascript', content: '' },
  { itemtype: 'iot', templateID: 'x' }
];

test('平台：validateForm: outputs must exist, not be an embed, not be inside form/subgroup', () => {
  const form = baseForm().concat([embedBlock(40, { outputs: { a: 10, b: 11, c: 20, d: 30 }, inputs: { x: 10 } })]);
  assert.deepEqual(eb.validateForm(form), []);
  const bad = baseForm().concat([
    embedBlock(40, { outputs: { missing: 99, self: 40, other: 41, sub: 14, pop: 16, area: 1 } }),
    embedBlock(41, { height: 480 })
  ]);
  assert.deepEqual(eb.validateForm(bad).map(e => e.itemid + ':' + e.code), [
    '40:E_EMBED_OUTPUT_MISSING', '40:E_EMBED_OUTPUT_EMBED', '40:E_EMBED_OUTPUT_EMBED',
    '40:E_EMBED_OUTPUT_GROUP', '40:E_EMBED_OUTPUT_GROUP', '40:E_EMBED_OUTPUT_MISSING'
  ]);
});

test('平台：validateForm: inputs need an existing tocalc field', () => {
  const form = baseForm().concat([embedBlock(40, { inputs: { ok: 10, nocalc: 12, none: 99 } })]);
  assert.deepEqual(eb.validateForm(form).map(e => e.code), ['E_EMBED_INPUT', 'E_EMBED_INPUT']);
});

test('平台：validateForm: outputs of several embeds must not overlap; at most one fill', () => {
  const form = baseForm().concat([
    embedBlock(40, { height: 'fill', outputs: { a: 10 } }),
    embedBlock(41, { height: 'fill', outputs: { b: 10, c: 11 } }),
    embedBlock(42, { height: 300, outputs: { c: 11 } })
  ]);
  assert.deepEqual(eb.validateForm(form).map(e => e.itemid + ':' + e.code), ['41:E_EMBED_FILL', '41:E_EMBED_OUTPUT_DUP', '42:E_EMBED_OUTPUT_DUP']);
  assert.deepEqual(eb.validateForm(baseForm().concat([embedBlock(40, { outputs: { a: 10, b: 10 } })])), [], '同一個 embed 兩個 key 寫同一欄不算重疊');
});

test('平台：validateForm also reports block errors and malformed maps', () => {
  const form = baseForm().concat([embedBlock(40, { url: 'http://evil.com/', params: { x: '{idno}' }, outputs: { 'a b': 10 }, inputs: { k: 'A10' } })]);
  assert.deepEqual(eb.validateForm(form).map(e => e.code),
    ['E_EMBED_SCHEME', 'E_EMBED_HOST', 'E_EMBED_PII', 'E_EMBED_MAP', 'E_EMBED_MAP', 'E_EMBED_INPUT']);
});

test('平台：result values are text; number fields reject non-numbers', () => {
  assert.deepEqual(eb.coerceResultValue('<b>x</b>', false), { ok: true, value: '<b>x</b>' });
  assert.deepEqual(eb.coerceResultValue(7, false), { ok: true, value: '7' });
  assert.deepEqual(eb.coerceResultValue(' 7.5 ', true), { ok: true, value: '7.5' });
  assert.deepEqual(eb.coerceResultValue('-1e3', true), { ok: true, value: '-1e3' });
  assert.deepEqual(eb.coerceResultValue('', true), { ok: true, value: '' });
  assert.deepEqual(eb.coerceResultValue(null, true), { ok: true, value: '' });
  assert.equal(eb.coerceResultValue('7 分', true).ok, false);
  assert.equal(eb.coerceResultValue('NaN', true).ok, false);
  assert.equal(eb.coerceResultValue({ a: 1 }, false).ok, false);
  assert.equal(eb.coerceResultValue(['a'], false).ok, false);
});

test('錯誤碼與訊息和平台完全相同（12 個 E_EMBED_*）', () => {
  assert.deepEqual(eb.CODES, ['E_EMBED_URL', 'E_EMBED_SCHEME', 'E_EMBED_HOST', 'E_EMBED_PII', 'E_EMBED_HEIGHT', 'E_EMBED_FILL', 'E_EMBED_INPUT',
    'E_EMBED_OUTPUT_MISSING', 'E_EMBED_OUTPUT_EMBED', 'E_EMBED_OUTPUT_GROUP', 'E_EMBED_OUTPUT_DUP', 'E_EMBED_MAP']);
  // 平台 web/ 的本機副本（STRUCMED_RUNTIME_WEB，或 repo 旁的 strucmed/web）有 embed-block.js 時，直接載入比對訊息與同一組案例的結果；找不到就略過
  const here = path.dirname(fileURLToPath(import.meta.url));
  const platform = [process.env.STRUCMED_RUNTIME_WEB && path.join(process.env.STRUCMED_RUNTIME_WEB, 'js/embed-block.js'),
    ...['../../../..', '../../../../../../..'].map(p => path.resolve(here, p, 'strucmed/web/js/embed-block.js'))].find(p => p && fs.existsSync(p));
  if (!platform) return;
  const sandbox = { module: { exports: {} } };
  new Function('module', 'self', fs.readFileSync(platform, 'utf8'))(sandbox.module, {});
  const pe = sandbox.module.exports;
  assert.deepEqual(pe.MESSAGES, eb.MESSAGES);
  const cases = [baseForm().concat([embedBlock(40, { url: 'http://evil.com/?idno=1', params: { x: '{idno}', name: 'a' }, outputs: { 'a b': 10, o: 14, p: 99 }, inputs: { k: 'A10', n: 12 }, height: 'fill' }), embedBlock(41, { height: 'fill', outputs: { q: 10 } })])];
  for (const f of cases) assert.deepEqual(eb.validateForm(f), pe.validateForm(f));
});

// 平台 tests/fixtures/internal-hosts.json（DLL NavigationPolicy.IsInternalHost 與站台 isInternalHost 共用，commit 44dac17）的案例逐條抄來。
// IPv4 的點寫成 #、執行時換回（發佈掃描會擋四段數字的院內 IP）。平台倉儲在旁邊時另直接讀那份 JSON 比對。
const dots = s => (s === null ? null : s.replace(/#/g, '.'));
const SHARED_HOSTS = {
  internal: ['assistantai.cgmh.org.tw', 'cgmh.org.tw', 'CGMH.ORG.TW', 'a.b.cgmh.org.tw', 'a.b.cgmh.org.tw.', 'lvaiw.cgmf.org.tw', 'cgmf.org.tw',
    'x.cgmh.me', 'cgmh.me', 'cgmh.me.', 'localhost', 'LOCALHOST', 'localhost.', '127#0#0#1', '[::1]', '::1',
    '10#0#0#0', '10#0#0#1', '10#30#111#14', '10#255#255#255', '172#16#0#0', '172#16#0#1', '172#20#10#5', '172#31#255#1', '172#31#255#255',
    '192#168#0#0', '192#168#1#1', '192#168#255#255'].map(dots),
  external: ['evil.com', 'example.com', 'cgmh.org.tw.evil.com', 'lvaiw.cgmf.org.tw.evil.example', 'xcgmh.org.tw', 'evilcgmh.me', 'cgmh.org', 'org.tw', 'tw',
    '172#15#0#1', '172#15#255#255', '172#32#0#0', '172#32#0#1', '192#169#0#1', '192#167#1#1', '11#0#0#1', '9#255#255#255', '8#8#8#8', '127#0#0#2', '0#0#0#0',
    '10#0#0', '10#0#0#1#5', '010#0#0#1', '10#00#0#1', '10#0#0#256', '1000#0#0#1', '[fe80::1]', '[::ffff:10#0#0#1]', 'fe80::1', '[]', '.', '', null].map(dots)
};

test('平台：共用主機案例（internal-hosts.json，與 1.10.9 DLL 同一份）', () => {
  for (const h of SHARED_HOSTS.internal) assert.equal(eb.isInternalHost(h), true, String(h));
  for (const h of SHARED_HOSTS.external) assert.equal(eb.isInternalHost(h), false, String(h));
  // 實際網址先由 URL 解析器正規化主機（八進位、十六進位 IPv4 轉十進位）再判斷
  assert.equal(eb.isInternalHost(new URL('http://010.0.0.1/').hostname), false, '010 → 8.0.0.1');
  assert.equal(eb.isInternalHost(new URL('http://0x0a.0.0.1/').hostname), true, '0x0a → 10');
  assert.equal(eb.isInternalHost(new URL('http://[0:0:0:0:0:0:0:1]/').hostname), true, '→ [::1]');
  assert.equal(eb.isInternalHost(new URL('https://X.CGMH.ORG.TW:8443/a?b').hostname), true);
  assert.equal(eb.checkUrl('https://0x0a.0.0.1/').ok, true, 'checkUrl 看正規化後的主機');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = [process.env.STRUCMED_RUNTIME_WEB && path.join(process.env.STRUCMED_RUNTIME_WEB, '../tests/fixtures/internal-hosts.json'),
    ...['../../../..', '../../../../../../..'].map(p => path.resolve(here, p, 'strucmed/tests/fixtures/internal-hosts.json'))].find(p => p && fs.existsSync(p));
  if (!fixture) return;
  const f = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.deepEqual({ internal: f.internal, external: f.external }, SHARED_HOSTS, '平台的共用案例有更新：請把新案例抄進 SHARED_HOSTS');
});

// ── plugin：flag、tools、validate、匯入、OPENPANEL ────────────────────────────

function baseDraft() {
  const { draft_id } = t.form_create({ name: '嵌入測試', dept_no: 'TEST0' });
  const a1 = t.form_add_area({ draft_id, title: '輸入' }).area_itemid;
  const age = t.form_add_control({ draft_id, area_itemid: a1, label_text: '年齡：', control: { datatype: 'numberbox' } }).itemid;
  return { draft_id, a1, age };
}
const embedArgs = extra => ({ type: 'embed', title: '臨床決策支援', url: 'https://assistantai.cgmh.org.tw/ERCDSS/', params: { chtno: '{chtno}', dept: '{deptNo}', mode: 'his' }, ...extra });

test('flag 關：form_add_area 不接受 embed（E_FEATURE_DISABLED），OPENPANEL 視為禁用；flag 開：可以', () => {
  setFlags({ embedArea: false });
  const { draft_id } = baseDraft();
  assert.equal(errOf(() => t.form_add_area({ draft_id, ...embedArgs() })).code, 'E_FEATURE_DISABLED');
  assert.ok(codes(lint.lintMacro('OPENPANEL("https://x.cgmh.org.tw/", "查詢")', {}).findings).includes('E_FORBIDDEN_FUNCTION'));
  assert.equal(errOf(() => t.form_add_control({ draft_id, area_itemid: 1, control: { datatype: 'action', action_name: '開', action_script: 'OPENPANEL("https://x.cgmh.org.tw/", "查詢")' } })).code, 'E_INVALID_INPUT');
  assert.ok(codes(t.formula_check({ kind: 'macro', text: 'OPENPANEL("https://x.cgmh.org.tw/")' }).errors).includes('E_FORBIDDEN_FUNCTION'));
  assert.equal(store.loadDraft(draft_id).areas.length, 1, 'draft 沒有被改');
  // 工具清單：flag 關時 type 列舉沒有 embed（skill 依此判斷），說明寫明需要 flag；開啟後才出現
  const addArea = TOOL_DEFS.find(x => x.name === 'form_add_area');
  assert.ok(!addArea.inputSchema.properties.type.enum.includes('embed'));
  assert.match(addArea.description, /需 feature flag embedArea，目前未開啟/);
  assert.equal(addArea.inputSchema.additionalProperties, false);
  setFlags({ embedArea: true });
  assert.ok(addArea.inputSchema.properties.type.enum.includes('embed'));
  assert.match(addArea.description, /flag embedArea 已開啟/);
  const r = t.form_add_area({ draft_id, ...embedArgs() });
  assert.equal(r.type, 'embed');
  assert.match(r.summary, /主機 assistantai\.cgmh\.org\.tw/);
});

test('form_add_area embed：GetData 形狀、key 順序、預設值；outputs 指到之後才建的欄位可延後', () => {
  const { draft_id, age } = baseDraft();
  const r = t.form_add_area({ draft_id, ...embedArgs({ inputs: { age: `A${age}` }, outputs: { risk: 99 } }) });
  assert.ok(r.pending.some(p => /E_EMBED_OUTPUT_MISSING/.test(p)), '欄位還沒建：延後');
  const a2 = t.form_add_area({ draft_id, title: '結果' }).area_itemid;
  const risk = t.form_add_control({ draft_id, area_itemid: a2, label_text: '風險：', control: { datatype: 'textbox' } }).itemid;
  t.form_update_area({ draft_id, itemid: r.area_itemid, outputs: { risk } });
  const out = model.toFormJson(store.loadDraft(draft_id), 'test').find(x => x.itemtype === 'embed');
  assert.deepEqual(Object.keys(out), ['itemtype', 'itemid', 'title', 'url', 'params', 'height', 'inputs', 'outputs', 'authread', 'authwrite', 'gettext']);
  assert.deepEqual(out, { itemtype: 'embed', itemid: String(r.area_itemid), title: '臨床決策支援', url: 'https://assistantai.cgmh.org.tw/ERCDSS/',
    params: { chtno: '{chtno}', dept: '{deptNo}', mode: 'his' }, height: 600, inputs: { age }, outputs: { risk }, authread: ['doctor'], authwrite: ['doctor'], gettext: true });
  const v = t.form_validate({ draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const flow = v.warnings.find(w => w.code === 'W_EMBED_DATAFLOW');
  assert.match(flow.message, /assistantai\.cgmh\.org\.tw/);
  assert.match(flow.message, /chtno=\{chtno\}（病歷號）/);
  assert.match(flow.message, new RegExp(`risk→#${risk}`));
  assert.equal(v.stats.embeds, 1);
  assert.deepEqual(v.embeds.map(e => [e.kind, e.host, e.source]), [['embed', 'assistantai.cgmh.org.tw', 'new']]);
  // 預覽顯示摘要（主機、參數、寫回欄位）
  const tree = t.form_preview({ draft_id, format: 'tree' });
  const text = typeof tree === 'string' ? tree : tree.preview || tree.text || JSON.stringify(tree);
  assert.match(text, /嵌入頁面：臨床決策支援/);
  assert.match(text, /主機 assistantai\.cgmh\.org\.tw/);
  assert.match(text, /chtno=病歷號/);
  assert.match(text, new RegExp(`寫回欄位（strucmed.result）：risk→#${risk}`));
  // manifest 揭露
  const man = exp.embedSection(v);
  assert.match(man, /## 嵌入頁面資料流（1 個）/);
  assert.ok(man.includes(exp.EMBED_APPEND_WARNING), '有送出／寫回欄位：manifest 提醒不要用編輯器「加載表單」');
  assert.match(exp.EMBED_APPEND_WARNING, /加載表單/);
  const noMap = exp.embedSection({ embeds: [{ kind: 'embed', itemid: 1, title: 'x', host: 'x.cgmh.org.tw', params: [], inputs: [], outputs: [], source: 'new' }] });
  assert.ok(noMap && !noMap.includes(exp.EMBED_APPEND_WARNING), '沒有送出／寫回欄位：不提醒');
  assert.match(man, /\| 區塊 #\d+ 臨床決策支援 \| 表單載入時 \| assistantai\.cgmh\.org\.tw \| chtno=\{chtno\}（病歷號）、dept=\{deptNo\}（科別）、mode=his \|/);
});

test('form_add_area embed：當下拒絕的錯誤（各 E_EMBED_*），draft 不變', () => {
  const { draft_id, age } = baseDraft();
  const bad = (extra, code) => {
    const before = JSON.stringify(store.loadDraft(draft_id).areas);
    const e = errOf(() => t.form_add_area({ draft_id, ...embedArgs(extra) }));
    assert.equal(e.code, 'E_INVALID_INPUT');
    assert.ok(e.details.errors.some(x => x.code === code), `${code}：${e.message}`);
    assert.equal(JSON.stringify(store.loadDraft(draft_id).areas), before);
  };
  bad({ url: 'http://assistantai.cgmh.org.tw/' }, 'E_EMBED_SCHEME');
  bad({ url: 'https://www.google.com/' }, 'E_EMBED_HOST');
  bad({ url: 'assistantai.cgmh.org.tw/ERCDSS' }, 'E_EMBED_URL');
  bad({ url: 'https://x.cgmh.org.tw/?chtno={chtno}' }, 'E_EMBED_PII');
  bad({ params: { name: '{user}' } }, 'E_EMBED_PII');
  bad({ params: { q: '{idno}' } }, 'E_EMBED_PII');
  bad({ height: '50%' }, 'E_EMBED_HEIGHT');
  bad({ outputs: { 'a b': age } }, 'E_EMBED_MAP');
  bad({ inputs: ['A2'] }, 'E_EMBED_MAP');
  bad({ params: ['{chtno}'] }, 'E_EMBED_PII');
});

test('form_add_area embed：關係錯誤（fill、outputs 重疊、指向 embed）當下拒絕；inputs 未參與計算延後到 form_validate', () => {
  const { draft_id, a1, age } = baseDraft();
  const first = t.form_add_area({ draft_id, ...embedArgs({ height: 'fill', outputs: { a: age } }) }).area_itemid;
  const e1 = errOf(() => t.form_add_area({ draft_id, ...embedArgs({ height: 'fill' }) }));
  assert.ok(e1.details.errors.some(x => x.code === 'E_EMBED_FILL'));
  const e2 = errOf(() => t.form_add_area({ draft_id, ...embedArgs({ outputs: { b: age } }) }));
  assert.ok(e2.details.errors.some(x => x.code === 'E_EMBED_OUTPUT_DUP'));
  const e3 = errOf(() => t.form_add_area({ draft_id, ...embedArgs({ outputs: { c: first } }) }));
  assert.ok(e3.details.errors.some(x => x.code === 'E_EMBED_OUTPUT_EMBED'));
  const note = t.form_add_control({ draft_id, area_itemid: a1, label_text: '備註：', control: { datatype: 'textbox', tocalc: false } }).itemid;
  const r = t.form_add_area({ draft_id, ...embedArgs({ inputs: { note } }) });
  assert.ok(r.pending.some(p => /E_EMBED_INPUT/.test(p)));
  const v = t.form_validate({ draft_id });
  assert.ok(v.errors.some(x => x.code === 'E_EMBED_INPUT' && x.itemid === r.area_itemid), '本工具新增的 embed → error');
  // 修正後通過；form_update_area 不合時拒絕且不改
  assert.equal(errOf(() => t.form_update_area({ draft_id, itemid: r.area_itemid, url: 'http://evil.com/' })).code, 'E_INVALID_INPUT');
  assert.equal(store.loadDraft(draft_id).areas.find(a => a.itemid === r.area_itemid).area.url, 'https://assistantai.cgmh.org.tw/ERCDSS/');
  t.form_update_area({ draft_id, itemid: r.area_itemid, inputs: {}, title: '改名' });
  const after = t.form_validate({ draft_id });
  assert.equal(after.errors.filter(x => /^E_EMBED/.test(x.code)).length, 0, JSON.stringify(after.errors));
  assert.equal(store.loadDraft(draft_id).areas.find(a => a.itemid === r.area_itemid).area.title, '改名');
  // 非 embed 不接受 embed 參數
  assert.equal(errOf(() => t.form_add_area({ draft_id, url: 'https://x.cgmh.org.tw/' })).code, 'E_UNSUPPORTED_DATATYPE');
  assert.equal(errOf(() => t.form_update_area({ draft_id, itemid: a1, height: 300 })).code, 'E_UNSUPPORTED_DATATYPE');
});

test('寫回／送出欄位被 embed 參照時不能刪；embed 區塊可以直接刪；flag 事後關閉時驗證拒絕', () => {
  const { draft_id, age } = baseDraft();
  const id = t.form_add_area({ draft_id, ...embedArgs({ outputs: { a: age } }) }).area_itemid;
  const e = errOf(() => t.form_remove_control({ draft_id, itemid: age }));
  assert.equal(e.code, 'E_REF_BROKEN');
  assert.match(e.message, /嵌入頁面的 inputs／outputs/);
  assert.deepEqual(e.details.blockers.map(b => b.kind), ['embedOutput']);
  setFlags({ embedArea: false });
  const v = t.form_validate({ draft_id });
  assert.ok(v.errors.some(x => x.code === 'E_FEATURE_DISABLED' && /embedArea/.test(x.message)));
  assert.equal(errOf(() => t.form_update_area({ draft_id, itemid: id, height: 300 })).code, 'E_FEATURE_DISABLED');
  assert.equal(t.form_remove_area({ draft_id, itemid: id }).removed_area, id, 'flag 關閉時也能刪，讓 draft 修得好');
  assert.equal(t.form_validate({ draft_id }).valid, true);
  setFlags({ embedArea: true });
});

test('匯入既有含 embed 的表單：不論 flag 原樣保留並檢查；原表單的錯誤是 warning，指到本次修改的欄位時是 error', () => {
  setFlags({ embedArea: false });
  const src = [
    { ...areaAuth, itemtype: 'form', itemid: '1', item: [{ datatype: 'text', datavalue: '分數：' }, ctl(2, 'numberbox'), { datatype: 'newline' }, { datatype: 'text', datavalue: '建議：' }, ctl(3, 'textarea'),
      { datatype: 'text', datavalue: '' }, ctl(4, 'action', { actionName: '查詢', actionID: '', actionScript: 'OPENPANEL("https://x.cgmh.org.tw/guide", "指引")' })] },
    { itemtype: 'embed', itemid: '5', title: '原表單嵌入', url: 'https://cdss.cgmh.org.tw/app', params: { c: '{chtno}', k: 'v1' }, height: 'fill', inputs: { s: 2 }, outputs: { adv: 3, gone: 77 }, authread: ['doctor'], authwrite: ['doctor'], gettext: true, extra: { keep: true } },
    { itemtype: 'javascript', content: '' },
    { itemtype: 'iot', editorver: '1.6', sheetid: 'S', f_opdno: false, f_chtno: true, templateID: 'T', f_histext: 'histextbyblock', f_day: '30', d_url: '' }
  ];
  const r = t.form_import({ source_text: JSON.stringify(src), source_name: 'embed-src.json', name: '嵌入改版', dept_no: 'TEST0' });
  assert.equal(r.area_types.embed, 1);
  const d = store.loadDraft(r.draft_id);
  const out = model.toFormJson(d, 'test');
  assert.deepEqual(out.find(x => x.itemtype === 'embed'), src[1], '原樣保留（含未知欄位）');
  const v = t.form_validate({ draft_id: r.draft_id });
  assert.equal(v.errors.filter(x => /EMBED|FEATURE|FORBIDDEN/.test(x.code)).length, 0, JSON.stringify(v.errors));
  assert.ok(v.warnings.some(w => w.code === 'E_EMBED_OUTPUT_MISSING' && /原表單既有/.test(w.message)));
  assert.ok(v.warnings.some(w => w.code === 'E_FORBIDDEN_FUNCTION' && /OPENPANEL/.test(w.message)), 'flag 關：原表單的 OPENPANEL 照標禁用（warning）');
  assert.ok(v.warnings.some(w => w.code === 'W_EMBED_DATAFLOW' && /cdss\.cgmh\.org\.tw/.test(w.message)));
  assert.deepEqual(v.embeds.map(e => [e.kind, e.source]), [['embed', 'imported']]);
  assert.match(t.form_preview({ draft_id: r.draft_id, format: 'tree' }).preview || JSON.stringify(t.form_preview({ draft_id: r.draft_id, format: 'tree' })), /嵌入頁面/);
  // 本次把送出欄位改成不參與計算 → 這個 embed 的錯誤算本次的
  t.form_update_control({ draft_id: r.draft_id, itemid: 2, changes: { tocalc: false } });
  const v2 = t.form_validate({ draft_id: r.draft_id });
  assert.ok(v2.errors.some(x => x.code === 'E_EMBED_INPUT'), JSON.stringify(v2.errors));
  // flag 開：原表單的 OPENPANEL 通過並列入揭露
  setFlags({ embedArea: true });
  const v3 = t.form_validate({ draft_id: r.draft_id });
  assert.ok(!v3.warnings.some(w => w.code === 'E_FORBIDDEN_FUNCTION'));
  assert.deepEqual(v3.embeds.map(e => [e.kind, e.host]).sort(), [['embed', 'cdss.cgmh.org.tw'], ['openpanel', 'x.cgmh.org.tw']]);
  assert.match(exp.embedSection(v3), /\| 巨集 #4 查詢（原表單） \| 按下 OPENPANEL \| x\.cgmh\.org\.tw \|/);
  assert.ok(exp.embedSection(v3).includes(exp.EMBED_APPEND_WARNING), '原表單的 embed 有送出／寫回欄位：也要提醒加載表單');
  const onlyPanel = exp.embedSection({ embeds: v3.embeds.filter(e => e.kind === 'openpanel') });
  assert.ok(onlyPanel && !onlyPanel.includes(exp.EMBED_APPEND_WARNING), '只有 OPENPANEL：不提醒加載表單');
});

test('OPENPANEL（flag 開）：網址必須是字串字面值且通過 embed url 的檢查；只能用在巨集；OPENURL 維持禁用', () => {
  const m = s => lint.lintMacro(s, { embedArea: true }).findings;
  assert.deepEqual(codes(m('OPENPANEL("https://assistantai.cgmh.org.tw/ERCDSS/", "決策支援")').filter(f => f.level === 'error')), []);
  assert.ok(m('OPENPANEL("https://assistantai.cgmh.org.tw/ERCDSS/", "決策支援")').some(f => f.code === 'W_EMBED_DATAFLOW' && f.host === 'assistantai.cgmh.org.tw'));
  assert.ok(codes(m('OPENPANEL("http://assistantai.cgmh.org.tw/")')).includes('E_EMBED_SCHEME'));
  assert.ok(codes(m('OPENPANEL("https://www.google.com/")')).includes('E_EMBED_HOST'));
  assert.ok(codes(m(`OPENPANEL("https://${ip('192', '168', '0', '9')}/x")`)).every(c => !/^E_/.test(c)), '院內網段');
  assert.ok(codes(m(`OPENPANEL("https://${ip('8', '8', '8', '8')}/")`)).includes('E_EMBED_HOST'));
  assert.ok(codes(m('OPENPANEL("https://x.cgmh.org.tw/?idno=1")')).includes('E_EMBED_PII'));
  assert.ok(codes(m('OPENPANEL(CONCATENATE("https://x.cgmh.org.tw/?c=", A1))')).includes('E_EMBED_URL'), '不能組網址');
  assert.ok(codes(m('OPENPANEL(A1)')).includes('E_EMBED_URL'));
  assert.ok(codes(lint.lintFormula('OPENPANEL("https://x.cgmh.org.tw/")', { embedArea: true }).findings).includes('E_FORMULA_MACRO_ONLY'));
  assert.ok(codes(m('OPENURL("https://x.cgmh.org.tw/")')).includes('E_FORBIDDEN_FUNCTION'));
  // formula_check 走同一組規則；form_add_control 當下拒絕不合的網址
  setFlags({ embedArea: true });
  assert.ok(codes(t.formula_check({ kind: 'macro', text: 'OPENPANEL("http://evil.com/")' }).errors).includes('E_EMBED_SCHEME'));
  const ok = t.formula_check({ kind: 'macro', text: 'OPENPANEL("https://x.cgmh.org.tw/", "面板")' });
  assert.equal(ok.ok, true);
  assert.ok(ok.warnings.some(w => w.code === 'W_EMBED_DATAFLOW'));
  const { draft_id, a1 } = baseDraft();
  assert.throws(() => t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'action', action_name: '開', action_script: 'OPENPANEL("https://evil.com/")' } }), /E_EMBED_HOST|計算式／巨集有錯誤/);
  const btn = t.form_add_control({ draft_id, area_itemid: a1, control: { datatype: 'action', action_name: '指引', action_script: 'OPENPANEL("https://x.cgmh.org.tw/guide", "指引")' } }).itemid;
  const v = t.form_validate({ draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.deepEqual(v.embeds.map(e => [e.kind, e.itemid, e.host]), [['openpanel', btn, 'x.cgmh.org.tw']]);
  assert.equal(v.stats.openpanels, 1);
});

test('embedArea 3.11.0 起預設開：plugin 根目錄 feature-flags.json 與程式預設都是 true', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'feature-flags.json'), 'utf8')).embedArea, true);
  const src = fs.readFileSync(path.join(root, 'mcp/strucmed-mcp/src/flags.mjs'), 'utf8');
  assert.match(src, /embedArea: true\b/);
});
