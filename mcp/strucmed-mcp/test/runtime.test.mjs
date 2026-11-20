// 第 7 項：runtime 副本從站台抓並做雜湊驗證（runtime_fetch／runtime_status、findRuntimeWeb 的第 4 個來源、form_preview 拒絕用壞掉的快取）
// 第 8 項：scripts/sbom.mjs 的三份 SBOM
// 站台用 127.0.0.1 上的假站台（site.mjs 的 http 只放行本機），不連真站。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SBOM = path.resolve(HERE, '../../../scripts/sbom.mjs');
const node = (file, args, env = {}) => new Promise(res => execFile(process.execPath, [file, ...args], { cwd: os.tmpdir(), env: { ...process.env, ...env } }, (e, stdout, stderr) => res({ code: e ? e.code : 0, stdout, stderr })));

// 假站台：TempHtml.html ＋ 一個 js ＋ 一個 css（css 內有 url() 指向一個字型）
const TEMPLATE = (stamp, extra = '') =>
  `<!DOCTYPE html>\n<html>\n<!-- ver ${stamp} 使用 TempHtml.js?v=${stamp} 假站台測試用 -->\n<head>\n` +
  `<link href="css/TempHtml.css?v=${stamp}" rel="stylesheet">\n<script src="js/TempHtml.js?v=${stamp}"></script>\n` +
  `<script src="data:image/png;base64,AAAA"></script>\n${extra}</head>\n<body></body>\n</html>\n`;
const FILES = stamp => ({
  '/TempHtml.html': { type: 'text/html', body: TEMPLATE(stamp) },
  '/js/TempHtml.js': { type: 'text/javascript', body: `// runtime ${stamp}\nwindow.X=1;\n` },
  '/css/TempHtml.css': { type: 'text/css', body: '@font-face{src:url(../assets/f.woff2) format("woff2")}\n.a{background:url("data:image/gif;base64,AA")}\n' },
  '/assets/f.woff2': { type: 'font/woff2', body: 'FONTBYTES' }
});

let server, port, stamp = '20261108', missing = new Set(), hits = [];
let ws, home, t, rf, rw, siteMod;

// node:test 的多個頂層 before 是「反向」執行的，所以全部放在同一個 before 裡（順序才確定）
before(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits.push(p);
    const f = FILES(stamp)[p];
    if (!f || missing.has(p)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': f.type });
    res.end(f.body);
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  port = server.address().port;

  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-rt-ws-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-rt-home-'));
  process.env.STRUCMED_WORKSPACE = ws;
  process.env.STRUCMED_HOME = home;                      // 快取與抓來的副本都在這個假 HOME 底下
  process.env.STRUCMED_RUNTIME_WEB = '';
  delete process.env.STRUCMED_RUNTIME_WEB_CACHE;
  delete process.env.STRUCMED_ONLINE_BASE_URL;
  process.env.STRUCMED_SITE = 'internal';
  process.env.STRUCMED_INTERNAL_URL = `http://127.0.0.1:${port}`;
  siteMod = await import('../src/site.mjs');
  siteMod._reset();
  rf = await import('../src/runtime-fetch.mjs');
  rw = await import('../src/runtime-web.mjs');
  const tools = await import('../src/tools.mjs');
  const rt = await import('../src/runtime-tools.mjs');
  t = Object.fromEntries([...tools.TOOLS, ...rt.RUNTIME_TOOLS].map(x => [x.name, x.handler]));
});
after(() => {
  server.close();
  for (const d of [ws, home]) fs.rmSync(d, { recursive: true, force: true });
});
beforeEach(() => { hits = []; missing = new Set(); stamp = '20261108'; });

const fetchedDir = () => rf.fetchedDir();
const draft = () => {
  const { draft_id } = t.form_create({ name: 'runtime 測試', dept_no: 'TEST0' });
  const { area_itemid } = t.form_add_area({ draft_id, title: '區塊' });
  t.form_add_control({ draft_id, area_itemid, label_text: 'x：', control: { datatype: 'textbox' } });
  return draft_id;
};

