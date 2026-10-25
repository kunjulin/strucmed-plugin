#!/usr/bin/env node
// connect-strucmed 的第一步：檢查執行環境，只輸出 JSON。
//   node scripts/check-env.mjs [--workspace <dir>]
// 環境變數只回報「有沒有設定」（present），絕不印出值；密碼與金鑰不會出現在輸出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const wsArg = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : '';
const workspace = path.resolve(wsArg || process.env.STRUCMED_WORKSPACE || process.cwd());

const present = name => { const s = String(process.env[name] || '').trim(); return !!s && !s.startsWith('${'); };   // 未展開的 ${…} 視為未設定
const checks = [];
const check = (id, ok, detail, level = 'error') => checks.push({ id, ok, level: ok ? 'ok' : level, detail });

// Node 版本
const major = Number(process.versions.node.split('.')[0]);
check('node', major >= 20, `node ${process.versions.node}（需要 ≥20）`);

// MCP 版本與檔案
const pkgPath = path.join(PLUGIN_ROOT, 'mcp', 'strucmed-mcp', 'package.json');
let mcpVersion = null;
try { mcpVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; } catch { /* 缺檔 */ }
check('mcp', !!mcpVersion, mcpVersion ? `strucmed-mcp v${mcpVersion}` : `找不到 ${pkgPath}`);

// feature flags
const flagsPath = process.env.STRUCMED_FLAGS ? path.resolve(process.env.STRUCMED_FLAGS) : path.join(PLUGIN_ROOT, 'feature-flags.json');
let flags = null;
try { flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8')); } catch { /* 缺檔或壞掉 → MCP 用預設值 */ }
check('flags', true, flags ? `feature-flags：${flagsPath}` : `feature-flags 不存在或無法解析（${flagsPath}），MCP 使用預設值`, 'warning');

// 工作目錄
check('workspace', fs.existsSync(workspace), `工作目錄：${workspace}（draft 與輸出會寫在這裡的 .strucmed/ 與 output/）`);

// 環境變數：只回報 present
const env = {};
for (const name of ['STRUCMED_ONLINE_BASE_URL', 'STRUCMED_SITE', 'STRUCMED_EXTERNAL_URL', 'LLMGW_BASE_URL', 'LLMGW_API_KEY', 'FMAPI_BASE_URL', 'FMAPI_API_KEY', 'STRUCMED_RUNTIME_WEB'])
  env[name] = present(name);
// 站台：自動判斷院內（LVAIW）／院外（使用者設定的網址），與 MCP 用同一份邏輯（mcp/strucmed-mcp/src/site.mjs）
const site = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'mcp', 'strucmed-mcp', 'src', 'site.mjs')).href);
const explicit = site.explicitUrl();
const siteMode = site.mode();
let reach = null, profile = null;
if (explicit) {
  profile = site.profile();
  let okUrl = false, why = '';
  try {
    const u = new URL(explicit);
    okUrl = u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
    if (!okUrl) why = '必須是 https（http 只限本機）';
    if (u.username || u.password || u.search || u.hash) { okUrl = false; why = '不可含帳密、查詢字串或 #'; }
    // 院外站台掛在根目錄，/strucmed/… 會 301 轉址，MCP 不跟隨轉址
    if (okUrl && profile !== 'internal' && /^\/strucmed\/?$/i.test(u.pathname) && site.sites().external && u.hostname === new URL(site.sites().external.strucmed).hostname) { okUrl = false; why = '院外站台在根目錄，請去掉 /strucmed'; }
  } catch { why = '不是有效的網址'; }
  check('online_url', okUrl, okUrl ? `站台：以 STRUCMED_ONLINE_BASE_URL 指定（${profile === 'custom' ? '自訂站台' : (site.sites()[profile] || {}).label}）` : `STRUCMED_ONLINE_BASE_URL ${why}`);
} else if (siteMode === 'offline') {
  check('site', true, '站台：STRUCMED_SITE=offline，只做離線流程', 'ok');
} else if (siteMode !== 'auto') {
  profile = siteMode;
  check('site', !!site.sites()[siteMode], site.sites()[siteMode] ? `站台：STRUCMED_SITE=${siteMode}（${site.sites()[siteMode].label}），不偵測` : '站台：STRUCMED_SITE=external 但院外站台已停用（STRUCMED_EXTERNAL_URL=none）或網址無效', site.sites()[siteMode] ? 'ok' : 'warning');
} else {
  reach = await site.probeAll();
  profile = reach.internal ? 'internal' : reach.external ? 'external' : null;
  check('site', true, profile
    ? `站台：自動判斷為${site.sites()[profile].label}（院內 ${reach.internal ? '可連' : '連不到'}、院外 ${site.sites().external ? (reach.external ? '可連' : '連不到') : '已停用'}）${profile === 'external' ? '；院外站台沒有 LlmGateway 與 FMapi，AI 巨集無法實測、模型白名單用內建靜態表' : ''}`
    : (site.sites().external ? '站台：院內與院外都連不到，只能離線作業' : '站台：院內連不到，且院外站台已停用（STRUCMED_EXTERNAL_URL=none）或網址無效，只能離線作業'), 'warning');
}
const online = !!profile;
if (online) check('login', true, '登入：online_login 會以瀏覽器開啟站台登入頁，HIS 帳密在頁面輸入（不需要事先設定）', 'ok');
check('llmgateway', true, profile === 'external' ? 'LlmGateway：院外站台不可用（模型白名單使用內建靜態表）' : env.LLMGW_API_KEY ? 'LlmGateway：已設定金鑰' : 'LlmGateway：本 shell 未見 token（選用；/plugin configure 填「LlmGateway token」，院內才用得到；未設定時模型白名單使用內建靜態表）', 'ok');
check('fmapi', true, profile === 'internal' || env.FMAPI_BASE_URL ? 'FMapi：可用（院內）' : 'FMapi：只有院內提供（選用）', 'ok');

// runtime 驗證需要平台前端副本
const runtimeWeb = env.STRUCMED_RUNTIME_WEB ? path.resolve(process.env.STRUCMED_RUNTIME_WEB) : path.join(workspace, 'repo', 'strucmed', 'web');
const hasRuntime = fs.existsSync(path.join(runtimeWeb, 'TempHtml.html'));
check('runtime_web', true, hasRuntime ? `runtime 驗證可用：${runtimeWeb}` : `runtime 驗證不可用：找不到 ${path.join(runtimeWeb, 'TempHtml.html')}（設定 STRUCMED_RUNTIME_WEB 指向平台 web/ 的本機副本）`, hasRuntime ? 'ok' : 'warning');

const ok = checks.every(c => c.ok);
console.log(JSON.stringify({ ok, plugin_root: PLUGIN_ROOT, workspace, mcp_version: mcpVersion, mode: online ? 'online' : 'offline', site: { profile, label: profile === 'custom' ? '自訂站台' : profile ? site.sites()[profile].label : '離線', reachable: reach, selected_by: explicit ? 'STRUCMED_ONLINE_BASE_URL' : siteMode === 'auto' ? 'auto' : `STRUCMED_SITE=${siteMode}` }, env_present: env, runtime_web: { path: runtimeWeb, available: hasRuntime }, checks }, null, 2));
process.exit(ok ? 0 : 1);
