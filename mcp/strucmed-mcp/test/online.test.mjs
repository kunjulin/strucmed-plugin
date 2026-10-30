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
import * as dc from '../src/dictcomment.mjs';
import { fakeAuthorize, browserLogin, browserApprove } from './fake-login.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../src/server.mjs');
const USER_ID = 'U123';
const GW_TOKEN = 'cgllm-browser-Secret42';     // api/llm-config 回的瀏覽器型金鑰：tool 不可回傳
const ONLINE_SHA = 'sha-online-1';
const ONLINE_FORM = [{ itemtype: 'form', itemid: 1, authread: ['doctor'], authwrite: ['doctor'], gettext: true, item: [{ datatype: 'text', datavalue: '姓名' }, { datatype: 'textbox', itemid: 2, datavalue: '', dictionary: '', dicid: '', dicrole: 'nohis' }] }, { itemtype: 'javascript', content: '' }, { itemtype: 'iot', sheetid: 'T-1', templateID: 'T-1', editorver: '1.6' }];
const templates = new Map();             // 假伺服器保存的範本
// 完整的範本套件 v2（form_import 會驗證 schema 與 integrity）；ETag 另外給（head sha 與 integrity 不同，與真實伺服器相同）
const fakePackage = (id, template, form) => buildPackage({ form, meta: { name: template.name, dept_no: 'APP', groups: template.groups || [], shortcut: template.shortcut || '', description: template.description || '', folder_type: 'usr' }, generator: 'fake-v2', templateID: id });
let tplSeq = 100, dictSeq = 0;
// 假字典表（docs/14：dicComment 是 JSON 容器）。D5 是體系（PP＝APP 的第 2–3 碼）字典、D6 是其他體系的 5 碼字典、
// D7 是同體系他科（XPPB0）由管理者升級的字典：dicType 不變，說明帶體系標記 sys.code＝PP
const seedDicts = () => [{ id: 'D1', dicType: 'APP', dicName: '跌倒史', dicComment: '有無跌倒', createDate: '20260101' },
  { id: 'D2', dicType: 'APP', dicName: '跌倒史', dicComment: '重複', createDate: '20250101' },
  { id: 'D3', dicType: 'APP', dicName: '疼痛評估', dicComment: '', createDate: '20240101' },
  { id: 'D5', dicType: 'PP', dicName: '體重', dicComment: dc.build({ desc: '體重（kg）', memo: { unit: 'kg' } }), createDate: '20230101' },
  { id: 'D6', dicType: 'XAPP0', dicName: '握力', dicComment: '握力（kg）', createDate: '20220101' },
  { id: 'D7', dicType: 'XPPB0', dicName: '鬆弛度', dicComment: dc.build({ desc: '關節鬆弛度', sys: { code: 'PP', by: 'ADM01', at: '2026-10-27T01:00:00Z' } }), createDate: '20210101' }];
let dicts = seedDicts();
const dictItem = d => { const p = dc.parse(d.dicComment); return { id: d.id, dicType: d.dicType, dicName: d.dicName, dicComment: d.dicComment, createDate: d.createDate,
  desc: p.desc, sys: p.sys, memo: p.memo, fhir: p.fhir, aliasOf: p.alias_of, level: dc.level(d.dicType, 'APP', p.sys ? p.sys.code : ''), etag: dc.etag(d.dicComment),
  memoBy: p.memo_by, memoAt: p.memo_at }; };
// 字典使用索引（平台每日掃描）：D1 被兩張範本用、D5 一張
let usage = { scannedAt: '2026-10-27T02:00:00Z', uses: [{ dic: 'D1', templateID: 'T-1', templatename: '跌倒評估', folder: 'APP', itemIds: '2' }, { dic: 'D1', templateID: 'T-7', templatename: '住院跌倒', folder: 'APP', itemIds: '5,6' }, { dic: 'D5', templateID: 'T-8', templatename: 'BMI', folder: 'U123', itemIds: '3' }] };
const dictConflict = (res, d) => json(res, 409, { ok: false, error: { code: 'E_CONFLICT', message: '字典已被修改', details: { etag: dc.etag(d.dicComment), current: dictItem(d) } } });
let notes = [{ dictID: 'T-1', dictVal: '跌倒評估' }];   // struNote 清單   // 新建的範本從 T-101 起，不與預設的 T-1 衝突