test('runtime_fetch 是兩段式：第一次只回 plan（不寫入），第二次才抓', async () => {
  fs.rmSync(fetchedDir(), { recursive: true, force: true });
  const first = await t.runtime_fetch({});
  assert.ok(first.confirm_token, '第一次只回 plan 與 token');
  assert.equal(first.plan.version_stamp, '20261108');
  assert.equal(first.plan.required_files, 3, 'TempHtml.html＋1 js＋1 css（data: 不算）');
  assert.match(first.plan.outbound, /對外連線/);
  assert.equal(first.plan.target_dir, fetchedDir());
  assert.equal(fs.existsSync(fetchedDir()), false, '第一次什麼都沒有寫');

  const r = await t.runtime_fetch({ confirm_token: first.confirm_token });
  assert.equal(r.verified, true);
  assert.equal(r.version_stamp, '20261108');
  assert.equal(r.files, 4, 'TempHtml.html、js、css ＋ css 內 url() 的字型');
  assert.equal(fs.existsSync(path.join(fetchedDir(), 'assets', 'f.woff2')), true, 'CSS 的 url() 也抓下來');
  assert.deepEqual(r.skipped, []);
  // manifest：來源、時間、版本戳記、每檔雜湊
  const m = JSON.parse(fs.readFileSync(r.manifest_file, 'utf8'));
  assert.equal(m.source.base, `http://127.0.0.1:${port}`);
  assert.equal(m.version_stamp, '20261108');
  assert.ok(m.fetched_at);
  const js = m.files.find(f => f.file === 'js/TempHtml.js');
  assert.equal(js.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(fetchedDir(), 'js/TempHtml.js'))).digest('hex'));
  assert.match(js.url, /^http:\/\/127\.0\.0\.1:\d+\/js\/TempHtml\.js$/);
  // 錯的 token 不放行
  await assert.rejects(t.runtime_fetch({ confirm_token: 'bogus' }), e => e.code === 'E_CONFIRM_MISMATCH');
});

test('抓好之後 findRuntimeWeb 用它（source: fetched），form_preview 開預覽前先驗雜湊', async () => {
  const web = rw.findRuntimeWeb(ws);
  assert.deepEqual([web.available, web.source, web.path], [true, 'fetched', fetchedDir()]);
  const r = t.form_preview({ draft_id: draft(), format: 'html' });
  assert.equal(r.runtime_available, true);
  assert.equal(r.runtime_source, 'fetched');
  assert.equal(r.runtime_version, '20261108');
  assert.equal(r.runtime_verified, true);
  assert.ok(r.notes.some(n => n.includes('ver 20261108') && n.includes('雜湊已驗證')));
});

test('快取被改過：雜湊不符就拒絕用它開預覽，不默默使用', async () => {
  const js = path.join(fetchedDir(), 'js', 'TempHtml.js');
  const keep = fs.readFileSync(js);
  fs.writeFileSync(js, `${keep}\n/* 被改過 */\n`);
  try {
    const v = rf.verifyRuntime(fetchedDir());
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'hash_mismatch');
    assert.deepEqual(v.mismatched, ['js/TempHtml.js']);
    const r = t.form_preview({ draft_id: draft(), format: 'html' });
    assert.equal(r.runtime_available, false, '拒絕開');
    assert.ok(r.warnings.some(w => w.startsWith('E_RUNTIME_HASH')));
    // 缺檔也一樣
    fs.writeFileSync(js, keep);
    fs.rmSync(path.join(fetchedDir(), 'assets', 'f.woff2'));
    const v2 = rf.verifyRuntime(fetchedDir());
    assert.deepEqual([v2.ok, v2.reason, v2.missing], [false, 'missing_files', ['assets/f.woff2']]);
  } finally {
    fs.writeFileSync(js, keep);
    fs.writeFileSync(path.join(fetchedDir(), 'assets', 'f.woff2'), 'FONTBYTES');
    assert.equal(rf.verifyRuntime(fetchedDir()).ok, true, '復原');
  }
});

