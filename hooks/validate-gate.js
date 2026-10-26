#!/usr/bin/env node
// PreToolUse（Claude Code、Copilot CLI、Codex）：線上寫入 tool 的第二段呼叫（帶 confirm_token）前，檢查閘門 G3 的核准 sidecar。
// 檢查本身在 gate-check.js（與 Antigravity 版 antigravity/validate-gate.js 共用）；計畫檔在 <cwd>/.strucmed/plans/<draft_id>/。
// exit 0＝放行；exit 2＝阻擋（stderr 是原因）。無法確認核准時（含 hook 自身錯誤）一律阻擋：寫入線上必須確定已核准。
'use strict';
const { checkGate } = require('./gate-check.js');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch (e) { process.stderr.write(`strucmed 閘門：讀不到 hook 輸入，阻擋（${e.message}）\n`); return process.exit(2); }
  const r = checkGate({ tool: String(input.tool_name || ''), args: input.tool_input || {}, workspace: String(input.cwd || process.cwd()) });
  if (r.ok) return process.exit(0);
  process.stderr.write(r.reason + '\n');
  process.exit(2);
});
