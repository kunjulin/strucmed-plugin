// 閘門 G3 的核准檢查（validate-gate.js 與 antigravity/validate-gate.js 共用；references/Gates.md）。
//   計畫檔：<workspace>/.strucmed/plans/<draft_id>/publish-plan.md
//   sidecar：<workspace>/.strucmed/plans/<draft_id>/.approved-publish-plan.md（scripts/verify-plan.mjs prepare 產生）
// 回傳 { ok: true } 或 { ok: false, code, reason }（code：no_draft／no_plan／not_approved／changed／error）。第一段呼叫（沒有 confirm_token）只取得 plan，不寫入，直接放行；
// 無法確認核准時（含檢查本身出錯）一律 ok: false：寫入線上必須確定已核准。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GATED = /online_(template_create|template_update|dictionary_create|dictionary_batch)$/;

function checkGate({ tool, args, workspace }) {
  if (!args || !args.confirm_token) return { ok: true };            // 第一段：只取 plan
  const draftId = String(args.draft_id || '');
  if (!/^d-[0-9a-f]{12}$/.test(draftId)) return { ok: false, code: 'no_draft', reason: `strucmed 閘門：${tool} 缺少 draft_id，無法確認核准` };
  const dir = path.join(String(workspace), '.strucmed', 'plans', draftId);
  const plan = path.join(dir, 'publish-plan.md');
  const sidecar = path.join(dir, '.approved-publish-plan.md');
  if (!fs.existsSync(plan)) return { ok: false, code: 'no_plan', reason: `strucmed 閘門 G3：找不到上架計畫 ${plan}。請先用 publish-form 取得 plan、寫入計畫檔並取得使用者核准。` };
  if (!fs.existsSync(sidecar)) return { ok: false, code: 'not_approved', reason: `strucmed 閘門 G3：上架計畫尚未核准（沒有 ${sidecar}）。請把「## 上架計畫」給使用者確認，核准後執行 scripts/verify-plan.mjs prepare。` };
  try {
    const text = fs.readFileSync(plan, 'utf8');
    // 與 scripts/verify-plan.mjs 相同：排除「### 建置對照表」段
    const canonical = String(text).replace(/\r\n/g, '\n').replace(/\n### 建置對照表[^\n]*\n[\s\S]*?(?=\n##? |\n### |$)/, '\n');
    const sha = crypto.createHash('sha256').update(canonical).digest('hex');
    const s = {};
    for (const line of fs.readFileSync(sidecar, 'utf8').split(/\r?\n/)) { const m = line.match(/^([a-z0-9_]+):\s*(.*)$/); if (m) s[m[1]] = m[2].trim(); }
    const rev = (text.match(/^Revision:\s*(\d+)\s*$/m) || [])[1];
    if (s.sha256 !== sha || String(s.revision) !== String(rev)) {
      return { ok: false, code: 'changed', reason: `strucmed 閘門 G3：上架計畫在核准後被修改（核准 rev ${s.revision}，目前 rev ${rev}）。核准失效，請重新呈現計畫並核准。` };
    }
    if (!/^Status:\s*Approved\s*$/m.test(text.split(/^## 核准/m)[1] || '')) {
      return { ok: false, code: 'not_approved', reason: 'strucmed 閘門 G3：計畫檔的「## 核准」段不是 Approved。' };
    }
  } catch (e) {
    return { ok: false, code: 'error', reason: `strucmed 閘門 G3：檢查時發生錯誤，無法確認核准，阻擋（${e.message}）。請重新產生計畫並核准。` };
  }
  return { ok: true };
}

module.exports = { GATED, checkGate };
