// FMapi tool against a fake FMapi on 127.0.0.1, over the real stdio protocol.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../src/server.mjs');
const KEY = 'fm-viewer-Secret-Key-55';
let fake, port, reqs = [];
const behavior = {};
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  reqs.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers });
  const p = url.pathname.replace(/^\/FM\//, '');
  if (req.method === 'GET' && p === 'api/errorlog/status')
    return json(res, 200, { provider: 'Sqlite', count: 1234, latest: '2026-10-22T01:00:00Z', retention: { lastRun: '2026-10-22T03:00:00Z', lastDeleted: 5, lastError: null }, gateway: { enabled: true, pending: 0 } });
  if (req.method === 'GET' && p === 'api/uptime/summary') {
    if (behavior.denied || (req.headers['x-api-key'] || '') !== KEY) return json(res, 403, { message: 'forbidden' });
    if (behavior.disabled) return json(res, 200, { enabled: false });
    return json(res, 200, { enabled: true, window: url.searchParams.get('window'), bucketMinutes: 30, from: '2026-10-21T01:00:00Z', to: '2026-10-22T01:00:00Z', intervalMinutes: 5,
      sites: [
        { key: 'strucmed-health', name: '/strucmed api/health', url: 'https://x/strucmed/api/health', method: 'GET', checks: 288, failures: 0, uptimePct: 100, avgLatencyMs: 40, latest: { checkedAt: '2026-10-22T01:00:00Z', success: true, statusCode: 200, latencyMs: 38 }, buckets: [] },
        { key: 'llmgw', name: 'LlmGateway /llmgw/health', url: 'https://x/llmgw/health', method: 'GET', checks: 288, failures: 3, uptimePct: 98.9, avgLatencyMs: 90, latest: { checkedAt: '2026-10-22T01:00:00Z', success: false, statusCode: 502, latencyMs: 1200, error: 'Bad Gateway' }, buckets: [] },
        { key: 'other', name: '某個無關站台', url: 'https://x/other', method: 'GET', checks: 10, failures: 0, uptimePct: 100, avgLatencyMs: 10, latest: null, buckets: [] }
      ],
      failures: [], errorGroups: [{ siteKey: 'llmgw', siteName: 'LlmGateway /llmgw/health', error: 'Bad Gateway', count: 3, first: '2026-10-21T10:00:00Z', last: '2026-10-22T01:00:00Z' }] });
  }
  return json(res, 404, { message: 'no route' });
}
function startMcp(env) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-fmapi-'));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, STRUCMED_WORKSPACE: ws, STRUCMED_SITE: 'offline', STRUCMED_ONLINE_BASE_URL: '', LLMGW_BASE_URL: '', LLMGW_API_KEY: '', FMAPI_BASE_URL: '', FMAPI_API_KEY: '', STRUCMED_FLAGS: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let seq = 0;
  const m = { ws, proc, stdout: '', stderr: '' };
  proc.stderr.on('data', d => { m.stderr += d; });
  readline.createInterface({ input: proc.stdout }).on('line', l => { m.stdout += l + '\n'; const msg = JSON.parse(l); const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg); } });
  m.rpc = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => rej(new Error('timeout ' + method)), 8000); });
  m.call = async (name, args = {}) => { const r = await m.rpc('tools/call', { name, arguments: args }); return { isError: !!r.result.isError, ...JSON.parse(r.result.content[0].text) }; };
  m.stop = () => { proc.kill(); fs.rmSync(ws, { recursive: true, force: true }); };
  return m;
}
let mcp;
const BASE = () => `http://127.0.0.1:${port}/FM`;
before(async () => { fake = http.createServer(handler); await new Promise(r => fake.listen(0, '127.0.0.1', r)); port = fake.address().port; mcp = startMcp({ FMAPI_BASE_URL: BASE(), FMAPI_API_KEY: KEY }); });
after(() => { mcp.stop(); fake.close(); assert.ok(!mcp.stdout.includes(KEY) && !mcp.stderr.includes(KEY), 'api key leaked'); });
beforeEach(() => { reqs = []; for (const k of Object.keys(behavior)) delete behavior[k]; });

test('hidden when FMAPI_BASE_URL is not set', async () => {
  const off = startMcp({});
  try {
    const list = await off.rpc('tools/list', {});
    assert.ok(!list.result.tools.some(t => t.name === 'fmapi_status'));
    assert.equal((await off.call('fmapi_status', {})).error.code, 'E_FMAPI_DISABLED');
  } finally { off.stop(); }
  assert.equal(reqs.length, 0);
});

test('fmapi_status aggregates errorlog status and relevant uptime sites, flags down sites', async () => {
  const list = await mcp.rpc('tools/list', {});
  assert.ok(list.result.tools.some(t => t.name === 'fmapi_status'));
  const r = await mcp.call('fmapi_status', { window: '6h' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.errorlog.count, 1234);
  assert.equal(r.data.errorlog.gateway_forward.enabled, true);
  assert.equal(r.data.uptime.enabled, true);
  assert.equal(r.data.uptime.sites.length, 2, 'unrelated site filtered out');
  assert.equal(r.data.uptime.sites[1].latest.success, false);
  assert.ok(r.warnings.some(w => w.startsWith('W_SITE_DOWN') && w.includes('LlmGateway')));
  assert.ok(reqs.some(x => x.path.endsWith('/api/uptime/summary') && x.search.includes('window=6h') && x.headers['x-api-key'] === KEY));
  const all = await mcp.call('fmapi_status', { all_sites: true });
  assert.equal(all.data.uptime.sites.length, 3);
});

test('uptime denied or disabled → warnings only, errorlog still returned', async () => {
  behavior.denied = true;
  const r = await mcp.call('fmapi_status', {});
  assert.equal(r.ok, true);
  assert.equal(r.data.errorlog.available, true);
  assert.equal(r.data.uptime.available, false);
  assert.ok(r.warnings.some(w => w.includes('uptime/summary')));
  delete behavior.denied; behavior.disabled = true;
  const r2 = await mcp.call('fmapi_status', {});
  assert.equal(r2.data.uptime.enabled, false);
});
