// 3.9.1 不靜默（docs/16 M1、M2、M4）：未知參數回錯誤、單位可直接設定、同一字典多欄位寫入提示。
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
let ws, t, store, proc, rl, seq = 0;
const waiting = new Map();

function rpc(method, params) {
  const id = ++seq;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise(res => waiting.set(id, res));
}
const call = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-nosilent-'));
  process.env.STRUCMED_WORKSPACE = ws;
  t = Object.fromEntries((await import('../src/tools.mjs')).TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  proc = spawn(process.execPath, [SERVER], { env: { ...process.env, STRUCMED_WORKSPACE: ws, STRUCMED_SITE: 'offline' }, stdio: ['pipe', 'pipe', 'ignore'] });
  rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', l => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
});
after(() => { rl.close(); proc.kill(); fs.rmSync(ws, { recursive: true, force: true }); });

function one(extra = {}) {
  const { draft_id } = t.form_create({ name: '不靜默', dept_no: 'TEST0' });
  const { area_itemid } = t.form_add_area({ draft_id, title: '評估' });
  const itemid = t.form_add_control({ draft_id, area_itemid, label_text: '體重：', control: { datatype: 'numberbox', ...extra } }).itemid;
  return { draft_id, area_itemid, itemid };
}

test('form_update_control：changes 的未知鍵回 E_UNKNOWN_KEY，什麼都不改，並提示正確寫法', () => {
  const { draft_id, itemid } = one();
  const before = store.loadDraft(draft_id);
  assert.throws(() => t.form_update_control({ draft_id, itemid, changes: { caption: '新說明', required: true } }), e => {
    assert.equal(e.code, 'E_UNKNOWN_KEY');
    assert.match(e.message, /caption/);
    assert.match(e.message, /label_text/);
    assert.deepEqual(e.details.unknown, ['caption']);
    assert.ok(e.details.allowed.includes('required'));
    return true;
  });
  assert.deepEqual(store.loadDraft(draft_id), before, '有未知鍵時整筆不寫入，required 也沒有改');
  assert.throws(() => t.form_update_control({ draft_id, itemid, changes: { dictionary: { name: 'X', desc: '說明' } } }), { code: 'E_UNKNOWN_KEY' });
  // 所有 changes 鍵都走得過白名單（review 的 suggested_calls 用到的鍵）
  t.form_update_control({ draft_id, itemid, label_text: '體重(kg)：', changes: { datavalue: '60', required: true, minval: 1, maxval: 300 } });
  assert.equal(t.form_fields({ draft_id }).fields[0].caption, '體重(kg)');
});

test('form_add_control：control 與 control.dictionary 的未知鍵回 E_UNKNOWN_KEY', () => {
  const { draft_id, area_itemid } = one();
  assert.throws(() => t.form_add_control({ draft_id, area_itemid, control: { datatype: 'textbox', caption: 'x' } }), { code: 'E_UNKNOWN_KEY' });
  assert.throws(() => t.form_add_control({ draft_id, area_itemid, control: { datatype: 'textbox', dictionary: { name: 'X', unit: 'kg' } } }), { code: 'E_UNKNOWN_KEY' });
  assert.equal(store.loadDraft(draft_id).nextItemId, 3, '失敗不占用 itemid');
});

