// v0 harness static server (localhost only, no outbound requests).
//   node tools/v0-harness/serve.mjs [port] [--workspace <dir>]
// Serves repo/strucmed/web read-only; editor.html is served with guard.js
// injected as the first <head> script and harness.js before </body>.
// Results POSTed to /__result are written to tools/v0-harness/out/.
// 審閱模式（docs/15 §2.3）：POST /__review/<draft_id> 把意見寫到 <workspace>/.strucmed/review/<draft_id>/。
// 工作目錄在啟動時定下來（絕對路徑），之後不再看 cwd；實際的埠寫到 <workspace>/.strucmed/preview/server.json，form_preview 讀它組網址。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  fs.writeFileSync(SERVER_JSON, JSON.stringify({ v: 1, port, pid: process.pid, workspace: WORKSPACE, web: WEB, version: VERSION, serve: SERVE, started_at: new Date().toISOString() }, null, 1));
}
function clearServerInfo() {
  try { if (JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8')).pid === process.pid) fs.rmSync(SERVER_JSON); } catch { /* 已經不在 */ }
}
const PREVIEW_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; " +
  "object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'self'";
function composePreview(tempHtml, formJson, metaJson) {
  const data = String(formJson).replace(/<\//g, '<\\/');
  // meta 含字典補述等別人寫的文字：所有 < 都跳脫，不會結束 <script>
  const meta = metaJson ? String(metaJson).replace(/</g, '\\u003c') : 'null';
  let html = String(tempHtml).replace(/<head[^>]*>/i, m => m + '\n<base href="/">\n<script src="/__harness/guard.js"></script>');
  // TempHtml.html 在 </html> 之後還有一段預設的 var tempdata，執行順序不可靠 → 表單資料放在 __previewData，
  // 由 preview-shim.js 在 load 事件（所有 script 都執行完）時指定給 tempdata 再呼叫 getheader()
  return html + `\n<script>window.__previewData = ${data};</script>\n<script>window.__reviewMeta = ${meta};</script>\n` +
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
function saveReview(res, id, review) {
  const dir = path.join(REVIEW_DIR, id);
  const seq = nextReviewSeq(dir);
  // seq、at 由伺服器決定，本文帶的不算
  const { v, draft_id, status, seq: _seq, at: _at, ...rest } = review;
  const text = JSON.stringify({ v, draft_id, seq, at: new Date().toISOString(), status, ...rest }, null, 2);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(seq).padStart(3, '0') + '.json');
  fs.writeFileSync(file, text, { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'latest.json'), text);
  sendJson(res, 200, { ok: true, seq, file: path.relative(WORKSPACE, file) });
}
function handleReview(req, res, id, latest) {
  if (!reviewHostOk(req)) return sendJson(res, 403, { ok: false, error: 'Host 或 Origin 不符' });
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

http.createServer((req, res) => {
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
  if (review) return handleReview(req, res, review[1], !!review[2]);
  if (p.startsWith('/__preview/')) {
    const id = p.slice('/__preview/'.length);
    if (!/^d-[0-9a-f]{12}$/.test(id)) return send(res, 404, 'nf');
    const f = path.join(PREVIEW_DIR, id + '.json');
    const th = path.join(WEB, 'TempHtml.html');
    if (!fs.existsSync(f)) return send(res, 404, '找不到預覽資料，請先以 form_preview（format: html）產生');
    if (!fs.existsSync(th)) return send(res, 404, `找不到 ${th}（HTML 預覽需要平台前端的本機副本，設定 STRUCMED_RUNTIME_WEB）`);
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': PREVIEW_CSP });
    const mf = path.join(PREVIEW_DIR, id + '.meta.json');
    return res.end(composePreview(fs.readFileSync(th, 'utf8'), fs.readFileSync(f, 'utf8'), fs.existsSync(mf) ? fs.readFileSync(mf, 'utf8') : null));
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
  console.log(`[v0] http://127.0.0.1:${PORT}/editor.html?autorun=1`);
  console.log(`[v0] HTML 預覽：http://127.0.0.1:${PORT}/__preview/<draft_id>`);
});
