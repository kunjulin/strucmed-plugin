// Online client for the strucmed V2 API (api/v2/auth/*, templates, folders, records).
// The site (院內 LVAIW／院外站台) is detected by site.mjs; STRUCMED_ONLINE_BASE_URL overrides it.
// Security posture :
//   - credentials come only from the process environment (STRUCMED_USER / STRUCMED_PASS), never from tool
//     arguments, and are sent once to api/v2/auth/token; they are never returned, logged or written to disk
//   - access/refresh tokens live only in this process's memory (lost on restart) and are never returned
//   - https only (plain http is accepted for loopback hosts, for local tests); redirects are not followed,
//     so the bearer token cannot leak to another host
//   - this module writes nothing to stdout/stderr; error messages never include request bodies
//   - after the server says the password is wrong, the same credentials are not sent again in this process
//     (HIS passwords change every three months; repeated failures could lock the account)
import crypto from 'node:crypto';
import { E, fail } from './errors.mjs';
import * as site from './site.mjs';

const TIMEOUT_MS = 30_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

let session = null;   // { base, access, refresh, expiresAt, user: { userId, name, deptNo, loc } }
let refreshing = null;
let rejected = null;  // sha256(帳號＋密碼)：伺服器回「帳號或密碼錯誤」的那組，只在記憶體

export const RECONFIGURE = '/plugin configure strucmed@strucmed-marketplace';
const PASSWORD_HINT = `院內 HIS 帳號或密碼錯誤（HIS 密碼每三個月變更一次，可能已更換）：請使用者執行 ${RECONFIGURE} 更新「院內 HIS 密碼」，` +
  '再執行 /reload-plugins（仍失敗時開新工作階段）。為避免帳號被鎖定，設定更新前不會再以相同帳密登入；不接受從對話提供密碼';

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

export async function login({ hospital, dept_no } = {}) {
  const base = baseUrl();
  const account = String(process.env.STRUCMED_USER || '').trim();
  const password = String(process.env.STRUCMED_PASS || '');
  if (!account || !password)
    fail(E.AUTH, '尚未設定院內帳號密碼：請使用者執行 /plugin configure strucmed@strucmed-marketplace 填「院內 HIS 帳號／密碼」後 /reload-plugins（或在啟動環境設定 STRUCMED_USER 與 STRUCMED_PASS）；不接受從對話或 tool 參數傳入帳密');
  const fp = crypto.createHash('sha256').update(`${account}\0${password}`).digest('hex');
  if (rejected === fp) fail(E.AUTH, PASSWORD_HINT, { reconfigure: true, action: RECONFIGURE, retried: false });
  session = null;
  // clientId：平台只讓 strucmed-mcp 的 token 呼叫範本與字典的 API（strucmed docs/MCP-LOGIN-MFA-DESIGN.md 第 1 期）；舊版平台會忽略這個欄位
  const body = { hospital: hospital || 'CGMH', account, password, clientId: 'strucmed-mcp' };
  if (dept_no) body.deptNo = String(dept_no);
  const r = await send(base, 'POST', 'api/v2/auth/token', { body });
  if (r.status === 401 && isBadPassword(r)) {
    rejected = fp;
    fail(E.AUTH, PASSWORD_HINT, { status: 401, reconfigure: true, action: RECONFIGURE });
  }
  if (r.status !== 200 || !r.json || !r.json.accessToken) upstreamError(r, '登入');
  const u = r.json.userInfo || {};
  setTokens(base, r.json, { userId: String(u.userId || ''), name: String(u.name || ''), deptNo: String(u.deptNo || dept_no || ''), loc: String(u.loc || '') });
  if (!session.user.userId) { session = null; fail(E.UPSTREAM, '登入回應缺少 userInfo.userId'); }
  return status();
}

// 伺服器（HisLogin）只有上游明確回「帳號或密碼錯誤」時才是密碼問題；「暫時無回應」可以重試
function isBadPassword(r) {
  const msg = String((r.json && r.json.error && r.json.error.message) || '');
  return /帳號或密碼錯誤/.test(msg) && !/暫時無回應/.test(msg);
}

export function logout() {
  const was = !!session;
  session = null;
  return { logged_out: was };
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
