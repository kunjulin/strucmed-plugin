#!/usr/bin/env node
// Antigravity 版閘門 G3（PreToolUse，matcher call_mcp_tool）：檢查同 ../gate-check.js，只有輸入與輸出格式不同。
//   輸入（stdin，camelCase）：{ toolCall: { name: "call_mcp_tool", args: { ServerName, ToolName, Arguments } }, workspacePaths, ... }
//   輸出（stdout）：{"decision":"deny","reason":…} 阻擋；其餘回 {"decision":"ask"}，照 Antigravity 原本的核准流程（不額外放行）。
// hook 的 cwd 是 hooks.json 所在目錄，IDE 未開資料夾時 workspacePaths 是空的，所以計畫檔所在的工作目錄依序取：
//   STRUCMED_WORKSPACE 環境變數 → cwd 下的 mcp_config.json → ~/.gemini/config/mcp_config.json 裡 strucmed 伺服器的 STRUCMED_WORKSPACE。
// 無法確認核准時（含讀不到輸入、找不到工作目錄、hook 自身錯誤）一律阻擋。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GATED, checkGate } = require('../gate-check.js');

const unset = v => { const s = String(v || '').trim(); return !s || s.startsWith('${'); };

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
  return null;
}

function decide(raw) {
  const input = JSON.parse(raw || '{}');
  const call = input.toolCall || {};
  if (call.name !== 'call_mcp_tool') return { decision: 'ask' };
  const a = call.args || {};
  const tool = String(a.ToolName || '');
  if (!GATED.test(tool)) return { decision: 'ask' };
  const args = typeof a.Arguments === 'string' ? JSON.parse(a.Arguments || '{}') : (a.Arguments || {});
  if (!args.confirm_token) return { decision: 'ask' };                // 第一段：只取 plan
  const workspace = resolveWorkspace();
  if (!workspace) return { decision: 'deny', reason: 'strucmed 閘門 G3：找不到工作目錄，無法確認核准。請在 mcp_config.json 的 strucmed 伺服器設定 STRUCMED_WORKSPACE。' };
  const r = checkGate({ tool, args, workspace });
  return r.ok ? { decision: 'ask' } : { decision: 'deny', reason: r.reason };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let out;
  try { out = decide(raw); } catch (e) { out = { decision: 'deny', reason: `strucmed 閘門：hook 輸入無法解析或檢查出錯，阻擋（${e.message}）` }; }
  process.stdout.write(JSON.stringify(out));
});
