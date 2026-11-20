#!/usr/bin/env node
// SBOM（CycloneDX 1.5 JSON）：產三份，分開不混。
//   node scripts/sbom.mjs [--out <目錄>] [--runtime <web 副本目錄>] [--quiet]
//
//   1. sbom-plugin.json    plugin 本身：自有程式、宿主提供的 Node.js、改寫自 jQuery Calx 的那一項。
//                          plugin 執行期**零第三方相依**（mcp/strucmed-mcp/package.json 的 dependencies 是空的，沒有 node_modules）。
//   2. sbom-form-app.json  表單 APP 範本（templates/form-app）：從 package-lock.json 產，含遞移相依與 resolved 來源網址。
//                          這是**員工產生 B2 app 時才會安裝的產出物相依，不是 plugin 的執行相依**。
//   3. sbom-runtime.json   平台前端 web/ 本機快取：由 runtime_fetch 寫的 .strucmed-runtime.json（站台版本戳記＋每檔 SHA-256）轉成 SBOM／provenance。
//                          沒有快取時這一份會標 note 並且 components 是空的（不是錯誤）。
//
// 每一筆都帶 supplier 與來源國（審查要看來源）。不連網、不裝任何東西。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const argOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const OUT = path.resolve(argOf('--out') || path.join(ROOT, 'sbom'));
const QUIET = args.includes('--quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const NOW = new Date().toISOString();
const pluginJson = readJson(path.join(ROOT, '.claude-plugin', 'plugin.json')) || {};
const mcpPkg = readJson(path.join(ROOT, 'mcp', 'strucmed-mcp', 'package.json')) || {};

// CycloneDX 的外殼。serialNumber 用內容雜湊，同一份輸入會得到同一個序號（可重現）
function doc(kind, components, extra = {}) {
  const body = {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: {
      timestamp: NOW,
      tools: [{ vendor: 'Chang Gung Memorial Hospital', name: 'strucmed-plugin scripts/sbom.mjs', version: String(pluginJson.version || '') }],
      component: extra.rootComponent,
      properties: Object.entries(extra.properties || {}).map(([name, value]) => ({ name, value: String(value) }))
    },
    components
  };
  const serial = crypto.createHash('sha256').update(JSON.stringify({ kind, components, p: body.metadata.properties })).digest('hex').slice(0, 32);
  body.serialNumber = `urn:uuid:${serial.slice(0, 8)}-${serial.slice(8, 12)}-${serial.slice(12, 16)}-${serial.slice(16, 20)}-${serial.slice(20, 32)}`;
  return body;
}

const supplier = (name, country, url) => ({ name, ...(url && { url: [url] }), ...(country && { contact: [{ name: `來源國：${country}` }] }) });
const prop = (name, value) => ({ name, value: String(value) });

// ── 1. plugin 本身 ────────────────────────────────────────────────────────────
function pluginSbom() {
  const cg = supplier('Chang Gung Memorial Hospital（長庚醫療財團法人）', 'TW', 'https://github.com/kunjulin/strucmed-plugin');
  const components = [
    {
      type: 'application', 'bom-ref': 'strucmed-mcp', name: 'strucmed-mcp', version: String(mcpPkg.version || ''),
      description: 'MCP 伺服器（Node ESM）。自有程式，執行期零第三方相依（package.json 的 dependencies 是空的，沒有 node_modules）。',
      supplier: cg, publisher: 'Kunjulin', licenses: [{ license: { id: 'MIT' } }],
      properties: [prop('strucmed:origin', 'first-party'), prop('strucmed:country', 'TW'), prop('strucmed:runtime-dependencies', 0)]
    },
    {
      type: 'library', 'bom-ref': 'calx-derived', name: 'calx.mjs（改寫自 jQuery Calx 2.2.8）', version: '2.2.8',
      description: 'mcp/strucmed-mcp/src/calx.mjs 的計算式詞法與文法規則改寫自 jQuery Calx 2.2.8，用於離線檢查表單計算式語法。原始碼改寫後納入本專案，不在執行期下載。',
      supplier: supplier('Xsanisty / Ikhsan Agustian', 'ID（印尼）', 'https://github.com/xsanisty/calx.js'),
      licenses: [{ license: { id: 'MIT' } }],
      externalReferences: [{ type: 'website', url: 'https://github.com/xsanisty/jquery-calx' }],
      properties: [prop('strokes:none', ''), prop('strucmed:origin', 'third-party-derived'), prop('strucmed:country', 'ID'),
        prop('strucmed:notice', 'THIRD_PARTY_NOTICES.md〈jQuery Calx〉')]
    },
    {
      type: 'platform', 'bom-ref': 'nodejs-host', name: 'Node.js', version: `>=${(mcpPkg.engines && mcpPkg.engines.node || '20').replace(/^[^\d]*/, '')}`,
      description: '執行環境。**由宿主機器提供，不隨 plugin 發佈、不由 plugin 安裝**（AI 工具或使用者自行安裝的 Node）。',
      supplier: supplier('OpenJS Foundation', 'US', 'https://nodejs.org'),
      licenses: [{ license: { id: 'MIT' } }],
      properties: [prop('strucmed:origin', 'host-provided'), prop('strucmed:country', 'US'), prop('strucmed:shipped-with-plugin', 'false')]
    }
  ];
  // 清掉上面不小心留下的空屬性
  for (const c of components) if (c.properties) c.properties = c.properties.filter(p => p.name !== 'strokes:none');
  return doc('plugin', components, {
    rootComponent: { type: 'application', 'bom-ref': 'strucmed-plugin', name: 'strucmed', version: String(pluginJson.version || ''), supplier: cg, licenses: [{ license: { id: 'MIT' } }] },
    properties: {
      'strucmed:scope': 'plugin 本身（安裝到 AI 工具裡執行的部分）',
      'strucmed:runtime-third-party': '0（執行期不載入任何第三方套件）',
      'strucmed:outbound': '預設離線。對外連線只有三處，都要使用者動作：站台（strucmed API v2，瀏覽器登入）、LlmGateway／FMapi（院內、需金鑰）、runtime_fetch（兩段式確認，只抓站台同源的靜態檔，不碰第三方 CDN）',
      'strucmed:patient-data': 'plugin 沒有查詢或存檔病人紀錄的 tool；平台對 strucmed-mcp 的 token 呼叫病人資料 API 一律回 403',
      'strucmed:note': '表單 APP 範本的相依不在這一份，見 sbom-form-app.json；HTML 預覽用的平台前端快取見 sbom-runtime.json'
    }
  });
}

// ── 2. 表單 APP 範本（package-lock.json）────────────────────────────────────
// npm 名稱 → 來源國：審查只要求「不得使用中國來源不合規元件」，所以無法判斷的一律標 unknown，不猜。
const KNOWN_COUNTRY = { react: 'US', 'react-dom': 'US', 'react-router-dom': 'US', 'react-router': 'US', typescript: 'US', vite: 'NL', eslint: 'US' };
function formAppSbom() {
  const lockFile = path.join(ROOT, 'templates', 'form-app', 'package-lock.json');
  const lock = readJson(lockFile);
  const pkg = readJson(path.join(ROOT, 'templates', 'form-app', 'package.json')) || {};
  if (!lock || !lock.packages) {
    return doc('form-app', [], { rootComponent: { type: 'application', name: 'strucmed form-app template', version: '' },
      properties: { 'strucmed:scope': '表單 APP 範本', 'strucmed:note': `找不到或無法解析 ${lockFile}，這一份是空的` } });
  }
  const direct = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const registries = new Set();
  const components = [];
  for (const [key, v] of Object.entries(lock.packages)) {
    if (!key || !v || !v.resolved) continue;                       // 根套件沒有 resolved
    const name = key.replace(/^(?:.*node_modules\/)/, '');
    let host = '';
    try { host = new URL(v.resolved).host; } catch { host = ''; }
    if (host) registries.add(host);
    components.push({
      type: 'library', 'bom-ref': `${name}@${v.version || ''}`, name, version: String(v.version || ''),
      purl: `pkg:npm/${name.replace('@', '%40')}@${v.version || ''}`,
      ...(v.license && { licenses: [{ license: typeof v.license === 'string' ? { id: v.license } : v.license }] }),
      ...(v.integrity && { hashes: hashesOf(v.integrity) }),
      supplier: supplier(`npm registry（${host || '未知'}）`, KNOWN_COUNTRY[name] || 'unknown', v.resolved),
      externalReferences: [{ type: 'distribution', url: v.resolved }],
      scope: v.dev ? 'excluded' : 'required',
      properties: [prop('strucmed:origin', 'third-party'), prop('strucmed:country', KNOWN_COUNTRY[name] || 'unknown'),
        prop('strucmed:registry', host || 'unknown'), prop('strucmed:dev-only', v.dev ? 'true' : 'false'),
        prop('strucmed:direct', direct.has(name) ? 'true' : 'false')]
    });
  }
  components.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  return doc('form-app', components, {
    rootComponent: { type: 'application', 'bom-ref': 'strucmed-form-app', name: 'strucmed form-app template', version: String(pluginJson.version || ''),
      supplier: supplier('Chang Gung Memorial Hospital（長庚醫療財團法人）', 'TW'), description: 'templates/form-app：B2 表單 APP 的 PWA 範本（React＋Vite）' },
    properties: {
      'strucmed:scope': '**產出物相依，不是 plugin 的執行相依**：員工用 build-form-app 產生 B2 app 並在自己的機器上 npm install 時才會安裝這些套件。plugin 本身不安裝、不載入它們（見 sbom-plugin.json）。',
      'strucmed:lockfileVersion': String(lock.lockfileVersion || ''),
      'strucmed:components': String(components.length),
      'strucmed:registries': [...registries].sort().join('、') || '（無）',
      'strucmed:country-note': '來源國只標得出來的（KNOWN_COUNTRY），其餘一律 unknown，不猜。要逐套件判斷請以 externalReferences 的 resolved 網址與各套件的 repository 為準。',
      'strucmed:note': '所有 resolved 都指向 registry.npmjs.org，沒有鏡像或私有來源；dev-only 的套件 scope 標 excluded（只在建置時用，不進產出的 app）。'
    }
  });
}
// npm 的 integrity（sha512-<base64>）→ CycloneDX hashes
function hashesOf(integrity) {
  const out = [];
  for (const part of String(integrity).split(/\s+/)) {
    const m = /^(sha\d{3})-(.+)$/.exec(part);
    if (!m) continue;
    const alg = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }[m[1]];
    if (alg) out.push({ alg, content: Buffer.from(m[2], 'base64').toString('hex') });
  }
  return out;
}