// ── 假伺服器 ────────────────────────────────────────────────
let fake, port, reqs = [], tokenSeq = 0, validAccess = new Set(), validRefresh = new Set();
const issued = [];                             // 發出過的 token：也不可出現在 tool 回應
const behavior = {};
const login = fakeAuthorize();
let revoked = [];
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
    reqs.push({ method: req.method, path: url.pathname, search: url.search, auth, body, ifMatch: String(req.headers['if-match'] || '') });
    const p = url.pathname.replace(/^\/strucmed\//, '');
    if (p === 'api/v2/auth/authorize' && req.method === 'GET') return login.authorize(url, res);
    if (p === 'api/v2/auth/token') {
      if (body.grantType !== 'authorization_code' || !login.exchange(body)) return err(res, 400, 'E_INVALID_GRANT', '授權碼無效');
      return json(res, 200, issue(true));
    }
    if (p === 'api/v2/auth/revoke') { revoked.push(body.token); validRefresh.delete(body.token); return json(res, 200, { ok: true }); }
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
    if (req.method === 'GET' && p === 'api/v2/me/notes') return json(res, 200, { ok: true, fillID: 'N1', items: notes });
    if (req.method === 'PUT' && p === 'api/v2/me/notes') { notes = (body.items || []).map(x => ({ dictID: x.dictID, dictVal: x.dictVal })); return json(res, 200, { ok: true, fillID: 'N1', count: notes.length }); }
    if (req.method === 'GET' && p === 'api/v2/me')
      return json(res, 200, { userId: USER_ID, name: '測試醫師', deptNo: behavior.noDept ? '' : 'APP', folders: { usr: USER_ID, sub: 'APP', dpt: 'APP' }, isAdmin: false, tokenExpiresAt: '2026-10-19T12:00:00Z' });
    if (req.method === 'GET' && p === 'api/health') return json(res, 200, { ok: true, ts: '2026-10-19T00:00:00Z' });
    if (req.method === 'GET' && p === 'api/v2/runtime/features')
      return json(res, 200, { ok: true, presets: true, recordDelete: true, save: url.searchParams.get('user') === USER_ID, query: false, queryRoot: 'x' });
    if (req.method === 'GET' && p === 'api/llm-config') {
      issued.push(GW_TOKEN);
      return json(res, 200, { enabled: true, baseUrl: '/llmgw', token: GW_TOKEN, site: req.headers['x-asr-site'] || 'unknown', endpoints: [] });
    }
    if (req.method === 'GET' && p === 'api/v2/dictionaries') {
      const q = url.searchParams.get('q') || '';
      const scope = url.searchParams.get('scope') || 'match';
      // 假伺服器不分 scope 都回全部（既有測試依賴）；all 時把他體系的 D6（XAPP0）標成 other
      let items = dicts.filter(d => !q || d.dicName.includes(q) || (scope === 'all' && String(d.dicComment).includes(q))).map(dictItem);
      if (scope === 'all') items = items.map(it => ({ ...it, level: it.id === 'D6' ? 'other' : it.level }));
      if (behavior.oldServer) for (const it of items) for (const k of ['desc', 'sys', 'memo', 'fhir', 'aliasOf', 'level', 'etag', 'memoBy', 'memoAt']) delete it[k];
      const total = items.length, page = Number(url.searchParams.get('page') || 0), size = Number(url.searchParams.get('pageSize') || 100);
      if (page) items = items.slice((page - 1) * size, page * size);
      return json(res, 200, { deptNo: 'APP', scope, levels: scope === 'all' ? [] : ['APP'], total, truncated: false, items,
        ...(page && { page, pageSize: size, hasMore: page * size < total }), ...(!(behavior.oldServer || behavior.oldMemoKeys) && { memoKeys: dc.MEMO_KEYS }) });
    }
    if (req.method === 'GET' && p === 'api/v2/dictionaries/usage') {
      if (behavior.noUsageApi) return err(res, 403, 'E_FORBIDDEN', 'not allowed');
      const counts = {};
      for (const u of usage.uses) counts[u.dic] = (counts[u.dic] || 0) + 1;
      return json(res, 200, { scannedAt: usage.scannedAt, counts });
    }
    if (req.method === 'GET' && (m = p.match(/^api\/v2\/dictionaries\/([A-Za-z0-9-]+)\/usage$/))) {
      const uses = usage.uses.filter(u => u.dic === m[1]);
      return json(res, 200, { id: m[1], scannedAt: usage.scannedAt, count: uses.length, templates: uses.map(({ dic, ...t }) => t) });
    }
    if (req.method === 'PUT' && p === 'api/v2/dictionaries/memo/batch') {
      if (behavior.noMemoBatch) return err(res, 403, 'E_FORBIDDEN', 'not allowed');
      const results = (body.items || []).map((x, i) => {
        const d = dicts.find(y => y.id === x.id);
        if (!d) return { row: i + 1, ok: false, id: x.id, code: 'E_NOT_FOUND', message: '找不到字典' };
        if (x.etag !== dc.etag(d.dicComment)) return { row: i + 1, ok: false, id: x.id, code: 'E_CONFLICT', message: '字典已被修改', details: { etag: dc.etag(d.dicComment), current: dictItem(d) } };
        const cur = dc.parse(d.dicComment);
        d.dicComment = dc.build({ desc: cur.desc, memo: x.memo !== undefined ? x.memo : cur.memo, fhir: x.fhir !== undefined ? x.fhir : cur.fhir,
          memo_by: USER_ID, memo_at: '2026-10-27T10:00:00Z', sys: cur.sys, promote: cur.promote, alias_of: cur.alias_of }, { forceJson: true });
        return { row: i + 1, ok: true, id: x.id, item: dictItem(d) };
      });
      return json(res, 200, { ok: true, total: results.length, succeeded: results.filter(r => r.ok).length, results });
    }
    if ((m = p.match(/^api\/v2\/dictionaries\/([A-Za-z0-9-]+)\/(memo)$/))) {
      const d = dicts.find(x => x.id === m[1]);
      if (!d) return err(res, 404, 'E_NOT_FOUND', '找不到字典');
      const tag = String(req.headers['if-match'] || '').replace(/^W\//, '').replace(/"/g, '');
      if (!tag) return err(res, 428, 'E_PRECONDITION', '缺少 If-Match');
      if (tag !== dc.etag(d.dicComment)) return dictConflict(res, d);
      const cur = dc.parse(d.dicComment);
      if (m[2] === 'memo' && req.method === 'PUT') {
        d.dicComment = dc.build({ desc: cur.desc, memo: body.memo !== undefined ? body.memo : cur.memo, fhir: body.fhir !== undefined ? body.fhir : cur.fhir,
          memo_by: USER_ID, memo_at: '2026-10-26T10:00:00Z', sys: cur.sys, promote: cur.promote, alias_of: cur.alias_of }, { forceJson: true });
      } else return err(res, 405, 'E_METHOD', 'method');
      const it = dictItem(d);
      return json(res, 200, { ok: true, ...it, memoBy: dc.parse(d.dicComment).memo_by, memoAt: dc.parse(d.dicComment).memo_at, warnings: [] });
    }
    return err(res, 404, 'E_NOT_FOUND', 'no route');
  });
}

// ── MCP 子行程 ──────────────────────────────────────────────
function startMcp(env) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-online-'));
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, STRUCMED_WORKSPACE: ws, STRUCMED_SITE: 'offline', STRUCMED_ONLINE_BASE_URL: '', STRUCMED_NO_BROWSER: '1', STRUCMED_LOGIN_WAIT_MS: '300', STRUCMED_APPROVE_WAIT_MS: '300', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
const ONLINE_ENV = () => ({ STRUCMED_ONLINE_BASE_URL: BASE() + '/' });

before(async () => {
  fake = http.createServer(handler);
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  port = fake.address().port;
  mcp = startMcp(ONLINE_ENV());
});
after(() => {
  mcp.stop(); fake.closeAllConnections(); fake.close();   // fetch（測試端的瀏覽器）留下的 keep-alive 連線
  // 整個測試過程：token 與授權碼都不可出現在 MCP 的 stdout（tool 回應）或 stderr（log）
  for (const secret of [...issued, ...login.issuedCodes]) {
    assert.ok(!mcp.stdout.includes(secret), `stdout leaked ${secret.slice(0, 4)}…`);
    assert.ok(!mcp.stderr.includes(secret), `stderr leaked ${secret.slice(0, 4)}…`);
  }
});
beforeEach(() => { reqs = []; revoked = []; dicts = seedDicts(); login.deny = false; for (const k of Object.keys(behavior)) delete behavior[k]; });

