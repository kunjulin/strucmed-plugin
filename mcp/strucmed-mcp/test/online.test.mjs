// Online tools against a fake strucmed V2 server on 127.0.0.1 (never the real site), over the real stdio protocol.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../src/package.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../src/server.mjs');
const ACCOUNT = 'TESTUSR';
const PASSWORD = 'pw-Secret#9z';               // 不可出現在任何 tool 回應或 stdout/stderr
const USER_ID = 'U123';
const GW_TOKEN = 'cgllm-browser-Secret42';     // api/llm-config 回的瀏覽器型金鑰：tool 不可回傳
const ONLINE_SHA = 'sha-online-1';
const ONLINE_FORM = [{ itemtype: 'form', itemid: 1, authread: ['doctor'], authwrite: ['doctor'], gettext: true, item: [{ datatype: 'text', datavalue: '姓名' }, { datatype: 'textbox', itemid: 2, datavalue: '', dictionary: '', dicid: '', dicrole: 'nohis' }] }, { itemtype: 'javascript', content: '' }, { itemtype: 'iot', sheetid: 'T-1', templateID: 'T-1', editorver: '1.6' }];
const templates = new Map();             // 假伺服器保存的範本
// 完整的範本套件 v2（form_import 會驗證 schema 與 integrity）；ETag 另外給（head sha 與 integrity 不同，與真實伺服器相同）
const fakePackage = (id, template, form) => buildPackage({ form, meta: { name: template.name, dept_no: 'APP', groups: template.groups || [], shortcut: template.shortcut || '', description: template.description || '', folder_type: 'usr' }, generator: 'fake-v2', templateID: id });
let tplSeq = 100, dictSeq = 0;
let notes = [{ dictID: 'T-1', dictVal: '跌倒評估' }];   // struNote 清單   // 新建的範本從 T-101 起，不與預設的 T-1 衝突

// ── 假伺服器 ────────────────────────────────────────────────
let fake, port, reqs = [], tokenSeq = 0, validAccess = new Set(), validRefresh = new Set();
const issued = [];                             // 發出過的 token：也不可出現在 tool 回應
const behavior = {};
function issue(withUser) {
  const a = `acc-${++tokenSeq}-xyz`, r = `ref-${tokenSeq}-xyz`;
  validAccess.add(a); validRefresh.add(r); issued.push(a, r);
  return { ok: true, accessToken: a, refreshToken: r, expiresAt: '2026-10-19T12:00:00Z',
    userInfo: withUser ? { userId: USER_ID, name: '測試醫師', deptNo: 'APP', loc: 'LK' } : null };
}
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const err = (res, status, code, message) => json(res, status, { ok: false, error: { code, message } });

