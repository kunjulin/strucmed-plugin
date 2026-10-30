// Streamable HTTP transport: the same server over POST <path>, in a throw-away workspace.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpConfig, DEFAULT_HOST, DEFAULT_PATH } from '../src/http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../src/server.mjs');
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
let ws, proc, url, seq = 0;

function startServer(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => {
      err += d;
      const m = /; http: (http:\/\/[^\s]+)/.exec(err);
      if (m) resolve({ p, url: m[1], stdout: () => out, stderr: () => err });
    });
    p.once('exit', code => reject(new Error(`server exited ${code}: ${err}`)));
    setTimeout(() => reject(new Error('server did not start: ' + err)), 8000).unref();
  });
}

async function post(body, { token = TOKEN, headers = {}, raw = false, path: p } = {}) {
  const target = p ? new URL(p, url).toString() : url;
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}
const rpc = async (method, params) => (await post({ jsonrpc: '2.0', id: ++seq, method, params })).body;
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return { isError: !!r.result.isError, ...JSON.parse(r.result.content[0].text) };
}

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-http-'));
  const started = await startServer({ STRUCMED_WORKSPACE: ws, STRUCMED_HTTP_PORT: '0', STRUCMED_HTTP_TOKEN: TOKEN, STRUCMED_SITE: '' });
  proc = started.p; url = started.url;
  proc.stdoutText = started.stdout; proc.stderrText = started.stderr;
});
after(() => { proc.kill(); fs.rmSync(ws, { recursive: true, force: true }); });

test('httpConfig: unset → stdio; validates port, host/token pairing, path', () => {
  assert.equal(httpConfig({}), null);
  assert.equal(httpConfig({ STRUCMED_HTTP_PORT: '${user_config.port}' }), null, 'unexpanded placeholder counts as unset');
  assert.deepEqual(httpConfig({ STRUCMED_HTTP_PORT: '8765' }), { port: 8765, host: DEFAULT_HOST, token: '', path: DEFAULT_PATH });
  assert.throws(() => httpConfig({ STRUCMED_HTTP_PORT: 'abc' }), /STRUCMED_HTTP_PORT/);
  assert.throws(() => httpConfig({ STRUCMED_HTTP_PORT: '70000' }), /STRUCMED_HTTP_PORT/);
  assert.throws(() => httpConfig({ STRUCMED_HTTP_PORT: '8765', STRUCMED_HTTP_HOST: '0.0.0.0' }), /STRUCMED_HTTP_TOKEN/, 'non-loopback bind needs a token');
  assert.equal(httpConfig({ STRUCMED_HTTP_PORT: '8765', STRUCMED_HTTP_HOST: '0.0.0.0', STRUCMED_HTTP_TOKEN: 't' }).host, '0.0.0.0');
  assert.equal(httpConfig({ STRUCMED_HTTP_PORT: '1', STRUCMED_HTTP_PATH: 'api/mcp/' }).path, '/api/mcp');
});

test('http: defaults to offline (no online tools) and keeps stdout free', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'strucmed-mcp');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map(t => t.name);
  for (const n of ['form_create', 'form_add_control', 'form_validate', 'form_export']) assert.ok(names.includes(n), n);
  assert.ok(!names.some(n => n.startsWith('online_')), 'HTTP mode runs offline by default');
  assert.match(proc.stderrText(), /site: .*離線|offline/i);
  assert.equal(proc.stdoutText(), '', 'nothing on stdout in HTTP mode');
});

test('http: full offline flow create → add → validate → export plan', async () => {
  const { draft_id } = (await call('form_create', { name: 'HTTP 跌倒評估', dept_no: 'TEST0', shortcut: 'HttpFall', groups: ['門'], folder_type: 'dpt' })).data;
  const { area_itemid } = (await call('form_add_area', { draft_id, title: '評估' })).data;
  const added = await call('form_add_control', { draft_id, area_itemid, label_text: '跌倒史：', control: { datatype: 'radiobutton', options: ['有', '無'] } });
  assert.equal(added.ok, true, JSON.stringify(added));
  const v = await call('form_validate', { draft_id });
  assert.equal(v.ok, true);
  assert.equal(v.data.errors.length, 0, JSON.stringify(v.data.errors));
  const plan = await call('form_export', { draft_id });
  assert.equal(plan.ok, true);
  assert.ok(plan.data.confirm_token, 'two-step export still returns a plan with confirm_token');
  assert.ok(!fs.existsSync(path.join(ws, 'output')) || fs.readdirSync(path.join(ws, 'output')).length === 0, 'plan step writes nothing');
});

