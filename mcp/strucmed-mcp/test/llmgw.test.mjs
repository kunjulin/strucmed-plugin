// LlmGateway tools against a fake gateway on 127.0.0.1 (never the real one), over the real stdio protocol.
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
const KEY = 'cgllm_test-Secret-Key-77';                  // 不可出現在任何 tool 回應、stdout、stderr 或工作目錄

let fake, port, reqs = [];
const behavior = {};
const MODELS = [
  { id: 'Qwen3.6:27B', owned_by: 'llm_test', context_length: 262144, vision: false, thinking: 'enable_thinking', status: '', description: '預設' },
  { id: 'qwen3:32b', owned_by: 'llama31', context_length: 40960, vision: false, thinking: 'think', status: '', description: '' },
  { id: 'gemma3:12b', owned_by: 'gemma2_9b', context_length: 16000, vision: true, thinking: null, status: '', description: '影像' },
  { id: 'gemma2:latest', owned_by: 'gemma2_9b', context_length: 8192, vision: false, thinking: null, status: 'deprecated', description: '即將停用' },
  { id: 'llama3.1:8b-instruct-q8_0', owned_by: 'llama3-1q8', context_length: 32000, vision: false, thinking: null, status: '', description: '' }
];
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
function handler(req, res) {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : undefined;
    reqs.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const p = url.pathname.replace(/^\/llmgw\//, '');
    if ((req.headers.authorization || '') !== `Bearer ${KEY}`) return json(res, 401, { error: { code: 'invalid_api_key', message: 'bad key' } });
    if (behavior.redirect) { res.writeHead(302, { Location: 'https://evil.example/' }); return res.end(); }
    if (req.method === 'GET' && p === 'v1/models') return json(res, 200, { object: 'list', data: behavior.emptyModels ? [] : MODELS });
    if (req.method === 'POST' && p === 'v1/chat/completions') {
      if (behavior.rate) { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' }); return res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } })); }
      return json(res, 200, { id: 'c1', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `echo:${body.messages[body.messages.length - 1].content.slice(0, 20)}`, reasoning: body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking ? 'thought' : undefined } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
    }
    return json(res, 404, { error: { code: 'not_found', message: 'no route' } });
  });
}

function startMcp(env) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-llmgw-'));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, STRUCMED_WORKSPACE: ws, STRUCMED_SITE: 'offline', STRUCMED_ONLINE_BASE_URL: '', STRUCMED_USER: '', STRUCMED_PASS: '', LLMGW_BASE_URL: '', LLMGW_API_KEY: '', STRUCMED_FLAGS: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    setTimeout(() => rej(new Error('timeout ' + method)), 8000);
  });
  m.call = async (name, args = {}) => {
    const r = await m.rpc('tools/call', { name, arguments: args });
    return { isError: !!r.result.isError, ...JSON.parse(r.result.content[0].text) };
  };
  m.stop = () => {
    proc.kill();
    // 工作目錄內任何檔案都不可含金鑰
    for (const f of walk(ws)) assert.ok(!fs.readFileSync(f, 'utf8').includes(KEY), `workspace file leaked key: ${f}`);
    fs.rmSync(ws, { recursive: true, force: true });
  };
  return m;
}
function* walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }

let mcp;
const BASE = () => `http://127.0.0.1:${port}/llmgw`;
const ENV = () => ({ LLMGW_BASE_URL: BASE() + '/', LLMGW_API_KEY: KEY });
const flagsFile = (obj, tag) => { const f = path.join(os.tmpdir(), `strucmed-llmgw-flags-${tag}-${process.pid}.json`); fs.writeFileSync(f, JSON.stringify(obj)); return f; };

before(async () => {
  fake = http.createServer(handler);
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  port = fake.address().port;
  mcp = startMcp(ENV());
});
after(() => {
  mcp.stop(); fake.close();
  assert.ok(!mcp.stdout.includes(KEY), 'stdout leaked the key');
  assert.ok(!mcp.stderr.includes(KEY), 'stderr leaked the key');
});
beforeEach(() => { reqs = []; for (const k of Object.keys(behavior)) delete behavior[k]; });

