#!/usr/bin/env node
// PostToolUse（online_login）：伺服器回「帳號或密碼錯誤」時（MCP 的 error.details.reconfigure），
// 直接向使用者顯示重新設定的提示（systemMessage），並提醒 Claude 不要重試、不要在對話索取密碼。
// 不讀、不記任何帳密；永遠 exit 0。
'use strict';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const texts = responseTexts(input);
    let action = '';
    for (const t of texts) {
      try {
        const j = JSON.parse(t);
        if (j && j.error && j.error.details && j.error.details.reconfigure) action = String(j.error.details.action || '/plugin configure strucmed@strucmed-marketplace');
      } catch { /* 非 JSON */ }
    }
    if (action) {
      process.stdout.write(JSON.stringify({
        systemMessage: `strucmed：院內 HIS 密碼錯誤（每三個月變更一次，可能已更換）。請執行 ${action} 更新「院內 HIS 密碼」，再執行 /reload-plugins。`,
        hookSpecificOutput: { hookEventName: 'PostToolUse',
          additionalContext: `HIS 帳密被拒：請使用者執行 ${action} 更新密碼後 /reload-plugins，再重新執行 connect-strucmed。不要再呼叫 online_login 重試（避免帳號鎖定），也不要請使用者在對話中提供密碼。` }
      }));
    }
  } catch (e) {
    process.stderr.write(`strucmed auth-reminder：${e.message}\n`);
  }
  process.exit(0);
});

// tool 回應的文字：Claude Code 是 tool_response（content 陣列或 { content }），Copilot CLI 是 tool_result.text_result_for_llm
function responseTexts(input) {
  const out = [];
  const resp = input.tool_response;
  if (Array.isArray(resp)) { for (const c of resp) if (c && typeof c.text === 'string') out.push(c.text); }
  else if (resp && Array.isArray(resp.content)) { for (const c of resp.content) if (c && typeof c.text === 'string') out.push(c.text); }
  else if (typeof resp === 'string') out.push(resp);
  const r = input.tool_result;
  if (r && typeof r.text_result_for_llm === 'string') out.push(r.text_result_for_llm);
  return out;
}
