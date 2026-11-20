#!/usr/bin/env node
// Antigravity 版閘門 G2 定稿（PreToolUse，matcher call_mcp_tool）：檢查同 ../gate-check.js，只有輸入與輸出格式不同。
//   輸入（stdin，camelCase）：{ toolCall: { name: "call_mcp_tool", args: { ServerName, ToolName, Arguments } }, workspacePaths, ... }
//   輸出（stdout）：{"decision":"deny","reason":…} 阻擋；其餘回 {"decision":"ask"}，照 Antigravity 原本的核准流程（不額外放行）。
// hook 的 cwd 是 hooks.json 所在目錄，IDE 未開資料夾時 workspacePaths 是空的，所以計畫檔所在的工作目錄依序取：
//   STRUCMED_WORKSPACE 環境變數 → cwd 下的 mcp_config.json → ~/.gemini/config/mcp_config.json 裡 strucmed 伺服器的 STRUCMED_WORKSPACE
//   → MCP 的預設 ~/Documents/StrucMed（以 plugin 安裝時 MCP 沒有設定 STRUCMED_WORKSPACE，用的就是這裡；資料夾存在才採用）。
// Antigravity 不載入 publish-form skill，通常沒有 G2 定稿檔：沒有計畫檔（或找不到工作目錄）時回 ask，把關交給
//   (a) MCP 的瀏覽器寫入確認頁（flag browserApprove 開著時，預設），以及
//   (b) Antigravity 自己的「要不要允許這次 tool 呼叫」提示——flag browserApprove 關閉時只剩這一道，
//       所以 reason 會寫明；該提示也設成自動允許時，就沒有任何人在 AI 之外看過 plan（references/SecurityInvariants.md 第 2 條）。
// 有計畫檔但未核准、核准後被改過、或檢查出錯，仍然阻擋。讀不到輸入也阻擋。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GATED, checkGate } = require('../gate-check.js');

const unset = v => { const s = String(v || '').trim(); return !s || s.startsWith('${'); };

// feature flag browserApprove（與 mcp/strucmed-mcp/src/flags.mjs 同一份檔案；讀不到就當預設 true）
function browserApprove() {
  const f = unset(process.env.STRUCMED_FLAGS) ? path.resolve(__dirname, '..', '..', 'feature-flags.json') : path.resolve(process.env.STRUCMED_FLAGS.trim());
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).browserApprove !== false; } catch { return true; }
}

function workspaceFromConfig(file) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  for (const [name, s] of Object.entries((cfg && cfg.mcpServers) || {})) {
    const isStrucmed = name === 'strucmed' || (Array.isArray(s && s.args) && s.args.some(a => /strucmed-mcp[\\/]src[\\/]server\.mjs$/.test(String(a))));
    const w = s && s.env && s.env.STRUCMED_WORKSPACE;
    if (isStrucmed && !unset(w)) return path.resolve(String(w).trim().replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return null;
}

function resolveWorkspace() {
  if (!unset(process.env.STRUCMED_WORKSPACE)) return path.resolve(process.env.STRUCMED_WORKSPACE.trim());
  for (const f of [path.join(process.cwd(), 'mcp_config.json'), path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')]) {
    const w = workspaceFromConfig(f);
    if (w) return w;
  }
  const docs = path.join(os.homedir(), 'Documents');
  const def = path.join(fs.existsSync(docs) ? docs : os.homedir(), 'StrucMed');
  return fs.existsSync(def) ? def : null;
}

function decide(raw) {
  if (!String(raw || '').trim()) throw new Error('沒有收到輸入');   // 前一個 node 失敗後重跑時 stdin 已被讀走：阻擋，不放行
  const input = JSON.parse(raw);
  const call = input.toolCall || {};
  if (call.name !== 'call_mcp_tool') return { decision: 'ask' };
  const a = call.args || {};
  const tool = String(a.ToolName || '');
  if (!GATED.test(tool)) return { decision: 'ask' };
  const args = typeof a.Arguments === 'string' ? JSON.parse(a.Arguments || '{}') : (a.Arguments || {});
  if (!args.confirm_token) return { decision: 'ask' };                // 第一段：只取 plan
  const browser = { decision: 'ask', reason: browserApprove()
    ? 'strucmed：沒有 G2 定稿檔，寫入要由使用者在 MCP 開啟的瀏覽器確認頁按「確認寫入」'
    : 'strucmed：沒有 G2 定稿檔，且 feature flag browserApprove 已關閉（不會開瀏覽器確認頁）。這個允許提示是唯一在 AI 之外的把關，請自己核對要寫入什麼；自動允許的話就沒有人看過這份 plan' };
  const workspace = resolveWorkspace();
  if (!workspace) return browser;
  const r = checkGate({ tool, args, workspace });
  if (r.ok) return { decision: 'ask' };
  return r.code === 'no_plan' ? browser : { decision: 'deny', reason: r.reason };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let out;
  try { out = decide(raw); } catch (e) { out = { decision: 'deny', reason: `strucmed 閘門：hook 輸入無法解析或檢查出錯，阻擋（${e.message}）` }; }
  process.stdout.write(JSON.stringify(out));
});
