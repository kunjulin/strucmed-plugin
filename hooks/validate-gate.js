#!/usr/bin/env node
// PreToolUse：線上寫入 tool 的第二段呼叫（帶 confirm_token）前，檢查閘門 G3 的核准 sidecar（references/Gates.md）。
//   計畫檔：<cwd>/.strucmed/plans/<draft_id>/publish-plan.md
//   sidecar：<cwd>/.strucmed/plans/<draft_id>/.approved-publish-plan.md（scripts/verify-plan.mjs prepare 產生）
// 第一段呼叫（沒有 confirm_token）只取得 plan，不寫入，直接放行。
// exit 0＝放行；exit 2＝阻擋（stderr 是原因）。無法確認核准時（含 hook 自身錯誤）一律阻擋：寫入線上必須確定已核准。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch (e) { process.stderr.write(`strucmed 閘門：讀不到 hook 輸入，阻擋（${e.message}）\n`); return process.exit(2); }
  const tool = String(input.tool_name || '');
  const args = input.tool_input || {};
  if (!args.confirm_token) return process.exit(0);                 // 第一段：只取 plan
  const draftId = String(args.draft_id || '');
  if (!/^d-[0-9a-f]{12}$/.test(draftId)) { process.stderr.write(`strucmed 閘門：${tool} 缺少 draft_id，無法確認核准\n`); return process.exit(2); }
  const cwd = String(input.cwd || process.cwd());
  const dir = path.join(cwd, '.strucmed', 'plans', draftId);
  const plan = path.join(dir, 'publish-plan.md');
  const sidecar = path.join(dir, '.approved-publish-plan.md');
  if (!fs.existsSync(plan)) { process.stderr.write(`strucmed 閘門 G3：找不到上架計畫 ${plan}。請先用 publish-form 取得 plan、寫入計畫檔並取得使用者核准。\n`); return process.exit(2); }
  if (!fs.existsSync(sidecar)) { process.stderr.write(`strucmed 閘門 G3：上架計畫尚未核准（沒有 ${sidecar}）。請把「## 上架計畫」給使用者確認，核准後執行 scripts/verify-plan.mjs prepare。\n`); return process.exit(2); }
  try {
    const text = fs.readFileSync(plan, 'utf8');
    // 與 scripts/verify-plan.mjs 相同：排除「### 建置對照表」段
    const canonical = String(text).replace(/\r\n/g, '\n').replace(/\n### 建置對照表[^\n]*\n[\s\S]*?(?=\n##? |\n### |$)/, '\n');
    const sha = crypto.createHash('sha256').update(canonical).digest('hex');
    const s = {};
    for (const line of fs.readFileSync(sidecar, 'utf8').split(/\r?\n/)) { const m = line.match(/^([a-z0-9_]+):\s*(.*)$/); if (m) s[m[1]] = m[2].trim(); }
    const rev = (text.match(/^Revision:\s*(\d+)\s*$/m) || [])[1];
    if (s.sha256 !== sha || String(s.revision) !== String(rev)) {
      process.stderr.write(`strucmed 閘門 G3：上架計畫在核准後被修改（核准 rev ${s.revision}，目前 rev ${rev}）。核准失效，請重新呈現計畫並核准。\n`);
      return process.exit(2);
    }
    if (!/^Status:\s*Approved\s*$/m.test(text.split(/^## 核准/m)[1] || '')) {
      process.stderr.write('strucmed 閘門 G3：計畫檔的「## 核准」段不是 Approved。\n');
      return process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`strucmed 閘門 G3：檢查時發生錯誤，無法確認核准，阻擋（${e.message}）。請重新產生計畫並核准。\n`);
    return process.exit(2);
  }
  process.exit(0);
});
