#!/usr/bin/env node
// verify-runtime：開啟 HTML 預覽（HIS 端 runtime 的本機離線版）。plugin 安裝後工作目錄不在本 repo，
// 所以由這裡補上環境變數再交給 tools/v0-harness/preview.mjs，只回一個 link：
//   node scripts/preview.mjs <draft_id> [起始埠] [--workspace <dir>]
// 工作目錄＝--workspace、STRUCMED_WORKSPACE 或目前目錄（form_preview html 把資料寫在 <workspace>/.strucmed/preview/）。
// 平台 web/ 副本與 form_preview 同一份判斷（mcp/strucmed-mcp/src/runtime-web.mjs）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRuntimeWeb } from '../mcp/strucmed-mcp/src/runtime-web.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const wsAt = args.indexOf('--workspace');
const wsArg = wsAt >= 0 ? args.splice(wsAt, 2)[1] : '';
const envWs = String(process.env.STRUCMED_WORKSPACE || '').trim();
const workspace = path.resolve(wsArg || (envWs && !envWs.startsWith('${') ? envWs : process.cwd()));
const web = findRuntimeWeb(workspace);
if (!web.available) {
  console.log(JSON.stringify({ ok: false, runtime_available: false,
    message: `找不到 TempHtml.html（找過 ${web.tried.join('、')}）：請設定 STRUCMED_RUNTIME_WEB 指向平台 web/ 的本機副本，或跳過 runtime 驗證並告知使用者` }, null, 1));
  process.exit(2);
}
const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'tools', 'v0-harness', 'preview.mjs'), ...args], {
  stdio: 'inherit', env: { ...process.env, STRUCMED_WORKSPACE: workspace, STRUCMED_RUNTIME_WEB: web.path }
});
process.exit(r.status ?? 1);
