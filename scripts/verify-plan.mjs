#!/usr/bin/env node
// 閘門核准的來源保護：計畫檔核准後產生 sidecar，建置前比對計畫檔是否仍是核准的那份。
//   node scripts/verify-plan.mjs prepare <plan.md> [--by <user>]   核准時：把計畫檔的「## 核准」段填成 Approved（含時間、核准者），再寫 .approved-<basename>（sha256、revision、時間、核准者）
//   node scripts/verify-plan.mjs verify  <plan.md>                 建置前：比對 sha256 與 Revision；不符＝核准失效
//   node scripts/verify-plan.mjs status  <plan.md>                 只讀狀態
// 輸出一律 JSON；exit 0＝ok，1＝未核准或不符，2＝用法錯誤。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [cmd, planArg, ...rest] = process.argv.slice(2);
const out = (o, code = 0) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };
if (!['prepare', 'verify', 'status'].includes(cmd) || !planArg) out({ ok: false, message: '用法：verify-plan.mjs prepare|verify|status <plan.md> [--by <user>]' }, 2);

const plan = path.resolve(planArg);
if (!fs.existsSync(plan)) out({ ok: false, message: `找不到計畫檔：${plan}` }, 2);
const sidecar = path.join(path.dirname(plan), `.approved-${path.basename(plan)}`);
const text = fs.readFileSync(plan, 'utf8');
// 核准雜湊排除「### 建置對照表」段（builder 建置後回填 itemid，不算修改計畫；references/Gates.md §2）
export function canonical(t) {
  return String(t).replace(/\r\n/g, '\n').replace(/\n### 建置對照表[^\n]*\n[\s\S]*?(?=\n##? |\n### |$)/, '\n');
}
// 「## 核准」段由 prepare 填（3.9.2）：Approved-At 是執行當下的時間，skill 不必、也不要手寫（手寫的時間常與實際核准不符）。
// 段內其他行保留；沒有這一段時加在檔尾
export function stamp(t, fields) {
  const lines = String(t).replace(/\r\n/g, '\n').split('\n');
  const want = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  const at = lines.findIndex(l => /^## 核准\s*$/.test(l));
  if (at < 0) return `${lines.join('\n').replace(/\n*$/, '\n')}\n## 核准\n${want.join('\n')}\n`;
  let end = lines.findIndex((l, j) => j > at && /^## /.test(l));
  if (end < 0) end = lines.length;
  const keep = lines.slice(at + 1, end).filter(l => !/^(Status|Approved-Revision|Approved-At|Approved-By):/.test(l));
  return [...lines.slice(0, at + 1), ...want, ...keep, ...lines.slice(end)].join('\n');
}
const hash = t => crypto.createHash('sha256').update(canonical(t)).digest('hex');
const sha256 = hash(text);
const revMatch = text.match(/^Revision:\s*(\d+)\s*$/m);
const revision = revMatch ? Number(revMatch[1]) : null;
const statusMatch = text.match(/^Status:\s*(Ready|NeedsRevision|Blocked)\s*$/m);
const readSidecar = () => {
  if (!fs.existsSync(sidecar)) return null;
  const s = {};
  for (const line of fs.readFileSync(sidecar, 'utf8').split(/\r?\n/)) { const m = line.match(/^([a-z0-9_]+):\s*(.*)$/); if (m) s[m[1]] = m[2].trim(); }
  return s;
};

if (cmd === 'prepare') {
  if (revision === null) out({ ok: false, message: '計畫檔缺少「Revision: <n>」行' }, 1);
  if (statusMatch && statusMatch[1] !== 'Ready') out({ ok: false, message: `計畫 Status 是 ${statusMatch[1]}，只有 Ready 可以核准` }, 1);
  const by = rest.includes('--by') ? String(rest[rest.indexOf('--by') + 1] || 'local') : 'local';
  const at = new Date().toISOString();
  const stamped = stamp(text, { Status: 'Approved', 'Approved-Revision': revision, 'Approved-At': at, 'Approved-By': by });
  fs.writeFileSync(plan, stamped);
  const sha = hash(stamped);
  fs.writeFileSync(sidecar, `sha256: ${sha}\nrevision: ${revision}\napproved_at: ${at}\napproved_by: ${by}\nplan: ${path.basename(plan)}\n`);
  out({ ok: true, approved: true, revision, sha256: sha, approved_at: at, approved_by: by, sidecar, note: '「## 核准」段已由 prepare 填成 Approved（時間、核准者）；之後不要再改計畫檔' });
}

const s = readSidecar();
if (!s) out({ ok: false, approved: false, revision, sha256, message: '尚未核准：沒有 sidecar（請先在閘門取得使用者核准，再執行 prepare）' }, cmd === 'verify' ? 1 : 0);
const match = s.sha256 === sha256 && String(s.revision) === String(revision);
const result = { ok: match, approved: match, revision, approved_revision: Number(s.revision), sha256, approved_sha256: s.sha256,
  approved_at: s.approved_at || null, approved_by: s.approved_by || null, sidecar,
  message: match ? '計畫與核准版本一致' : '計畫已在核准後修改：核准失效，請把新版計畫重新交給使用者核准（Revision 需遞增）' };
out(result, cmd === 'verify' && !match ? 1 : 0);
