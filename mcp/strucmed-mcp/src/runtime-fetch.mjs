// 平台前端（web/）本機副本：從站台抓下來並快取（findRuntimeWeb 的第 4 個來源）。
//
// 為什麼不內附進 plugin：TempHtml.html 引用約 25 個第三方元件（jQuery、Bootstrap、moment、numeral、jstat、
// fancytree、html2canvas…）。內附會把它們拉進 plugin 的合規與 SBOM 範圍；抓下來的副本是「使用者機器上的快取」，
// 由站台提供、有雜湊與版本戳記可追溯（manifest 就是第 3 份 SBOM／provenance 證據）。
//
// 安全姿態：
//   - 只抓 https 且主機是 site.mjs 判斷出來的站台（院內 LVAIW／院外 cgmh.ddns.net；http 只限 127.0.0.1／localhost 測試）。
//     **絕不從任何第三方 CDN 抓**（bootcdn、staticfile、jsdelivr…）：抓的每一個網址都必須與站台同源且在站台路徑底下。
//   - 第一次抓之前要使用者同意：兩段式（第一次只回 plan，第二次帶 confirm_token 才連外）。之後沿用快取不再問。
//   - 抓下來的每個檔案都記 SHA-256；開預覽前重算比對，不符就拒絕開，不默默使用。
//   - 必要檔案（TempHtml.html 與它直接引用的 js／css）少一個就整批失敗，不留半套。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { E, fail } from './errors.mjs';
import * as site from './site.mjs';
import { fetchedDir, homeDir } from './runtime-web.mjs';

export const MANIFEST = '.strucmed-runtime.json';
const MAX_FILE = 8 * 1024 * 1024;          // 單檔上限（TempHtml.js 約 400K，assets 最大的也遠低於此）
const MAX_TOTAL = 48 * 1024 * 1024;        // 整批上限
const TIMEOUT_MS = 20_000;
const STAMP_RE = /<!--\s*ver\s+([0-9A-Za-z._-]{1,32})\b/;

export { fetchedDir };      // findRuntimeWeb 與這裡共用同一個路徑（runtime-web.mjs）
export const manifestPath = (dir = fetchedDir()) => path.join(dir, MANIFEST);
export const versionStamp = html => { const m = STAMP_RE.exec(String(html || '')); return m ? m[1] : ''; };
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// 站台：site.mjs 判斷出來的那一個。http 只放行本機（測試用假站台）
export function runtimeBase() {
  const url = site.strucmedUrl();
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  const d = site.describe();
  return { base: url.replace(/\/+$/, ''), origin: u.origin, host: u.host, label: d.label, profile: d.profile };
}

// 抓下來的每個網址都要通過這一關：與站台同源，且路徑在站台路徑底下（擋掉轉址到別處與 ../ 逃脫）
function sameSite(base, url) {
  const b = new URL(base.endsWith('/') ? base : base + '/');
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.origin !== b.origin) return false;
  // 站台掛在 /strucmed 時路徑必須在它底下；掛在根目錄時 b.pathname 是 '/'
  return u.pathname.startsWith(b.pathname);
}

