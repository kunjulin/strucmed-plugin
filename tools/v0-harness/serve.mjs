// v0 harness static server (localhost only, no outbound requests).
//   node tools/v0-harness/serve.mjs [port] [--workspace <dir>]
// Serves repo/strucmed/web read-only; editor.html is served with guard.js
// injected as the first <head> script and harness.js before </body>.
// Results POSTed to /__result are written to tools/v0-harness/out/.
// 審閱模式（docs/15 §2.3）：POST /__review/<draft_id> 把意見寫到 <workspace>/.strucmed/review/<draft_id>/。
// 工作目錄在啟動時定下來（絕對路徑），之後不再看 cwd；實際的埠寫到 <workspace>/.strucmed/preview/server.json，form_preview 讀它組網址。
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientScript as phiClientScript, phiReason, REASON_LABEL } from '../../mcp/strucmed-mcp/src/phi.mjs';
import { localStamp, readManifest, verifyRuntime } from '../../mcp/strucmed-mcp/src/runtime-fetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 平台前端副本：STRUCMED_RUNTIME_WEB，未設定時沿用 repo/strucmed/web；工作目錄：STRUCMED_WORKSPACE，未設定時是本 repo
const WEB = process.env.STRUCMED_RUNTIME_WEB ? path.resolve(process.env.STRUCMED_RUNTIME_WEB) : path.resolve(HERE, '../../repo/strucmed/web');
const args = process.argv.slice(2);
const wsAt = args.indexOf('--workspace');
const wsArg = wsAt >= 0 ? args.splice(wsAt, 2)[1] : '';
const WORKSPACE = path.resolve(wsArg || process.env.STRUCMED_WORKSPACE || path.resolve(HERE, '../..'));
const FIX = path.join(HERE, 'fixtures');
const OUT = path.join(HERE, 'out');
const PORT = Number(args[0] || 8765);
// preview.mjs 用這兩個值判斷埠上的 harness 是不是這份 plugin（F-02：別版 plugin 留下的 harness 不沿用）
const SERVE = fileURLToPath(import.meta.url);
// 預覽網址的一次性 nonce（做法同 mcp/strucmed-mcp/src/approve.mjs）：伺服器一啟動就產生，寫進 server.json，
// form_preview 與 preview.mjs 從那裡讀來組網址。伺服器重啟就換一個，舊連結失效。
const NONCE = crypto.randomBytes(16).toString('hex');
// 閒置自動關：沒有任何請求超過這段時間就結束並清掉 server.json（預設 120 分鐘；0 或負數＝不自動關）
const IDLE_MS = (() => { const n = Number(process.env.STRUCMED_PREVIEW_IDLE_MS); return Number.isFinite(n) ? n : 120 * 60_000; })();
let lastHit = Date.now();
const VERSION = (() => { try { return String(JSON.parse(fs.readFileSync(path.resolve(HERE, '../../.claude-plugin/plugin.json'), 'utf8')).version || ''); } catch { return ''; } })();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.otf': 'font/otf'
};

function safeJoin(root, p) {
  const full = path.resolve(root, '.' + decodeURIComponent(p));
  return full.startsWith(root) ? full : null;
}

