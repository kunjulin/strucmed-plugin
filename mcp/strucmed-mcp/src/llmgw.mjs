// LlmGateway（院內 OpenAI 相容閘道）用戶端。需要 LLMGW_API_KEY；網址取 LLMGW_BASE_URL，未設定時用院內站台的預設值
// （site.mjs；院外站台連不到 LlmGateway，不啟用）。
// 安全姿態：金鑰只從環境變數讀、只進 Authorization 標頭、不回傳、不寫檔、不寫 log；https only（本機 http 例外）；
// 不跟隨轉址；錯誤訊息不含請求本文與金鑰。
import { E, fail } from './errors.mjs';
import * as site from './site.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MODELS_TIMEOUT_MS = 15_000;
const CHAT_TIMEOUT_MS = 90_000;

const unset = v => { const s = String(v || '').trim(); return !s || s.startsWith('${'); };
export const configured = () => !!site.llmgwUrl() && !unset(process.env.LLMGW_API_KEY);

export function baseUrl() {
  const raw = site.llmgwUrl();
  if (!raw) fail(E.LLMGW_DISABLED, site.profile() === 'external'
    ? 'LlmGateway tool 無法使用：院外站台連不到院內 LlmGateway，模型白名單使用內建靜態表'
    : 'LlmGateway tool 未啟用：目前不在院內網路（或未設定 LlmGateway token：/plugin configure strucmed@strucmed-marketplace 填「LlmGateway token」）', { site: site.describe() });
  let u;
  try { u = new URL(raw); } catch { fail(E.LLMGW_DISABLED, 'LLMGW_BASE_URL 不是有效的網址'); }
  if (u.username || u.password) fail(E.LLMGW_DISABLED, 'LLMGW_BASE_URL 不可包含帳號密碼');
  if (u.search || u.hash) fail(E.LLMGW_DISABLED, 'LLMGW_BASE_URL 不可包含查詢字串或 #');
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))))
    fail(E.LLMGW_DISABLED, 'LLMGW_BASE_URL 必須是 https（http 只限本機測試）');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function apiKey() {
  const k = String(process.env.LLMGW_API_KEY || '').trim();
  if (!k) fail(E.LLMGW_DISABLED, '尚未設定 LlmGateway token：請使用者執行 /plugin configure strucmed@strucmed-marketplace 填「LlmGateway token」（伺服器型；不接受從對話或 tool 參數傳入）');
  return k;
}

const clip = (s, n = 300) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

export async function request(method, path, { body, headers: extra, timeoutMs } = {}, what) {
  const base = baseUrl();
  const key = apiKey();
  const url = `${base}/${path}`;
  const headers = { Accept: 'application/json', Authorization: `Bearer ${key}`, ...(extra || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs || MODELS_TIMEOUT_MS) });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? '逾時' : (e && e.cause && e.cause.code) || (e && e.name) || '連線失敗';
    fail(E.UPSTREAM, `${what}：無法連線到 LlmGateway（${why}）`, { path });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (res.status >= 300 && res.status < 400) fail(E.UPSTREAM, `${what}失敗：LlmGateway 要求轉址（HTTP ${res.status}），基於安全不跟隨；請確認 LLMGW_BASE_URL`, { status: res.status, path });
  if (res.status === 401 || res.status === 403) fail(E.AUTH, `${what}失敗：LlmGateway 拒絕金鑰（HTTP ${res.status}）；請確認 LLMGW_API_KEY 有效、未撤銷且允許此模型`, { status: res.status, path });
  if (res.status === 429) {
    const code = (json && json.error && json.error.code) || '';
    fail(E.LIMIT, `${what}失敗：LlmGateway 限速或配額（HTTP 429 ${code}）${res.headers.get('retry-after') ? `，請 ${res.headers.get('retry-after')} 秒後再試` : ''}`, { status: 429, path, code, retry_after: res.headers.get('retry-after') });
  }
  if (res.status < 200 || res.status >= 300) {
    const msg = json && json.error && (json.error.message || json.error.code);
    fail(E.UPSTREAM, `${what}失敗（HTTP ${res.status}）${msg ? `：${clip(msg)}` : ''}`, { status: res.status, path });
  }
  return json;
}

export const MODELS_TIMEOUT = MODELS_TIMEOUT_MS;
export const CHAT_TIMEOUT = CHAT_TIMEOUT_MS;
