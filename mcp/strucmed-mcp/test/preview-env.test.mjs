// 3.9.1 環境（docs/16 M3、M6、H1、H4）：實際的埠寫到 server.json、8765 被占用時自動換埠、工作目錄固定、runtime_web 的尋找順序。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRuntimeWeb } from '../src/runtime-web.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../../scripts/preview.mjs');
const CHECK = path.resolve(HERE, '../../../scripts/check-env.mjs');
let ws, web, t, pids = [];
const blockers = [];

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const node = (file, args, env = {}, cwd = os.tmpdir()) => new Promise(res => execFile(process.execPath, [file, ...args], { cwd, env: { ...process.env, ...env } }, (e, stdout) => res({ code: e ? e.code : 0, json: stdout ? JSON.parse(stdout) : null })));
const serverInfo = root => JSON.parse(fs.readFileSync(path.join(root, '.strucmed', 'preview', 'server.json'), 'utf8'));
const runtime = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-env-web-')); fs.writeFileSync(path.join(dir, 'TempHtml.html'), '<html><head></head><body></body></html>'); return dir; };

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-env-'));
  web = runtime();
  process.env.STRUCMED_WORKSPACE = ws;
  process.env.STRUCMED_RUNTIME_WEB = web;
  t = Object.fromEntries((await import('../src/tools.mjs')).TOOLS.map(x => [x.name, x.handler]));
});
after(() => {
  for (const p of pids) { try { process.kill(p); } catch { /* 已結束 */ } }
  blockers.forEach(s => s.close());
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(web, { recursive: true, force: true });
});

function draft() {
  const { draft_id } = t.form_create({ name: '環境', dept_no: 'TEST0' });
  const { area_itemid } = t.form_add_area({ draft_id });
  t.form_add_control({ draft_id, area_itemid, label_text: 'x', control: { datatype: 'textbox' } });
  return draft_id;
}
const listen = port => new Promise(res => { const s = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(q.url === '/__health' ? JSON.stringify({ harness: 'v0', features: ['preview', 'snapshot', 'review'] }) : 'old'); }).listen(port, '127.0.0.1', () => { blockers.push(s); res(s); }); });

test('M3／H1／H4：起始埠被舊版占用時改下一個埠，回一個 link；server.json 記實際的埠，form_preview 用它組 url', async () => {
  const id = draft();
  const start = await freePort();
  await listen(start);
  assert.equal(t.form_preview({ draft_id: id, format: 'html' }).url, null);
  const open = t.form_preview({ draft_id: id, format: 'html' }).open;
  assert.ok(open.includes('--workspace'));

  // 目前目錄刻意不是工作目錄（F-04：Bash cd 之後）
  const r = await node(SCRIPT, [id, String(start), '--workspace', ws]);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.notEqual(r.json.port, start);
  assert.match(r.json.server, /舊版 harness/);
  assert.equal(r.json.link, `[開啟表單預覽](http://127.0.0.1:${r.json.port}/__preview/${id})`);
  assert.ok(!JSON.stringify(r.json).includes(`:${start}/`), '不再給第二個網址');
  const info = serverInfo(ws);
  pids.push(info.pid);
  assert.equal(info.port, r.json.port);
  assert.equal(info.workspace, ws);
  assert.equal(t.form_preview({ draft_id: id, format: 'html' }).url, `http://127.0.0.1:${r.json.port}/__preview/${id}`);

  // 再跑一次：沿用同一台，不多開
  const again = await node(SCRIPT, [id, String(start), '--workspace', ws]);
  assert.equal(again.json.port, r.json.port);
  assert.match(again.json.server, /沿用/);
  assert.equal(serverInfo(ws).pid, info.pid);

  // H4：POST /__review 只寫到啟動時的工作目錄，不看 cwd
  const res = await fetch(`http://127.0.0.1:${r.json.port}/__review/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, draft_id: id, status: 'revise', items: [] }) });
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(ws, '.strucmed', 'review', id, '001.json')));
  const health = await (await fetch(`http://127.0.0.1:${r.json.port}/__health`)).json();
  assert.equal(health.workspace, ws);

  // 伺服器結束：server.json 清掉，form_preview 回到 url:null
  process.kill(info.pid, 'SIGTERM');
  for (let i = 0; i < 50 && fs.existsSync(path.join(ws, '.strucmed', 'preview', 'server.json')); i++) await new Promise(x => setTimeout(x, 50));
  assert.ok(!fs.existsSync(path.join(ws, '.strucmed', 'preview', 'server.json')));
  assert.equal(t.form_preview({ draft_id: id, format: 'html' }).url, null);
});

test('H4：別的工作目錄的 harness 不沿用；stale 的 server.json（pid 已不在）當作沒有', async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-env-other-'));
  const a = draft();
  t.form_preview({ draft_id: a, format: 'html' });
  const start = await freePort();
  const first = await node(SCRIPT, [a, String(start), '--workspace', ws]);
  pids.push(serverInfo(ws).pid);
  fs.mkdirSync(path.join(other, '.strucmed', 'preview'), { recursive: true });
  fs.copyFileSync(path.join(ws, '.strucmed', 'preview', `${a}.json`), path.join(other, '.strucmed', 'preview', `${a}.json`));
  const second = await node(SCRIPT, [a, String(start), '--workspace', other]);
  assert.equal(second.json.ok, true, JSON.stringify(second.json));
  assert.notEqual(second.json.port, first.json.port);
  assert.match(second.json.server, /別的工作目錄/);
  const pid = serverInfo(other).pid;
  pids.push(pid);
  process.kill(pid, 'SIGKILL');
  await new Promise(x => setTimeout(x, 100));
  fs.writeFileSync(path.join(ws, '.strucmed', 'preview', 'server.json'), JSON.stringify({ v: 1, port: 1, pid, workspace: ws }));
  assert.equal(t.form_preview({ draft_id: a, format: 'html' }).url, null, 'pid 不在了不給網址');
  fs.rmSync(other, { recursive: true, force: true });
});