// v0.2 HTML 預覽：form_preview(format=html) 把 draft 寫到 <repo>/.strucmed/preview/<draft_id>.json，
// 這裡以真實 TempHtml.html（HIS 端 runtime）＋ guard.js ＋ preview-shim.js 組出頁面。
// CSP 在瀏覽器層封鎖所有對外請求（含 <img>、<script> 等 guard.js 攔不到的載入），表單自訂 JS 也無法連外。
const PREVIEW_DIR = path.join(WORKSPACE, '.strucmed', 'preview');
const SERVER_JSON = path.join(PREVIEW_DIR, 'server.json');
function writeServerInfo(port) {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  fs.writeFileSync(SERVER_JSON, JSON.stringify({ v: 1, port, pid: process.pid, workspace: WORKSPACE, web: WEB, version: VERSION, serve: SERVE, nonce: NONCE, idle_ms: IDLE_MS, started_at: new Date().toISOString() }, null, 1));
}
function clearServerInfo() {
  try { if (JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8')).pid === process.pid) fs.rmSync(SERVER_JSON); } catch { /* 已經不在 */ }
}
const PREVIEW_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; " +
  "object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'self'";
// runtime 版本與來源（第 7 項）：橫幅讓使用者一眼看到預覽跑的是哪一版引擎。版本漂移在畫面上原本完全看不出來
function runtimeInfo() {
  const m = readManifest(WEB);
  const v = m ? verifyRuntime(WEB) : null;
  return { ver: localStamp(WEB) || '', web: WEB,
    source: m ? 'fetched' : (process.env.STRUCMED_RUNTIME_WEB ? 'env' : 'local'),
    ...(m && { fetched_at: m.fetched_at, site: (m.source && m.source.site) || '', verified: !!(v && v.ok) }) };
}
function bannerScript(info) {
  return '<script>(function(){var i=' + JSON.stringify(info).replace(/</g, '\\u003c') + ';window.__runtimeInfo=i;' +
    'function show(){var b=document.createElement("div");b.id="sm-runtime-banner";' +
    'b.style.cssText="position:fixed;left:0;right:0;bottom:0;z-index:99999;font:12px/1.6 system-ui,sans-serif;background:#222;color:#eee;padding:4px 10px;opacity:.92";' +
    'var bad=i.source==="fetched"&&i.verified===false;if(bad){b.style.background="#a00";b.style.color="#fff";}' +
    'b.textContent="runtime "+(i.ver?("ver "+i.ver):"（無版本註解）")+"　來源："' +
    '+(i.source==="fetched"?("站台快取"+(i.site?("（"+i.site+"）"):"")+(bad?"　雜湊驗證失敗":"　雜湊已驗證")):i.source==="env"?"STRUCMED_RUNTIME_WEB":"本機副本")' +
    '+"　"+i.web+"　（本機離線預覽，不存檔）";' +
    'document.body.appendChild(b);document.body.style.paddingBottom="28px";}' +
    'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",show);}else{show();}}());</script>';
}
function composePreview(tempHtml, formJson, metaJson) {
  const data = String(formJson).replace(/<\//g, '<\\/');
  // meta 含字典補述等別人寫的文字：所有 < 都跳脫，不會結束 <script>
  const meta = metaJson ? String(metaJson).replace(/</g, '\\u003c') : 'null';
  let html = String(tempHtml).replace(/<head[^>]*>/i, m => m + '\n<base href="/">\n<script src="/__harness/guard.js"></script>');
  // TempHtml.html 在 </html> 之後還有一段預設的 var tempdata，執行順序不可靠 → 表單資料放在 __previewData，
  // 由 preview-shim.js 在 load 事件（所有 script 都執行完）時指定給 tempdata 再呼叫 getheader()
  return html + `\n<script>window.__previewData = ${data};</script>\n<script>window.__reviewMeta = ${meta};</script>\n` +
    bannerScript(runtimeInfo()) + '\n' +
    '<script src="/__harness/phi.js"></script>\n' +
    '<script src="/__harness/preview-shim.js"></script>\n<script src="/__harness/review-mode.js"></script>\n';
}

// 審閱意見：只收本機頁面送來的 JSON。Host 擋 DNS rebinding；Origin（瀏覽器才帶）擋其他網站的表單與 fetch
const REVIEW_DIR = path.join(WORKSPACE, '.strucmed', 'review');
const REVIEW_MAX = 1024 * 1024;
const DRAFT_ID = /^d-[0-9a-f]{12}$/;
function reviewHostOk(req) {
  const port = req.socket.localPort;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = req.headers.origin;
  return hosts.includes(req.headers.host) && (origin === undefined || hosts.includes(String(origin).replace(/^http:\/\//, '')));
}
function nextReviewSeq(dir) {
  const seqs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).map(f => parseInt(f, 10)) : [];
  return Math.max(0, ...seqs) + 1;
}
// 疑似病歷號／身分證字號不寫進 review JSON（規則同 mcp/strucmed-mcp/src/phi.mjs，review-mode.js 也用同一份）。
// 伺服器端是最後一道：頁面端的檢查可以被繞過，這裡才是真正決定寫什麼進檔案的地方。
function stripPhi(review) {
  const dropped = [];
  const out = { ...review };
  if (out.values && typeof out.values === 'object') {
    const kept = {};
    for (const [k, val] of Object.entries(out.values)) {
      const why = phiReason(val);
      if (why) dropped.push({ where: `values.${k}`, reason: why, label: REASON_LABEL[why] });
      else kept[k] = val;
    }
    out.values = kept;
  }
  if (typeof out.text_output === 'string' && phiReason(out.text_output)) {
    dropped.push({ where: 'text_output', reason: phiReason(out.text_output), label: REASON_LABEL[phiReason(out.text_output)] });
    delete out.text_output;
  } else if (out.text_output && typeof out.text_output === 'object') {
    const kept = {};
    for (const [k, val] of Object.entries(out.text_output)) {
      const why = phiReason(val);
      if (why) dropped.push({ where: `text_output.${k}`, reason: why, label: REASON_LABEL[why] });
      else kept[k] = val;
    }
    out.text_output = kept;
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((it, i) => {
      if (!it || typeof it !== 'object' || typeof it.text !== 'string') return it;
      const why = phiReason(it.text);
      if (!why) return it;
      dropped.push({ where: `items[${i}].text`, reason: why, label: REASON_LABEL[why] });
      return { ...it, text: '（已移除：疑似個資，未寫入）' };
    });
  }
  return { review: out, dropped };
}

function saveReview(res, id, review) {
  const dir = path.join(REVIEW_DIR, id);
  const seq = nextReviewSeq(dir);
  const { review: clean, dropped } = stripPhi(review);
  // seq、at 由伺服器決定，本文帶的不算
  const { v, draft_id, status, seq: _seq, at: _at, ...rest } = clean;
  const text = JSON.stringify({ v, draft_id, seq, at: new Date().toISOString(), status, ...rest, ...(dropped.length && { phi_dropped: dropped }) }, null, 2);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(seq).padStart(3, '0') + '.json');
  fs.writeFileSync(file, text, { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'latest.json'), text);
  if (dropped.length) console.log(`[v0] review ${seq}：${dropped.length} 個疑似個資的值未寫入（${dropped.map(x => x.where).join('、')}）`);
  sendJson(res, 200, { ok: true, seq, file: path.relative(WORKSPACE, file), ...(dropped.length && { phi_dropped: dropped }) });
}
function handleReview(req, res, id, latest, givenNonce) {
  if (!reviewHostOk(req)) return sendJson(res, 403, { ok: false, error: 'Host 或 Origin 不符' });
  // 127.0.0.1＋Host／Origin 的檢查照舊；預覽頁會一併帶上網址的 nonce，帶了就必須正確（舊的頁面重整後寫不進來）
  if (givenNonce !== null && !nonceOk(givenNonce)) return sendJson(res, 403, { ok: false, error: 'nonce 不符（預覽伺服器重啟過？請重新呼叫 form_preview 取得新連結）' });
  if (req.method === 'GET' && latest) {
    const f = path.join(REVIEW_DIR, String(id), 'latest.json');
    if (!DRAFT_ID.test(id) || !fs.existsSync(f)) return sendJson(res, 404, { ok: false, error: '還沒有送出過意見' });
    return send(res, 200, fs.readFileSync(f), TYPES['.json']);
  }
  if (req.method !== 'POST' || latest) return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  if (!DRAFT_ID.test(id)) return sendJson(res, 400, { ok: false, error: 'draft_id 格式不正確' });
  if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return sendJson(res, 415, { ok: false, error: 'Content-Type 必須是 application/json' });
  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length; if (size <= REVIEW_MAX) chunks.push(c); });
  req.on('end', () => {
    if (size > REVIEW_MAX) return sendJson(res, 413, { ok: false, error: '本文超過 1 MiB' });
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: '本文不是合法的 JSON' }); }
    if (!body || typeof body !== 'object' || body.v !== 1 || body.draft_id !== id) return sendJson(res, 400, { ok: false, error: 'v 必須是 1，draft_id 必須與路徑相同' });
    if (!['revise', 'finalize'].includes(body.status) || !Array.isArray(body.items)) return sendJson(res, 400, { ok: false, error: 'status 必須是 revise／finalize，items 必須是陣列' });
    try { saveReview(res, id, body); } catch (e) { console.error('[v0] review 寫入失敗', e); sendJson(res, 500, { ok: false, error: '寫入失敗' }); }
  });
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), TYPES['.json']);
// nonce 比對：長度相同才做 timingSafeEqual（同 approve.mjs）
function nonceOk(given) {
  const n = String(given || '');
  return n.length === NONCE.length && crypto.timingSafeEqual(Buffer.from(n), Buffer.from(NONCE));
}