test('hidden and disabled when LLMGW_* are not set; no network', async () => {
  const off = startMcp({});
  try {
    const list = await off.rpc('tools/list', {});
    assert.ok(!list.result.tools.some(t => t.name.startsWith('llmgateway_')));
    const r = await off.call('llmgateway_models', {});
    assert.equal(r.error.code, 'E_LLMGW_DISABLED');
    const init = await off.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.ok(!init.result.instructions.includes('llmgateway_models'));
  } finally { off.stop(); }
  assert.equal(reqs.length, 0);
});

test('only https (or loopback http) base URLs are accepted', async () => {
  for (const bad of ['http://gw.example/llmgw', 'https://u:p@gw.example/llmgw', 'not a url']) {
    const m = startMcp({ LLMGW_BASE_URL: bad, LLMGW_API_KEY: KEY });
    try { assert.equal((await m.call('llmgateway_models', {})).error.code, 'E_LLMGW_DISABLED', bad); } finally { m.stop(); }
  }
  assert.equal(reqs.length, 0);
});

test('llmgateway_models fetches with the bearer key, writes the cache and maps aliases', async () => {
  const list = await mcp.rpc('tools/list', {});
  const names = list.result.tools.map(t => t.name);
  assert.ok(names.includes('llmgateway_models'));
  assert.ok(!names.includes('llmgateway_chat_test'), 'chat test hidden by default flag');
  const r = await mcp.call('llmgateway_models', {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.count, 5);
  assert.equal(r.data.fetched, true);
  assert.equal(reqs[0].headers.authorization, `Bearer ${KEY}`);
  assert.match(r.data.aliases.qwen3627b, /^Qwen3\.6:27B/);
  assert.match(r.data.aliases.tw, /gemma2:latest（deprecated）/);
  assert.match(r.data.aliases.ph4, /不在清單/);
  const cache = JSON.parse(fs.readFileSync(path.join(mcp.ws, '.strucmed', 'llm-models.json'), 'utf8'));
  assert.equal(cache.models.length, 5);
  assert.ok(!JSON.stringify(cache).includes(KEY));
  const again = await mcp.call('llmgateway_models', { refresh: false });
  assert.equal(again.data.fetched, false, 'fresh cache reused');
});

test('wrong key → E_AUTH; redirects not followed; empty list → E_UPSTREAM', async () => {
  const m = startMcp({ LLMGW_BASE_URL: BASE(), LLMGW_API_KEY: 'cgllm_wrong' });
  try { assert.equal((await m.call('llmgateway_models', {})).error.code, 'E_AUTH'); } finally { m.stop(); }
  behavior.redirect = true;
  assert.equal((await mcp.call('llmgateway_models', {})).error.code, 'E_UPSTREAM');
  delete behavior.redirect; behavior.emptyModels = true;
  assert.equal((await mcp.call('llmgateway_models', {})).error.code, 'E_UPSTREAM');
});

test('formula_check uses the gateway whitelist: missing, deprecated and no-vision models are reported', async () => {
  await mcp.call('llmgateway_models', {});
  const check = async text => (await mcp.call('formula_check', { kind: 'macro', text })).data;
  const ok = await check('LLMQUERY(A3, "摘要", "qwen3627b")');
  assert.ok(!JSON.stringify(ok).includes('E_LLM_MODEL'), JSON.stringify(ok));
  const missing = await check('LLMQUERY(A3, "摘要", "ph4")');
  assert.match(JSON.stringify(missing), /E_LLM_MODEL_NOT_ON_GATEWAY/);
  const deprecated = await check('LLMQUERY(A3, "摘要", "tw")');
  assert.match(JSON.stringify(deprecated), /E_LLM_MODEL_DEPRECATED/);
  const vision = await check('LLMvision(A3, "看圖", "gemma3_12b")');
  assert.ok(!JSON.stringify(vision).includes('E_LLM_MODEL'), JSON.stringify(vision));
});

test('form_validate warns W_LLM_WHITELIST_STALE when AI steps exist without a cache', async () => {
  const m = startMcp(ENV());
  try {
    const c = await m.call('form_create', { name: 'AI 表單', dept_no: 'APP' });
    const a = await m.call('form_add_area', { draft_id: c.data.draft_id, type: 'form', title: 'x' });
    const ta = await m.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: '回覆', control: { datatype: 'textarea' } });
    const btn = await m.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: '問 AI', control: { datatype: 'action', action_name: '摘要', action_script: `LLMQUERY(A${ta.data.itemid}, "請摘要", "qwen3627b")`, action_id: ta.data.itemid } });
    assert.equal(btn.ok, true, JSON.stringify(btn));
    const v = await m.call('form_validate', { draft_id: c.data.draft_id });
    assert.ok(v.data.warnings.some(w => String(w.code || w).includes('W_LLM_WHITELIST_STALE')), JSON.stringify(v.data.warnings));
    await m.call('llmgateway_models', {});
    const v2 = await m.call('form_validate', { draft_id: c.data.draft_id });
    assert.ok(!v2.data.warnings.some(w => String(w.code || w).includes('W_LLM_WHITELIST_STALE')), JSON.stringify(v2.data.warnings));
  } finally { m.stop(); }
});

