// Online client for the strucmed V2 API (api/v2/auth/*, templates, folders, dictionaries, me/notes).
// The site (院內 LVAIW／院外站台) is detected by site.mjs; STRUCMED_ONLINE_BASE_URL overrides it.
// Security posture (strucmed docs/MCP-LOGIN-MFA-DESIGN.md 第 2 期):
//   - browser login: OAuth 2.0 authorization code + PKCE (S256) with a loopback redirect on 127.0.0.1 (RFC 8252).
//     The HIS password is typed only into the site's login page; this process never sees it
//   - access/refresh tokens live only in this process's memory (lost on restart) and are never returned;
//     the refresh token rotates on every use and is revoked on logout and on exit
//   - https only (plain http is accepted for loopback hosts, for local tests); redirects are not followed,
//     so the bearer token cannot leak to another host
//   - this module writes nothing to stdout/stderr; error messages never include request bodies
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { E, fail } from './errors.mjs';
import * as site from './site.mjs';

const TIMEOUT_MS = 30_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const CLIENT_ID = 'strucmed-mcp';
const FLOW_TTL_MS = 10 * 60_000;                 // 開啟登入頁後最多等 10 分鐘
const waitMs = () => { const n = Number(process.env.STRUCMED_LOGIN_WAIT_MS); return Number.isFinite(n) && n >= 0 ? Math.min(n, 300_000) : 120_000; };

let session = null;   // { base, access, refresh, expiresAt, user: { userId, name, deptNo, loc } }
let refreshing = null;
let flow = null;      // 進行中的瀏覽器登入：{ base, url, server, done, result, expires, verifier, redirectUri }

export const configured = () => !!site.strucmedUrl();

// 正規化並檢查 base URL（每次呼叫都重讀站台判斷，換站台時舊 session 失效）
export function baseUrl() {
  const raw = site.strucmedUrl();
  if (!raw) fail(E.ONLINE_DISABLED, `線上 tool 無法使用：${site.unavailableReason()}`, { site: site.describe() });
  let u;
  try { u = new URL(raw); } catch { fail(E.ONLINE_DISABLED, 'STRUCMED_ONLINE_BASE_URL 不是有效的網址'); }
  if (u.username || u.password) fail(E.ONLINE_DISABLED, 'STRUCMED_ONLINE_BASE_URL 不可包含帳號密碼');
  if (u.search || u.hash) fail(E.ONLINE_DISABLED, 'STRUCMED_ONLINE_BASE_URL 不可包含查詢字串或 #');
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))))
    fail(E.ONLINE_DISABLED, 'STRUCMED_ONLINE_BASE_URL 必須是 https（http 只限本機 localhost／127.0.0.1 測試）');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

const clip = (s, n = 300) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

