#!/usr/bin/env node
// PostToolUse（online_login）：瀏覽器登入還沒完成時（MCP 回 data.pending），直接向使用者顯示登入頁的提示（systemMessage），
// 並提醒 Claude 等使用者完成後再呼叫一次、不要在對話索取密碼。不讀、不記任何帳密或 token；永遠 exit 0。
'use strict';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    let pending = null;
    for (const t of responseTexts(input)) {
      try {
        const j = JSON.parse(t);
        if (j && j.ok && j.data && j.data.pending && typeof j.data.authorize_url === 'string') pending = j.data;
      } catch { /* 非 JSON */ }
    }
    if (pending) {
      let host = '';
      try { host = new URL(pending.authorize_url).host; } catch { /* 格式不對就不顯示 */ }
      const open = pending.browser_opened === false ? `瀏覽器沒有自動開啟，請開啟 ${pending.authorize_url} 。` : '已在瀏覽器開啟登入頁。';
      process.stdout.write(JSON.stringify({
        systemMessage: `strucmed：${open}請確認網址是 strucmed 站台${host ? `（${host}）` : ''}後輸入 HIS 帳號密碼，按「登入並同意」，再回到這裡。`,
        hookSpecificOutput: { hookEventName: 'PostToolUse',
          additionalContext: '瀏覽器登入進行中：等使用者說完成後再呼叫一次 online_login（會接著等同一個登入）。不要請使用者在對話中提供密碼。' }
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