function handler(req, res) {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : undefined;
    const auth = req.headers.authorization || '';
    reqs.push({ method: req.method, path: url.pathname, search: url.search, auth, body });
    const p = url.pathname.replace(/^\/strucmed\//, '');
    if (p === 'api/v2/auth/token') {
      if (body.account !== ACCOUNT || body.password !== PASSWORD) return err(res, 401, 'E_AUTH', '帳號或密碼錯誤');
      return json(res, 200, issue(true));
    }
    if (p === 'api/v2/auth/refresh') {
      if (behavior.refreshFails || !validRefresh.has(body.refreshToken)) return err(res, 401, 'E_AUTH', 'refresh token 無效或已過期，請重新登入');
      return json(res, 200, issue(false));
    }
    const token = auth.replace(/^Bearer /, '');
    if (!validAccess.has(token)) return err(res, 401, 'E_AUTH', 'token 無效');
    if (behavior.redirect) { res.writeHead(302, { Location: 'https://evil.example/steal' }); return res.end(); }
    if (behavior.upstream500) return err(res, 502, 'E_UPSTREAM', '倉儲連線失敗');
    let m;
    if (req.method === 'GET' && (m = p.match(/^api\/v2\/folders\/(\w+)\/templates$/)))
      return json(res, 200, { folder: m[1], exists: true, total: 1, items: [{ templateID: 'T-1', name: '跌倒評估' }] });
    if (req.method === 'GET' && (m = p.match(/^api\/v2\/templates\/([A-Za-z0-9-]+)$/))) {
      const saved = templates.get(m[1]);
      if (saved) { res.setHeader('ETag', '"' + saved.sha256 + '"'); return json(res, 200, fakePackage(m[1], saved.template, saved.form)); }
      res.setHeader('ETag', '"' + ONLINE_SHA + '"');
      return json(res, 200, fakePackage(m[1], { name: '跌倒評估', groups: ['門'] }, ONLINE_FORM));
    }
    if (req.method === 'GET' && (m = p.match(/^api\/v2\/templates\/([A-Za-z0-9-]+)\/versions$/)))
      return json(res, 200, { currentRev: 2, diverged: false, versions: [{ rev: 2, fillID: 'F2', createUser: USER_ID, createDate: '20261022', sha256: 'h2', current: true, restorable: true, verified: true }, { rev: 1, fillID: 'F1', createUser: USER_ID, createDate: '20261021', sha256: 'h1', current: false, restorable: true, verified: true }] });
    if (req.method === 'POST' && (m = p.match(/^api\/v2\/folders\/(\w+)\/templates$/))) {
      if (behavior.writesDisabled) return err(res, 503, 'E_WRITES_DISABLED', '站台尚未開放範本寫入');
      if (behavior.pendingFail) return json(res, 502, { ok: false, error: { code: 'E_UPSTREAM', message: '倉儲寫入失敗', details: { step: 'head', templateID: 'T-NEW', pending: true } } });
      if (m[1] === 'sys') return err(res, 403, 'E_FORBIDDEN', 'sys 需管理者');
      if (!body || !body.template || typeof body.template.name !== 'string' || !Array.isArray(body.form)) return err(res, 400, 'E_INVALID_INPUT', '本文格式錯誤');
      const sha = 'sha-' + (++tplSeq);
      templates.set('T-' + tplSeq, { template: body.template, form: body.form, sha256: sha });
      res.setHeader('ETag', '"' + sha + '"');
      return json(res, 201, { ok: true, templateID: 'T-' + tplSeq, rev: 1, sha256: sha, folder: { type: m[1], code: m[1] === 'usr' ? USER_ID : 'APP' }, diverged: false, warnings: [] });
    }
    if (req.method === 'PUT' && (m = p.match(/^api\/v2\/templates\/([A-Za-z0-9-]+)$/))) {
      const ifMatch = String(req.headers['if-match'] || '').replace(/"/g, '');
      if (!ifMatch) return err(res, 428, 'E_PRECONDITION', '缺少 If-Match');
      const cur = templates.get(m[1]) ? templates.get(m[1]).sha256 : ONLINE_SHA;
      if (behavior.conflict || ifMatch !== cur) return json(res, 409, { ok: false, error: { code: 'E_CONFLICT', message: '內容已被修改', details: { currentSha256: 'sha-other' } } });
      const sha = 'sha-' + (++tplSeq);
      templates.set(m[1], { template: body.template, form: body.form, sha256: sha });
      res.setHeader('ETag', '"' + sha + '"');
      return json(res, 200, { ok: true, templateID: m[1], rev: 2, sha256: sha, folder: { type: 'usr', code: USER_ID }, diverged: !!behavior.diverged, warnings: [] });
    }
    if (req.method === 'POST' && p === 'api/v2/dictionaries') {
      if (body.dicName === '疼痛評估') return json(res, 200, { ok: true, id: 'D3', dicName: body.dicName, dicType: 'APP', dicComment: '', createUser: USER_ID, created: false, reused: true });
      if (body.dicName === '已刪除字典' && !body.force) return json(res, 409, { ok: false, error: { code: 'E_DELETED_EXISTS', message: '有已刪除的同名字典', details: { candidates: [{ id: 'D9', dicComment: '', createDate: '20250101' }] } } });
      const id = 'D-' + (++dictSeq);
      return json(res, 201, { ok: true, id, dicName: body.dicName, dicType: 'APP', dicComment: body.dicComment || '', createUser: USER_ID, created: true, reused: false });
    }
    if (req.method === 'POST' && p === 'api/v2/dictionaries/batch') {
      const results = (body.rows || []).map((row, i) => row.dicName === '已刪除字典'
        ? { row: i + 1, ok: false, code: 'E_DELETED_EXISTS', message: '有已刪除的同名字典', dicName: row.dicName }
        : { row: i + 1, ok: true, action: 'create', id: 'D-' + (++dictSeq), dicName: row.dicName });
      return json(res, 200, { ok: true, total: results.length, succeeded: results.filter(x => x.ok).length, results });
    }
    if (req.method === 'POST' && (m = p.match(/^api\/v2\/records\/query\/(data|image)$/)))
      return json(res, 200, [{ fillID: 'F1', chtno: body.query.chtno, kind: m[1] }, { fillID: 'F2', chtno: body.query.chtno, kind: m[1] }]);
    if (req.method === 'POST' && p === 'api/v2/records/save') {
      if (body.iot.user !== USER_ID) return err(res, 400, 'E_INVALID_INPUT', 'iot.user 與傳入的使用者不同');
      return json(res, 200, { ok: true, overwrite: false, overwriteDenied: !!body.xmlfillID,
        kv: { success: 'Y', msg: '', fillID: 'KV1' }, xml: { success: 'Y', msg: '', fillID: 'XML1' } });
    }
    if (req.method === 'GET' && p === 'api/v2/me/notes') return json(res, 200, { ok: true, fillID: 'N1', items: notes });
    if (req.method === 'PUT' && p === 'api/v2/me/notes') { notes = (body.items || []).map(x => ({ dictID: x.dictID, dictVal: x.dictVal })); return json(res, 200, { ok: true, fillID: 'N1', count: notes.length }); }
    if (req.method === 'GET' && p === 'api/v2/me')
      return json(res, 200, { userId: USER_ID, name: '測試醫師', deptNo: 'APP', folders: { usr: USER_ID, sub: 'APP', dpt: 'APP' }, isAdmin: false, tokenExpiresAt: '2026-10-19T12:00:00Z' });
    if (req.method === 'GET' && p === 'api/health') return json(res, 200, { ok: true, ts: '2026-10-19T00:00:00Z' });
    if (req.method === 'GET' && p === 'api/v2/runtime/features')
      return json(res, 200, { ok: true, presets: true, recordDelete: true, save: url.searchParams.get('user') === USER_ID, query: false, queryRoot: 'x' });
    if (req.method === 'GET' && p === 'api/llm-config') {
      issued.push(GW_TOKEN);
      return json(res, 200, { enabled: true, baseUrl: '/llmgw', token: GW_TOKEN, site: req.headers['x-asr-site'] || 'unknown', endpoints: [] });
    }
    if (req.method === 'GET' && p === 'api/v2/dictionaries') {
      const q = url.searchParams.get('q') || '';
      const all = [{ id: 'D1', dicType: 'APP', dicName: '跌倒史', dicComment: '有無跌倒', createDate: '20260101' },
        { id: 'D2', dicType: 'APP', dicName: '跌倒史', dicComment: '重複', createDate: '20250101' },
        { id: 'D3', dicType: 'APP', dicName: '疼痛評估', dicComment: '', createDate: '20240101' }];
      const items = all.filter(d => !q || d.dicName.includes(q));
      return json(res, 200, { deptNo: 'APP', scope: url.searchParams.get('scope') || 'match', levels: ['APP'], total: items.length, truncated: false, items });
    }
    return err(res, 404, 'E_NOT_FOUND', 'no route');
  });
}

