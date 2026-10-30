// MCP Apps card: tool _meta, resources, structuredContent on preview/export, signed download links (HTTP mode).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../src/server.mjs');
const TOKEN = 'card-token-' + Math.random().toString(36).slice(2);
let ws, proc, url, seq = 0;

function startServer(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; const m = /; http: (http:\/\/[^\s]+)/.exec(err); if (m) resolve({ p, url: m[1] }); });
    p.once('exit', code => reject(new Error(`server exited ${code}: ${err}`)));
    setTimeout(() => reject(new Error('server did not start: ' + err)), 8000).unref();
  });
}
async function post(body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
  return res.json();
}
const rpc = async (method, params) => (await post({ jsonrpc: '2.0', id: ++seq, method, params })).result;
const call = (name, args) => rpc('tools/call', { name, arguments: args });
const text = r => JSON.parse(r.content[0].text);

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-cards-'));
  const started = await startServer({ STRUCMED_WORKSPACE: ws, STRUCMED_HTTP_PORT: '0', STRUCMED_HTTP_TOKEN: TOKEN, STRUCMED_SITE: '', STRUCMED_PUBLIC_URL: '' });
  proc = started.p; url = started.url;
});
after(() => { proc.kill(); fs.rmSync(ws, { recursive: true, force: true }); });

test('tools/list links the card to form_preview and form_export only; resources expose the card HTML', async () => {
  const { tools } = await rpc('tools/list', {});
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.equal(byName.form_preview._meta.ui.resourceUri, 'ui://strucmed/form-card.html');
  assert.equal(byName.form_export._meta.ui.resourceUri, 'ui://strucmed/form-card.html');
  assert.equal(byName.form_create._meta, undefined);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.ok(init.capabilities.resources, 'declares resources capability');
  const { resources } = await rpc('resources/list', {});
  assert.equal(resources[0].mimeType, 'text/html;profile=mcp-app');
  const read = await rpc('resources/read', { uri: 'ui://strucmed/form-card.html' });
  assert.match(read.contents[0].text, /ui\/initialize/);
  assert.match(read.contents[0].text, /__MCP_INITIAL_RENDER_DATA__/);
  assert.match(read.contents[0].text, /snakeKeys/, 'card accepts camelCased structured data');
  const missing = await post({ jsonrpc: '2.0', id: ++seq, method: 'resources/read', params: { uri: 'ui://nope' } });
  assert.equal(missing.error.code, -32002);
});