test('offline by default: online tools hidden and disabled, no network', async () => {
  const off = startMcp({});
  try {
    const list = await off.rpc('tools/list', {});
    assert.ok(!list.result.tools.some(t => t.name.startsWith('online_')), 'online tools not listed when unconfigured');
    for (const name of ['online_login', 'online_template_get', 'online_me_notes_set']) {
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
    const m = startMcp({ STRUCMED_ONLINE_BASE_URL: bad });
    try {
      const r = await m.call('online_login', {});
      assert.equal(r.error.code, 'E_ONLINE_DISABLED', bad);
    } finally { m.stop(); }
  }
});

test('online tools need a login first', async () => {
  const m = startMcp(ONLINE_ENV());
  try {
    const list = await m.rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    for (const n of ['online_login', 'online_logout', 'online_folder_list', 'online_template_get', 'online_me_notes_get', 'form_create'])
      assert.ok(names.includes(n), n);
    for (const n of ['online_records_query', 'online_records_save'])
      assert.ok(!names.includes(n), `${n} was removed (platform returns 403 for strucmed-mcp tokens)`);
    const login = list.result.tools.find(t => t.name === 'online_login');
    assert.deepEqual(Object.keys(login.inputSchema.properties).sort(), ['dept_no', 'hospital'], 'no credential parameters');
    assert.equal((await m.call('online_template_get', { template_id: 'T-1' })).error.code, 'E_AUTH');
  } finally { m.stop(); }
  assert.equal(reqs.length, 0);
});

test('login opens the browser login page with PKCE and a loopback redirect, then exchanges the code', async () => {
  const m = startMcp(ONLINE_ENV());
  try {
    const first = await m.call('online_login', { dept_no: 'APP' });
    assert.equal(first.ok, true);
    assert.equal(first.data.pending, true);
    assert.equal(first.data.browser_opened, false, 'STRUCMED_NO_BROWSER=1');
    const u = new URL(first.data.authorize_url);
    assert.equal(u.origin + u.pathname, BASE() + '/api/v2/auth/authorize');
    const q = Object.fromEntries(u.searchParams);
    assert.equal(q.client_id, 'strucmed-mcp');
    assert.equal(q.response_type, 'code');
    assert.equal(q.code_challenge_method, 'S256');
    assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.match(q.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(q.dept_no, 'APP');
    assert.ok(q.state.length >= 16);
    assert.equal(reqs.length, 0, 'nothing is sent to the site before the browser opens the page');

    // 再呼叫一次但瀏覽器還沒完成：沿用同一個登入（不換網址）
    const again = await m.call('online_login', { dept_no: 'APP' });
    assert.equal(again.data.authorize_url, first.data.authorize_url);

    await (await fetch(first.data.authorize_url)).text();
    const r = await m.call('online_login', { dept_no: 'APP' });
    assert.equal(r.ok, true);
    assert.equal(r.data.logged_in, true);
    assert.equal(r.data.user_id, USER_ID);
    assert.equal(r.data.dept_no, 'APP');
    assert.equal(r.data.base_url, BASE(), 'trailing slash normalised');
    const token = reqs.find(x => x.path === '/strucmed/api/v2/auth/token');
    assert.deepEqual(Object.keys(token.body).sort(), ['clientId', 'code', 'codeVerifier', 'grantType', 'redirectUri']);
    assert.equal(token.body.grantType, 'authorization_code');
    assert.equal(token.body.redirectUri, q.redirect_uri);
    assert.ok(!/accessToken|refreshToken|acc-|ref-/.test(JSON.stringify(r)), 'tokens never returned');

    // 已登入：不再開登入頁
    const status = await m.call('online_login', {});
    assert.equal(status.data.already, true);
  } finally { m.stop(); }
});

test('the loopback callback ignores requests with a wrong state', async () => {
  const m = startMcp(ONLINE_ENV());
  try {
    const first = await m.call('online_login', {});
    const redirect = new URL(first.data.authorize_url).searchParams.get('redirect_uri');
    const bad = await fetch(redirect + '?code=ac_forged&state=wrong');
    assert.equal(bad.status, 400);
    await bad.text();
    const still = await m.call('online_login', {});
    assert.equal(still.data.pending, true, 'a forged callback does not complete the login');
    assert.ok(!reqs.some(x => x.path.endsWith('/auth/token')));
  } finally { m.stop(); }
});

test('denied on the login page → E_AUTH, and a new login can start', async () => {
  const m = startMcp(ONLINE_ENV());
  try {
    login.deny = true;
    const r = await browserLogin(m);
    assert.equal(r.error.code, 'E_AUTH');
    assert.match(r.error.message, /拒絕/);
    login.deny = false;
    assert.equal((await browserLogin(m)).data.logged_in, true);
  } finally { m.stop(); }
});

test('folder list and template get send the bearer token', async () => {
  await browserLogin(mcp, {});
  reqs = [];
  const f = await mcp.call('online_folder_list', { type: 'dpt', q: '跌倒', page: 2, page_size: 20 });
  assert.equal(f.ok, true);
  assert.equal(f.data.folder, 'dpt');
  assert.equal(reqs[0].path, '/strucmed/api/v2/folders/dpt/templates');
  assert.equal(new URLSearchParams(reqs[0].search).get('q'), '跌倒');
  assert.equal(new URLSearchParams(reqs[0].search).get('pageSize'), '20');
  assert.match(reqs[0].auth, /^Bearer acc-/);

  const t = await mcp.call('online_template_get', { template_id: 'T-1', save: true });
  assert.equal(t.data.package, undefined, 'save:true returns a summary only (試用回饋 #5)');
  assert.equal(t.data.summary.name, '跌倒評估');
  assert.equal(t.data.summary.controls, 1);
  assert.equal(t.data.summary.areas, 1);
  assert.deepEqual(t.data.summary.groups, ['門']);
  assert.equal(t.data.saved, '.strucmed/online/T-1.package.json');
  assert.equal(JSON.parse(fs.readFileSync(path.join(mcp.ws, t.data.saved), 'utf8')).format, 'strucmed.template/v2');
  const full = await mcp.call('online_template_get', { template_id: 'T-1', save: true, include_package: true });
  assert.equal(full.data.package.format, 'strucmed.template/v2');

  assert.equal((await mcp.call('online_template_get', { template_id: '../etc' })).error.code, 'E_INVALID_INPUT');
  assert.equal((await mcp.call('online_folder_list', { type: 'other' })).error.code, 'E_INVALID_INPUT');
});

test('401 → refresh → retry with the new access token', async () => {
  await browserLogin(mcp, {});
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
  await browserLogin(mcp, {});
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
  await browserLogin(mcp, {});
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

test('logout revokes the refresh token and clears the in-memory tokens', async () => {
  await browserLogin(mcp, {});
  const out = await mcp.call('online_logout');
  assert.equal(out.data.logged_out, true);
  assert.equal(out.data.revoked, true);
  assert.equal(revoked.length, 1);
  assert.match(revoked[0], /^ref-/);
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
    for (const s of [...issued, ...login.issuedCodes]) assert.ok(!c.includes(s), `${f} contains a secret`);
  }
});

test('online_me returns identity, folders and admin flag', async () => {
  await browserLogin(mcp, {});
  const r = await mcp.call('online_me', {});
  assert.equal(r.ok, true);
  assert.equal(r.data.user_id, USER_ID);
  assert.deepEqual(r.data.folders, { usr: USER_ID, sub: 'APP', dpt: 'APP' });
  assert.equal(r.data.is_admin, false);
  assert.ok(reqs.some(x => x.path.endsWith('/api/v2/me') && x.auth.startsWith('Bearer ')));
});

test('online_me explains an empty dept_no (試用回饋 #11)', async () => {
  await browserLogin(mcp, {});
  assert.equal((await mcp.call('online_me', {})).data.warnings, undefined);
  behavior.noDept = true;
  const r = await mcp.call('online_me', {});
  assert.equal(r.data.dept_no, '');
  assert.match(r.data.warnings[0], /^W_NO_DEPT：.*online_login\(dept_no\)/);
});

test('online_features aggregates health, runtime features and llm-config without the gateway token', async () => {
  await browserLogin(mcp, {});
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
  await browserLogin(mcp, {});
  behavior.upstream500 = true;
  const r = await mcp.call('online_features', {});
  assert.equal(r.ok, true);
  assert.equal(r.data.health.available, false);
  assert.equal(r.data.runtime.available, false);
  assert.equal(r.data.llm_gateway.available, false);
  assert.equal(r.warnings.length, 3);
});

test('online_dictionary_search filters by q and can replace the local dictionary index', async () => {
  await browserLogin(mcp, {});
  const bad = await mcp.call('online_dictionary_search', { scope: 'all' });
  assert.equal(bad.error.code, 'E_INVALID_INPUT');
  const r = await mcp.call('online_dictionary_search', { q: '跌倒', scope: 'exact' });
  assert.equal(r.ok, true);
  assert.equal(r.data.items.length, 2);
  assert.equal(r.data.items[0].name, '跌倒史');
  assert.ok(reqs.some(x => x.path.endsWith('/api/v2/dictionaries') && x.search.includes('scope=exact') && x.search.includes('q=')));
  const idx = await mcp.call('online_dictionary_search', { update_index: true });
  assert.equal(idx.data.index_updated, true);
  assert.equal(idx.data.index_count, 6);
  assert.deepEqual(idx.warnings, []);
  // docs/14：體系優先排序、level／desc／memo／etag
  assert.equal(idx.data.items[0].id, 'D5');
  assert.equal(idx.data.items[0].level, 'sys');
  assert.equal(idx.data.items[0].desc, '體重（kg）');
  assert.deepEqual(idx.data.items[0].memo, { unit: 'kg' });
  assert.equal(idx.data.items[0].etag, dc.etag(dicts.find(d => d.id === 'D5').dicComment));
  assert.equal(idx.data.items.find(x => x.id === 'D1').desc, '有無跌倒', 'legacy plain text is desc');
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
  await browserLogin(mcp, {});
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
  const done = await browserApprove(mcp, 'online_template_create', { draft_id: id, folder_type: 'usr', confirm_token: plan.data.confirm_token });
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
  const r503 = await browserApprove(mcp, 'online_template_create', { draft_id: id, folder_type: 'usr', confirm_token: plan2.data.confirm_token });
  assert.equal(r503.error.code, 'E_WRITES_DISABLED');
  delete behavior.writesDisabled; behavior.pendingFail = true;
  const plan3 = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr' });
  const r502 = await browserApprove(mcp, 'online_template_create', { draft_id: id, folder_type: 'usr', confirm_token: plan3.data.confirm_token });
  assert.equal(r502.error.code, 'E_UPSTREAM');
  assert.equal(r502.error.details.pending, true);
  assert.match(r502.error.message, /請勿重複保存/);
});

// 2.3.0：寫入的第二段呼叫要使用者在瀏覽器確認頁按「確認寫入」；token 再對也不會自己寫入
test('online writes wait for the browser confirmation page: pending → approve once, reject, guarded page', async () => {
  await browserLogin(mcp, {});
  const id = await makeDraft(mcp, { name: '確認頁測試' });
  const posts = () => reqs.filter(x => x.method === 'POST' && x.path.includes('/templates')).length;
  const plan = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr' });
  const args = { draft_id: id, folder_type: 'usr', confirm_token: plan.data.confirm_token };
  const pend = await mcp.call('online_template_create', args);
  assert.equal(pend.ok, true, JSON.stringify(pend));
  assert.equal(pend.data.pending, true);
  assert.equal(pend.data.browser_opened, false, 'STRUCMED_NO_BROWSER=1');
  assert.equal(posts(), 0, 'a valid confirm_token alone writes nothing');
  const u = new URL(pend.data.approve_url);
  assert.equal(u.hostname, '127.0.0.1');
  const again = await mcp.call('online_template_create', args);
  assert.equal(again.data.approve_url, pend.data.approve_url, 'calling again keeps waiting on the same page');

  const page = await (await fetch(u)).text();
  for (const s of ['新增範本', '確認頁測試', USER_ID, '確認寫入']) assert.ok(page.includes(s), s);
  const wrongNonce = new URL(u); wrongNonce.searchParams.set('n', '0'.repeat(32));
  assert.equal((await fetch(wrongNonce)).status, 404);
  const raw = (method, headers, body) => new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port: u.port, path: method === 'GET' ? u.pathname + u.search : '/decide', method, headers }, res => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    r.on('error', no); r.end(body);
  });
  assert.equal(await raw('GET', { Host: 'evil.example' }), 400, 'DNS rebinding: Host must be 127.0.0.1:<port>');
  const form = new URLSearchParams({ n: u.searchParams.get('n'), d: 'approve' }).toString();
  assert.equal(await raw('POST', { Host: `127.0.0.1:${u.port}`, Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, form), 403, 'cross-site POST refused');
  assert.equal(posts(), 0);

  const r = await fetch(new URL('/decide', u), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  assert.match(await r.text(), /已確認/);
  const done = await mcp.call('online_template_create', args);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(posts(), 1);
  const reuse = await mcp.call('online_template_create', args);
  assert.equal(reuse.error.code, 'E_CONFIRM_MISMATCH', 'an approval is used once');
  assert.equal(posts(), 1);

  // 取消：不寫入，同一個 token 也不能再用
  const plan2 = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr' });
  const args2 = { draft_id: id, folder_type: 'usr', confirm_token: plan2.data.confirm_token };
  const rejected = await browserApprove(mcp, 'online_template_create', args2, 'reject');
  assert.equal(rejected.error.code, 'E_REJECTED');
  assert.equal(posts(), 1);
  assert.equal((await mcp.call('online_template_create', args2)).error.code, 'E_CONFIRM_MISMATCH');
});

test('online_template_create refuses drafts with pending dictionaries (E_DICT_PENDING)', async () => {
  await browserLogin(mcp, {});
  const id = await makeDraft(mcp, { withPendingDict: true, name: '待字典' });
  const r = await mcp.call('online_template_create', { draft_id: id, folder_type: 'usr' });
  assert.equal(r.error.code, 'E_DICT_PENDING');
  assert.deepEqual(r.error.details.pending, ['新字典A']);
});

test('online_template_update: only derived drafts, If-Match from ETag, 409 → E_CONFLICT', async () => {
  await browserLogin(mcp, {});
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
  const done = await browserApprove(mcp, 'online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-1', if_match: plan.data.plan.if_match, confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.data.rev, 2);
  const put = reqs.find(x => x.method === 'PUT');
  assert.ok(put, 'PUT sent');
  const plan2 = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-1' });
  behavior.conflict = true;
  const conflict = await browserApprove(mcp, 'online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-1', if_match: plan2.data.plan.if_match, confirm_token: plan2.data.confirm_token });
  assert.equal(conflict.error.code, 'E_CONFLICT');
  assert.equal(conflict.error.details.currentSha256, 'sha-other');
  const versions = await mcp.call('online_template_versions', { template_id: 'T-1' });
  assert.equal(versions.data.current_rev, 2);
  assert.equal(versions.data.items[0].rev, 2);
});

// 試用回饋（M9R）#1／#2／#9：update 沿用線上名稱／捷徑／作業別、逐項比對內容、iot 保留 ID
const listedForm = id => ONLINE_FORM.map(x => x.itemtype === 'iot' ? { ...x, sheetid: id, templateID: id } : structuredClone(x));
const seedListed = (id, form = listedForm(id), sha = 'sha-' + id) =>
  templates.set(id, { template: { name: '跌倒評估', shortcut: 'fall', groups: ['門', '住'], description: '原說明' }, form, sha256: sha });

test('online_template_update keeps the online name, shortcut and groups unless the draft changed them explicitly', async () => {
  await browserLogin(mcp, {});
  seedListed('T-90');
  // 外部工具產生的舊版 .htm：iot 帶線上 ID，改了一段說明文字
  const ext = listedForm('T-90');
  ext[0].item[0].datavalue = '姓名（全名）';
  fs.writeFileSync(path.join(mcp.ws, 'ext.htm'), `<html><body>engine</body></html><script>var tempdata =${JSON.stringify(ext)}</script>`);
  const plainImport = await mcp.call('form_import', { source_path: 'ext.htm', name: 'ext', dept_no: 'APP' });
  assert.equal(plainImport.error.code, 'E_INVALID_INPUT', 'same name as the source still needs for_update');
  const imp = await mcp.call('form_import', { source_path: 'ext.htm', dept_no: 'APP', for_update: true });
  assert.equal(imp.ok, true, JSON.stringify(imp));
  assert.equal(imp.data.derived_from.templateID, 'T-90');
  const plan = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-90' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const p = plan.data.plan;
  assert.deepEqual(p.meta.name, { online: '跌倒評估', draft: 'ext', will_write: '跌倒評估' });
  assert.equal(p.meta.shortcut.will_write, 'fall');
  assert.deepEqual(p.meta.groups.will_write, ['門', '住']);
  assert.equal(p.name, '跌倒評估');
  assert.equal(p.publish_on_save, true);
  const codes = p.warnings.map(w => String(w.code || w).split('：')[0]);
  assert.ok(codes.includes('W_META_KEPT_ONLINE') && !codes.includes('W_UNPUBLISH') && !codes.includes('W_META_RENAME'), JSON.stringify(p.warnings));
  assert.deepEqual(p.diff.changed_areas, ['1'], 'the edited caption shows up');
  assert.deepEqual(p.diff.changed_itemids, []);
  assert.equal(p.diff.js_changed, false, 'the generated-by marker line is not a change');
  assert.equal(p.diff.iot_changed, false, 'server-filled iot fields are not a change');
  assert.match(p.diff.online_since_source, /不是線上範本套件/);
  const done = await browserApprove(mcp, 'online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-90', if_match: p.if_match, confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  const put = reqs.find(x => x.method === 'PUT' && x.path.endsWith('/T-90'));
  assert.deepEqual(put.body.template, { name: '跌倒評估', shortcut: 'fall', groups: ['門', '住'], description: '原說明' });
  const iot = put.body.form.find(x => x.itemtype === 'iot');
  assert.equal(iot.templateID, 'T-90');
  assert.equal(iot.sheetid, 'T-90');

  // 明確清空捷徑 → W_UNPUBLISH；改名 → W_META_RENAME
  await mcp.call('form_update_meta', { draft_id: imp.data.draft_id, shortcut: '', name: '跌倒評估 v2' });
  const plan2 = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-90' });
  const codes2 = plan2.data.plan.warnings.map(w => String(w).split('：')[0]);
  assert.ok(codes2.includes('W_UNPUBLISH') && codes2.includes('W_META_RENAME'), JSON.stringify(plan2.data.plan.warnings));
  assert.equal(plan2.data.plan.publish_on_save, false);
  // 取得計畫後線上被改名 → 第二段不開確認頁
  templates.get('T-90').template.name = '別人改的名字';
  const stale = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-90', if_match: plan2.data.plan.if_match, confirm_token: plan2.data.confirm_token });
  assert.equal(stale.error.code, 'E_CONFIRM_MISMATCH', JSON.stringify(stale));
  // ETag 已變 → E_CONFLICT（不開確認頁）
  const plan3 = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-90' });
  templates.get('T-90').sha256 = 'sha-moved';
  const moved = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-90', if_match: plan3.data.plan.if_match, confirm_token: plan3.data.confirm_token });
  assert.equal(moved.error.code, 'E_CONFLICT');
});

test('online_template_update warns when the online template changed after the package was saved', async () => {
  await browserLogin(mcp, {});
  seedListed('T-91');
  const got = await mcp.call('online_template_get', { template_id: 'T-91', save: true });
  const imp = await mcp.call('form_import', { source_path: got.data.saved, dept_no: 'APP', for_update: true });
  assert.equal(imp.ok, true, JSON.stringify(imp));
  const same = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-91' });
  assert.equal(same.data.plan.diff.online_since_source, '（沒有變動）');
  assert.ok(same.data.plan.warnings.some(w => String(w).startsWith('W_NO_CHANGE')), JSON.stringify(same.data.plan.warnings));
  assert.equal(same.data.plan.meta.shortcut.draft, 'fall', 'for_update carries the package shortcut');
  // 有人在編輯器改了 #2 的預設值
  const edited = listedForm('T-91');
  edited[0].item[1].datavalue = '無';
  seedListed('T-91', edited, 'sha-T91-edited');
  const plan = await mcp.call('online_template_update', { draft_id: imp.data.draft_id, template_id: 'T-91' });
  const p = plan.data.plan;
  assert.deepEqual(p.diff.changed_itemids, ['2'], 'writing would revert #2');
  assert.match(p.diff.online_since_source, /修改控制項 #2/);
  assert.ok(p.warnings.some(w => String(w).startsWith('W_ONLINE_CHANGED_SINCE_SOURCE')), JSON.stringify(p.warnings));
});

test('feature flag templateUpdate=false hides online_template_update', async () => {
  const flags = path.join(os.tmpdir(), 'strucmed-flags2-' + process.pid + '.json');
  fs.writeFileSync(flags, JSON.stringify({ templateUpdate: false }));
  const m = startMcp({ ...ONLINE_ENV(), STRUCMED_FLAGS: flags });
  try {
    const list = await m.rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    assert.ok(names.includes('online_template_create') && !names.includes('online_template_update'));
    assert.ok(names.includes('online_dictionary_create') && names.includes('online_dictionary_memo_set'), 'dictionaryWrite defaults to true (docs/14)');
    assert.ok(!names.some(n => /promot/.test(n)), 'no promotion tools: system managers promote on the dictionary page');
    await browserLogin(m, {});
    assert.equal((await m.call('online_template_update', { draft_id: 'd-000000000000', template_id: 'T-1' })).error.code, 'E_FEATURE_DISABLED');
  } finally { m.stop(); fs.rmSync(flags, { force: true }); }
});

test('online_dictionary_create (flag on): creates or reuses, binds dicid, refuses deleted-exists without force', async () => {
  const flags = path.join(os.tmpdir(), 'strucmed-flags3-' + process.pid + '.json');
  fs.writeFileSync(flags, JSON.stringify({ dictionaryWrite: true }));
  const m = startMcp({ ...ONLINE_ENV(), STRUCMED_FLAGS: flags });
  try {
    await browserLogin(m, {});
    const id = await makeDraft(m, { withPendingDict: true, name: '字典上架' });
    const notPending = await m.call('online_dictionary_create', { draft_id: id, name: '不存在' });
    assert.equal(notPending.error.code, 'E_INVALID_INPUT');
    const plan = await m.call('online_dictionary_create', { draft_id: id, name: '新字典A' });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.deepEqual(plan.data.plan.used_by_itemids, [2]);
    const done = await browserApprove(m, 'online_dictionary_create', { draft_id: id, name: '新字典A', confirm_token: plan.data.confirm_token });
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
    const r409 = await browserApprove(m, 'online_dictionary_create', { draft_id: id2.data.draft_id, name: '已刪除字典', confirm_token: p2.data.confirm_token });
    assert.equal(r409.error.code, 'E_DELETED_EXISTS');
    assert.equal(r409.error.details.candidates[0].id, 'D9');
    const p3 = await m.call('online_dictionary_create', { draft_id: id2.data.draft_id, name: '已刪除字典', force: true });
    const forced = await browserApprove(m, 'online_dictionary_create', { draft_id: id2.data.draft_id, name: '已刪除字典', force: true, confirm_token: p3.data.confirm_token });
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.ok(reqs.some(x => x.path.endsWith('/api/v2/dictionaries') && x.body && x.body.force === true));
  } finally { m.stop(); fs.rmSync(flags, { force: true }); }
});

test('online_dictionary_batch (flag on): binds successes, leaves failures pending', async () => {
  const flags = path.join(os.tmpdir(), 'strucmed-flags4-' + process.pid + '.json');
  fs.writeFileSync(flags, JSON.stringify({ dictionaryWrite: true }));
  const m = startMcp({ ...ONLINE_ENV(), STRUCMED_FLAGS: flags });
  try {
    await browserLogin(m, {});
    const c = await m.call('form_create', { name: '批次字典', dept_no: 'APP' });
    const a = await m.call('form_add_area', { draft_id: c.data.draft_id, type: 'form', title: 'x' });
    for (const nm of ['批次甲', '已刪除字典'])
      assert.equal((await m.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: nm, control: { datatype: 'textbox', dictionary: { name: nm } } })).ok, true);
    const plan = await m.call('online_dictionary_batch', { draft_id: c.data.draft_id });
    assert.equal(plan.data.plan.rows.length, 2);
    const done = await browserApprove(m, 'online_dictionary_batch', { draft_id: c.data.draft_id, confirm_token: plan.data.confirm_token });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.data.succeeded, 1);
    assert.deepEqual(done.data.pending_left, ['已刪除字典']);
    assert.equal(done.warnings.length, 1);
  } finally { m.stop(); fs.rmSync(flags, { force: true }); }
});