// ── MCP 子行程 ──────────────────────────────────────────────
function startMcp(env) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-online-'));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, STRUCMED_WORKSPACE: ws, STRUCMED_SITE: 'offline', STRUCMED_ONLINE_BASE_URL: '', STRUCMED_USER: '', STRUCMED_PASS: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  m.stop = () => { proc.kill(); fs.rmSync(ws, { recursive: true, force: true }); };
  return m;
}

let mcp;
const BASE = () => `http://127.0.0.1:${port}/strucmed`;
const ONLINE_ENV = () => ({ STRUCMED_ONLINE_BASE_URL: BASE() + '/', STRUCMED_USER: ACCOUNT, STRUCMED_PASS: PASSWORD });

before(async () => {
  fake = http.createServer(handler);
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  port = fake.address().port;
  mcp = startMcp(ONLINE_ENV());
});
after(() => {
  mcp.stop(); fake.close();
  // 整個測試過程：密碼與 token 都不可出現在 MCP 的 stdout（tool 回應）或 stderr（log）
  for (const secret of [PASSWORD, ...issued]) {
    assert.ok(!mcp.stdout.includes(secret), `stdout leaked ${secret.slice(0, 4)}…`);
    assert.ok(!mcp.stderr.includes(secret), `stderr leaked ${secret.slice(0, 4)}…`);
  }
});
beforeEach(() => { reqs = []; for (const k of Object.keys(behavior)) delete behavior[k]; });

test('offline by default: online tools hidden and disabled, no network', async () => {
  const off = startMcp({});
  try {
    const list = await off.rpc('tools/list', {});
    assert.ok(!list.result.tools.some(t => t.name.startsWith('online_')), 'online tools not listed when unconfigured');
    for (const name of ['online_login', 'online_template_get', 'online_records_save']) {
      const r = await off.call(name, { template_id: 'T-1' });
      assert.equal(r.error.code, 'E_ONLINE_DISABLED', name);
    }
    const init = await off.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.ok(!init.result.instructions.includes('online_login'));
  } finally { off.stop(); }
  assert.equal(reqs.length, 0, 'no request reached the server');
});

test('only https (or loopback http) base URLs are accepted', async () => {
  for (const bad of ['http://lvaiw.cgmf.org.tw/strucmed', 'https://u:p@lvaiw.cgmf.org.tw/strucmed', 'ftp://127.0.0.1/x', 'not a url']) {
    const m = startMcp({ STRUCMED_ONLINE_BASE_URL: bad, STRUCMED_USER: ACCOUNT, STRUCMED_PASS: PASSWORD });
    try {
      const r = await m.call('online_login', {});
      assert.equal(r.error.code, 'E_ONLINE_DISABLED', bad);
      assert.ok(!JSON.stringify(r).includes(PASSWORD));
    } finally { m.stop(); }
  }
});

test('online tools need a login first', async () => {
  const m = startMcp(ONLINE_ENV());
  try {
    const list = await m.rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    for (const n of ['online_login', 'online_logout', 'online_folder_list', 'online_template_get', 'online_records_query', 'online_records_save', 'form_create'])
      assert.ok(names.includes(n), n);
    const login = list.result.tools.find(t => t.name === 'online_login');
    assert.deepEqual(Object.keys(login.inputSchema.properties).sort(), ['dept_no', 'hospital'], 'no credential parameters');
    assert.equal((await m.call('online_template_get', { template_id: 'T-1' })).error.code, 'E_AUTH');
  } finally { m.stop(); }
  assert.equal(reqs.length, 0);
});

test('missing credentials in the environment → E_AUTH without calling the server', async () => {
  const m = startMcp({ STRUCMED_ONLINE_BASE_URL: BASE() });
  try {
    const r = await m.call('online_login', {});
    assert.equal(r.error.code, 'E_AUTH');
    assert.match(r.error.message, /STRUCMED_USER/);
  } finally { m.stop(); }
  assert.equal(reqs.length, 0);
});