test('llmgateway_chat_test (flag on): whitelist, PHI guard, headers, thinking flag, 429', async () => {
  const flags = flagsFile({ llmChatTest: true }, 'chat');
  const m = startMcp({ ...ENV(), STRUCMED_FLAGS: flags });
  try {
    const list = await m.rpc('tools/list', {});
    assert.ok(list.result.tools.some(t => t.name === 'llmgateway_chat_test'));
    assert.equal((await m.call('llmgateway_chat_test', { model: 'qwen3627b', prompt: 'hi' })).error.code, 'E_NOT_WHITELISTED', 'no cache yet');
    await m.call('llmgateway_models', {});
    assert.equal((await m.call('llmgateway_chat_test', { model: 'ph4', prompt: 'hi' })).error.code, 'E_NOT_WHITELISTED');
    assert.equal((await m.call('llmgateway_chat_test', { model: 'tw', prompt: 'hi' })).error.code, 'E_NOT_WHITELISTED', 'deprecated');
    assert.equal((await m.call('llmgateway_chat_test', { model: 'qwen3627b', prompt: '病人 A123456789 的摘要' })).error.code, 'E_PHI_SUSPECT');
    const r = await m.call('llmgateway_chat_test', { model: 'qwen3627b', prompt: '請摘要：病人主訴頭痛三天', system: '你是助理', thinking: true, max_tokens: 5000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data.model, 'Qwen3.6:27B');
    assert.match(r.data.content, /^echo:/);
    assert.equal(r.data.reasoning, 'thought');
    assert.equal(r.data.usage.total_tokens, 8);
    const chat = reqs.find(x => x.path.endsWith('/v1/chat/completions'));
    assert.equal(chat.headers['x-client-feature'], 'strucmed-skill');
    assert.equal(chat.body.stream, false);
    assert.equal(chat.body.max_tokens, 1024, 'capped');
    assert.deepEqual(chat.body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(chat.body.messages[0].role, 'system');
    const byId = await m.call('llmgateway_chat_test', { model: 'gemma3:12b', prompt: 'x' });
    assert.equal(byId.data.model, 'gemma3:12b', 'gateway id accepted directly');
    behavior.rate = true;
    const rl = await m.call('llmgateway_chat_test', { model: 'qwen3627b', prompt: 'x' });
    assert.equal(rl.error.code, 'E_LIMIT');
    assert.equal(rl.error.details.retry_after, '7');
  } finally { m.stop(); fs.rmSync(flags, { force: true }); }
});