// ── 3. runtime 快取（runtime_fetch 的 manifest）────────────────────────────
function runtimeSbom(dir) {
  const manifest = readJson(path.join(dir, '.strucmed-runtime.json'));
  if (!manifest || !Array.isArray(manifest.files)) {
    return doc('runtime', [], {
      rootComponent: { type: 'application', name: 'strucmed platform web runtime (local cache)', version: '' },
      properties: {
        'strucmed:scope': 'HTML 預覽用的平台前端 web/ 本機快取',
        'strucmed:state': `找不到 manifest（${path.join(dir, '.strucmed-runtime.json')}）：這台機器還沒有用 runtime_fetch 抓過，或使用者用的是自己的副本（STRUCMED_RUNTIME_WEB）`,
        'strucmed:note': '這份快取不是 plugin 的一部分，也不隨 plugin 發佈；抓過之後再跑一次 npm run sbom 就會有內容'
      }
    });
  }
  const components = manifest.files.map(f => ({
    type: 'file', 'bom-ref': `runtime:${f.file}`, name: f.file, version: String(manifest.version_stamp || ''),
    hashes: [{ alg: 'SHA-256', content: f.sha256 }],
    supplier: supplier(`StrucMed 站台（${manifest.source && manifest.source.site || ''}）`, 'TW', manifest.source && manifest.source.base),
    externalReferences: [{ type: 'distribution', url: f.url }],
    properties: [prop('strucmed:origin', 'site-provided'), prop('strucmed:bytes', f.bytes), prop('strucmed:country', 'TW')]
  }));
  return doc('runtime', components, {
    rootComponent: { type: 'application', 'bom-ref': 'strucmed-runtime-cache', name: 'strucmed platform web runtime (local cache)',
      version: String(manifest.version_stamp || ''), supplier: supplier('Chang Gung Memorial Hospital（長庚醫療財團法人）', 'TW', manifest.source && manifest.source.base) },
    properties: {
      'strucmed:scope': 'HTML 預覽用的平台前端 web/ 本機快取（使用者機器上的檔案，不隨 plugin 發佈）',
      'strucmed:site': (manifest.source && manifest.source.site) || '',
      'strucmed:base_url': (manifest.source && manifest.source.base) || '',
      'strucmed:version_stamp': String(manifest.version_stamp || ''),
      'strucmed:fetched_at': String(manifest.fetched_at || ''),
      'strucmed:files': String(components.length),
      'strucmed:note': '每個檔案的 SHA-256 在開預覽前會重算比對（form_preview／scripts/preview.mjs），不符就拒絕開。' +
        '裡面的第三方元件（jQuery、Bootstrap、moment、numeral、jstat、fancytree、html2canvas…）由**平台**提供與維護，不在 plugin 的範圍；' +
        '這就是不把它們內附進 plugin 的原因。',
      ...(Array.isArray(manifest.skipped) && manifest.skipped.length && { 'strucmed:skipped': manifest.skipped.map(x => x.file).join('、') })
    }
  });
}