test('wrong password → E_AUTH; message does not echo the password', async () => {
  const m = startMcp({ ...ONLINE_ENV(), STRUCMED_PASS: 'wrong-pass-123' });
  try {
    const r = await m.call('online_login', {});
    assert.equal(r.error.code, 'E_AUTH');
    assert.equal(r.error.details.status, 401);
    assert.ok(!m.stdout.includes('wrong-pass-123') && !m.stderr.includes('wrong-pass-123'));
  } finally { m.stop(); }
});

test('login posts {hospital, account, password, deptNo} and returns only identity', async () => {
  const r = await mcp.call('online_login', { dept_no: 'APP' });
  assert.equal(r.ok, true);
  assert.deepEqual(reqs.map(q => q.path), ['/strucmed/api/v2/auth/token']);
  assert.deepEqual(reqs[0].body, { hospital: 'CGMH', account: ACCOUNT, password: PASSWORD, deptNo: 'APP' });
  assert.equal(r.data.user_id, USER_ID);
  assert.equal(r.data.dept_no, 'APP');
  assert.equal(r.data.base_url, BASE(), 'trailing slash normalised');
  const text = JSON.stringify(r);
  assert.ok(!/accessToken|refreshToken|acc-|ref-/.test(text), 'tokens never returned');
});

test('folder list and template get send the bearer token', async () => {
  await mcp.call('online_login', {});
  reqs = [];
  const f = await mcp.call('online_folder_list', { type: 'dpt', q: '跌倒', page: 2, page_size: 20 });
  assert.equal(f.ok, true);
  assert.equal(f.data.folder, 'dpt');
  assert.equal(reqs[0].path, '/strucmed/api/v2/folders/dpt/templates');
  assert.equal(new URLSearchParams(reqs[0].search).get('q'), '跌倒');
  assert.equal(new URLSearchParams(reqs[0].search).get('pageSize'), '20');
  assert.match(reqs[0].auth, /^Bearer acc-/);

  const t = await mcp.call('online_template_get', { template_id: 'T-1', save: true });
  assert.equal(t.data.package.format, 'strucmed.template/v2');
  assert.equal(t.data.saved, '.strucmed/online/T-1.package.json');
  assert.ok(fs.existsSync(path.join(mcp.ws, t.data.saved)));

  assert.equal((await mcp.call('online_template_get', { template_id: '../etc' })).error.code, 'E_INVALID_INPUT');
  assert.equal((await mcp.call('online_folder_list', { type: 'other' })).error.code, 'E_INVALID_INPUT');
});

test('401 → refresh → retry with the new access token', async () => {
  await mcp.call('online_login', {});
  validAccess.clear();                         // access token 過期
  reqs = [];
  const t = await mcp.call('online_template_get', { template_id: 'T-2' });
  assert.equal(t.ok, true);
  assert.deepEqual(reqs.map(q => q.path), ['/strucmed/api/v2/templates/T-2', '/strucmed/api/v2/auth/refresh', '/strucmed/api/v2/templates/T-2']);
  assert.match(reqs[1].body.refreshToken, /^ref-/);
  assert.notEqual(reqs[0].auth, reqs[2].auth, 'retried with the refreshed token');
  const s = await mcp.call('online_login', { dept_no: 'APP' });   // 登入仍正常
  assert.equal(s.data.user_id, USER_ID);
});

test('refresh fails → E_AUTH and the session is cleared', async () => {
  await mcp.call('online_login', {});
  validAccess.clear();
  behavior.refreshFails = true;
  const t = await mcp.call('online_template_get', { template_id: 'T-3' });
  assert.equal(t.error.code, 'E_AUTH');
  assert.match(t.error.message, /online_login/);
  reqs = [];
  assert.equal((await mcp.call('online_template_get', { template_id: 'T-3' })).error.code, 'E_AUTH');
  assert.equal(reqs.length, 0, 'no token left to send');
});

test('upstream errors and redirects are reported, redirects are not followed', async () => {
  await mcp.call('online_login', {});
  behavior.upstream500 = true;
  const e = await mcp.call('online_template_get', { template_id: 'T-1' });
  assert.equal(e.error.code, 'E_UPSTREAM');
  assert.equal(e.error.details.status, 502);
  assert.match(e.error.message, /倉儲連線失敗/);
  behavior.upstream500 = false;
  behavior.redirect = true;
  reqs = [];
  const r = await mcp.call('online_folder_list', { type: 'usr' });
  assert.equal(r.error.code, 'E_UPSTREAM');
  assert.match(r.error.message, /轉址/);
  assert.equal(reqs.length, 1, 'redirect target was not requested');
});

