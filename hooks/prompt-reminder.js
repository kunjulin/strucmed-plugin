#!/usr/bin/env node
// UserPromptSubmit：使用者的訊息提到病人資料、帳密金鑰、直連倉儲、上架或刪除時，注入一段簡短提醒（stdout＝additionalContext）。
// 只提醒、永不阻擋（永遠 exit 0）；不提醒時不輸出。比照 power-platform-skills 的 inject-sync-reminder：hook 不代替模型做事。
'use strict';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let prompt = '';
  try { prompt = String(JSON.parse(raw || '{}').prompt || ''); } catch { /* 非 JSON */ }
  if (!prompt) return process.exit(0);
  const notes = [];
  if (/病歷號|病人|患者|身分證|chtno|records_query|records_save/i.test(prompt))
    notes.push('病人資料：只在使用者明確要求查某位病人時用 online_records_query（必帶病歷號）；查詢結果只留在對話，不寫進檔案、計畫或範本預設值；存病人紀錄兩段式確認。');
  if (/密碼|帳密|帳號密碼|token|api[ _-]?key|金鑰|secret/i.test(prompt))
    notes.push('帳密與金鑰：由使用者在 /plugin configure strucmed@strucmed-marketplace 填寫（密碼與 token 存安全儲存區），MCP 只從環境變數讀；不要在對話中索取或複誦，不寫進任何檔案；填完後 /reload-plugins。');
  if (/倉儲|直連/i.test(prompt))
    notes.push('不直連倉儲：plugin 只走 strucmed API v2、LlmGateway、FMapi。');
  if (/上架|發佈|發布|publish|更新線上|online_template_(create|update)/i.test(prompt))
    notes.push('上架：載入 publish-form；第一次呼叫只取 plan，寫 .strucmed/plans/<draft_id>/publish-plan.md，閘門 G3 核准並 verify-plan.mjs prepare 後才帶 confirm_token；hooks 會阻擋未核准的第二段呼叫。');
  if (/刪除|覆寫|trash|delete|還原字典/i.test(prompt))
    notes.push('刪除與覆寫：沒有也不提供刪除線上範本、字典或紀錄的 tool；更新範本只限以該範本 import 改版的 draft（If-Match）。');
  if (/模型|LLM|llmquery|llmvision|gemma|qwen|llama|閘道|gateway/i.test(prompt))
    notes.push('模型名稱不得憑記憶：以 llmgateway_models 的白名單快取為準（references/ModelWhitelist.md）；沒有快取時以靜態表檢查並標 W_LLM_WHITELIST_STALE。');
  if (!notes.length) return process.exit(0);
  process.stdout.write('【strucmed plugin 提醒（references/SecurityInvariants.md）】\n- ' + notes.join('\n- ') + '\n');
  process.exit(0);
});
