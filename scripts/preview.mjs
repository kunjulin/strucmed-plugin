#!/usr/bin/env node
// verify-runtime：開啟 HTML 預覽（HIS 端 runtime 的本機離線版）。plugin 安裝後工作目錄不在本 repo，
// 所以由這裡補上環境變數再交給 tools/v0-harness/preview.mjs：
//   node scripts/preview.mjs <draft_id> [port]
// 需要：STRUCMED_RUNTIME_WEB（平台 web/ 的本機副本；未設定時用 <workspace>/repo/strucmed/web）。
// 工作目錄＝STRUCMED_WORKSPACE 或目前目錄（form_preview html 把資料寫在 <workspace>/.strucmed/preview/）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const workspace = path.resolve(process.env.STRUCMED_WORKSPACE || process.cwd());
const runtimeWeb = process.env.STRUCMED_RUNTIME_WEB ? path.resolve(process.env.STRUCMED_RUNTIME_WEB) : path.join(workspace, 'repo', 'strucmed', 'web');
if (!fs.existsSync(path.join(runtimeWeb, 'TempHtml.html'))) {
  console.log(JSON.stringify({ ok: false, runtime_available: false,
    message: `找不到 ${path.join(runtimeWeb, 'TempHtml.html')}：請設定 STRUCMED_RUNTIME_WEB 指向平台 web/ 的本機副本，或跳過 runtime 驗證並告知使用者` }, null, 1));
  process.exit(2);
}
const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'tools', 'v0-harness', 'preview.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, STRUCMED_WORKSPACE: workspace, STRUCMED_RUNTIME_WEB: runtimeWeb }
});
process.exit(r.status ?? 1);