test('http: dictionary_load and form_import take content, since the caller cannot see server files', async () => {
  const csv = '\ufeff"id","dicType","dictName","dicComment","createUser","createDate"\r\n"D1","TEST0","體重","體重（kg）","u","20250101"\r\n';
  const loaded = await call('dictionary_load', { csv_text: csv, csv_name: '../../字典.csv', dept_no: 'TEST0' });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.data.count, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, '.strucmed/dictionaries.json'), 'utf8')).source, '字典.csv', 'file name never carries a path');
  assert.equal((await call('dictionary_search', { query: '體重' })).data.results[0].id, 'D1');
  const { draft_id } = (await call('form_create', { name: '字典綁定', dept_no: 'TEST0' })).data;
  const { area_itemid } = (await call('form_add_area', { draft_id, title: '生命徵象' })).data;
  assert.equal((await call('form_add_control', { draft_id, area_itemid, label_text: '體重', control: { datatype: 'numberbox', dictionary: { name: '體重' } } })).ok, true);
  assert.equal((await call('form_preview', { draft_id, format: 'tree' })).ok, true);
  const bound = JSON.parse(fs.readFileSync(path.join(ws, '.strucmed/drafts', `${draft_id}.json`), 'utf8'));
  assert.deepEqual(bound.pendingDictionaries, [], 'name resolves against the loaded index instead of queuing a new dictionary');

  const form = fs.readFileSync(path.join(HERE, 'fixtures/existing-form.json'), 'utf8');
  const imported = await call('form_import', { source_text: form, source_name: '原表單.json', name: '改版', dept_no: 'TEST0' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.data.source_kind, 'getdata-json');
  assert.equal(imported.data.derived_from.name, '原表單');
  assert.equal((await call('form_import', { source_text: form, source_name: '原表單.json', name: '原表單', dept_no: 'TEST0' })).ok, false, 'file name still guards the original name');
  assert.equal((await call('form_import', { source_text: form, name: '不帶檔名', dept_no: 'TEST0' })).ok, true);
  assert.equal((await call('form_import', { source_text: '<html></html>', name: 'x', dept_no: 'TEST0' })).error.code, 'E_INVALID_INPUT');

  for (const args of [{}, { csv_path: 'a.csv', csv_text: csv }, { csv_path: '', csv_text: '' }]) {
    assert.match((await call('dictionary_load', { ...args, dept_no: 'TEST0' })).error.message, /擇一/);
  }
  assert.equal((await call('dictionary_load', { csv_path: '', csv_text: csv, dept_no: 'TEST0' })).ok, true, 'blank optional path from an agent platform is ignored');
  assert.match((await call('form_import', { name: 'x', dept_no: 'TEST0' })).error.message, /擇一/);
  assert.equal((await post({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: 'dictionary_load', arguments: { csv_text: 'x'.repeat(1024 * 1024), dept_no: 'TEST0' } } })).status, 413);
});

test('http: after_itemid inserts next to the anchor, whatever order the platform called in', async () => {
  const { draft_id } = (await call('form_create', { name: '順序', dept_no: 'TEST0' })).data;
  const { area_itemid } = (await call('form_add_area', { draft_id, title: '評估' })).data;
  const add = (label_text, extra = {}) => call('form_add_control', { draft_id, area_itemid, label_text, control: { datatype: 'textbox' }, ...extra });
  const a = (await add('甲')).data.itemid, c = (await add('丙')).data.itemid;
  const b = (await add('乙', { after_itemid: a })).data.itemid;
  const d2 = (await add('丁', { after_itemid: c })).data.itemid;
  assert.ok(b > c, 'itemid still follows creation order');
  const read = () => JSON.parse(fs.readFileSync(path.join(ws, '.strucmed/drafts', `${draft_id}.json`), 'utf8'));
  const seq = items => items.map(n => n.datatype === 'newline' ? '/' : n.datatype === 'text' ? n.datavalue : n.itemid);
  assert.deepEqual(seq(read().areas[0].items), ['甲', a, '/', '乙', b, '/', '丙', c, '/', '丁', d2, '/']);

  const before = read().nextItemId;
  const missing = await add('戊', { after_itemid: 999 });
  assert.equal(missing.error.code, 'E_NOT_FOUND');
  assert.equal(read().nextItemId, before, 'a refused insert consumes no itemid');
  assert.equal((await add('己', { after_itemid: area_itemid })).error.code, 'E_NOT_FOUND', 'the anchor must be a control');

  const form = fs.readFileSync(path.join(HERE, 'fixtures/existing-form.json'), 'utf8');
  const imported = (await call('form_import', { source_text: form, name: '既有區塊插入', dept_no: 'TEST0' })).data;
  const importedPath = path.join(ws, '.strucmed/drafts', `${imported.draft_id}.json`);
  const stored = () => JSON.parse(fs.readFileSync(importedPath, 'utf8')).areas.find(x => x.area.itemtype === 'form').area;
  const area = stored().itemid;
  const controls = stored().item.filter(n => n.itemid !== undefined && n.datatype !== 'text' && n.datatype !== 'newline');
  const put = (after_itemid) => call('form_add_control', { draft_id: imported.draft_id, area_itemid: area, label_text: '插入', after_itemid, control: { datatype: 'textbox' } });
  const lastId = controls[controls.length - 1].itemid;
  const tail = (await put(lastId)).data.itemid;
  assert.deepEqual(seq(stored().item).slice(-4), [lastId, '/', '插入', tail], 'imported stream keeps no trailing newline');
  assert.ok(controls.length > 1);
  const mid = (await put(controls[0].itemid)).data.itemid;
  const items = seq(stored().item);
  assert.ok(items.indexOf(mid) > items.indexOf(controls[0].itemid) && items.indexOf(mid) < items.indexOf(lastId));
  assert.equal((await call('form_validate', { draft_id: imported.draft_id })).data.errors.length, 0);
});

