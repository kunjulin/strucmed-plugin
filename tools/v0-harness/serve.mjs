// v0 harness static server (localhost only, no outbound requests).
//   node tools/v0-harness/serve.mjs [port]
// Serves repo/strucmed/web read-only; editor.html is served with guard.js
// injected as the first <head> script and harness.js before </body>.
// Results POSTed to /__result are written to tools/v0-harness/out/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 平台前端副本：STRUCMED_RUNTIME_WEB，未設定時沿用 repo/strucmed/web；工作目錄：STRUCMED_WORKSPACE，未設定時是本 repo
const WEB = process.env.STRUCMED_RUNTIME_WEB ? path.resolve(process.env.STRUCMED_RUNTIME_WEB) : path.resolve(HERE, '../../repo/strucmed/web');
const WORKSPACE = process.env.STRUCMED_WORKSPACE ? path.resolve(process.env.STRUCMED_WORKSPACE) : path.resolve(HERE, '../..');
const FIX = path.join(HERE, 'fixtures');
const OUT = path.join(HERE, 'out');
const PORT = Number(process.argv[2] || 8765);

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
const PREVIEW_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; " +
  "object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'self'";
function composePreview(tempHtml, formJson) {
  const data = String(formJson).replace(/<\//g, '<\\/');
  let html = String(tempHtml).replace(/<head[^>]*>/i, m => m + '\n<base href="/">\n<script src="/__harness/guard.js"></script>');
  // TempHtml.html 在 </html> 之後還有一段預設的 var tempdata，執行順序不可靠 → 表單資料放在 __previewData，
  // 由 preview-shim.js 在 load 事件（所有 script 都執行完）時指定給 tempdata 再呼叫 getheader()
  return html + `\n<script>window.__previewData = ${data};</script>\n<script src="/__harness/preview-shim.js"></script>\n`;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

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
    // preview.mjs 用來判斷 8765 上是不是（新版的）harness 伺服器
    return send(res, 200, JSON.stringify({ harness: 'v0', features: ['preview', 'snapshot'] }), TYPES['.json']);
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
  if (p.startsWith('/__preview/')) {
    const id = p.slice('/__preview/'.length);
    if (!/^d-[0-9a-f]{12}$/.test(id)) return send(res, 404, 'nf');
    const f = path.join(PREVIEW_DIR, id + '.json');
    const th = path.join(WEB, 'TempHtml.html');
    if (!fs.existsSync(f)) return send(res, 404, '找不到預覽資料，請先以 form_preview（format: html）產生');
    if (!fs.existsSync(th)) return send(res, 404, `找不到 ${th}（HTML 預覽需要平台前端的本機副本，設定 STRUCMED_RUNTIME_WEB）`);
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': PREVIEW_CSP });
    return res.end(composePreview(fs.readFileSync(th, 'utf8'), fs.readFileSync(f, 'utf8')));
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
  console.error(`[v0] 127.0.0.1:${PORT} 已被占用：可能已有一個 harness 伺服器在執行（直接用它即可），` +
    `或改用其他埠：node tools/v0-harness/serve.mjs ${PORT + 1}（預覽網址的埠也要跟著改）`);
  process.exit(1);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[v0] http://127.0.0.1:${PORT}/editor.html?autorun=1`);
  console.log(`[v0] HTML 預覽：http://127.0.0.1:${PORT}/__preview/<draft_id>`);
});
