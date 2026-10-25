// 站台自動判斷（院內／院外）與瀏覽器登入的站台選擇：以 127.0.0.1 上的兩個假站台取代 院內與院外站台（不連真實站台）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fakeAuthorize, browserLogin } from './fake-login.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../src/server.mjs');

// 假站台：api/health、api/v2/auth/authorize（立即導回本機回呼）與 api/v2/auth/token（授權碼兌換）
function fakeSite(name) {
  const s = { name, reqs: [], up: true, login: fakeAuthorize() };
  s.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/^\/strucmed\//, '/');
      s.reqs.push({ method: req.method, path: p, body: raw ? JSON.parse(raw) : undefined });
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!s.up) return json(503, { ok: false });
      if (p === '/api/health') return json(200, { ok: true, ts: 'x' });
      if (p === '/api/v2/auth/authorize') return s.login.authorize(url, res);
      if (p === '/api/v2/auth/token') {
        if (!s.login.exchange(JSON.parse(raw || '{}'))) return json(400, { ok: false, error: { code: 'E_INVALID_GRANT', message: '授權碼無效' } });
        return json(200, { ok: true, accessToken: `acc-${name}`, refreshToken: `ref-${name}`, expiresAt: null, userInfo: { userId: 'U1', name: '測試', deptNo: 'APP', loc: '' } });
      }
      return json(404, { ok: false, error: { code: 'E_NOT_FOUND', message: 'no route' } });
    });
  });
  return s;
}
const listen = s => new Promise(r => s.server.listen(0, '127.0.0.1', () => { s.url = `http://127.0.0.1:${s.server.address().port}/strucmed`; r(); }));

function startMcp(env) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-site-'));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, STRUCMED_WORKSPACE: ws, STRUCMED_SITE: '', STRUCMED_ONLINE_BASE_URL: '',
    STRUCMED_NO_BROWSER: '1', STRUCMED_LOGIN_WAIT_MS: '300', LLMGW_BASE_URL: '', LLMGW_API_KEY: '', FMAPI_BASE_URL: '', STRUCMED_FLAGS: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  const m = { ws, proc, stdout: '', stderr: '' };
  proc.stderr.on('data', d => { m.stderr += d; });
  readline.createInterface({ input: proc.stdout }).on('line', l => {
    m.stdout += l + '\n';
    const msg = JSON.parse(l);
    const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg); }
  });
  m.rpc = (method, params) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => rej(new Error('timeout ' + method)), 10000);
  });
  m.call = async (name, args = {}) => {
    const r = await m.rpc('tools/call', { name, arguments: args });
    return { isError: !!r.result.isError, ...JSON.parse(r.result.content[0].text) };
  };
  m.names = async () => (await m.rpc('tools/list', {})).result.tools.map(t => t.name);
  m.stop = () => { proc.kill(); fs.rmSync(ws, { recursive: true, force: true }); };
  return m;
}

let internal, external, closedUrl;
const sitesEnv = (i = internal.url, e = external.url) => ({ STRUCMED_INTERNAL_URL: i, STRUCMED_EXTERNAL_URL: e });
const reset = () => { for (const s of [internal, external]) { s.reqs = []; s.up = true; } };

before(async () => {
  internal = fakeSite('internal'); external = fakeSite('external');
  await listen(internal); await listen(external);
  // 一個已關閉的埠：模擬院外連不到 lvaiw
  const tmp = http.createServer(); await new Promise(r => tmp.listen(0, '127.0.0.1', r));
  closedUrl = `http://127.0.0.1:${tmp.address().port}/strucmed`; await new Promise(r => tmp.close(r));
});
after(() => { for (const s of [internal, external]) { s.server.closeAllConnections(); s.server.close(); } });

test('both sites reachable → internal; login goes to the internal site', async () => {
  reset();
  const m = startMcp(sitesEnv());
  try {
    assert.ok((await m.names()).includes('online_login'));
    const r = await browserLogin(m);
    assert.equal(r.ok, true);
    assert.equal(r.data.site.profile, 'internal');
    assert.equal(r.data.base_url, internal.url);
    assert.ok(internal.reqs.some(q => q.path === '/api/v2/auth/authorize') && internal.reqs.some(q => q.path === '/api/v2/auth/token'));
    assert.ok(!external.reqs.some(q => q.path.startsWith('/api/v2/auth/')));
  } finally { m.stop(); }
});

