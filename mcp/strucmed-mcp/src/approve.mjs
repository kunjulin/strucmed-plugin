// 線上寫入的瀏覽器確認（MCP 2.3.0）：第二段呼叫（帶 confirm_token）時，在 127.0.0.1 開一頁顯示 plan，
// 由使用者本人按「確認」才寫入。確認不經過 AI 工具與對話，所以不論 client 是否載入 skill、hooks 或處於自動執行模式，
// 寫入都一定有人看過 plan。做法同 online_login：第一次開頁並等待，還沒按就回 pending，再呼叫一次接著等同一頁。
//   - plan 在第一段呼叫時記下（offer），第二段只顯示記下的那份，與 confirm_token 綁同一個 payload 雜湊
//   - 每次確認只能用一次（consume）；按取消、逾時或 MCP 重啟都要重新取得計畫
//   - 只聽 127.0.0.1；網址含一次性 nonce，POST 另檢查 Host／Origin；頁面內容一律跳脫，不載入外部資源
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { E, fail } from './errors.mjs';

const TTL_MS = 10 * 60_000;   // 與 confirm_token 相同
const waitMs = () => { const n = Number(process.env.STRUCMED_APPROVE_WAIT_MS); return Number.isFinite(n) && n >= 0 ? Math.min(n, 300_000) : 120_000; };

const offers = new Map();     // `${action}|${hash}` → { title, plan, expires, flow, approved }

const key = (action, hash) => `${action}|${hash}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sweep() {
  const now = Date.now();
  for (const [k, o] of offers) if (now > o.expires) { closeFlow(o); offers.delete(k); }
}

// 第一段呼叫：記下要給使用者確認的 plan
export function offer(action, hash, title, plan) {
  sweep();
  const k = key(action, hash);
  closeFlow(offers.get(k));
  offers.set(k, { title, plan, expires: Date.now() + TTL_MS, flow: null, approved: false });
}

const LABELS = {
  action: '動作', site: '站台', user_id: '登入者', dept_no: '科部', folder_type: '資料夾類型', folder_code: '資料夾', template_id: '範本 ID',
  name: '名稱', shortcut: '捷徑', groups: '作業別', description: '說明', publish_on_save: '保存即上架', areas: '區塊數', controls: '控制項數',
  dictionaries: '字典', warnings: '警告', diff: '與線上版本的差異', if_match: 'If-Match', scope: '字典範圍', comment: '字典說明', force: '強制新建',
  used_by_itemids: '使用的控制項', rows: '字典清單', before: '原本筆數', after: '寫入後筆數', added: '新增', removed: '移除', renamed: '改名', kept: '保留',
  items: '寫入後的清單', note: '備註', draft_sha256: 'draft 雜湊', body_chars: '本文字元數'
};
const SHOWN_FIRST = ['action', 'site', 'user_id', 'folder_type', 'folder_code', 'template_id', 'name', 'shortcut', 'groups', 'publish_on_save'];

function value(v) {
  if (v === null || v === undefined || v === '') return '<span class="m">（無）</span>';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v) && v.every(x => typeof x !== 'object')) return v.length ? esc(v.join('、')) : '<span class="m">（無）</span>';
  if (typeof v === 'object') return `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
  return esc(v);
}