test('records query requires a chart number and forwards only the 12 warehouse fields', async () => {
  await mcp.call('online_login', {});
  reqs = [];
  assert.equal((await mcp.call('online_records_query', { kind: 'data', query: { sheetid: 'T-1' } })).error.code, 'E_INVALID_INPUT');
  assert.equal((await mcp.call('online_records_query', { kind: 'image', query: { chtno: 'Shortcut' } })).error.code, 'E_INVALID_INPUT');
  assert.equal(reqs.length, 0, 'rejected locally');

  const r = await mcp.call('online_records_query', { kind: 'image', query: { chtno: 'P000', sheetid: 'T-1', status: 'XMLdoc', assetNo: 'X', foo: 1 }, max_items: 1 });
  assert.equal(r.ok, true);
  assert.equal(reqs[0].path, '/strucmed/api/v2/records/query/image');
  assert.deepEqual(reqs[0].body, { patient: 'P000', source: 'strucmed-mcp', query: { chtno: 'P000', sheetid: 'T-1', status: 'XMLdoc' } });
  assert.equal(r.data.count, 2);
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.truncated, true);
  assert.ok(r.warnings.some(w => w.includes('assetNo') && w.includes('foo')));
});

test('records save is two-step: plan + confirm_token, then POST with iot.user from the token', async () => {
  await mcp.call('online_login', { dept_no: 'APP' });
  reqs = [];
  const args = { template_id: 'T-1', chtno: 'P000', opdno: 'O1', xml_content: '<doc>ok</doc>', detail: [{ dictID: 'd1', dictValue: '1' }] };
  const plan = await mcp.call('online_records_save', args);
  assert.equal(plan.ok, true);
  assert.equal(reqs.length, 0, 'first call does not write');
  assert.equal(plan.data.plan.chtno, 'P000');
  assert.equal(plan.data.plan.user_id, USER_ID);
  assert.equal(plan.data.plan.action, '新增病人紀錄');
  assert.ok(plan.data.confirm_token);

  const changed = await mcp.call('online_records_save', { ...args, xml_content: '<doc>changed</doc>', confirm_token: plan.data.confirm_token });
  assert.equal(changed.error.code, 'E_CONFIRM_MISMATCH');
  const forged = await mcp.call('online_records_save', { ...args, confirm_token: '9999999999999.deadbeef' });
  assert.equal(forged.error.code, 'E_CONFIRM_MISMATCH');
  assert.equal(reqs.length, 0);

  const done = await mcp.call('online_records_save', { ...args, confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true);
  assert.equal(done.data.result.xml.fillID, 'XML1');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].path, '/strucmed/api/v2/records/save');
  const b = reqs[0].body;
  assert.equal(b.iot.user, USER_ID);
  assert.equal(b.iot.deptNo, 'APP');
  assert.equal(b.iot.chtno, 'P000');
  assert.equal(b.iot.sheetid, 'T-1');
  assert.equal(b.templateID, 'T-1');
  assert.equal(b.xmlContent, '<doc>ok</doc>');
  assert.ok(!('assetNo' in b.iot) && !('user' in b), 'no assetNo, identity left to the token');
  assert.deepEqual(b.iot.detail, args.detail);

  // 覆寫被拒（伺服器判斷）→ 警告
  const ow = { ...args, xml_fill_id: 'XML0' };
  const p2 = await mcp.call('online_records_save', ow);
  assert.match(p2.data.plan.action, /覆寫/);
  const d2 = await mcp.call('online_records_save', { ...ow, confirm_token: p2.data.confirm_token });
  assert.ok(d2.warnings.some(w => w.startsWith('W_OVERWRITE_DENIED')));
});

test('logout clears the in-memory tokens', async () => {
  await mcp.call('online_login', {});
  assert.equal((await mcp.call('online_logout')).data.logged_out, true);
  reqs = [];
  assert.equal((await mcp.call('online_folder_list', { type: 'usr' })).error.code, 'E_AUTH');
  assert.equal(reqs.length, 0);
});

test('offline tools keep working when online is configured', async () => {
  const r = await mcp.call('form_create', { name: '線上模式離線表單', dept_no: 'TEST0' });
  assert.equal(r.ok, true);
  assert.ok(/^d-[0-9a-f]{12}$/.test(r.data.draft_id));
  assert.ok(!fs.existsSync(path.join(mcp.ws, '.strucmed', 'online', 'session.json')));
  // 工作目錄中任何檔案都不含密碼或 token
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(mcp.ws)) {
    const c = fs.readFileSync(f, 'utf8');
    for (const s of [PASSWORD, ...issued]) assert.ok(!c.includes(s), `${f} contains a secret`);
  }
});

test('online_me returns identity, folders and admin flag', async () => {
  await mcp.call('online_login', {});
  const r = await mcp.call('online_me', {});
  assert.equal(r.ok, true);
  assert.equal(r.data.user_id, USER_ID);
  assert.deepEqual(r.data.folders, { usr: USER_ID, sub: 'APP', dpt: 'APP' });
  assert.equal(r.data.is_admin, false);
  assert.ok(reqs.some(x => x.path.endsWith('/api/v2/me') && x.auth.startsWith('Bearer ')));
});