test('online_me_notes_get/set: incremental diff plan, two-step PUT, no-change short-circuit', async () => {
  await browserLogin(mcp, {});
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
  const done = await browserApprove(mcp, 'online_me_notes_set', { add: [{ template_id: 'T-2', name: '疼痛評估' }], remove: ['T-1'], confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.data.items, [{ template_id: 'T-2', name: '疼痛評估' }]);
  const put = reqs.find(x => x.method === 'PUT' && x.path.endsWith('/api/v2/me/notes'));
  assert.deepEqual(put.body, { items: [{ dictID: 'T-2', dictVal: '疼痛評估' }] });
  const bad = await mcp.call('online_me_notes_set', { items: [{ template_id: 'bad id!', name: 'x' }] });
  assert.equal(bad.error.code, 'E_INVALID_INPUT');
});

// ── docs/14：字典 JSON 說明、補述、體系升級 ─────────────────
test('online_dictionary_search: old server (no etag) warns W_SERVER_OLD and parses dicComment locally', async () => {
  await browserLogin(mcp, {});
  behavior.oldServer = true;
  const r = await mcp.call('online_dictionary_search', {});
  assert.ok(r.warnings.some(w => w.startsWith('W_SERVER_OLD')));
  const d5 = r.data.items.find(x => x.id === 'D5');
  assert.equal(d5.desc, '體重（kg）');
  assert.equal(d5.level, 'sys', 'level computed locally');
});

test('dictionary binding by name prefers the system dictionary and warns about missing memo', async () => {
  await browserLogin(mcp, {});
  dicts.push({ id: 'D7', dicType: 'APP', dicName: '體重', dicComment: '本科體重', createDate: '20260202' });
  await mcp.call('online_dictionary_search', { update_index: true });
  const c = await mcp.call('form_create', { name: '體系優先', dept_no: 'APP' });
  const a = await mcp.call('form_add_area', { draft_id: c.data.draft_id, type: 'form', title: 'x' });
  const x = await mcp.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: '體重', control: { datatype: 'numberbox', minval: 0, maxval: 300, dictionary: { name: '體重' } } });
  assert.equal(x.ok, true, JSON.stringify(x));
  assert.equal(x.data.dicid, 'D5');
  assert.ok(x.data.warnings.some(w => w.startsWith('W_DICT_PREFER_SYSTEM')), JSON.stringify(x.data.warnings));
  const y = await mcp.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: '疼痛', control: { datatype: 'textbox', dictionary: { name: '疼痛評估' } } });
  assert.ok(y.data.warnings.some(w => w.startsWith('W_DICT_NO_MEMO')));
  assert.ok(y.data.warnings.some(w => w.startsWith('W_DICT_DEPT_LEVEL')));
  const v = await mcp.call('form_validate', { draft_id: c.data.draft_id });
  assert.equal(v.data.stats.dict_missing_memo, 1);
  assert.equal(v.data.stats.dict_dept_level, 1);
});