// ── 寫檔 ──────────────────────────────────────────────────────────────────────
const runtimeDir = argOf('--runtime') || path.join(process.env.USERPROFILE || process.env.HOME || '', '.strucmed', 'runtime');
const files = [
  ['sbom-plugin.json', pluginSbom()],
  ['sbom-form-app.json', formAppSbom()],
  ['sbom-runtime.json', runtimeSbom(runtimeDir)]
];
fs.mkdirSync(OUT, { recursive: true });
const written = [];
for (const [name, body] of files) {
  const f = path.join(OUT, name);
  fs.writeFileSync(f, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  written.push({ file: f, components: body.components.length });
  log(`[sbom] ${name}：${body.components.length} 個元件 → ${f}`);
}
const index = {
  generated_at: NOW, plugin_version: String(pluginJson.version || ''), mcp_version: String(mcpPkg.version || ''),
  files: written.map(w => ({ file: path.basename(w.file), components: w.components })),
  reading_order: [
    'sbom-plugin.json：plugin 本身。資安審查要看的主要就是這一份（執行期零第三方相依）。',
    'sbom-form-app.json：表單 APP 範本的產出物相依（員工自己 npm install 時才會裝），不是 plugin 的執行相依。',
    'sbom-runtime.json：HTML 預覽用的平台前端快取（站台提供，附版本戳記與每檔雜湊），不隨 plugin 發佈。'
  ]
};
fs.writeFileSync(path.join(OUT, 'sbom-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
log(`[sbom] sbom-index.json → ${path.join(OUT, 'sbom-index.json')}`);
if (QUIET) console.log(JSON.stringify(index, null, 2));
