#!/usr/bin/env node
// B2 表單 APP 產生器：從 templates/form-app/ 產生一個可建置的 app 目錄。
//   node scripts/scaffold-form-app.mjs --config <config.json> --out <dir> [--force]
// config.json：
//   { "appName": "跌倒評估 APP", "shortName": "跌倒評估", "version": "1.0.0", "slug": "fall-app",
//     "hosting": "H0" | "H2", "siteUrl": "https://<站台>"（H0 必填，nginx 代理目標；https）, "port": 8080（H0）,
//     "siteBase": "/strucmed", "templates": [{ "id": "<templateID>", "name": "跌倒評估" }], "allowUserList": true,
//     "errorlog": { "enabled": true, "base": "/FM" }, "idleTimeoutMs": 1800000 }
// 只輸出 JSON；不寫任何 token、密碼；不執行 npm。exit 0＝ok，1＝設定錯誤，2＝用法錯誤。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(HERE, '..', 'templates', 'form-app');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = (o, code = 0) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };
const configPath = opt('--config'), outDir = opt('--out');
if (!configPath || !outDir) out({ ok: false, message: '用法：scaffold-form-app.mjs --config <config.json> --out <dir> [--force]' }, 2);

let cfg;
try { cfg = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8')); } catch (e) { out({ ok: false, message: `config 無法讀取：${e.message}` }, 1); }
const errors = [];
const str = (v, name, re, max = 100) => { if (typeof v !== 'string' || !v.trim()) errors.push(`${name} 必填`); else if (v.length > max) errors.push(`${name} 超過 ${max} 字`); else if (re && !re.test(v)) errors.push(`${name} 格式不正確`); };
str(cfg.appName, 'appName', null, 60);
const slug = String(cfg.slug || '').trim() || String(cfg.appName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'form-app';
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) errors.push('slug 只能是小寫英數與 -（最多 40 字）');
const version = String(cfg.version || '1.0.0');
if (!/^\d+\.\d+\.\d+([-.][A-Za-z0-9]+)*$/.test(version)) errors.push('version 需是 x.y.z');
const hosting = cfg.hosting === 'H2' ? 'H2' : 'H0';
let upstream = '';
if (hosting === 'H0') {
  try {
    const u = new URL(String(cfg.siteUrl || ''));
    if (u.protocol !== 'https:') errors.push('siteUrl 必須是 https');
    if (u.username || u.password || u.search || u.hash) errors.push('siteUrl 不可含帳密、查詢字串或 #');
    if (u.pathname !== '/' && u.pathname !== '') errors.push('siteUrl 只放根網址（不含 /strucmed 等路徑）');
    upstream = u.origin;
  } catch { errors.push('H0 需要 siteUrl（院內站台 https 根網址）'); }
}
const port = Number(cfg.port || 8080);
if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.push('port 需在 1024–65535');
const templates = Array.isArray(cfg.templates) ? cfg.templates : [];
templates.forEach((t, i) => { if (!t || !/^[A-Za-z0-9-]{1,64}$/.test(String(t.id || ''))) errors.push(`templates[${i}].id 格式不正確`); if (!t || typeof t.name !== 'string' || !t.name.trim()) errors.push(`templates[${i}].name 必填`); });
const SECRET = /(cgllm_[A-Za-z0-9]+|Bearer\s+\S+|password\s*[:=]|[A-Z][12]\d{8})/i;
if (SECRET.test(JSON.stringify(cfg))) errors.push('config 內疑似含金鑰、密碼或身分證字號，拒絕產生');
if (errors.length) out({ ok: false, errors }, 1);

const dest = path.resolve(outDir);
const force = args.includes('--force');
if (fs.existsSync(dest) && fs.readdirSync(dest).length && !force) out({ ok: false, message: `輸出目錄已存在且不是空的：${dest}（加 --force 覆寫）` }, 1);
if (!fs.existsSync(TEMPLATE)) out({ ok: false, message: `找不到範本 ${TEMPLATE}` }, 1);

const appConfig = {
  appName: cfg.appName, shortName: String(cfg.shortName || cfg.appName).slice(0, 12), version, hosting,
  siteBase: hosting === 'H0' ? String(cfg.siteBase || '/strucmed') : '',
  templates: templates.map(t => ({ id: String(t.id), name: String(t.name) })),
  allowUserList: cfg.allowUserList !== false,
  errorlog: { enabled: !(cfg.errorlog && cfg.errorlog.enabled === false), base: String((cfg.errorlog && cfg.errorlog.base) || '/FM') },
  idleTimeoutMs: Number.isFinite(cfg.idleTimeoutMs) ? cfg.idleTimeoutMs : 1_800_000
};
const subst = { '__APP_NAME__': appConfig.appName, '__APP_SHORT__': appConfig.shortName, '__APP_VERSION__': version, '__APP_SLUG__': slug, '__UPSTREAM__': upstream, '__PORT__': String(port) };
const TEXT = /\.(ts|tsx|css|json|html|md|js|yaml|yml|conf|inc)$|^(Dockerfile|\.gitignore|\.dockerignore)$/;
const files = [];
function copy(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'dev-dist') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copy(s, d); continue; }
    if (TEXT.test(e.name)) {
      let t = fs.readFileSync(s, 'utf8');
      for (const [k, v] of Object.entries(subst)) t = t.split(k).join(v);
      fs.writeFileSync(d, t);
    } else fs.copyFileSync(s, d);
    files.push(path.relative(dest, d).split(path.sep).join('/'));
  }
}
fs.mkdirSync(dest, { recursive: true });
copy(TEMPLATE, dest);
fs.writeFileSync(path.join(dest, 'app.config.json'), JSON.stringify(appConfig, null, 2) + '\n');
if (hosting !== 'H0') for (const f of ['Dockerfile', 'nginx.conf', 'proxy-common.inc', 'compose.yaml', '.dockerignore']) { try { fs.rmSync(path.join(dest, f)); } catch { /* 無 */ } }
const left = files.filter(f => TEXT.test(path.basename(f))).filter(f => /__APP_|__UPSTREAM__|__PORT__/.test(fs.readFileSync(path.join(dest, f), 'utf8')));
out({ ok: left.length === 0, out: dest, slug, hosting, upstream: upstream || null, port: hosting === 'H0' ? port : null, files: files.length, app_config: appConfig,
  unresolved_placeholders: left,
  next: hosting === 'H0'
    ? [`cd "${dest}"`, 'npm ci', 'npm run build', `node "${path.join(HERE, 'check-app-dist.mjs')}" dist`, 'docker compose build && docker compose up -d', `開啟 http://localhost:${port}/`]
    : [`cd "${dest}"`, 'npm ci', 'npm run build', `node "${path.join(HERE, 'check-app-dist.mjs')}" dist`, `把 dist/ 複製到站台 web/apps/${slug}/（需平台管理者設定靜態路由）`] }, left.length ? 1 : 0);