async function send(base, method, path, { body, token, query, headers: extra } = {}) {
  const url = new URL(`${base}/${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json', ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // 不帶 e.message：避免任何實作把請求內容放進例外訊息
    const why = e && e.name === 'TimeoutError' ? '逾時' : (e && e.cause && e.cause.code) || (e && e.name) || '連線失敗';
    fail(E.UPSTREAM, `無法連線到 ${url.host}（${why}）`, { path });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON（例如 IIS 錯誤頁） */ }
  return { status: res.status, json, path, etag: res.headers.get('etag') || '' };
}

function upstreamError(r, what) {
  if (r.status >= 300 && r.status < 400) fail(E.UPSTREAM, `${what}失敗：伺服器要求轉址（HTTP ${r.status}），基於安全不跟隨；請確認 STRUCMED_ONLINE_BASE_URL`, { status: r.status, path: r.path });
  const err = (r.json && typeof r.json.error === 'object' && r.json.error) || {};
  const code = r.status === 401 ? E.AUTH : E.UPSTREAM;
  fail(code, `${what}失敗（HTTP ${r.status}${err.code ? ` ${clip(err.code, 40)}` : ''}）${err.message ? `：${clip(err.message)}` : ''}`,
    { status: r.status, path: r.path, code: err.code, details: err.details });
}

function setTokens(base, j, user) {
  session = { base, access: String(j.accessToken), refresh: String(j.refreshToken || ''), expiresAt: j.expiresAt || null, user };
}

export function status() {
  if (!session) return { logged_in: false };
  return { logged_in: true, base_url: session.base, site: site.describe(), user_id: session.user.userId, name: session.user.name,
    dept_no: session.user.deptNo, expires_at: session.expiresAt };
}

export function currentUser() {
  const base = baseUrl();
  if (!session || session.base !== base) fail(E.AUTH, '尚未登入，請先呼叫 online_login');
  return session.user;
}

const b64url = buf => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const PAGE = (title, text) => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,'Microsoft JhengHei',sans-serif;max-width:420px;margin:48px auto;padding:0 16px"><h1 style="font-size:20px">${title}</h1><p>${text}</p></body></html>`;

function closeFlow() {
  if (flow) { try { flow.server.close(); } catch { /* 已關閉 */ } }
  flow = null;
}

// 在 127.0.0.1 隨機 port 等待登入頁導回；只接受 /callback 且 state 相符的那一次
async function startFlow(base, { dept_no, hospital }) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || u.pathname !== '/callback' || u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE('登入連結無效', '請回到 AI 工具重新執行登入。'));
    }
    const code = u.searchParams.get('code');
    const error = u.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(code ? PAGE('登入完成', '可以關閉此頁，回到 AI 工具。') : PAGE('已取消登入', '可以關閉此頁；需要時請在 AI 工具重新登入。'));
    resolve(code ? { code } : { error: error || 'unknown' });
    server.close();
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const url = new URL(`${base}/api/v2/auth/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', state, dept_no: dept_no || '', hospital: hospital || '' })) if (v) url.searchParams.set(k, v);
  const f = { base, url: url.toString(), server, done, result: null, expires: Date.now() + FLOW_TTL_MS, verifier, redirectUri };
  done.then(r => { f.result = r; });
  return f;
}

// 以系統瀏覽器開啟（不經 shell）；失敗時使用者可自行開啟回應中的網址。STRUCMED_NO_BROWSER=1 不開啟（測試、遠端主機）
function openBrowser(url) {
  if (String(process.env.STRUCMED_NO_BROWSER || '').trim() === '1') return false;
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

// 瀏覽器登入：第一次呼叫開啟登入頁並等待（預設最多 2 分鐘）；還沒完成時回 pending 與網址，再呼叫一次會接著等同一個登入
export async function login({ hospital, dept_no } = {}) {
  const base = baseUrl();
  if (session && session.base === base) return { ...status(), already: true };
  let opened = null;
  if (!flow || flow.base !== base || Date.now() > flow.expires) {
    closeFlow();
    flow = await startFlow(base, { dept_no, hospital });
    opened = openBrowser(flow.url);
  }
  const f = flow;
  const r = f.result || await Promise.race([f.done, new Promise(ok => setTimeout(ok, waitMs()).unref())]);
  if (!r) {
    return { logged_in: false, pending: true, authorize_url: f.url, browser_opened: opened,
      message: (opened === false ? '無法自動開啟瀏覽器，請使用者自行開啟 authorize_url。' : '已在瀏覽器開啟 strucmed 登入頁。') +
        '請使用者在登入頁確認網址是 strucmed 站台後輸入 HIS 帳密並按「登入並同意」，完成後再呼叫一次 online_login；不要在對話中索取密碼。' };
  }
  closeFlow();
  if (r.error) fail(E.AUTH, r.error === 'access_denied' ? '使用者在登入頁按了「拒絕」，未登入' : `登入頁回傳錯誤（${clip(r.error, 40)}），請重新 online_login`, { error: clip(r.error, 40) });
  const t = await send(base, 'POST', 'api/v2/auth/token', { body: { grantType: 'authorization_code', clientId: CLIENT_ID, code: r.code, codeVerifier: f.verifier, redirectUri: f.redirectUri } });
  if (t.status !== 200 || !t.json || !t.json.accessToken) upstreamError(t, '登入');
  const u = t.json.userInfo || {};
  setTokens(base, t.json, { userId: String(u.userId || ''), name: String(u.name || ''), deptNo: String(u.deptNo || dept_no || ''), loc: String(u.loc || '') });
  if (!session.user.userId) { session = null; fail(E.UPSTREAM, '登入回應缺少 userInfo.userId'); }
  return status();
}

// 盡力作廢 refresh token（auth/revoke），失敗也照樣清除本機 token
async function revoke() {
  const s = session;
  session = null;
  if (!s || !s.refresh) return false;
  try {
    const r = await send(s.base, 'POST', 'api/v2/auth/revoke', { body: { token: s.refresh } });
    return r.status === 200;
  } catch { return false; }
}

export async function logout() {
  const was = !!session;
  const revoked = await revoke();
  closeFlow();
  return { logged_out: was, revoked };
}

// MCP 結束前（stdin 關閉）：作廢 refresh token、關閉等待中的本機回呼
export async function shutdown() {
  closeFlow();
  await Promise.race([revoke(), new Promise(ok => setTimeout(ok, 3000).unref())]);
}

async function refreshTokens(base) {
  if (!refreshing) {
    const s = session;
    refreshing = (async () => {
      const r = await send(base, 'POST', 'api/v2/auth/refresh', { body: { refreshToken: s.refresh } });
      if (r.status !== 200 || !r.json || !r.json.accessToken) {
        if (session === s) session = null;
        fail(E.AUTH, 'access token 已過期且無法更新（refresh token 無效或過期），請重新 online_login', { status: r.status });
      }
      // refresh 回應的 userInfo 為 null：沿用登入時的使用者資訊
      if (session === s) setTokens(base, { ...r.json, refreshToken: r.json.refreshToken || s.refresh }, s.user);
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

// 帶 token 的呼叫（原始結果）；401 時以 refresh token 換新後重試一次。非 2xx 不拋錯（401 除外），由呼叫端對應狀態碼
export async function callRaw(method, path, opts, what) {
  const base = baseUrl();
  currentUser();
  let r = await send(base, method, path, { ...opts, token: session.access });
  if (r.status === 401 && session && session.refresh) {
    await refreshTokens(base);
    r = await send(base, method, path, { ...opts, token: session.access });
  }
  if (r.status === 401) { session = null; upstreamError(r, what); }
  return r;
}

// 帶 token 的呼叫；非 2xx 一律拋 E_UPSTREAM／E_AUTH
export async function call(method, path, opts, what) {
  const r = await callRaw(method, path, opts, what);
  if (r.status < 200 || r.status >= 300) upstreamError(r, what);
  return r.json;
}