test('preview and export carry structuredContent; export plan → confirm → files with signed download links', async () => {
  const { draft_id } = text(await call('form_create', { name: '卡片測試單', dept_no: 'TEST0', groups: ['門'] })).data;
  const { area_itemid } = text(await call('form_add_area', { draft_id, title: '評估' })).data;
  await call('form_add_control', { draft_id, area_itemid, label_text: '跌倒史：', control: { datatype: 'radiobutton', options: ['有', '無'] } });
  await call('form_add_control', { draft_id, area_itemid, label_text: '備註：', control: { datatype: 'textarea' } });

  const pv = await call('form_preview', { draft_id, format: 'markdown' });
  assert.equal(pv._meta.ui.resourceUri, 'ui://strucmed/form-card.html');
  const card = pv.structuredContent;
  assert.equal(card.kind, 'preview');
  assert.equal(card.form.name, '卡片測試單');
  assert.equal(card.areas.length, 1);
  const controls = card.areas[0].rows.flat().filter(i => i.type === 'control');
  assert.deepEqual(controls.map(c => c.datatype), ['radiobutton', 'textarea']);
  assert.deepEqual(controls[0].options, ['有', '無']);
  assert.equal(card.validation.valid, true);
  assert.match(card.ui_hints.modelContext, /卡片測試單/);
  assert.equal((await call('form_preview', { draft_id, format: 'html' })).structuredContent, undefined, 'html preview has no card');
  assert.equal((await call('form_validate', { draft_id })).structuredContent, undefined, 'non-card tools stay text-only');

  const plan = await call('form_export', { draft_id });
  assert.equal(plan.structuredContent.kind, 'export_plan');
  assert.ok(plan.structuredContent.confirm_token);
  assert.ok(plan.structuredContent.plan.files.length === 3);

  const done = await call('form_export', { draft_id, confirm_token: plan.structuredContent.confirm_token, include_content: true });
  const d = text(done).data;
  assert.equal(d.htm, undefined, 'the .htm is not in the text result');
  const emb = done.content.find(c => c.type === 'resource');
  assert.equal(emb.resource.uri, 'strucmed://export/' + draft_id + '/htm');
  assert.match(emb.resource.text, /<!DOCTYPE html>|<html/i, 'include_content returns the .htm as an embedded resource');
  assert.equal(d.resources.htm, emb.resource.uri);
  const read = await rpc('resources/read', { uri: d.resources.htm });
  assert.equal(read.contents[0].text, emb.resource.text, 'resources/read serves the same file');
  assert.equal((await post({ jsonrpc: '2.0', id: ++seq, method: 'resources/read', params: { uri: 'strucmed://export/' + draft_id + '/nope' } })).error.code, -32002);
  const { resourceTemplates } = await rpc('resources/templates/list', {});
  assert.match(resourceTemplates[0].uriTemplate, /^strucmed:\/\/export\//);
  assert.ok(d.download.htm.startsWith(url.replace(/\/mcp$/, '') + '/mcp/files/' + draft_id + '/htm?t='), d.download.htm);
  assert.equal(done.structuredContent.kind, 'exported');
  const htmFile = done.structuredContent.files.find(f => f.kind === 'htm');
  assert.equal(htmFile.url, d.download.htm);
  assert.equal(htmFile.sha256, d.sha256.htm);

  // signed download works with no bearer header (a browser opens it); tampered or expired tokens are 404
  const res = await fetch(d.download.htm);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename\*=UTF-8''/);
  assert.equal(await res.text(), emb.resource.text);
  assert.equal((await fetch(d.download.htm.replace(/t=[^&]+/, 't=1.deadbeef'))).status, 404);
  assert.equal((await fetch(d.download.htm.replace('/htm?', '/manifest?'))).status, 404, 'token is bound to the kind');
  assert.equal((await fetch(d.download.htm, { method: 'POST' })).status, 405);

  // links follow the recorded file, not the form name: a renamed draft keeps serving its export, and the
  // rename does not count as an edit (updated unchanged by the export record itself)
  await call('form_update_meta', { draft_id, name: '卡片測試單改名' });
  assert.equal((await fetch(d.download.htm)).status, 200, 'renamed draft still serves the exported file');
  // a custom out_dir inside the workspace gets links too; the link then points at the latest export
  const plan2 = await call('form_export', { draft_id, out_dir: 'exports/sub', overwrite: true });
  const done2 = text(await call('form_export', { draft_id, out_dir: 'exports/sub', overwrite: true, confirm_token: plan2.structuredContent.confirm_token })).data;
  assert.match(done2.files.htm, /^exports\/sub\//);
  const res2 = await fetch(done2.download.htm);
  assert.equal(res2.status, 200);
  assert.match(res2.headers.get('content-disposition'), /%E6%94%B9%E5%90%8D\.htm/, 'file is named after the renamed draft');
  assert.equal(await (await fetch(d.download.htm)).text(), await res2.text(), 'an older link of the same draft serves the latest export');
});

test('STRUCMED_PUBLIC_URL overrides the derived origin in download links', async () => {
  const s = await startServer({ STRUCMED_WORKSPACE: ws, STRUCMED_HTTP_PORT: '0', STRUCMED_HTTP_TOKEN: TOKEN, STRUCMED_SITE: '', STRUCMED_PUBLIC_URL: 'https://forms.example.org/' });
  try {
    const res = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'form_search', arguments: {} } }) });
    assert.equal(res.status, 200);
    const { draft_id } = JSON.parse((await res.json()).result.content[0].text).data.items[0];
    const plan = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'form_export', arguments: { draft_id, overwrite: true } } }) }).then(r => r.json());
    const token = plan.result.structuredContent.confirm_token;
    const done = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'form_export', arguments: { draft_id, overwrite: true, confirm_token: token } } }) }).then(r => r.json());
    assert.match(JSON.parse(done.result.content[0].text).data.download.htm, /^https:\/\/forms\.example\.org\/mcp\/files\//);
  } finally { s.p.kill(); }
});
