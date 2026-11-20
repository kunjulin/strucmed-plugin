// MCP 常駐預覽伺服器（preview-server.mjs + server.mjs）：
// form_preview(format: "html") 直接在 MCP 行程內啟動／沿用 127.0.0.1 預覽伺服器，避免 Antigravity 等環境回收 detach 子行程。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ensurePreviewServer, stopPreviewServers } from '../src/preview-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../src/server.mjs');
const PREVIEW_SCRIPT = path.resolve(HERE, '../../../scripts/preview.mjs');

const mkRuntime = (tag = 'v1') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `strucmed-pvs-web-${tag}-`));
  fs.writeFileSync(path.join(dir, 'TempHtml.html'), `<!DOCTYPE html><html><head></head><body><!-- ${tag} --></body></html>`);
  return dir;
};
const freePort = () => new Promise(res => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const runPreviewScript = (args, env = {}) => new Promise(res =>
  execFile(process.execPath, [PREVIEW_SCRIPT, ...args], { cwd: os.tmpdir(), env: { ...process.env, ...env } }, (e, stdout) =>
    res({ code: e ? e.code : 0, json: stdout ? JSON.parse(stdout) : null }))
);

function startMcpStdio(env) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, STRUCMED_SITE: 'offline', STRUCMED_RUNTIME_WEB_CACHE: 'none', ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let seq = 0;
  rl.on('line', line => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const fn = pending.get(msg.id);
    if (fn) { pending.delete(msg.id); fn(msg); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 10_000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg.result); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return JSON.parse(r.content[0].text);
  };
  const stop = () => new Promise(resolve => {
    proc.once('exit', code => resolve(code));
    proc.stdin.end();
  });
  return { proc, rpc, call, stop };
}

let tmpDirs = [];
after(() => {
  stopPreviewServers();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('MCP stdio: form_preview(html) 自動啟動內建預覽伺服器，可直接 fetch、支援審閱送出，preview.mjs 沿用同一台，MCP 結束後自動關閉', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-pvs-ws-'));
  const web = mkRuntime('mcp');
  tmpDirs.push(ws, web);

  const mcp = startMcpStdio({ STRUCMED_WORKSPACE: ws, STRUCMED_RUNTIME_WEB: web });
  const created = await mcp.call('form_create', { name: 'MCP 預覽測試', dept_no: 'TEST0' });
  const draft_id = created.data.draft_id;
  const area = await mcp.call('form_add_area', { draft_id, title: '基本' });
  await mcp.call('form_add_control', { draft_id, area_itemid: area.data.area_itemid, label_text: '身高', control: { datatype: 'numberbox' } });

  const pv1 = await mcp.call('form_preview', { draft_id, format: 'html' });
  assert.equal(pv1.ok, true, JSON.stringify(pv1));
  assert.ok(pv1.data.url && pv1.data.url.startsWith('http://127.0.0.1:'), `應直接回傳 url：${pv1.data.url}`);
  assert.equal(pv1.data.link, `[開啟表單預覽](${pv1.data.url})`);
  assert.ok(Number.isInteger(pv1.data.port));
  assert.match(pv1.data.server, /MCP 內建預覽伺服器/);

  // 實際可連線，且有預覽資料與嚴格 CSP
  const page = await fetch(pv1.data.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') || '', /connect-src 'self'/);
  const html = await page.text();
  assert.match(html, /window\.__previewData =/);
  assert.match(html, /<!-- mcp -->/);

  // 再呼叫一次 form_preview：沿用同一台與同一個 nonce
  const pv2 = await mcp.call('form_preview', { draft_id, format: 'html' });
  assert.equal(pv2.data.url, pv1.data.url);
  assert.equal(pv2.data.port, pv1.data.port);
  assert.match(pv2.data.server, /沿用/);

  // scripts/preview.mjs 也能偵測並沿用 MCP 啟動的伺服器，不另外 spawn
  const cli = await runPreviewScript([draft_id, '--workspace', ws], { STRUCMED_RUNTIME_WEB: web, STRUCMED_RUNTIME_WEB_CACHE: 'none' });
  assert.equal(cli.code, 0, JSON.stringify(cli));
  assert.equal(cli.json.ok, true);
  assert.equal(cli.json.port, pv1.data.port);
  assert.equal(cli.json.url, pv1.data.url);
  assert.match(cli.json.server, /沿用/);

  // 審閱送出可寫回並以 form_review_read 讀回
  const nonce = new URL(pv1.data.url).searchParams.get('n');
  const rev = await fetch(`http://127.0.0.1:${pv1.data.port}/__review/${draft_id}?n=${nonce}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, draft_id, status: 'revise', items: [{ kind: 'form', text: '測試意見' }] })
  });
  assert.equal(rev.status, 200);
  const read = await mcp.call('form_review_read', { draft_id });
  assert.equal(read.ok, true);
  assert.equal(read.data.review.items[0].text, '測試意見');

  // 結束 MCP：內建預覽伺服器應一併關閉且清掉 server.json
  await mcp.stop();
  assert.ok(!fs.existsSync(path.join(ws, '.strucmed', 'preview', 'server.json')), 'MCP 結束後應移除 server.json');
  await assert.rejects(() => fetch(pv1.data.url), 'MCP 結束後預覽埠應不再監聽');
});

test('ensurePreviewServer: 埠被占用時自動跳下一個埠；runtime web 變更時自動重啟換新 nonce', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-pvs-unit-'));
  const web1 = mkRuntime('w1');
  const web2 = mkRuntime('w2');
  tmpDirs.push(ws, web1, web2);

  const busy = await freePort();
  const blocker = await new Promise(res => {
    const s = net.createServer().listen(busy, '127.0.0.1', () => res(s));
  });
  try {
    const a = await ensurePreviewServer({ workspace: ws, web: web1, startPort: busy, tries: 5 });
    assert.notEqual(a.port, busy, '應跳過被占用的埠');
    assert.equal(a.reused, false);
    const a2 = await ensurePreviewServer({ workspace: ws, web: web1, startPort: busy, tries: 5 });
    assert.equal(a2.port, a.port);
    assert.equal(a2.nonce, a.nonce);
    assert.equal(a2.reused, true);

    // 切換 runtime web（例如 runtime_fetch 更新）→ 重啟並換新 nonce
    const b = await ensurePreviewServer({ workspace: ws, web: web2, startPort: busy, tries: 5 });
    assert.equal(b.reused, false);
    assert.notEqual(b.nonce, a.nonce);
    const health = await (await fetch(`http://127.0.0.1:${b.port}/__health`)).json();
    assert.equal(health.web, web2);

    stopPreviewServers();
    assert.ok(!fs.existsSync(path.join(ws, '.strucmed', 'preview', 'server.json')));
  } finally {
    blocker.close();
  }
});
