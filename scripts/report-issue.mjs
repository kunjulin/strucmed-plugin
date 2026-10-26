#!/usr/bin/env node
// report-issue：收集環境與工作紀錄，產生遮蔽後的 issue 草稿（不自動送出）。
//   node scripts/report-issue.mjs --title "<一句話>" [--notes <使用者描述檔或文字>] [--error <錯誤文字檔>] [--workspace <dir>]
// 輸出：<workspace>/output/strucmed-issue-<yyyymmdd-hhmm>.md，並印 JSON。草稿由使用者自行交給維護者，本腳本不送出。
// 遮蔽：Bearer／cgllm_ 金鑰、JWT、身分證字號、7–10 位數字（可能是病歷號）、帳號密碼形式的 env 值；環境變數只列「有／無」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = (o, code = 0) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };
const title = String(opt('--title') || '').trim();
if (!title) out({ ok: false, message: '用法：report-issue.mjs --title "<一句話>" [--notes <檔或文字>] [--error <檔>] [--workspace <dir>]' }, 2);
const ws = path.resolve(opt('--workspace') || process.env.STRUCMED_WORKSPACE || process.cwd());

const redact = s => String(s || '')
  .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [redacted]')
  .replace(/cgllm_[A-Za-z0-9_-]+/g, 'cgllm_[redacted]')
  .replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[jwt-redacted]')
  .replace(/[A-Z][12]\d{8}/g, '[id-redacted]')
  .replace(/\b\d{7,10}\b/g, '[num-redacted]')
  .replace(/(STRUCMED_PASS|STRUCMED_USER|LLMGW_API_KEY|FMAPI_API_KEY)\s*[=:]\s*\S+/g, '$1=[redacted]')
  .replace(/(password|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=[redacted]');
const readArg = v => { if (!v) return ''; const p = path.resolve(v); return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : String(v); };
const tryRead = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const tryJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const plugin = tryJson(path.join(ROOT, '.claude-plugin', 'plugin.json')) || {};
const mcp = tryJson(path.join(ROOT, 'mcp', 'strucmed-mcp', 'package.json')) || {};
const flags = tryJson(process.env.STRUCMED_FLAGS || path.join(ROOT, 'feature-flags.json')) || {};
let gitRev = '';
try { gitRev = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* 非 git（stderr 不印出） */ }
const envPresent = Object.fromEntries(['STRUCMED_ONLINE_BASE_URL', 'STRUCMED_SITE', 'STRUCMED_EXTERNAL_URL', 'LLMGW_BASE_URL', 'LLMGW_API_KEY', 'FMAPI_BASE_URL', 'FMAPI_API_KEY', 'STRUCMED_RUNTIME_WEB', 'STRUCMED_FLAGS'].map(k => [k, !!String(process.env[k] || '').trim()]));
const log = tryRead(path.join(ws, '.strucmed', 'workflow-log.md')).trim().split(/\r?\n/).filter(Boolean).slice(-40).map(redact).join('\n');
const plans = fs.existsSync(path.join(ws, '.strucmed', 'plans')) ? fs.readdirSync(path.join(ws, '.strucmed', 'plans')) : [];
const drafts = fs.existsSync(path.join(ws, '.strucmed', 'drafts')) ? fs.readdirSync(path.join(ws, '.strucmed', 'drafts')).filter(f => f.endsWith('.json')).length : 0;
const notes = redact(readArg(opt('--notes'))).slice(0, 4000);
const error = redact(readArg(opt('--error'))).slice(0, 6000);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/T(\d{4})\d{2}\.\d+Z$/, '-$1');
const outDir = path.join(ws, 'output');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `strucmed-issue-${stamp}.md`);
const body = `## 問題
${notes || '（請補充：做了什麼、預期與實際結果）'}

## 錯誤訊息（已遮蔽）
\`\`\`
${error || '（無）'}
\`\`\`

## 環境
| 項目 | 值 |
|---|---|
| plugin | ${plugin.name || 'strucmed'} ${plugin.version || '?'}${gitRev ? `（${gitRev}）` : ''} |
| MCP | strucmed-mcp ${mcp.version || '?'} |
| Node | ${process.versions.node}（${process.platform} ${process.arch}） |
| feature flags | ${Object.entries(flags).filter(([k]) => !k.startsWith('//')).map(([k, v]) => `${k}=${v}`).join('、')} |
| 環境變數（只列有無） | ${Object.entries(envPresent).map(([k, v]) => `${k}:${v ? '有' : '無'}`).join('、')} |
| 工作目錄 | ${drafts} 個 draft、${plans.length} 個計畫目錄 |

## workflow-log（最近 40 行，已遮蔽）
\`\`\`
${log || '（無）'}
\`\`\`

> 由 strucmed plugin 的 report-issue 產生；已遮蔽金鑰、token、身分證字號與 7–10 位數字。
> 姓名、病歷內容與臨床描述**不會**自動遮蔽。交出前請自己逐行檢查，刪掉任何病人資料。
`;
fs.writeFileSync(file, `# ${redact(title)}\n\n${body}`);
out({ ok: true, file, title: redact(title), redacted: true,
  next: [`請使用者檢視 ${file}：姓名、病歷內容與臨床描述不會自動遮蔽，請逐行檢查`, '檢查後由使用者經院內管道（例如公務信箱）把草稿交給維護者；不要貼到公開 issue'] });