http.createServer((req, res) => {
  lastHit = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'POST' && p === '/__result') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      fs.mkdirSync(OUT, { recursive: true });
      const setName = String(url.searchParams.get('set') || 'fixtures').replace(/[^A-Za-z0-9_-]/g, '_');
      const file = path.join(OUT, setName + '-roundtrip-result.json');
      fs.writeFileSync(file, body);
      console.log('[v0] result written:', file);
      send(res, 200, 'ok');
    });
    return;
  }
  if (p === '/__health') {
    // preview.mjs 用來判斷這個埠上是不是新版、同一個工作目錄的 harness 伺服器；路徑只回給本機頁面（Host 相符）
    return send(res, 200, JSON.stringify({ harness: 'v0', features: ['preview', 'snapshot', 'review', 'workspace'], ...(reviewHostOk(req) && { workspace: WORKSPACE, web: WEB, version: VERSION, serve: SERVE }) }), TYPES['.json']);
  }
  if (req.method === 'POST' && p === '/__snapshot') {
    // runtime 驗證的畫面截圖（preview-shim.js 的 __snapshot 以 html2canvas 產生 PNG）→ out/snapshots/（已 gitignore）
    const name = String(url.searchParams.get('name') || 'preview').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size <= 10 * 1024 * 1024) chunks.push(c); });
    req.on('end', () => {
      if (size > 10 * 1024 * 1024) return send(res, 413, 'too large');
      const buf = Buffer.concat(chunks);
      if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return send(res, 400, 'not png');
      const dir = path.join(OUT, 'snapshots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name + '.png');
      fs.writeFileSync(file, buf);
      console.log('[v0] snapshot written:', file);
      send(res, 200, file);
    });
    return;
  }
  const review = /^\/__review\/([^/]*)(\/latest)?$/.exec(p);
  if (review) return handleReview(req, res, review[1], !!review[2], url.searchParams.has('n') ? url.searchParams.get('n') : null);
  if (p.startsWith('/__preview/')) {
    const id = p.slice('/__preview/'.length);
    if (!/^d-[0-9a-f]{12}$/.test(id)) return send(res, 404, 'nf');
    // 一次性 nonce（做法同 approve.mjs）：網址沒有或不符就不給頁面。伺服器重啟換一個，舊連結失效
    if (!nonceOk(url.searchParams.get('n'))) {
      return send(res, 404, '連結無效或已失效（預覽伺服器重啟過）。請回到 AI 工具重新呼叫 form_preview 取得新連結。');
    }
    const f = path.join(PREVIEW_DIR, id + '.json');
    const th = path.join(WEB, 'TempHtml.html');
    if (!fs.existsSync(f)) return send(res, 404, '找不到預覽資料，請先以 form_preview（format: html）產生');
    if (!fs.existsSync(th)) return send(res, 404, `找不到 ${th}（HTML 預覽需要平台前端的本機副本，設定 STRUCMED_RUNTIME_WEB）`);
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': PREVIEW_CSP });
    const mf = path.join(PREVIEW_DIR, id + '.meta.json');
    return res.end(composePreview(fs.readFileSync(th, 'utf8'), fs.readFileSync(f, 'utf8'), fs.existsSync(mf) ? fs.readFileSync(mf, 'utf8') : null));
  }
  if (p === '/__harness/phi.js') {
    // 疑似個資的樣式由 mcp/strucmed-mcp/src/phi.mjs 產生：預覽頁與伺服器端用同一組規則，不在瀏覽器另寫一套
    return send(res, 200, phiClientScript(), TYPES['.js']);
  }
  if (p.startsWith('/__harness/')) {
    const f = safeJoin(HERE, p.slice('/__harness'.length));
    return f && fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)]) : send(res, 404, 'nf');
  }
  if (p.startsWith('/__out/')) {
    // out/<set>/…（本機產生的測試輸出；out/ 已 gitignore）
    const f = safeJoin(OUT, p.slice('/__out'.length));
    return f && fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), TYPES['.json']) : send(res, 404, 'nf');
  }
  if (p === '/__samples/index.json') {
    const SAM = path.join(HERE, 'samples');
    const list = fs.existsSync(SAM) ? fs.readdirSync(SAM).filter(f => f.endsWith('.json')).sort() : [];
    return send(res, 200, JSON.stringify(list), TYPES['.json']);
  }
  if (p.startsWith('/__samples/')) {
    const f = safeJoin(path.join(HERE, 'samples'), p.slice('/__samples'.length));
    return f && fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), TYPES['.json']) : send(res, 404, 'nf');
  }
  if (p.startsWith('/__fixtures/')) {
    const f = safeJoin(FIX, p.slice('/__fixtures'.length));
    return f && fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), TYPES['.json']) : send(res, 404, 'nf');
  }
  if (req.method !== 'GET') return send(res, 405, 'read-only');

  const f = safeJoin(WEB, p === '/' ? '/editor.html' : p);
  if (!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, 'nf');
  if (path.basename(f) === 'Dictionary.html') {
    // 字典頁只注入連線封鎖（P0 字典 CSV 修正的離線測試）
    const html = fs.readFileSync(f, 'utf8').replace(/<head>/i, '<head>\n<script src="/__harness/guard.js"></script>');
    return send(res, 200, html, TYPES['.html']);
  }
  if (path.basename(f) === 'editor.html') {
    let html = fs.readFileSync(f, 'utf8');
    html = html.replace(/<head>/i, '<head>\n<script src="/__harness/guard.js"></script>');
    html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="/__harness/harness.js"></script>\n</body>');
    return send(res, 200, html, TYPES['.html']);
  }
  send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] || 'application/octet-stream');
}).on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`[v0] 127.0.0.1:${PORT} 已被占用：可能已有一個 harness 伺服器在執行，或改用其他埠：node tools/v0-harness/serve.mjs ${PORT + 1}`);
  process.exit(1);
}).listen(PORT, '127.0.0.1', () => {
  writeServerInfo(PORT);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearServerInfo(); process.exit(0); });
  // 閒置自動關：沒人用就不要一直留一個聽本機埠的伺服器（重新 form_preview 會再啟一個）
  if (IDLE_MS > 0) {
    const tick = Math.min(IDLE_MS, 60_000);
    setInterval(() => {
      if (Date.now() - lastHit < IDLE_MS) return;
      console.log(`[v0] 閒置超過 ${Math.round(IDLE_MS / 60_000)} 分鐘，自動關閉（重新呼叫 form_preview 會再啟一個）`);
      clearServerInfo();
      process.exit(0);
    }, tick).unref();
  }
  console.log(`[v0] http://127.0.0.1:${PORT}/editor.html?autorun=1`);
  console.log(`[v0] HTML 預覽：http://127.0.0.1:${PORT}/__preview/<draft_id>?n=<nonce>（nonce 在 .strucmed/preview/server.json；請用 form_preview 或 scripts/preview.mjs 取得連結）`);
});
