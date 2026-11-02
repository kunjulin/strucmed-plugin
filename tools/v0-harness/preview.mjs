// 開啟 runtime 驗證（HTML 預覽）：找到同一個工作目錄的 harness 伺服器 → 沒有就在背景啟動 → 印出一個可點的連結。
//   node tools/v0-harness/preview.mjs <draft_id> [起始埠，預設 8765] [--workspace <dir>]
// 先用 MCP form_preview（format: "html"）產生 .strucmed/preview/<draft_id>.json。
// 起始埠被占用（舊版 harness、別的工作目錄、其他程式）時自動往後找，回報實際的埠；伺服器把埠寫到 .strucmed/preview/server.json。
// 伺服器只監聽 127.0.0.1；啟動後會留著讓使用者點連結，要關閉時結束該 node 程序即可。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const wsAt = args.indexOf('--workspace');
const wsArg = wsAt >= 0 ? args.splice(wsAt, 2)[1] : '';
const WORKSPACE = path.resolve(wsArg || process.env.STRUCMED_WORKSPACE || path.resolve(HERE, '../..'));
const WEB = process.env.STRUCMED_RUNTIME_WEB ? path.resolve(process.env.STRUCMED_RUNTIME_WEB) : '';
const [id, portArg] = args;
const START = Number(portArg || 8765);
const TRIES = 10;
const out = o => { console.log(JSON.stringify(o, null, 1)); };

if (!/^d-[0-9a-f]{12}$/.test(String(id || ''))) {
  out({ ok: false, message: '用法：node tools/v0-harness/preview.mjs <draft_id> [起始埠] [--workspace <dir>]' });
  process.exit(2);
}
const data = path.join(WORKSPACE, '.strucmed', 'preview', id + '.json');
if (!fs.existsSync(data)) {
  out({ ok: false, message: `找不到 ${data}，請先呼叫 form_preview（format: "html"）；工作目錄不對時帶 --workspace` });
  process.exit(2);
}

async function probe(port, p, ms = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(ms) });
    return { status: r.status, text: await r.text() };
  } catch { return null; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parse = h => { try { return JSON.parse(h.text); } catch { return null; } };
const isOurs = j => !!j && Array.isArray(j.features) && j.features.includes('review') && j.workspace === WORKSPACE && (!WEB || j.web === WEB);

// 這個埠上的東西為什麼不能用（回報給使用者）；null＝沒有東西在聽
async function occupant(port) {
  const h = await probe(port, '/__health');
  if (h) {
    const j = h.status === 200 ? parse(h) : null;
    if (isOurs(j)) return { ours: true };
    if (j && j.harness && j.workspace) return { why: `別的工作目錄（${j.workspace}）或別份 runtime 的 harness` };
    if (j && j.harness) return { why: '舊版 harness' };
    return { why: '其他程式' };
  }
  return (await probe(port, '/')) ? { why: '其他程式' } : null;
}
async function start(port) {
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), String(port)], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: path.resolve(HERE, '../..'), env: { ...process.env, STRUCMED_WORKSPACE: WORKSPACE }
  });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const h = await probe(port, '/__health');
    if (h && isOurs(parse(h))) return child.pid;
  }
  return 0;
}

const saved = (() => { try { return JSON.parse(fs.readFileSync(path.join(WORKSPACE, '.strucmed', 'preview', 'server.json'), 'utf8')).port; } catch { return null; } })();
const ports = [...new Set([...(Number.isInteger(saved) ? [saved] : []), ...Array.from({ length: TRIES }, (_, i) => START + i)])];
const skipped = [];
let port = 0, pid = 0;
for (const p of ports) {
  const o = await occupant(p);
  if (o && o.ours) { port = p; break; }
  if (o) { skipped.push(`${p}：${o.why}`); continue; }
  pid = await start(p);
  if (pid) { port = p; break; }
  skipped.push(`${p}：啟動失敗`);
}
if (!port) {
  out({ ok: false, message: `找不到可用的埠（${skipped.join('；')}）` });
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/__preview/${id}`;
const page = await probe(port, '/__preview/' + id, 5000);
out({
  ok: !!page && page.status === 200,
  url,
  link: `[開啟表單預覽](${url})`,
  port,
  server: `${pid ? `已在背景啟動（pid ${pid}）` : '沿用已在執行的伺服器'}${skipped.length ? `；略過 ${skipped.join('、')}` : ''}`,
  review: true,
  ...(page && page.status !== 200 && { message: page.text.slice(0, 200) })
});