test('online_features aggregates health, runtime features and llm-config without the gateway token', async () => {
  await mcp.call('online_login', {});
  const r = await mcp.call('online_features', {});
  assert.equal(r.ok, true);
  assert.equal(r.data.health.ok, true);
  assert.equal(r.data.runtime.save, true, 'features called with the token user');
  assert.equal(r.data.runtime.query, false);
  assert.equal(r.data.llm_gateway.enabled, true);
  assert.equal(r.data.llm_gateway.base_url, '/llmgw');
  assert.equal(r.data.llm_gateway.site, 'strucmed', 'X-Asr-Site header sent');
  assert.ok(!JSON.stringify(r).includes(GW_TOKEN), 'browser token must not be returned');
  const feat = reqs.find(x => x.path.endsWith('/api/v2/runtime/features'));
  assert.ok(feat.search.includes('user=' + USER_ID) && feat.search.includes('deptNo=APP'));
});

test('online_features reports unavailable endpoints as warnings instead of failing', async () => {
  await mcp.call('online_login', {});
  behavior.upstream500 = true;
  const r = await mcp.call('online_features', {});
  assert.equal(r.ok, true);
  assert.equal(r.data.health.available, false);
  assert.equal(r.data.runtime.available, false);
  assert.equal(r.data.llm_gateway.available, false);
  assert.equal(r.warnings.length, 3);
});

test('online_dictionary_search filters by q and can replace the local dictionary index', async () => {
  await mcp.call('online_login', {});
  const bad = await mcp.call('online_dictionary_search', { scope: 'all' });
  assert.equal(bad.error.code, 'E_INVALID_INPUT');
  const r = await mcp.call('online_dictionary_search', { q: '跌倒', scope: 'exact' });
  assert.equal(r.ok, true);
  assert.equal(r.data.items.length, 2);
  assert.equal(r.data.items[0].name, '跌倒史');
  assert.ok(reqs.some(x => x.path.endsWith('/api/v2/dictionaries') && x.search.includes('scope=exact') && x.search.includes('q=')));
  const idx = await mcp.call('online_dictionary_search', { update_index: true });
  assert.equal(idx.data.index_updated, true);
  assert.equal(idx.data.index_count, 3);
  assert.deepEqual(idx.warnings, []);
  const local = await mcp.call('dictionary_search', { query: '疼痛', dept_no: 'APP' });
  assert.equal(local.ok, true);
  assert.equal(local.data.results.length, 1, JSON.stringify(local.data));
  assert.equal(local.data.results[0].id, 'D3');
  const partial = await mcp.call('online_dictionary_search', { q: '跌倒', update_index: true });
  assert.ok(partial.warnings.some(w => w.startsWith('W_INDEX_PARTIAL')));
});

test('feature flag online=false hides online tools and returns E_FEATURE_DISABLED', async () => {
  const flags = path.join(os.tmpdir(), 'strucmed-flags-' + process.pid + '.json');
  fs.writeFileSync(flags, JSON.stringify({ online: false }));
  const m = startMcp({ ...ONLINE_ENV(), STRUCMED_FLAGS: flags });
  try {
    const list = await m.rpc('tools/list', {});
    assert.ok(!list.result.tools.some(t => t.name.startsWith('online_')), 'online tools hidden by flag');
    assert.ok(list.result.tools.some(t => t.name === 'form_create'));
    const r = await m.call('online_login', {});
    assert.equal(r.error.code, 'E_FEATURE_DISABLED');
    assert.ok(!JSON.stringify(r).includes(PASSWORD));
  } finally { m.stop(); fs.rmSync(flags, { force: true }); }
  assert.equal(reqs.length, 0, 'no request reached the server');
});

// ── Phase 2：範本與字典寫入 ───────────────────────────────
async function makeDraft(m, { withPendingDict = false, name = '上架測試' } = {}) {
  const c = await m.call('form_create', { name, dept_no: 'APP', groups: ['門'] });
  assert.equal(c.ok, true, JSON.stringify(c));
  const a = await m.call('form_add_area', { draft_id: c.data.draft_id, type: 'form', title: '基本' });
  assert.equal(a.ok, true, JSON.stringify(a));
  const ctl = { datatype: 'textbox' };
  if (withPendingDict) ctl.dictionary = { name: '新字典A' };
  const x = await m.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: '主訴', control: ctl });
  assert.equal(x.ok, true, JSON.stringify(x));
  return c.data.draft_id;
}

