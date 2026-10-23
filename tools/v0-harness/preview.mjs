// 開啟 runtime 驗證（HTML 預覽）：檢查 harness 伺服器 → 沒開就在背景啟動 → 印出可點的預覽連結。
//   node tools/v0-harness/preview.mjs <draft_id> [port]
// 先用 MCP form_preview（format: "html"）產生 .strucmed/preview/<draft_id>.json。
// 伺服器只監聽 127.0.0.1；啟動後會留著讓使用者點連結，要關閉時結束該 node 程序即可。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.STRUCMED_WORKSPACE ? path.resolve(process.env.STRUCMED_WORKSPACE) : path.resolve(HERE, '../..');
const [id, portArg] = process.argv.slice(2);
const PORT = Number(portArg || 8765);
const base = `http://127.0.0.1:${PORT}`;
const out = o => { console.log(JSON.stringify(o, null, 1)); };

if (!/^d-[0-9a-f]{12}$/.test(String(id || ''))) {
  out({ ok: false, message: '用法：node tools/v0-harness/preview.mjs <draft_id> [port]' });
  process.exit(2);
}
if (!fs.existsSync(path.join(WORKSPACE, '.strucmed', 'preview', id + '.json'))) {
  out({ ok: false, message: `找不到 .strucmed/preview/${id}.json，請先呼叫 form_preview（format: "html"）` });
  process.exit(2);
}

async function probe(p, ms = 1500) {
  try {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(ms) });
    return { status: r.status, text: await r.text() };
  } catch { return null; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let started = false;
let health = await probe('/__health');
let old = false;
if (!health) {
  const anything = await probe('/');
  if (anything) {
    // 8765 上有伺服器但不是新版 harness（舊版 serve.mjs 或其他程式）
    old = true;
  } else {
    const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), String(PORT)], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: path.resolve(HERE, '../..')
    });
    child.unref();
    started = child.pid;
    for (let i = 0; i < 25 && !health; i++) { await sleep(200); health = await probe('/__health'); }
    if (!health) { out({ ok: false, message: `伺服器啟動失敗（${base}）` }); process.exit(1); }
  }
} else if (health.status !== 200) old = true;

const page = await probe('/__preview/' + id, 5000);
const url = `${base}/__preview/${id}`;
out({
  ok: !!page && page.status === 200,
  url,
  link: `[開啟表單預覽](${url})`,
  server: started ? `已在背景啟動（pid ${started}）` : old ? '沿用已在執行的伺服器（舊版：沒有截圖功能，重新啟動 serve.mjs 即可更新）' : '沿用已在執行的伺服器',
  ...(page && page.status !== 200 && { message: page.text.slice(0, 200) })
});
