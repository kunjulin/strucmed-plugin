#!/usr/bin/env node
// B2 app 建置輸出的靜態檢查：dist/ 內不得含金鑰、token、密碼、身分證字號樣式；index.html 必須存在；只輸出 JSON。
//   node scripts/check-app-dist.mjs <dist>
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'dist');
const out = (o, code = 0) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };
if (!fs.existsSync(path.join(dir, 'index.html'))) out({ ok: false, message: `找不到 ${path.join(dir, 'index.html')}（請先 npm run build）` }, 1);

const PATTERNS = [
  ['llmgateway_key', /cgllm_[A-Za-z0-9_-]{8,}/],
  ['bearer', /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  ['password_literal', /(STRUCMED_PASS|LLMGW_API_KEY|FMAPI_API_KEY)\s*[=:]\s*["']?[^"'\s]{4,}/],
  ['tw_id', /[A-Z][12]\d{8}/],
  ['placeholder', /__APP_NAME__|__UPSTREAM__|__PORT__|__APP_SLUG__/]
];
const findings = [];
let files = 0, bytes = 0;
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }
for (const f of walk(dir)) {
  files++;
  const st = fs.statSync(f); bytes += st.size;
  if (!/\.(js|html|css|json|txt|webmanifest|map)$/.test(f)) continue;
  const t = fs.readFileSync(f, 'utf8');
  for (const [id, re] of PATTERNS) { const m = re.exec(t); if (m) findings.push({ file: path.relative(dir, f).split(path.sep).join('/'), pattern: id, sample: m[0].slice(0, 12) + '…' }); }
  if (f.endsWith('.map')) findings.push({ file: path.relative(dir, f), pattern: 'sourcemap', sample: 'sourcemap 不應隨 dist 發佈' });
}
out({ ok: findings.length === 0, dir, files, bytes, findings }, findings.length ? 1 : 0);