test('必要檔案抓不到就整批失敗，不留半套（舊快取保持原樣）', async () => {
  const before = rf.readManifest(fetchedDir());
  missing.add('/js/TempHtml.js');
  const first = await t.runtime_fetch({ refetch: true });
  await assert.rejects(t.runtime_fetch({ confirm_token: first.confirm_token }), e => { assert.equal(e.code, 'E_UPSTREAM'); assert.match(e.message, /js\/TempHtml\.js/); return true; });
  assert.deepEqual(rf.readManifest(fetchedDir()), before, '原來的快取沒被動到');
  assert.equal(rf.verifyRuntime(fetchedDir()).ok, true);
  assert.equal(fs.readdirSync(path.dirname(fetchedDir())).filter(f => f.includes('.tmp-')).length, 0, '沒有留下暫存目錄');
});

test('runtime_status：站台比較新時回 W_RUNTIME_STALE，不自動覆蓋', async () => {
  const same = await t.runtime_status({});
  assert.equal(same.site_checked, true);
  assert.equal(same.newer_on_site, false);
  assert.equal(same.version_stamp, '20261108');
  assert.equal(same.fetched_cache.verified, true);
  assert.deepEqual(same.warnings, []);

  stamp = '20261201';                                   // 站台更新了（本機沒變）
  const drift = await t.runtime_status({});
  assert.equal(drift.newer_on_site, true);
  assert.equal(drift.site.version_stamp, '20261201');
  assert.ok(drift.warnings.some(w => w.startsWith('W_RUNTIME_STALE') && w.includes('20261108') && w.includes('20261201')));
  assert.equal(fs.readFileSync(path.join(fetchedDir(), 'TempHtml.html'), 'utf8').includes('20261108'), true, '沒有自動覆蓋');
  // form_preview 讀 runtime_status 寫下的結果（自己不連外）
  const r = t.form_preview({ draft_id: draft(), format: 'html' });
  assert.ok(r.warnings.some(w => w.startsWith('W_RUNTIME_STALE')));

  // check_site: false 完全不連外
  hits = [];
  const off = await t.runtime_status({ check_site: false });
  assert.equal(off.site_checked, false);
  assert.deepEqual(hits, []);
  stamp = '20261108';
  await t.runtime_status({});                            // 把漂移狀態清回同版，不影響後面的測試
});

test('只抓與站台同源的網址：http 只放行本機，其他一律不視為可用站台', async () => {
  assert.equal(rf.runtimeBase().host, `127.0.0.1:${port}`);
  const keep = process.env.STRUCMED_INTERNAL_URL;
  try {
    process.env.STRUCMED_INTERNAL_URL = 'http://cdn.bootcdn.net/strucmed';
    assert.equal(rf.runtimeBase(), null, 'http 的非本機主機不接受（也就擋掉第三方 CDN）');
    process.env.STRUCMED_INTERNAL_URL = 'https://lvaiw.example.org/strucmed';
    assert.equal(rf.runtimeBase().host, 'lvaiw.example.org', 'https 可以');
  } finally { process.env.STRUCMED_INTERNAL_URL = keep; }
});

test('flag runtimeFetch 關閉時 runtime_fetch 不列出', async () => {
  const flagsFile = path.join(home, 'flags-off.json');
  fs.writeFileSync(flagsFile, JSON.stringify({ runtimeFetch: false }));
  const keep = process.env.STRUCMED_FLAGS;
  process.env.STRUCMED_FLAGS = flagsFile;
  try {
    const { enabled } = await import('../src/flags.mjs');
    assert.equal(enabled('runtimeFetch'), false);
    const { RUNTIME_TOOLS } = await import('../src/runtime-tools.mjs');
    assert.equal(RUNTIME_TOOLS.find(x => x.name === 'runtime_fetch').flag, 'runtimeFetch', 'server.mjs 依這個 flag 決定要不要列出');
    assert.equal(RUNTIME_TOOLS.find(x => x.name === 'runtime_status').flag, undefined, 'status 是唯讀的，不受 flag 影響');
  } finally { if (keep === undefined) delete process.env.STRUCMED_FLAGS; else process.env.STRUCMED_FLAGS = keep; }
});

test('STRUCMED_RUNTIME_WEB_CACHE=none 同時停用本機快取與抓來的副本', () => {
  const env = { STRUCMED_RUNTIME_WEB: '', STRUCMED_RUNTIME_WEB_CACHE: 'none', STRUCMED_HOME: home };
  assert.equal(rw.findRuntimeWeb(ws, env).available, false);
  assert.ok(!rw.findRuntimeWeb(ws, env).tried.includes(fetchedDir()));
});

