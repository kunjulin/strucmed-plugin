#!/usr/bin/env node
// strucmed-mcp — offline stdio MCP server (zero dependencies).
// Protocol: JSON-RPC 2.0, one message per line on stdin/stdout (MCP stdio transport).
// Security posture :
//   - offline by default: no network access, no credentials. Online tools (online-tools.mjs) exist only when a
//     strucmed site is available (site.mjs: 院內／院外自動判斷, or STRUCMED_ONLINE_BASE_URL); login goes through the
//     system browser (the HIS password never reaches this process), never through tool args
//   - writes only under <workspace>/.strucmed and <workspace>/output
//   - stdout carries protocol messages only; diagnostics go to stderr
import readline from 'node:readline';
import { TOOLS } from './tools.mjs';
import { ONLINE_TOOLS as ONLINE_READ_TOOLS } from './online-tools.mjs';
import { ONLINE_WRITE_TOOLS } from './online-write-tools.mjs';
import { LLMGW_TOOLS } from './llmgw-tools.mjs';
import * as llmgw from './llmgw.mjs';
import { FMAPI_TOOLS } from './fmapi-tools.mjs';
import * as fmapi from './fmapi.mjs';
const ONLINE_TOOLS = [...ONLINE_READ_TOOLS, ...ONLINE_WRITE_TOOLS];
import * as online from './online.mjs';
import * as site from './site.mjs';
import { ToolError, E } from './errors.mjs';
import { loadFlags, enabled } from './flags.mjs';
import { VERSION } from './export.mjs';
import { workspaceRoot } from './store.mjs';

const SERVER_INFO = { name: 'strucmed-mcp', version: VERSION };
const INSTRUCTIONS =
  '產生長庚結構化病歷 2.0（StrucMed）可匯入的表單定義檔。預設離線：不連線、不處理帳密、不寫入編輯器或倉儲。' +
  '流程：dictionary_load（選用）→ form_create → form_add_area → form_add_control… → form_validate → form_preview → ' +
  'form_export（兩段式確認，plan 必須先給使用者看）。產出的 .htm 由使用者本人在編輯器匯入並保存。';
const ONLINE_INSTRUCTIONS =
  ' 線上模式可用（站台自動判斷院內／院外，online_login 回應的 site 標明）：online_login（開啟瀏覽器登入頁，使用者在頁面輸入 HIS 帳密，絕不在對話中索取密碼；' +
  '回 pending 時請使用者在瀏覽器完成登入後再呼叫一次）→ online_me／online_features／online_dictionary_search／online_folder_list／online_template_get（唯讀）、' +
  'online_template_create／online_template_update（上架，兩段式，plan 是閘門 G3，核准前不得呼叫第二次）、online_dictionary_create／batch（建立時 dicComment 以字典 JSON 寫好 desc＋memo）、online_dictionary_memo_set（補述與 FHIR 對應，If-Match；體系升級沒有 tool，列入計畫的「體系升級建議」交給體系字典管理者在字典頁操作）、online_template_versions、online_me_notes_get／set（struNote 清單，set 兩段式）。所有寫入的第二次呼叫都會在瀏覽器開啟寫入確認頁，使用者按「確認寫入」才寫入；回 pending 時請使用者到確認頁操作，再帶同一個 confirm_token 呼叫一次，不要替使用者確認。沒有查詢或存檔病人紀錄的 tool（平台對 strucmed-mcp 的 token 一律回 403），請使用者在編輯器或 HIS 操作。';
const LLMGW_INSTRUCTIONS =
  ' LlmGateway 已設定（LLMGW_BASE_URL／LLMGW_API_KEY）：llmgateway_models 取得模型白名單快取（之後 form_validate／formula_check 以此檢查巨集模型）；llmgateway_chat_test（flag llmChatTest）只用白名單模型試跑去識別化的 prompt。';
