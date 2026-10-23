// FMapi（錯誤紀錄與站台可用性）用戶端。網址取 FMAPI_BASE_URL，未設定時用院內站台的預設值（site.mjs；院外不啟用）；FMAPI_API_KEY 選用（X-Api-Key，只進標頭、不回傳）。
// https only（本機 http 例外）；不跟隨轉址；唯讀。
import { E, fail } from './errors.mjs';
import * as site from './site.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const TIMEOUT_MS = 15_000;

export const configured = () => !!site.fmapiUrl();

export function baseUrl() {
  const raw = site.fmapiUrl();
  if (!raw) fail(E.FMAPI_DISABLED, 'FMapi tool 無法使用：只有院內站台提供（或在啟動環境設定 FMAPI_BASE_URL）', { site: site.describe() });
  let u;
  try { u = new URL(raw); } catch { fail(E.FMAPI_DISABLED, 'FMAPI_BASE_URL 不是有效的網址'); }
  if (u.username || u.password || u.search || u.hash) fail(E.FMAPI_DISABLED, 'FMAPI_BASE_URL 不可包含帳密、查詢字串或 #');
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)))) fail(E.FMAPI_DISABLED, 'FMAPI_BASE_URL 必須是 https（http 只限本機測試）');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export async function get(path, what, { query } = {}) {
  const base = baseUrl();
  const url = new URL(`${base}/${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json' };
  const key = String(process.env.FMAPI_API_KEY || '').trim();
  if (key) headers['X-Api-Key'] = key;
  let res;
  try { res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) {
    const why = e && e.name === 'TimeoutError' ? '逾時' : (e && e.cause && e.cause.code) || (e && e.name) || '連線失敗';
    fail(E.UPSTREAM, `${what}：無法連線到 FMapi（${why}）`, { path });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (res.status >= 300 && res.status < 400) fail(E.UPSTREAM, `${what}失敗：FMapi 要求轉址（HTTP ${res.status}），不跟隨`, { status: res.status, path });
  if (res.status === 401 || res.status === 403) fail(E.AUTH, `${what}失敗：FMapi 拒絕存取（HTTP ${res.status}）；需要 FMAPI_API_KEY`, { status: res.status, path });
  if (res.status === 501) return { status: 501, json };
  if (res.status < 200 || res.status >= 300) fail(E.UPSTREAM, `${what}失敗（HTTP ${res.status}）${json && json.message ? `：${String(json.message).slice(0, 200)}` : ''}`, { status: res.status, path });
  return { status: res.status, json };
}
