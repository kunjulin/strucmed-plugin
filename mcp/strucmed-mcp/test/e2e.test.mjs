// End-to-end over the real stdio protocol, in a throw-away workspace.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { extractPackage, validatePackage } from '../src/package.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../src/server.mjs');
let ws, proc, rl, seq = 0;
const pending = new Map();

function rpc(method, params) {
  const id = ++seq;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => rej(new Error('timeout ' + method)), 5000); });
}
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const body = JSON.parse(r.result.content[0].text);
  return { isError: !!r.result.isError, ...body };
}

before(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-e2e-'));
  fs.writeFileSync(path.join(ws, 'dict.csv'),
    '"id","dicType","dictName","dicComment","createUser","createDate"\r\n' +
    '"e2e-id-1","TEST","E2E_FALL","跌倒史","U1","2026-01-01"\r\n');
  proc = spawn(process.execPath, [SERVER], { env: { ...process.env, STRUCMED_WORKSPACE: ws }, stdio: ['pipe', 'pipe', 'pipe'] });
  rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', l => {
    const m = JSON.parse(l);                       // stdout must be pure JSON-RPC
    const p = pending.get(m.id); if (p) { pending.delete(m.id); p.res(m); }
  });
});
after(() => { proc.kill(); fs.rmSync(ws, { recursive: true, force: true }); });

test('stdio: a local user can still load a CSV from outside the workspace, but not a directory', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-e2e-outside-'));
  try {
    fs.copyFileSync(path.join(ws, 'dict.csv'), path.join(outside, 'dict.csv'));
    assert.equal((await call('dictionary_load', { csv_path: path.join(outside, 'dict.csv'), dept_no: 'TEST0' })).data.count, 1);
    assert.match(JSON.stringify(await call('dictionary_load', { csv_path: outside, dept_no: 'TEST0' })), /E_INVALID_INPUT/);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test('full offline flow: create → add → validate → preview → export (two-step)', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'strucmed-mcp');
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map(t => t.name);
  for (const n of ['dictionary_load', 'form_create', 'form_add_control', 'form_validate', 'form_export']) assert.ok(names.includes(n));
  assert.ok(!names.includes('login'), 'no online tools in v0.1');

  assert.equal((await call('dictionary_load', { csv_path: 'dict.csv', dept_no: 'TEST0' })).data.count, 1);
  const { draft_id } = (await call('form_create', { name: 'E2E 跌倒評估', dept_no: 'TEST0', shortcut: 'E2EFall',
    groups: ['門', '住'], description: 'e2e </script> 測試', folder_type: 'dpt' })).data;
  const { area_itemid } = (await call('form_add_area', { draft_id, title: '評估' })).data;

  const bound = await call('form_add_control', { draft_id, area_itemid, label_text: '跌倒史：',
    control: { datatype: 'radiobutton', dictionary: { name: 'E2E_FALL' }, dicrole: 'puthis',
      options: [{ value: '有', further: [3] }, '無'] } });
  assert.equal(bound.data.dicid, 'e2e-id-1');
  assert.equal(bound.data.dicrole, 'puthis', 'bound by id keeps requested role');

  await call('form_add_control', { draft_id, area_itemid, label_text: '說明：', control: { datatype: 'textbox' } });
  const pend = await call('form_add_control', { draft_id, area_itemid, label_text: '步態：',
    control: { datatype: 'selection', dictionary: { name: 'E2E_GAIT_NEW' }, options: ['正常', '異常'] } });
  assert.equal(pend.data.dicrole, 'tohis');
  assert.ok(pend.warnings.some(w => w.startsWith('W_NEW_DICTIONARY')));

  const bogus = await call('form_add_control', { draft_id, area_itemid, control: { datatype: 'textbox', dictionary: { id: 'nope' } } });
  assert.equal(bogus.isError, true);
  assert.equal(bogus.error.code, 'E_DICT_UNKNOWN_ID');

  const v = (await call('form_validate', { draft_id })).data;
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.stats.controls, 3);

  const pv = (await call('form_preview', { draft_id })).data.content;
  assert.match(pv, /跌倒史/);
  assert.match(pv, /待新建字典（1）/);

  const plan = await call('form_export', { draft_id });
  assert.ok(plan.data.confirm_token);
  assert.equal(plan.data.plan.import_mode, '匯入表單及字典（必須）');
  assert.equal(fs.existsSync(path.join(ws, 'output')), false, 'nothing written before confirmation');

  const bad = await call('form_export', { draft_id, confirm_token: '1.deadbeef' });
  assert.equal(bad.error.code, 'E_CONFIRM_MISMATCH');

  const done = await call('form_export', { draft_id, confirm_token: plan.data.confirm_token });
  assert.equal(done.isError, false, JSON.stringify(done.error));
  const htm = fs.readFileSync(path.join(ws, done.data.files.htm), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ws, done.data.files.json), 'utf8'));
  assert.deepEqual(validatePackage(pkg), [], 'package v2 is valid');
  assert.equal(done.data.format, 'strucmed.template/v2');
  assert.equal(done.data.integrity, pkg.integrity.sha256);
  assert.deepEqual(pkg.template, { templateID: '', name: 'E2E 跌倒評估', shortcut: 'e2efall', groups: ['門', '住'],
    description: 'e2e </script> 測試', folder: { type: 'dpt', code: 'TES' }, rev: 0, editorver: '1.6' });
  assert.deepEqual(pkg.dictionaries.map(d => [d.id, d.dicName]), [['e2e-id-1', 'E2E_FALL'], ['', 'E2E_GAIT_NEW']]);
  assert.deepEqual(extractPackage(htm), pkg, '.htm carries the same v2 package');
  const json = pkg.form;

  // mimic the editor importer getFormData() (平台 web/js/shortcut.js:2081-2107)
  const start = htm.indexOf('<script>var tempdata =');
  assert.ok(start >= 0);
  let s = htm.substring(start); s = s.substring(0, s.indexOf('</script>'));
  const extracted = JSON.parse(s.replace('<script>var tempdata =', '').trim());
  assert.deepEqual(extracted, json);

  const area = json[0];
  assert.deepEqual([area.authread, area.authwrite, area.gettext], [['doctor'], ['doctor'], true]);
  assert.equal(area.item[area.item.length - 1].datatype !== 'newline', true, 'no trailing newline (editor drops it)');
  assert.match(json.at(-2).content, /^\/\/ generated-by: strucmed-skill v\d+\.\d+\.\d+ /);
  assert.equal(json.at(-1).itemtype, 'iot');

  const again = await call('form_export', { draft_id });
  assert.equal(again.error.code, 'E_OUTPUT_EXISTS');

  const del = await call('form_delete', { draft_id });
  assert.ok(del.data.confirm_token);
  assert.equal((await call('form_delete', { draft_id, confirm_token: del.data.confirm_token })).data.deleted, draft_id);
});