const onlineNames = new Set(ONLINE_TOOLS.map(t => t.name));
const llmgwNames = new Set(LLMGW_TOOLS.map(t => t.name));
const fmapiNames = new Set(FMAPI_TOOLS.map(t => t.name));
const byName = new Map([...TOOLS, ...ONLINE_TOOLS, ...LLMGW_TOOLS, ...FMAPI_TOOLS].map(t => [t.name, t]));
// 線上 tool 只在有可用站台（site.mjs）且 feature flag online 開啟時列出；未設定時呼叫一律 E_ONLINE_DISABLED，
// flag 關閉（feature-flags.json）時回 E_FEATURE_DISABLED。個別 tool 可再帶 flag（例如 templateUpdate）。
function listed() {
  const f = loadFlags();
  const out = [...TOOLS];
  if (online.configured() && enabled('online', f)) out.push(...ONLINE_TOOLS.filter(t => !t.flag || enabled(t.flag, f)));
  if (llmgw.configured() && enabled('llmgateway', f)) out.push(...LLMGW_TOOLS.filter(t => !t.flag || enabled(t.flag, f)));
  if (fmapi.configured() && enabled('fmapi', f)) out.push(...FMAPI_TOOLS.filter(t => !t.flag || enabled(t.flag, f)));
  return out;
}

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const log = (...a) => process.stderr.write('[strucmed-mcp] ' + a.join(' ') + '\n');

async function callTool(name, args) {
  const tool = byName.get(name);
  if (!tool) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'E_NOT_FOUND', message: `未知的 tool：${name}` } }) }], isError: true };
  try {
    if (onlineNames.has(name) || llmgwNames.has(name) || fmapiNames.has(name)) await site.ready();
    if (onlineNames.has(name)) {
      online.baseUrl();
      const f = loadFlags();
      if (!enabled('online', f)) throw new ToolError(E.FEATURE_DISABLED, 'feature flag online 已關閉（feature-flags.json）');
      if (tool.flag && !enabled(tool.flag, f)) throw new ToolError(E.FEATURE_DISABLED, `feature flag ${tool.flag} 未開啟（feature-flags.json）`);
    }
    if (fmapiNames.has(name)) {
      fmapi.baseUrl();
      if (!enabled('fmapi', loadFlags())) throw new ToolError(E.FEATURE_DISABLED, 'feature flag fmapi 已關閉（feature-flags.json）');
    }
    if (llmgwNames.has(name)) {
      llmgw.baseUrl();
      const f = loadFlags();
      if (!enabled('llmgateway', f)) throw new ToolError(E.FEATURE_DISABLED, 'feature flag llmgateway 已關閉（feature-flags.json）');
      if (tool.flag && !enabled(tool.flag, f)) throw new ToolError(E.FEATURE_DISABLED, `feature flag ${tool.flag} 未開啟（feature-flags.json）`);
    }
    const data = await tool.handler(args || {});
    const warnings = Array.isArray(data && data.warnings) ? data.warnings : [];
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data, warnings }, null, 2) }] };
  } catch (e) {
    const error = e instanceof ToolError
      ? { code: e.code, message: e.message, details: e.details }
      : { code: 'E_INTERNAL', message: String(e && e.message || e) };
    if (!(e instanceof ToolError)) log('internal error in', name, e && e.stack);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error }, null, 2) }], isError: true };
  }
}

const inflight = new Set();   // 線上 tool 與站台偵測是非同步的：stdin 關閉時等它們回完再結束
const track = job => { inflight.add(job); job.finally(() => inflight.delete(job)); };

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      // 先等站台偵測（最多約 3 秒），instructions 與 tools/list 才反映院內／院外
      return isRequest && track(site.ready().then(() => send({ jsonrpc: '2.0', id, result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO, instructions: INSTRUCTIONS + (online.configured() ? ONLINE_INSTRUCTIONS : '') + (llmgw.configured() ? LLMGW_INSTRUCTIONS : '') } })));
    case 'ping':
      return isRequest && send({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return isRequest && track(site.ready().then(() => send({ jsonrpc: '2.0', id, result: {
        tools: listed().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })));
    case 'tools/call':
      if (!isRequest) return;
      return track(callTool(params && params.name, params && params.arguments).then(result => send({ jsonrpc: '2.0', id, result })));
    default:
      if (method && method.startsWith('notifications/')) return;   // no response to notifications
      if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  (Array.isArray(msg) ? msg : [msg]).forEach(handle);
});
rl.on('close', () => Promise.allSettled([...inflight]).then(() => online.shutdown()).then(() => process.exit(0)));   // 結束前作廢 refresh token
site.ready().then(() => log(`v${VERSION} ready (workspace: ${workspaceRoot()}; site: ${site.describe().label}; online: ${online.configured() ? 'on' : 'off'}; llmgateway: ${llmgw.configured() ? 'on' : 'off'}; fmapi: ${fmapi.configured() ? 'on' : 'off'})`));