test('server：所有工具 additionalProperties:false，schema 外的頂層鍵回 E_INVALID_INPUT', async () => {
  const { result } = await rpc('tools/list', {});
  assert.ok(result.tools.length > 20);
  for (const x of result.tools) assert.equal(x.inputSchema.additionalProperties, false, x.name);
  const u = result.tools.find(x => x.name === 'form_update_control').inputSchema;
  assert.equal(u.properties.changes.additionalProperties, false);
  assert.ok(u.properties.changes.properties.unit);
  const { data: { draft_id } } = await call('form_create', { name: 'schema', dept_no: 'TEST0' });
  const r = await call('form_update_control', { draft_id, itemid: 1, caption: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_INVALID_INPUT');
  assert.match(r.error.message, /caption/);
  assert.match(r.error.message, /label_text/);
  assert.deepEqual(r.error.details.unknown, ['caption']);
  const none = await call('form_search', { q: 'x' });
  assert.equal(none.error.code, 'E_INVALID_INPUT');
  assert.equal((await call('form_search', { query: 'schema' })).ok, true);
});

test('changes.unit：寫入 draft、不進表單 JSON、優先於說明文字，"" 清除；form_fields 回 unit_source', () => {
  const { draft_id, itemid } = one();
  const field = () => t.form_fields({ draft_id }).fields.find(f => f.itemid === itemid);
  assert.equal(field().unit_source, 'none');
  t.form_update_control({ draft_id, itemid, label_text: '體重(公斤)：' });
  assert.deepEqual([field().unit, field().unit_source], ['公斤', 'caption']);
  const r = t.form_update_control({ draft_id, itemid, changes: { unit: 'kg' } });
  assert.equal(r.unit, 'kg');
  assert.deepEqual([field().unit, field().unit_source], ['kg', 'set']);
  assert.equal(field().derived.unit, 'kg');
  t.form_preview({ draft_id, format: 'html' });
  assert.ok(!fs.readFileSync(path.join(ws, '.strucmed', 'preview', `${draft_id}.json`), 'utf8').includes('"unit"'), '單位只存 draft，不進表單 JSON');
  t.form_update_control({ draft_id, itemid, changes: { unit: '' } });
  assert.deepEqual([field().unit, field().unit_source], ['公斤', 'caption']);
  assert.throws(() => t.form_update_control({ draft_id, itemid, changes: { unit: 'x'.repeat(21) } }), { code: 'E_INVALID_INPUT' });
});

test('control.unit 在建立時設定；說明文字的（M）不再被當成單位', () => {
  const { draft_id, area_itemid } = one({ unit: 'kg' });
  assert.deepEqual([t.form_fields({ draft_id }).fields[0].unit, t.form_fields({ draft_id }).fields[0].unit_source], ['kg', 'set']);
  const cdr = t.form_add_control({ draft_id, area_itemid, label_text: 'CDR 記憶（M）：', control: { datatype: 'numberbox' } }).itemid;
  const f = t.form_fields({ draft_id }).fields.find(x => x.itemid === cdr);
  assert.equal(f.unit, undefined);
  assert.equal(f.unit_source, 'none');
});

test('form_remove_control 一併清掉單位', () => {
  const { draft_id, itemid } = one({ unit: 'kg' });
  const { confirm_token } = t.form_remove_control({ draft_id, itemid });
  t.form_remove_control({ draft_id, itemid, confirm_token });
  assert.deepEqual(store.loadDraft(draft_id).units, {});
});

test('W_DICT_DUP_WRITE：同一字典被兩個以上 tohis／puthis 欄位寫入時提示，不阻擋；fromhis 不算', () => {
  const { draft_id, area_itemid, itemid } = one({ dictionary: { name: 'BW_DUP', comment: '體重' } });
  const dup = () => t.form_validate({ draft_id }).warnings.filter(w => w.code === 'W_DICT_DUP_WRITE');
  assert.deepEqual(dup(), []);
  const b = t.form_add_control({ draft_id, area_itemid, label_text: '複測：', control: { datatype: 'numberbox', dictionary: { name: 'BW_DUP' } } }).itemid;
  const [w] = dup();
  assert.match(w.message, /存檔只留第一個有值的欄位/);
  assert.ok(w.message.includes(`#${itemid}、#${b}`));
  assert.equal(w.itemid, itemid);
  assert.equal(t.form_validate({ draft_id }).valid, true, '只提示，不阻擋');
});

test('M14：formula 型 label 可先留空，form_validate 回 E_FORMULA_EMPTY；補上公式後通過', () => {
  const { draft_id, area_itemid } = one();
  const b = t.form_add_control({ draft_id, area_itemid, label_text: '總分：', control: { datatype: 'label', format: 'formula' } }).itemid;
  const v = t.form_validate({ draft_id });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => e.code === 'E_FORMULA_EMPTY' && e.itemid === b));
  t.form_update_control({ draft_id, itemid: b, changes: { formula: 'A2 + 1' } });
  assert.equal(t.form_validate({ draft_id }).valid, true);
});

test('M14：欄位名稱不截掉前綴；兩個以上空白才視為分段', () => {
  const { draft_id, area_itemid } = one();
  const a = t.form_add_control({ draft_id, area_itemid, label_text: 'BMI 計算（測試）：身高（cm）：', control: { datatype: 'numberbox' } }).itemid;
  const b = t.form_add_control({ draft_id, area_itemid, label_text: '第二段  體重：', control: { datatype: 'numberbox' } }).itemid;
  const f = id => t.form_fields({ draft_id }).fields.find(x => x.itemid === id);
  assert.equal(f(a).caption, 'BMI 計算（測試）：身高（cm）');
  assert.equal(f(a).unit, 'cm');
  assert.equal(f(b).caption, '體重');
  const d = t.form_add_control({ draft_id, area_itemid, label_text: ' mmHg 舒張壓：', control: { datatype: 'numberbox' } }).itemid;
  assert.equal(f(d).caption, '舒張壓', '開頭有空白：前一格的單位接這一格的名稱');
  const c = t.formula_check({ kind: 'formula', text: `A${a} + 1`, draft_id });
  assert.equal(c.labeled, '[BMI 計算（測試）：身高（cm）] + 1');
});

test('M14：只有空白的說明文字視為無說明，不算區塊的可見標題', () => {
  const { draft_id } = t.form_create({ name: '空白說明', dept_no: 'TEST0' });
  const { area_itemid } = t.form_add_area({ draft_id, title: '標題' });
  t.form_add_control({ draft_id, area_itemid, label_text: ' ', control: { datatype: 'label', datavalue: '可見的文字' } });
  assert.ok(!t.form_validate({ draft_id }).warnings.some(w => w.code === 'W_AREA_NO_VISIBLE_HEADING'), '第一個有內容的節點是可見文字');
});

test('M14：fhir_status 離線一律填沿用既有或待人工確認', () => {
  const { draft_id } = one({ dictionary: { name: 'FHIR_NEW', comment: '新' } });
  const { file } = t.dictionary_plan_export({ draft_id });
  assert.ok(fs.readFileSync(path.join(ws, file), 'utf8').includes('待人工確認'));
});

test('M14：VERSION 取自 package.json，generator 與實際版本一致', async () => {
  const { VERSION } = await import('../src/export.mjs');
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '../package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal(pkg.version, '2.13.1');
});

test('M15：所有線上寫入工具的描述以寫入性質開頭', async () => {
  const { ONLINE_WRITE_TOOLS } = await import('../src/online-write-tools.mjs');
  const writers = ONLINE_WRITE_TOOLS.filter(x => !/唯讀/.test(x.description.slice(0, 20)));
  assert.equal(writers.length, 7);
  for (const x of writers) {
    assert.ok(x.description.startsWith('（只產生計畫，不寫入）'), x.name);
    assert.ok(x.description.includes('（寫入，需 confirm_token 與瀏覽器確認）'), x.name);
    assert.ok(x.description.includes('回 pending'), x.name);
  }
});