test('preview.mjs：draft 不在工作目錄時訊息寫出完整路徑；runtime 找不到時 runtime_available:false', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-env-empty-'));
  const miss = await node(SCRIPT, ['d-0123456789ab', '--workspace', empty]);
  assert.equal(miss.code, 2);
  assert.ok(miss.json.message.includes(empty));
  const none = await node(SCRIPT, ['d-0123456789ab', '--workspace', empty], { STRUCMED_RUNTIME_WEB: '${user_config.runtime_web}' });
  assert.equal(none.json.runtime_available, false);
  assert.match(none.json.message, /strucmed\/web/);
  fs.rmSync(empty, { recursive: true, force: true });
});

test('M6：runtime_web 依序找 <ws>/strucmed/web、<ws>/repo/strucmed/web、<ws>/../strucmed/web；未展開的 ${} 視為未設定', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-env-find-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  const put = rel => { const d = path.join(base, rel); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'TempHtml.html'), ''); return d; };
  const unset = { STRUCMED_RUNTIME_WEB: '${user_config.runtime_web}' };
  assert.deepEqual([findRuntimeWeb(root, unset).available, findRuntimeWeb(root, unset).source], [false, 'none']);
  assert.equal(findRuntimeWeb(root, unset).tried.length, 3);
  const up = put('strucmed/web');
  assert.equal(findRuntimeWeb(root, unset).path, up);
  const nested = put('repo/repo/strucmed/web');
  assert.equal(findRuntimeWeb(root, unset).path, nested);
  const direct = put('repo/strucmed/web');
  assert.equal(findRuntimeWeb(root, {}).path, direct);
  assert.deepEqual(findRuntimeWeb(root, { STRUCMED_RUNTIME_WEB: up }), { path: up, available: true, source: 'env', tried: [up] });
  fs.rmSync(base, { recursive: true, force: true });
});

test('M6：form_preview 回實際的 runtime_web 並寫進 notes；check-env 用同一份判斷', async () => {
  const r = t.form_preview({ draft_id: draft(), format: 'html' });
  assert.equal(r.runtime_available, true);
  assert.equal(r.runtime_web, web);
  assert.ok(r.notes.some(n => n.includes(web)));
  const c = await node(CHECK, ['--workspace', ws], { STRUCMED_SITE: 'offline' });
  assert.deepEqual(c.json.runtime_web, { path: web, available: true, note: '以 MCP form_preview 的 runtime_available 為準' });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-env-chk-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(base, 'strucmed', 'web'), { recursive: true });
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(base, 'strucmed', 'web', 'TempHtml.html'), '');
  const up = await node(CHECK, ['--workspace', root], { STRUCMED_SITE: 'offline', STRUCMED_RUNTIME_WEB: '' });
  assert.equal(up.json.runtime_web.available, true, '不再疊成雙 repo（F-03）');
  fs.rmSync(base, { recursive: true, force: true });
});