test('online_dictionary_memo_set: local FHIR check, two-step plan with before/after, If-Match, desc untouched', async () => {
  await browserLogin(mcp, {});
  const bad = await mcp.call('online_dictionary_memo_set', { dic_id: 'D3', fhir: [{ res: 'Observation', path: 'Condition.code' }] });
  assert.equal(bad.error.code, 'E_INVALID_FHIR');
  const badSys = await mcp.call('online_dictionary_memo_set', { dic_id: 'D3', fhir: [{ res: 'Observation', path: 'Observation.valueQuantity', code: 'http://example.org|1' }] });
  assert.equal(badSys.error.code, 'E_INVALID_FHIR');
  assert.equal(reqs.filter(x => x.method === 'PUT').length, 0, 'invalid FHIR never reaches the server');
  const args = { dic_id: 'D5', memo: { asr: ['體重', 'BW'], type: 'numberbox' }, fhir: [{ res: 'Observation', path: 'Observation.valueQuantity', code: 'http://loinc.org|29463-7', display: 'Body weight', ucum: 'kg' }] };
  const plan = await mcp.call('online_dictionary_memo_set', args);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.data.plan.before.memo, { unit: 'kg' });
  assert.deepEqual(plan.data.plan.after.memo, { unit: 'kg', type: 'numberbox', asr: ['體重', 'BW'] }, 'memo is merged, existing keys kept');
  assert.equal(plan.data.plan.desc, '體重（kg）');
  assert.equal(reqs.filter(x => x.method === 'PUT').length, 0, 'plan step does not write');
  const done = await browserApprove(mcp, 'online_dictionary_memo_set', { ...args, etag: plan.data.plan.etag, confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.approvePage, /補述/);
  const put = reqs.find(x => x.method === 'PUT' && x.path.endsWith('/api/v2/dictionaries/D5/memo'));
  assert.equal(put.ifMatch.replace(/"/g, ''), plan.data.plan.etag);
  assert.deepEqual(put.body.memo, { unit: 'kg', type: 'numberbox', asr: ['體重', 'BW'] });
  const after = dc.parse(dicts.find(d => d.id === 'D5').dicComment);
  assert.equal(after.desc, '體重（kg）', 'desc untouched');
  assert.equal(after.fhir[0].code, 'http://loinc.org|29463-7');
  assert.equal(done.data.memo_by, USER_ID);
  assert.notEqual(done.data.etag, plan.data.plan.etag);
});

test('online_dictionary_memo_set: someone else changed it after the plan → E_CONFLICT with current content', async () => {
  await browserLogin(mcp, {});
  const args = { dic_id: 'D3', memo: { meaning: '疼痛分數 0-10' } };
  const plan = await mcp.call('online_dictionary_memo_set', args);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  dicts.find(d => d.id === 'D3').dicComment = dc.build({ desc: '', memo: { unit: '分' } });   // 他人搶先寫入
  const r = await browserApprove(mcp, 'online_dictionary_memo_set', { ...args, etag: plan.data.plan.etag, confirm_token: plan.data.confirm_token });
  assert.equal(r.error.code, 'E_CONFLICT');
  assert.deepEqual(r.error.details.current.memo, { unit: '分' });
});

test('sys mark: a promoted dictionary of another dept in the same system is level sys, bindable by name, and memo_set keeps the mark', async () => {
  await browserLogin(mcp, {});
  const idx = await mcp.call('online_dictionary_search', { update_index: true });
  const d7 = idx.data.items.find(x => x.id === 'D7');
  assert.equal(d7.level, 'sys');
  assert.equal(d7.dic_type, 'XPPB0', 'id and dicType unchanged by promotion');
  assert.deepEqual(d7.sys, { code: 'PP', by: 'ADM01', at: '2026-10-27T01:00:00Z' });
  assert.equal(idx.data.items.find(x => x.id === 'D6').level, 'other', 'another system without a mark stays other');
  const local = await mcp.call('dictionary_search', { query: '鬆弛', dept_no: 'APP' });
  assert.equal(local.data.results[0].id, 'D7');
  assert.equal(local.data.results[0].level, 'sys');
  assert.equal(local.data.results[0].sys.code, 'PP');
  const c = await mcp.call('form_create', { name: '體系標記', dept_no: 'APP' });
  const a = await mcp.call('form_add_area', { draft_id: c.data.draft_id, type: 'form', title: 'x' });
  const x = await mcp.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: '鬆弛度', control: { datatype: 'textbox', dictionary: { name: '鬆弛度' } } });
  assert.equal(x.ok, true, JSON.stringify(x));
  assert.equal(x.data.dicid, 'D7', 'marked dictionary is in the dept match scope');
  assert.ok(!x.data.warnings.some(w => w.startsWith('W_DICT_DEPT_LEVEL')));
  const args = { dic_id: 'D7', memo: { meaning: 'joint laxity' } };
  const plan = await mcp.call('online_dictionary_memo_set', args);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const done = await browserApprove(mcp, 'online_dictionary_memo_set', { ...args, etag: plan.data.plan.etag, confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  const after = dc.parse(dicts.find(d => d.id === 'D7').dicComment);
  assert.deepEqual(after.sys, { code: 'PP', by: 'ADM01', at: '2026-10-27T01:00:00Z' }, 'memo write keeps the sys mark');
  assert.equal(after.memo.meaning, 'joint laxity');
});

test('online_dictionary_create writes desc+memo as dictionary JSON in one go', async () => {
  await browserLogin(mcp, {});
  const c = await mcp.call('form_create', { name: 'JSON 說明', dept_no: 'APP' });
  const a = await mcp.call('form_add_area', { draft_id: c.data.draft_id, type: 'form', title: 'x' });
  const x = await mcp.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: '身高',
    control: { datatype: 'numberbox', minval: 30, maxval: 250, dictionary: { name: 'TEST_HEIGHT', comment: '身高（cm）', memo: { unit: 'cm', range: '30-250', asr: ['身高'] } } } });
  assert.equal(x.ok, true, JSON.stringify(x));
  const plan = await mcp.call('online_dictionary_create', { draft_id: c.data.draft_id, name: 'TEST_HEIGHT' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const j = JSON.parse(plan.data.plan.dic_comment_json);
  assert.deepEqual(j, { v: 1, desc: '身高（cm）', memo: { unit: 'cm', range: '30-250', asr: ['身高'] } });
  const done = await browserApprove(mcp, 'online_dictionary_create', { draft_id: c.data.draft_id, name: 'TEST_HEIGHT', confirm_token: plan.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  const post = reqs.find(r => r.method === 'POST' && r.path.endsWith('/api/v2/dictionaries'));
  assert.equal(post.body.dicComment, plan.data.plan.dic_comment_json);
  // 沒有說明的新字典：plan 警告
  await mcp.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: '其他', control: { datatype: 'textbox', dictionary: { name: 'TEST_OTHER' } } });
  const p2 = await mcp.call('online_dictionary_create', { draft_id: c.data.draft_id, name: 'TEST_OTHER' });
  assert.ok(p2.data.plan.warnings.some(w => w.startsWith('W_DICT_NO_DESC')));
  assert.equal(p2.data.plan.dic_comment_json, '', 'no desc and no memo → empty plain text, not JSON');
});

test('emoji in a new dictionary name or memo is rejected before anything is sent', async () => {
  await browserLogin(mcp, {});
  const c = await mcp.call('form_create', { name: '字元檢查', dept_no: 'APP' });
  const a = await mcp.call('form_add_area', { draft_id: c.data.draft_id, type: 'form', title: 'x' });
  const bad = await mcp.call('form_add_control', { draft_id: c.data.draft_id, area_itemid: a.data.area_itemid, label_text: 'x', control: { datatype: 'textbox', dictionary: { name: 'TEST_😀' } } });
  assert.equal(bad.error.code, 'E_INVALID_INPUT');
  const memo = await mcp.call('online_dictionary_memo_set', { dic_id: 'D3', memo: { meaning: '疼痛😀' } });
  assert.equal(memo.error.code, 'E_INVALID_INPUT');
  assert.equal(reqs.filter(x => x.method !== 'GET' && /dictionaries/.test(x.path)).length, 0, 'nothing written');
});

// ── 字典助手（plugin 3.7.0）：全院搜尋、補述新欄位與舊站台、補述批次、使用索引 ─────────────
test('online_dictionary_search scope=all merges other-system dictionaries into the index and reports memo_keys', async () => {
  await browserLogin(mcp, {});
  const base = await mcp.call('online_dictionary_search', { update_index: true });
  assert.ok(base.data.memo_keys.includes('interop'));
  const all = await mcp.call('online_dictionary_search', { scope: 'all', q: '握力', update_index: true });
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.deepEqual(all.data.items.map(x => [x.id, x.level]), [['D6', 'other']]);
  assert.equal(all.data.index_count, base.data.index_count, 'merged, not replaced (D6 was already in the full list)');
  const paged = await mcp.call('online_dictionary_search', { scope: 'all', page: 1, page_size: 2 });
  assert.equal(paged.data.has_more, true);
  assert.equal(paged.data.items.length, 2);
  assert.equal((await mcp.call('online_dictionary_search', { scope: 'all', page: 1, page_size: 501 })).error.code, 'E_INVALID_INPUT');
});

test('memo writes drop func／usecase／interop on a site that does not report memoKeys', async () => {
  await browserLogin(mcp, {});
  behavior.oldMemoKeys = true;
  const s = await mcp.call('online_dictionary_search', { update_index: true });
  assert.ok(s.warnings.some(w => w.startsWith('W_SERVER_OLD_MEMO_KEYS')), JSON.stringify(s.warnings));
  const plan = await mcp.call('online_dictionary_memo_set', { dic_id: 'D1', memo: { meaning: '過去一年跌倒', func: '使用者輸入' } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.data.plan.after.memo, { meaning: '過去一年跌倒' });
  assert.ok(plan.data.plan.warnings.some(w => w.startsWith('W_SERVER_OLD_MEMO_KEYS')));
  delete behavior.oldMemoKeys;
  const plan2 = await mcp.call('online_dictionary_memo_set', { dic_id: 'D1', memo: { func: '使用者輸入' } });
  assert.equal(plan2.data.plan.after.memo.func, '使用者輸入', 'new site keeps the new keys');
});

test('online_dictionary_memo_batch: per-dictionary plan, stale check before the page, batch PUT, fallback on old sites', async () => {
  await browserLogin(mcp, {});
  await mcp.call('online_dictionary_search', { update_index: true });
  const items = [{ dic_id: 'D1', memo: { func: '跌倒風險分數的輸入', usecase: '住院入院評估' } }, { dic_id: 'D3', memo: { interop: '0-10 分' } }, { dic_id: 'D5', memo: { unit: 'kg' } }];
  const plan = await mcp.call('online_dictionary_memo_batch', { items });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.data.plan.rows.map(r => r.dic_id), ['D1', 'D3']);
  assert.deepEqual(plan.data.plan.no_change.map(r => r.dic_id), ['D5'], 'D5 already has unit kg');
  assert.equal(plan.data.plan.rows[0].after.memo.func, '跌倒風險分數的輸入');
  // 取得計畫後 D3 被別人改了 → 不開確認頁，回目前內容
  const d3 = dicts.find(d => d.id === 'D3');
  d3.dicComment = dc.build({ desc: '疼痛', memo: { meaning: '別人先寫' } });
  const stale = await mcp.call('online_dictionary_memo_batch', { items, etags: plan.data.etags, confirm_token: plan.data.confirm_token });
  assert.equal(stale.error.code, 'E_CONFLICT');
  assert.equal(stale.error.details.stale[0].dic_id, 'D3');
  assert.equal(stale.error.details.stale[0].current.memo.meaning, '別人先寫');
  assert.equal(reqs.filter(x => x.path.endsWith('/memo/batch')).length, 0);
  // 重取計畫 → 確認頁 → 批次寫入
  const plan2 = await mcp.call('online_dictionary_memo_batch', { items });
  assert.equal(plan2.data.plan.rows[1].after.memo.meaning, '別人先寫', 'merge keeps the other person\'s text');
  const done = await browserApprove(mcp, 'online_dictionary_memo_batch', { items, etags: plan2.data.etags, confirm_token: plan2.data.confirm_token });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.data.succeeded, 2);
  const put = reqs.find(x => x.method === 'PUT' && x.path.endsWith('/api/v2/dictionaries/memo/batch'));
  assert.deepEqual(put.body.items.map(x => x.id), ['D1', 'D3']);
  assert.equal(dc.parse(dicts.find(d => d.id === 'D1').dicComment).memo.usecase, '住院入院評估');
  // 舊站台沒有批次端點：逐本 PUT {id}/memo
  behavior.noMemoBatch = true;
  const items2 = [{ dic_id: 'D2', memo: { meaning: '重複的跌倒史' } }];
  const plan3 = await mcp.call('online_dictionary_memo_batch', { items: items2 });
  const done3 = await browserApprove(mcp, 'online_dictionary_memo_batch', { items: items2, etags: plan3.data.etags, confirm_token: plan3.data.confirm_token });
  assert.equal(done3.ok, true, JSON.stringify(done3));
  assert.ok(done3.data.warnings.some(w => w.startsWith('W_SERVER_OLD')));
  assert.ok(reqs.some(x => x.method === 'PUT' && x.path.endsWith('/api/v2/dictionaries/D2/memo')));
  // 輸入檢查
  assert.equal((await mcp.call('online_dictionary_memo_batch', { items: [{ dic_id: 'D1', memo: {} }, { dic_id: 'D1', memo: {} }] })).error.code, 'E_INVALID_INPUT');
  assert.equal((await mcp.call('online_dictionary_memo_batch', { items: [{ dic_id: 'D1' }] })).error.code, 'E_INVALID_INPUT');
});

test('online_dictionary_usage: where-used per dictionary, counts into the index, old sites refused', async () => {
  await browserLogin(mcp, {});
  await mcp.call('online_dictionary_search', { update_index: true });
  const one = await mcp.call('online_dictionary_usage', { dic_id: 'D1' });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.deepEqual(one.data.templates.map(x => [x.name, x.itemids]), [['跌倒評估', ['2']], ['住院跌倒', ['5', '6']]]);
  const all = await mcp.call('online_dictionary_usage', {});
  assert.equal(all.data.index_updated, true);
  assert.deepEqual(all.data.top[0], { dic_id: 'D1', count: 2, name: '跌倒史' });
  const s = await mcp.call('dictionary_suggest', { field: { caption: '跌倒史' } });
  assert.ok(s.data.candidates[0].reasons.some(x => /2 張表單在用/.test(x)), JSON.stringify(s.data.candidates[0]));
  const scanned = usage.scannedAt;
  usage.scannedAt = null;
  assert.ok((await mcp.call('online_dictionary_usage', { dic_id: 'D5' })).warnings.some(w => w.startsWith('W_USAGE_NOT_SCANNED')));
  usage.scannedAt = scanned;
  behavior.noUsageApi = true;
  const old = await mcp.call('online_dictionary_usage', {});
  assert.equal(old.error.code, 'E_UPSTREAM');
  assert.match(old.error.message, /W_SERVER_OLD/);
});