test('internal unreachable → external; LlmGateway and FMapi are not offered', async () => {
  reset();
  const m = startMcp({ ...sitesEnv(closedUrl), LLMGW_API_KEY: 'cgllm_test_key' });
  try {
    const names = await m.names();
    assert.ok(names.includes('online_login'));
    assert.ok(!names.some(n => n.startsWith('llmgateway_')), 'no LlmGateway tools outside the hospital');
    assert.ok(!names.some(n => n.startsWith('fmapi_')), 'no FMapi tools outside the hospital');
    const r = await browserLogin(m);
    assert.equal(r.data.site.profile, 'external');
    assert.equal(r.data.base_url, external.url);
    const g = await m.call('llmgateway_models', {});
    assert.equal(g.error.code, 'E_LLMGW_DISABLED');
    assert.match(g.error.message, /院外/);
  } finally { m.stop(); }
});

test('no external URL configured → never contacts an external site; internal down means offline', async () => {
  reset();
  const m = startMcp({ STRUCMED_INTERNAL_URL: closedUrl, STRUCMED_EXTERNAL_URL: '' });
  try {
    const names = await m.names();
    assert.ok(!names.includes('online_login'), 'offline without an internal site and without a configured external site');
    assert.equal(external.reqs.length, 0, 'the external site is never probed unless the user configures it');
  } finally { m.stop(); }
});

test('external URL must be https (http only for localhost)', async () => {
  reset();
  const m = startMcp({ STRUCMED_INTERNAL_URL: closedUrl, STRUCMED_EXTERNAL_URL: 'http://example.org/strucmed' });
  try {
    const names = await m.names();
    assert.ok(!names.includes('online_login'), 'a non-https external URL is ignored');
  } finally { m.stop(); }
});

test('no site reachable → online tools hidden; health probes carry no credentials', async () => {
  reset();
  internal.up = false; external.up = false;
  const m = startMcp(sitesEnv());
  try {
    assert.ok(!(await m.names()).some(n => n.startsWith('online_')));
    const r = await m.call('online_login', {});
    assert.equal(r.error.code, 'E_ONLINE_DISABLED');
    assert.match(r.error.message, /都連不到/);
  } finally { m.stop(); }
  for (const q of [...internal.reqs, ...external.reqs]) assert.equal(q.path, '/api/health');
});

test('STRUCMED_SITE=offline → no probing at all', async () => {
  reset();
  const m = startMcp({ ...sitesEnv(), STRUCMED_SITE: 'offline' });
  try {
    assert.ok(!(await m.names()).some(n => n.startsWith('online_')));
    assert.match((await m.call('online_login', {})).error.message, /offline/);
  } finally { m.stop(); }
  assert.equal(internal.reqs.length + external.reqs.length, 0);
});

test('no credentials are needed to detect the site (health probes only)', async () => {
  reset();
  const m = startMcp(sitesEnv());
  try {
    assert.ok((await m.names()).includes('online_login'));
  } finally { m.stop(); }
  for (const q of [...internal.reqs, ...external.reqs]) assert.equal(q.path, '/api/health');
});

test('STRUCMED_SITE=external forces the external site without probing', async () => {
  reset();
  const m = startMcp({ ...sitesEnv(), STRUCMED_SITE: 'external' });
  try {
    const r = await browserLogin(m);
    assert.equal(r.data.site.profile, 'external');
  } finally { m.stop(); }
  assert.ok(!internal.reqs.length);
  assert.ok(!external.reqs.some(q => q.path === '/api/health'));
});

test('explicit STRUCMED_ONLINE_BASE_URL on the external host is reported as external', async () => {
  reset();
  const m = startMcp({ ...sitesEnv(closedUrl), STRUCMED_ONLINE_BASE_URL: external.url });
  try {
    const r = await browserLogin(m);
    assert.equal(r.data.site.profile, 'external');
    assert.equal(r.data.site.selected_by, 'STRUCMED_ONLINE_BASE_URL');
  } finally { m.stop(); }
  assert.ok(!external.reqs.some(q => q.path === '/api/health'), 'explicit URL skips probing');
});