async function get(url, what) {
  let r;
  try { r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { fail(E.UPSTREAM, `抓 ${what} 失敗（${url}）：${String(e && e.message || e)}`); }
  // 站台會把 /strucmed/... 301 轉到根目錄；轉址後的位置仍必須同源
  if (r.url && !sameSite(new URL(url).origin + '/', r.url)) fail(E.UPSTREAM, `抓 ${what} 被轉址到站台之外（${r.url}），已停止`);
  if (!r.ok) fail(E.UPSTREAM, `抓 ${what} 失敗（${url}）：HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_FILE) fail(E.LIMIT, `${what} 超過單檔上限 ${MAX_FILE} bytes（${buf.length}）`);
  return buf;
}

// TempHtml.html 直接引用的 js／css（data: 與絕對網址跳過）。查詢字串（?v=…）只用於請求，存檔用乾淨路徑
function refsOf(html) {
  const out = [];
  const re = /(?:src|href)\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const raw = m[1].trim();
    if (!raw || /^(data:|https?:|\/\/|#|javascript:)/i.test(raw)) continue;
    const clean = raw.split(/[?#]/)[0];
    if (!clean || clean.startsWith('/') || clean.includes('..')) continue;     // 只接受相對路徑
    if (!/\.(js|css)$/i.test(clean)) continue;                                 // 必要檔案只收 js／css
    if (!out.some(x => x.file === clean)) out.push({ file: clean, request: raw });
  }
  return out;
}

// CSS 裡的 url(...)：字型與圖片。抓不到只記 warning（有些是選用的 sprite），不讓整批失敗
function cssRefs(cssText, cssFile) {
  const dir = path.posix.dirname(cssFile);
  const out = [];
  const re = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"]+))\s*\)/gi;
  let m;
  while ((m = re.exec(String(cssText))) !== null) {
    const raw = String(m[1] || m[2] || m[3] || '').trim();
    if (!raw || /^(data:|https?:|\/\/|#)/i.test(raw)) continue;
    const clean = raw.split(/[?#]/)[0];
    if (!clean) continue;
    const file = path.posix.normalize(path.posix.join(dir, clean));
    if (file.startsWith('..') || file.startsWith('/')) continue;
    if (!out.includes(file)) out.push(file);
  }
  return out;
}

const urlFor = (base, rel) => `${base}/${String(rel).replace(/^\/+/, '')}`;

// 第一段呼叫用：連一次站台讀 TempHtml.html，算出要抓哪些檔案（還沒有寫入任何東西）
export async function discover(b) {
  const html = await get(urlFor(b.base, 'TempHtml.html'), 'TempHtml.html');
  const text = html.toString('utf8');
  const required = refsOf(text);
  if (!required.length) fail(E.UPSTREAM, `站台的 TempHtml.html 沒有解析到任何 js／css 引用（${html.length} bytes），不像預期的 runtime，已停止`);
  return { html, stamp: versionStamp(text), required };
}

// 第二段呼叫用：抓齊、寫檔、算雜湊、寫 manifest。→ { dir, stamp, files, bytes, skipped, manifest_file }
export async function fetchRuntime(b, dir = fetchedDir()) {
  const d = await discover(b);
  const files = [{ file: 'TempHtml.html', buf: d.html }];
  let total = d.html.length;
  const take = async (rel, request, what) => {
    const buf = await get(urlFor(b.base, request || rel), what);
    total += buf.length;
    if (total > MAX_TOTAL) fail(E.LIMIT, `整批超過上限 ${MAX_TOTAL} bytes，已停止`);
    files.push({ file: rel, buf });
    return buf;
  };
  // 必要：TempHtml.html 直接引用的 js／css。少一個就整批失敗（不留半套）
  const cssTexts = [];
  for (const r of d.required) {
    const buf = await take(r.file, r.request, r.file);
    if (/\.css$/i.test(r.file)) cssTexts.push({ file: r.file, text: buf.toString('utf8') });
  }
  // 選用：CSS 裡 url(...) 的字型與圖片。抓不到只記 skipped
  const skipped = [];
  const seen = new Set(files.map(f => f.file));
  for (const c of cssTexts) {
    for (const rel of cssRefs(c.text, c.file)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      try { await take(rel, rel, rel); } catch (e) { skipped.push({ file: rel, reason: String(e && e.message || e).slice(0, 120) }); }
    }
  }
  // 全部抓到才落地：先寫到暫存目錄再換過去，中途失敗不會留半套
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const full = path.join(tmp, f.file);
    if (!path.resolve(full).startsWith(path.resolve(tmp))) fail(E.INVALID_INPUT, `檔名逃出目標目錄：${f.file}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.buf);
  }
  const manifest = {
    v: 1, source: { base: b.base, host: b.host, site: b.label, profile: b.profile },
    fetched_at: new Date().toISOString(), version_stamp: d.stamp,
    note: '平台前端 web/ 的本機快取。由 runtime_fetch 從上面的站台抓下來，不是 plugin 的一部分，也不隨 plugin 發佈。' +
      '每個檔案的 sha256 在開預覽前會重算比對；第三方元件的聲明見 plugin 的 THIRD_PARTY_NOTICES.md 與 sbom-runtime.json。',
    files: files.map(f => ({ file: f.file, bytes: f.buf.length, sha256: sha256(f.buf), url: urlFor(b.base, f.file) })).sort((x, y) => x.file.localeCompare(y.file)),
    skipped
  };
  fs.writeFileSync(path.join(tmp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(tmp, dir);
  return { dir, stamp: d.stamp, files: manifest.files.length, bytes: total, skipped, manifest_file: manifestPath(dir) };
}

export function readManifest(dir = fetchedDir()) {
  try { return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')); } catch { return null; }
}

// 開預覽前的雜湊驗證。→ { ok, reason, stamp, checked, mismatched, missing, manifest }
export function verifyRuntime(dir = fetchedDir()) {
  const m = readManifest(dir);
  if (!m || !Array.isArray(m.files) || !m.files.length) return { ok: false, reason: 'no_manifest', checked: 0, mismatched: [], missing: [], manifest: null };
  const mismatched = [], missing = [];
  for (const f of m.files) {
    const full = path.join(dir, f.file);
    let buf;
    try { buf = fs.readFileSync(full); } catch { missing.push(f.file); continue; }
    if (sha256(buf) !== f.sha256) mismatched.push(f.file);
  }
  const ok = !mismatched.length && !missing.length;
  return { ok, reason: ok ? '' : mismatched.length ? 'hash_mismatch' : 'missing_files', stamp: m.version_stamp || '', checked: m.files.length, mismatched, missing, manifest: m };
}

// 本機某個 web 目錄的版本戳記（抓來的或使用者自己的副本都適用）
export function localStamp(dir) {
  try { return versionStamp(fs.readFileSync(path.join(dir, 'TempHtml.html'), 'utf8')); } catch { return ''; }
}

// 站台目前的版本戳記（只 GET TempHtml.html，不帶憑證）
export async function siteStamp(b) {
  const html = await get(urlFor(b.base, 'TempHtml.html'), 'TempHtml.html');
  return { stamp: versionStamp(html.toString('utf8')), bytes: html.length };
}

// 版本漂移的檢查結果快取：form_preview 離線也讀得到（不在 form_preview 裡連外，MCP 的「預設離線」不變）
export const driftFile = (env = process.env) => path.join(homeDir(env), '.strucmed', 'runtime-drift.json');
export function saveDrift(info, env = process.env) {
  try {
    const f = driftFile(env);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify({ v: 1, checked_at: new Date().toISOString(), ...info }, null, 2)}\n`, 'utf8');
  } catch { /* 快取寫不進去不影響功能 */ }
}
export function readDrift(env = process.env) {
  try {
    const d = JSON.parse(fs.readFileSync(driftFile(env), 'utf8'));
    const ageH = (Date.now() - Date.parse(d.checked_at || 0)) / 3_600_000;
    return { ...d, age_hours: Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null, stale: !Number.isFinite(ageH) || ageH > 24 };
  } catch { return null; }
}