test('online_template_create: two-step plan → POST, published recorded, errors mapped', async () => {
  await mcp.call('online_login', {});
  const id = await makeDraft(mcp);
  const sys = await mcp.call('online_template_create', { draft_id: id, folder_type: 'sys' });
  assert.equal(sys.error.code, 'E_INVALID_INPUT');
  const plan = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.data.plan.action, '新增範本');
  assert.equal(plan.data.plan.folder_code, USER_ID);
  assert.equal(plan.data.plan.publish_on_save, false, 'no shortcut → not published on save');
  assert.ok(/^[0-9a-f]{64}$/.test(plan.data.plan.draft_sha256), 'stable draft hash (no timestamps)');
  const plan1b = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr' });
  assert.equal(plan1b.data.plan.draft_sha256, plan.data.plan.draft_sha256, 'same draft → same hash across plan calls');
  assert.equal(reqs.filter(x => x.method === 'POST' && x.path.includes('/templates')).length, 0, 'plan step sends nothing');
  const bad = await mcp.call('online_template_create', { draft_id: id, folder_type: 'dpt', confirm_token: plan.data.confirm_token });
  assert.equal(bad.error.code, 'E_CONFIRM_MISMATCH', 'token bound to folder');
  const done = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr', confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.data.template_id, /^T-\d+$/);
  assert.equal(done.data.rev, 1);
  const post = reqs.find(x => x.method === 'POST' && x.path.endsWith('/api/v2/folders/usr/templates'));
  assert.ok(post && post.auth.startsWith('Bearer ') && Array.isArray(post.body.form) && post.body.template.name === '上架測試');
  assert.equal(post.body.form[post.body.form.length - 1].itemtype, 'iot');
  const back = await mcp.call('online_template_get', { template_id: done.data.template_id });
  assert.equal(back.data.package.template.name, '上架測試', 'template readable after create');
  assert.equal(back.data.package.template.templateID, done.data.template_id);
  behavior.writesDisabled = true;
  const plan2 = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr' });
  const r503 = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr', confirm_token: plan2.data.confirm_token });
  assert.equal(r503.error.code, 'E_WRITES_DISABLED');
  delete behavior.writesDisabled; behavior.pendingFail = true;
  const plan3 = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr' });
  const r502 = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr', confirm_token: plan3.data.confirm_token });
  assert.equal(r502.error.code, 'E_UPSTREAM');
  assert.equal(r502.error.details.pending, true);
  assert.match(r502.error.message, /請勿重複保存/);
});

test('online_template_create refuses drafts with pending dictionaries (E_DICT_PENDING)', async () => {
  await mcp.call('online_login', {});
  const id = await makeDraft(mcp, { withPendingDict: true, name: '待字典' });
  const r = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr' });
  assert.equal(r.error.code, 'E_DICT_PENDING');
  assert.deepEqual(r.error.details.pending, ['新字典A']);
});

test('online_template_update: only derived drafts, If-Match from ETag, 409 → E_CONFLICT', async () => {
  await mcp.call('online_login', {});
  const fresh = await makeDraft(mcp, { name: '非改版' });
  const notDerived = await mcp.call('online_template_update', { draft_id: fresh, template_id: 'T-1' });
  assert.equal(notDerived.error.code, 'E_INVALID_INPUT');
  const got = await mcp.call('online_template_get', { template_id: 'T-1', save: true });
  assert.equal(got.ok, true, JSON.stringify(got));
  const imp = await mcp.call('form_import', { source_path: got.data.saved, name: '跌倒評估 改版', dept_no: 'APP' });
  assert.equal(imp.ok, true, JSON.stringify(imp));
  assert.equal(imp.data.derived_from.templateID, 'T-1');
  const plan = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-1' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.data.plan.if_match, ONLINE_SHA, 'If-Match taken from ETag');
  assert.equal(plan.data.plan.diff.controls_before, 1);
  const noIfMatch = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-1', confirm_token: plan.data.confirm_token });
  assert.equal(noIfMatch.error.code, 'E_INVALID_INPUT');
  const done = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-1', if_match: plan.data.plan.if_match, confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.data.rev, 2);
  const put = reqs.find(x => x.method === 'PUT');
  assert.ok(put, 'PUT sent');
  const plan2 = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-1' });
  behavior.conflict = true;
  const conflict = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-1', if_match: plan2.data.plan.if_match, confirm_token: plan2.data.confirm_token });
  assert.equal(conflict.error.code, 'E_CONFLICT');
  assert.equal(conflict.error.details.currentSha256, 'sha-other');
  const versions = await mcp.call('online_template_versions', { template_id: 'T-1' });
  assert.equal(versions.data.current_rev, 2);
  assert.equal(versions.data.items[0].rev, 2);
});

test('feature flag templateUpdate=false hides online_template_update', async () => {
  const flags = path.join(os.tmpdir(), 'strucmed-flags2-' + process.pid + '.json');
  fs.writeFileSync(flags, JSON.stringify({ templateUpdate: false }));
  const m = startMcp({ ...ONLINE_ENV(), STRUCMED_FLAGS: flags });
  try {
    const list = await m.rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    assert.ok(names.includes('online_template_create') && !names.includes('online_template_update'));
    assert.ok(!names.includes('online_dictionary_create'), 'dictionaryWrite defaults to false');
    await m.call('online_login', {});
    assert.equal((await m.call('online_template_update', { draft_id: 'd-000000000000', template_id: 'T-1' })).error.code, 'E_FEATURE_DISABLED');
  } finally { m.stop(); fs.rmSync(flags, { force: true }); }
});