test('http: form_validate reports when the draft changed, without affecting the export token', async () => {
  const { draft_id } = (await call('form_create', { name: '版本', dept_no: 'TEST0' })).data;
  const { area_itemid } = (await call('form_add_area', { draft_id, title: '評估' })).data;
  const first = (await call('form_validate', { draft_id })).data;
  assert.match(first.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await call('form_validate', { draft_id, updated_at: first.updated_at })).data.updated_at, first.updated_at, 'validating changes nothing');
  await new Promise(r => setTimeout(r, 5));
  await call('form_add_control', { draft_id, area_itemid, label_text: '欄位', control: { datatype: 'textbox' } });
  assert.notEqual((await call('form_validate', { draft_id, updated_at: first.updated_at })).data.updated_at, first.updated_at);
  const plan = (await call('form_export', { draft_id })).data;
  await call('form_validate', { draft_id });
  assert.equal((await call('form_export', { draft_id, confirm_token: plan.confirm_token })).ok, true);
});

test('http: shortcut is stored lowercase, as the platform requires, and says so', async () => {
  const created = (await call('form_create', { name: '捷徑', dept_no: 'TEST0', shortcut: 'FallRisk' })).data;
  assert.equal(created.shortcut, 'fallrisk');
  assert.match(created.shortcut_note, /FallRisk → fallrisk/);
  assert.equal((await call('form_create', { name: '捷徑二', dept_no: 'TEST0', shortcut: 'fall' })).data.shortcut_note, undefined);
  assert.equal((await call('form_create', { name: '捷徑三', dept_no: 'TEST0' })).data.shortcut_note, undefined);
  const updated = (await call('form_update_meta', { draft_id: created.draft_id, shortcut: 'ParTest' })).data;
  assert.equal(updated.meta.shortcut, 'partest');
  assert.match(updated.shortcut_note, /ParTest → partest/);
  const form = fs.readFileSync(path.join(HERE, 'fixtures/existing-form.json'), 'utf8');
  assert.match((await call('form_import', { source_text: form, name: '捷徑四', shortcut: 'ImpTest', dept_no: 'TEST0' })).data.shortcut_note, /ImpTest → imptest/);
});

test('http: protocol edge cases (notification → 202, batch, unknown method, parse error)', async () => {
  const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(n.status, 202);
  assert.equal(n.body, undefined);
  const b = await post([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 'b', method: 'nope' }]);
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.map(r => r.id), ['a', 'b']);
  assert.equal(b.body[1].error.code, -32601);
  const bad = await post('{not json', { raw: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, -32700);
  const invalid = await post({ id: 1, method: 'ping' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, -32600);
});

test('http: auth and surface — bearer, Origin, method, path, content-type', async () => {
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: '' })).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: TOKEN + 'x' })).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { path: '/other' })).status, 404);
  assert.equal((await post('x', { raw: true, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const get = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(get.status, 405);
  const del = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(del.status, 405);
  assert.ok(!proc.stderrText().includes(TOKEN), 'token never logged');
});

test('http: refuses to start on a non-loopback host without a token', async () => {
  await assert.rejects(startServer({ STRUCMED_WORKSPACE: ws, STRUCMED_HTTP_PORT: '0', STRUCMED_HTTP_HOST: '0.0.0.0', STRUCMED_HTTP_TOKEN: '' }), /exited 2/);
});
