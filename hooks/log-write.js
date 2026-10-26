#!/usr/bin/env node
// PostToolUse：線上寫入 tool 執行後，把結果追加到 <cwd>/.strucmed/workflow-log.md。
// 只記 tool 名稱、draft_id、template_id、是否成功、錯誤碼、rev；不記 token、本文、病歷號、帳密。
// 設定 STRUCMED_NO_LOG=1 可關閉。永遠 exit 0。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  try {
    if (process.env.STRUCMED_NO_LOG) return;
    const input = JSON.parse(raw || '{}');
    const tool = String(input.tool_name || '').replace(/^mcp__[^_]+(_[^_]+)*?__/, '').replace(/^mcp__plugin_strucmed_strucmed__/, '').replace(/^strucmed[-_]/, '');
    const args = input.tool_input || {};
    const stage = args.confirm_token ? 'execute' : 'plan';
    let ok = null, code = '', rev = '', templateId = String(args.template_id || '');
    const texts = responseTexts(input);
    for (const t of texts) {
      try {
        const j = JSON.parse(t);
        if (typeof j.ok === 'boolean') ok = j.ok;
        if (j.error && j.error.code) code = String(j.error.code);
        const d = j.data || {};
        if (d.template_id) templateId = String(d.template_id);
        if (d.rev !== undefined) rev = String(d.rev);
      } catch { /* 非 JSON */ }
    }
    const cwd = String(input.cwd || process.cwd());
    const dir = path.join(cwd, '.strucmed');
    fs.mkdirSync(dir, { recursive: true });
    const line = `- ${new Date().toISOString()} ${tool} stage=${stage}` +
      (args.draft_id ? ` draft=${args.draft_id}` : '') + (templateId ? ` template=${templateId}` : '') +
      (args.name ? ` dict=${String(args.name).slice(0, 40)}` : '') + (args.dic_id ? ` dic_id=${String(args.dic_id).slice(0, 64)}` : '') + (args.folder_type ? ` folder=${args.folder_type}` : '') +
      ` ok=${ok === null ? '?' : ok}` + (code ? ` code=${code}` : '') + (rev ? ` rev=${rev}` : '') + '\n';
    fs.appendFileSync(path.join(dir, 'workflow-log.md'), line);
  } catch (e) {
    process.stderr.write(`strucmed log-write：${e.message}\n`);
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