test('scripts/sbom.mjs：三份分開，plugin 零第三方執行相依、form-app 從 lock 產、runtime 用 manifest', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-sbom-'));
  const r = await node(SBOM, ['--out', out, '--runtime', fetchedDir(), '--quiet']);
  assert.equal(r.code, 0, r.stderr);
  const read = n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8'));
  const index = read('sbom-index.json');
  assert.deepEqual(index.files.map(f => f.file), ['sbom-plugin.json', 'sbom-form-app.json', 'sbom-runtime.json']);
  assert.equal(index.reading_order.length, 3);

  const p = read('sbom-plugin.json');
  assert.equal(p.bomFormat, 'CycloneDX');
  assert.equal(p.specVersion, '1.5');
  assert.equal(p.components.length, 3, '自有程式、Calx 衍生、宿主的 Node.js');
  const prop = (c, k) => (c.properties.find(x => x.name === k) || {}).value;
  const calx = p.components.find(c => c.name.includes('Calx'));
  assert.equal(prop(calx, 'strucmed:country'), 'ID', '來源國要寫出來（審查要看）');
  assert.equal(calx.licenses[0].license.id, 'MIT');
  assert.ok(calx.supplier.name.includes('Xsanisty'));
  const nodejs = p.components.find(c => c.name === 'Node.js');
  assert.equal(prop(nodejs, 'strucmed:shipped-with-plugin'), 'false', '宿主提供，不隨 plugin 發佈');
  const own = p.components.find(c => c.name === 'strucmed-mcp');
  assert.equal(prop(own, 'strucmed:runtime-dependencies'), '0');
  const meta = k => (p.metadata.properties.find(x => x.name === k) || {}).value;
  assert.match(meta('strucmed:patient-data'), /403/);
  assert.match(meta('strucmed:note'), /sbom-form-app\.json/);

  const fa = read('sbom-form-app.json');
  const lock = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../../templates/form-app/package-lock.json'), 'utf8'));
  assert.equal(fa.components.length, Object.values(lock.packages).filter(v => v.resolved).length, '每一筆 resolved 都要有一個元件');
  assert.ok(fa.components.length > 500);
  const fmeta = k => (fa.metadata.properties.find(x => x.name === k) || {}).value;
  assert.match(fmeta('strucmed:scope'), /不是 plugin 的執行相依/);
  assert.equal(fmeta('strucmed:registries'), 'registry.npmjs.org', '沒有鏡像或私有來源');
  const react = fa.components.find(c => c.name === 'react');
  assert.match(react.purl, /^pkg:npm\/react@/);
  assert.equal(react.externalReferences[0].url.startsWith('https://registry.npmjs.org/'), true);
  assert.equal(react.hashes[0].alg, 'SHA-512');
  assert.ok(fa.components.some(c => c.scope === 'excluded'), 'dev-only 標 excluded');

  const rt = read('sbom-runtime.json');
  const m = rf.readManifest(fetchedDir());
  assert.equal(rt.components.length, m.files.length);
  const rmeta = k => (rt.metadata.properties.find(x => x.name === k) || {}).value;
  assert.equal(rmeta('strucmed:version_stamp'), '20261108');
  assert.equal(rmeta('strucmed:base_url'), `http://127.0.0.1:${port}`);
  assert.match(rmeta('strucmed:note'), /jQuery、Bootstrap/);
  assert.equal(rt.components[0].hashes[0].alg, 'SHA-256');

  // 沒有 runtime 快取時 sbom-runtime.json 是空的一份，不是錯誤
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-sbom-empty-'));
  const r2 = await node(SBOM, ['--out', empty, '--runtime', path.join(empty, 'nope'), '--quiet']);
  assert.equal(r2.code, 0);
  const rt2 = JSON.parse(fs.readFileSync(path.join(empty, 'sbom-runtime.json'), 'utf8'));
  assert.equal(rt2.components.length, 0);
  assert.match((rt2.metadata.properties.find(x => x.name === 'strucmed:state') || {}).value, /還沒有用 runtime_fetch 抓過/);
  for (const d of [out, empty]) fs.rmSync(d, { recursive: true, force: true });
});