test('online_dictionary_create (flag on): creates or reuses, binds dicid, refuses deleted-exists without force', async () => {
  const flags = path.join(os.tmpdir(), 'strucmed-flags3-' + process.pid + '.json');
  fs.writeFileSync(flags, JSON.stringify({ dictionaryWrite: true }));
  const m = startMcp({ ...ONLINE_ENV(), STRUCMED_FLAGS: flags });
  try {
    await m.call('online_login', {});
    const id = await makeDraft(m, { withPendingDict: true, name: '字典上架' });
    const notPending = await m.call('online_dictionary_create', { draft_id: id, name: '不存在' });
    assert.equal(notPending.error.code, 'E_INVALID_INPUT');
    const plan = await m.call('online_dictionary_create', { draft_id: id, name: '新字典A' });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.deepEqual(plan.data.plan.used_by_itemids, [2]);
    const done = await m.call('online_dictionary_create', { draft_id: id, name: '新字典A', confirm_token: plan.data.confirm_token });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.data.created, true);
    assert.deepEqual(done.data.bound_itemids, [2]);
    assert.deepEqual(done.data.pending_left, []);
    const pv = await m.call('form_preview', { draft_id: id, format: 'tree' });
    assert.match(pv.data.content, /新字典A／僅寫入/, 'control bound to created id');
    const v = await m.call('form_validate', { draft_id: id });
    assert.equal(v.data.valid, true, JSON.stringify(v.data.errors));
    const create = await m.call('online_template_create', { draft_id: id, folder_type: 'usr' });
    assert.equal(create.ok, true, 'no pending dictionaries left → template plan available');
    assert.equal(create.data.plan.dictionaries[0].id, done.data.id);
    // 已刪除同名：不自動 force
    const id2 = await m.call('form_create', { name: '刪除字典測試', dept_no: 'APP' });
    const a2 = await m.call('form_add_area', { draft_id: id2.data.draft_id, type: 'form', title: 'x' });
    await m.call('form_add_control', { draft_id: id2.data.draft_id, area_itemid: a2.data.area_itemid, label_text: 'y', control: { datatype: 'textbox', dictionary: { name: '已刪除字典' } } });
    const p2 = await m.call('online_dictionary_create', { draft_id: id2.data.draft_id, name: '已刪除字典' });
    const r409 = await m.call('online_dictionary_create', { draft_id: id2.data.draft_id, name: '已刪除字典', confirm_token: p2.data.confirm_token });
    assert.equal(r409.error.code, 'E_DELETED_EXISTS');
    assert.equal(r409.error.details.candidates[0].id, 'D9');
    const p3 = await m.call('online_dictionary_create', { draft_id: id2.data.draft_id, name: '已刪除字典', force: true });
    const forced = await m.call('online_dictionary_create', { draft_id: id2.data.draft_id, name: '已刪除字典', force: true, confirm_token: p3.data.confirm_token });
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.ok(reqs.some(x => x.path.endsWith('/api/v2/dictionaries') && x.body && x.body.force === true));
  } finally { m.stop(); fs.rmSync(flags, { force: true }); }
});

test('online_dictionary_batch (flag on): binds successes, leaves failures pending', async () => {
  const flags = path.join(os.tmpdir(), 'strucmed-flags4-' + process.pid + '.json');
  fs.writeFileSync(flags, JSON.stringify({ dictionaryWrite: true }));
  const m = startMcp({ ...ONLINE_ENV(), STRUCMED_FLAGS: flags });
  try {
    await m.call('online_login', {});
    const c = await m.call('form_create', { name: '批次字典', dept_no: 'APP' });
    const a = await m.call('form_add_area', { draft_id: c.data.draft_id, type: 'form', title: 'x' });
    for (const nm of ['批次甲', '已刪除字典'])
      assert.equal((await m.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: nm, control: { datatype: 'textbox', dictionary: { name: nm } } })).ok, true);
    const plan = await m.call('online_dictionary_batch', { draft_id: c.data.draft_id });
    assert.equal(plan.data.plan.rows.length, 2);
    const done = await m.call('online_dictionary_batch', { draft_id: c.data.draft_id, confirm_token: plan.data.confirm_token });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.data.succeeded, 1);
    assert.deepEqual(done.data.pending_left, ['已刪除字典']);
    assert.equal(done.warnings.length, 1);
  } finally { m.stop(); fs.rmSync(flags, { force: true }); }
});

test('online_me_notes_get/set: incremental diff plan, two-step PUT, no-change short-circuit', async () => {
  await mcp.call('online_login', {});
  const g = await mcp.call('online_me_notes_get', {});
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(g.data.items, [{ template_id: 'T-1', name: '跌倒評估' }]);
  const none = await mcp.call('online_me_notes_set', { add: [{ template_id: 'T-1', name: '跌倒評估' }] });
  assert.equal(none.data.no_change, true);
  const plan = await mcp.call('online_me_notes_set', { add: [{ template_id: 'T-2', name: '疼痛評估' }], remove: ['T-1'] });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.data.plan.added.length, 1);
  assert.equal(plan.data.plan.removed.length, 1);
  assert.equal(reqs.filter(x => x.method === 'PUT').length, 0, 'plan step does not write');
  const done = await mcp.call('online_me_notes_set', { add: [{ template_id: 'T-2', name: '疼痛評估' }], remove: ['T-1'], confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.data.items, [{ template_id: 'T-2', name: '疼痛評估' }]);
  const put = reqs.find(x => x.method === 'PUT' && x.path.endsWith('/api/v2/me/notes'));
  assert.deepEqual(put.body, { items: [{ dictID: 'T-2', dictVal: '疼痛評估' }] });
  const bad = await mcp.call('online_me_notes_set', { items: [{ template_id: 'bad id!', name: 'x' }] });
  assert.equal(bad.error.code, 'E_INVALID_INPUT');
});
