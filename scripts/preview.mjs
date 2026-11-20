#!/usr/bin/env node
// verify-runtime：開啟 HTML 預覽（HIS 端 runtime 的本機離線版）。plugin 安裝後工作目錄不在本 repo，
// 所以由這裡補上環境變數再交給 tools/v0-harness/preview.mjs，只回一個 link：
//   node scripts/preview.mjs <draft_id> [起始埠] [--workspace <dir>]
// 工作目錄＝--workspace、STRUCMED_WORKSPACE 或目前目錄（form_preview html 把資料寫在 <workspace>/.strucmed/preview/）。
// 平台 web/ 副本與 form_preview、check-env 同一份判斷與同一份訊息（mcp/strucmed-mcp/src/runtime-web.mjs）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRuntimeWeb, helpText } from '../mcp/strucmed-mcp/src/runtime-web.mjs';
import { verifyRuntime } from '../mcp/strucmed-mcp/src/runtime-fetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const wsAt = args.indexOf('--workspace');
const wsArg = wsAt >= 0 ? args.splice(wsAt, 2)[1] : '';
const envWs = String(process.env.STRUCMED_WORKSPACE || '').trim();
const workspace = path.resolve(wsArg || (envWs && !envWs.startsWith('${') ? envWs : process.cwd()));
const web = findRuntimeWeb(workspace);
if (!web.available) {
  console.log(JSON.stringify({ ok: false, runtime_available: false, runtime_web: web.path, tried: web.tried, cache_file: web.cache_file,
    message: `找不到 TempHtml.html。${helpText(web)}或跳過 runtime 驗證並告知使用者。` }, null, 1));
  process.exit(2);
}
// 從站台抓來的快取（runtime_fetch）：開預覽前重算每個檔案的 sha256 比對，不符就拒絕開，不默默使用
if (web.source === 'fetched') {
  const v = verifyRuntime(web.path);
  if (!v.ok) {
    console.log(JSON.stringify({ ok: false, runtime_available: false, runtime_web: web.path, runtime_source: web.source, reason: v.reason,
      mismatched: v.mismatched, missing: v.missing,
      message: `抓來的 runtime 快取雜湊驗證沒通過（${v.reason}：不符 ${v.mismatched.length} 個、缺 ${v.missing.length} 個），拒絕開預覽。` +
        '請執行 MCP 的 runtime_fetch(refetch: true) 重抓，或設 STRUCMED_RUNTIME_WEB 指向自己的平台 web/ 副本。' }, null, 1));
    process.exit(2);
  }
}
const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'tools', 'v0-harness', 'preview.mjs'), ...args], {
  stdio: 'inherit', env: { ...process.env, STRUCMED_WORKSPACE: workspace, STRUCMED_RUNTIME_WEB: web.path }
});
process.exit(r.status ?? 1);