function page(o, nonce, state) {
  const plan = o.plan || {};
  const keys = [...SHOWN_FIRST.filter(k => k in plan), ...Object.keys(plan).filter(k => !SHOWN_FIRST.includes(k))];
  const rows = keys.map(k => `<tr><th>${esc(LABELS[k] || k)}</th><td>${value(plan[k])}</td></tr>`).join('');
  const body = state === 'approved' ? '<p class="ok">已確認。可以關閉此頁，回到 AI 工具。</p>'
    : state === 'rejected' ? '<p class="no">已取消，不會寫入。可以關閉此頁。</p>'
    : `<form method="post" action="/decide"><input type="hidden" name="n" value="${esc(nonce)}">` +
      '<button name="d" value="approve" class="ok">確認寫入</button> <button name="d" value="reject">取消</button></form>' +
      '<p class="m">10 分鐘內未確認即失效；按取消不會寫入。</p>';
  return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>strucmed 寫入確認：${esc(o.title)}</title><style>body{font-family:system-ui,'Microsoft JhengHei',sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#222}` +
    'h1{font-size:20px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top;font-size:14px}' +
    'th{width:9em;background:#f5f5f5;white-space:nowrap}pre{margin:0;white-space:pre-wrap;font-size:12px}button{font-size:16px;padding:8px 20px;margin-right:8px;cursor:pointer}' +
    'button.ok{background:#0b6e4f;color:#fff;border:0}p.ok{color:#0b6e4f;font-weight:bold}p.no{color:#a00;font-weight:bold}.m{color:#777}</style></head><body>' +
    `<h1>strucmed 寫入確認：${esc(o.title)}</h1><p>這是 AI 工具要寫入線上 strucmed 的內容，請核對站台、登入者、資料夾與名稱。只有在這頁按「確認寫入」才會寫入。</p>` +
    `<table>${rows}</table>${body}</body></html>`;
}

function closeFlow(o) {
  if (o && o.flow) { try { o.flow.server.close(); } catch { /* 已關閉 */ } o.flow = null; }
}

async function startFlow(o) {
  const nonce = crypto.randomBytes(16).toString('hex');
  let resolve;
  const done = new Promise(r => { resolve = r; });
  let state = 'pending';
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", 'X-Frame-Options': 'DENY' }); res.end(html); };
    const u = new URL(req.url, 'http://127.0.0.1');
    // DNS rebinding：Host 必須是本機這個 port
    if (req.headers.host !== `127.0.0.1:${port}`) return send(400, '<p>連結無效</p>');
    if (req.method === 'GET' && u.pathname === '/approve') {
      if (u.searchParams.get('n') !== nonce) return send(404, '<p>連結無效或已失效，請回到 AI 工具重新取得計畫。</p>');
      return send(200, page(o, nonce, state));
    }
    if (req.method === 'POST' && u.pathname === '/decide') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}`) return send(403, '<p>來源不符</p>');
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy(); });
      req.on('end', () => {
        const f = new URLSearchParams(raw);
        const n = String(f.get('n') || '');
        const ok = n.length === nonce.length && crypto.timingSafeEqual(Buffer.from(n), Buffer.from(nonce));
        if (!ok || state !== 'pending') return send(400, '<p>連結無效或已處理過，請回到 AI 工具。</p>');
        state = f.get('d') === 'approve' ? 'approved' : 'rejected';
        send(200, page(o, nonce, state));
        resolve(state);
        setTimeout(() => server.close(), 1000).unref();
      });
      return;
    }
    send(404, '<p>找不到</p>');
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const url = `http://127.0.0.1:${server.address().port}/approve?n=${nonce}`;
  const flow = { server, url, done, result: null };
  done.then(r => { flow.result = r; });
  return flow;
}

// 以系統瀏覽器開啟（不經 shell）；STRUCMED_NO_BROWSER=1 不開啟
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

// 第二段呼叫：已確認 → { approved: true }（並作廢，只能用一次）；還沒確認 → { pending: true, ... }；取消 → E_REJECTED
export async function awaitApproval(action, hash) {
  sweep();
  const k = key(action, hash);
  const o = offers.get(k);
  if (!o) fail(E.CONFIRM_MISMATCH, '找不到這份計畫的確認（已過期、已使用，或 MCP 重新啟動過），請重新取得計畫');
  let opened = null;
  if (!o.flow) { o.flow = await startFlow(o); opened = openBrowser(o.flow.url); }
  const f = o.flow;
  const r = f.result || await Promise.race([f.done, new Promise(ok => setTimeout(ok, waitMs()).unref())]);
  if (!r) {
    return { pending: true, approve_url: f.url, browser_opened: opened,
      message: (opened === false ? '無法自動開啟瀏覽器，請使用者自行開啟 approve_url。' : '已在瀏覽器開啟寫入確認頁。') +
        '請使用者在頁面核對站台、登入者、資料夾與名稱後按「確認寫入」，完成後帶同一個 confirm_token 再呼叫一次；尚未寫入。' };
  }
  offers.delete(k);
  closeFlow(o);
  if (r !== 'approved') fail(E.REJECTED, '使用者在確認頁按了「取消」，未寫入；需要時請重新取得計畫');
  return { approved: true };
}

// 測試用：目前等待確認的筆數
export const pendingCount = () => { sweep(); return offers.size; };
