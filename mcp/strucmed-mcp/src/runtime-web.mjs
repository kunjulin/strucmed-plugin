// 平台前端（web/）本機副本的位置：form_preview、scripts/preview.mjs、scripts/check-env.mjs 共用同一份判斷。
// 順序：
//   1. STRUCMED_RUNTIME_WEB（plugin 設定或環境變數）
//   2. 本機快取 <HOME>/.strucmed/runtime-web.json（STRUCMED_RUNTIME_WEB_CACHE 可改路徑，'none' 停用）：
//      只要任何來源解析出可用路徑，scripts/check-env.mjs 就寫回這裡，之後換工作目錄也找得到（F-01、F-03）
//   3. 目錄搜尋：工作目錄本身與往上數層的 <dir>/strucmed/web、<dir>/repo/strucmed/web
//      （工作目錄本身可能就叫 repo，只找一種路徑會疊成雙 repo），再加 HOME 底下常見的 checkout 位置
//   4. 從站台抓下來的本機快取 <HOME>/.strucmed/runtime（runtime_fetch 寫的，runtime-fetch.mjs）：
//      只看 TempHtml.html 在不在，雜湊驗證在開預覽前才做（form_preview／scripts/preview.mjs 呼叫 verifyRuntime）。
//      STRUCMED_RUNTIME_WEB_CACHE='none' 同時停用第 2 與第 4 項（都在 HOME 底下，意思是「不使用本機快取」）。
// 找不到時 helpText() 給出可以照做的設定指令；三處的訊息都用它，保持一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UP_LEVELS = 4;                         // 從工作目錄往上找幾層（避免掃到整個磁碟根目錄）
const HOME_RELS = [['repo'], ['source', 'repos'], ['src'], ['git'], ['projects'], ['Documents', 'StrucMed', 'repo'], ['Documents', 'StrucMed'], []];

const hasRuntime = dir => { try { return !!dir && fs.existsSync(path.join(dir, 'TempHtml.html')); } catch { return false; } };
// 未展開的 ${…} 字面值與空白一律視為未設定
const given = v => { const s = String(v ?? '').trim(); return !s || s.startsWith('${') ? '' : s; };

export function homeDir(env = process.env) {
  return given(env.STRUCMED_HOME) || given(env.USERPROFILE) || given(env.HOME) || os.homedir();
}

// runtime_fetch 從站台抓來的副本放這裡（runtime-fetch.mjs 共用這一個函式，避免兩邊各算一次）
export const fetchedDir = (env = process.env) => path.join(homeDir(env), '.strucmed', 'runtime');

// 快取檔路徑；STRUCMED_RUNTIME_WEB_CACHE='none' 表示不使用快取（回 null）
export function cacheFile(env = process.env) {
  const set = given(env.STRUCMED_RUNTIME_WEB_CACHE);
  if (set === 'none') return null;
  return set ? path.resolve(set) : path.join(homeDir(env), '.strucmed', 'runtime-web.json');
}

function readCache(env) {
  const f = cacheFile(env);
  if (!f) return '';
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const p = given(raw && raw.path);
    return p ? path.resolve(p) : '';
  } catch { return ''; }   // 檔案不存在或壞掉：當作沒有快取，不中斷
}

// 解析出可用路徑後寫回快取（check-env.mjs 呼叫）。→ { ok, file, written, reason }
export function saveRuntimeWeb(dir, env = process.env) {
  const f = cacheFile(env);
  if (!f) return { ok: false, file: null, written: false, reason: 'STRUCMED_RUNTIME_WEB_CACHE=none：不使用快取' };
  const p = path.resolve(String(dir || ''));
  if (!hasRuntime(p)) return { ok: false, file: f, written: false, reason: `${p} 裡沒有 TempHtml.html，不寫入快取` };
  if (readCache(env) === p) return { ok: true, file: f, written: false, reason: '快取已經是這個路徑' };
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify({ path: p, saved_at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    return { ok: true, file: f, written: true, reason: '' };
  } catch (e) { return { ok: false, file: f, written: false, reason: String(e && e.message || e) }; }
}

function candidates(root, env) {
  const out = [];
  const add = dir => { const r = path.resolve(dir); if (!out.includes(r)) out.push(r); };
  let dir = path.resolve(root);
  for (let i = 0; i <= UP_LEVELS; i++) {
    add(path.join(dir, 'strucmed', 'web'));
    add(path.join(dir, 'repo', 'strucmed', 'web'));
    const up = path.dirname(dir);
    if (up === dir) break;                   // 到了磁碟根目錄
    dir = up;
  }
  const home = homeDir(env);
  for (const rel of HOME_RELS) add(path.join(home, ...rel, 'strucmed', 'web'));
  // 最後才用站台抓來的快取（runtime_fetch）：使用者自己的副本優先。
  // STRUCMED_RUNTIME_WEB_CACHE='none' 的意思是「不使用本機快取」，所以連這個目錄也一起跳過
  if (cacheFile(env)) add(fetchedDir(env));
  return out;
}

// → { path, available, source: 'env'|'cache'|'search'|'none', tried, cache_file }；找不到時 path 是第一個候選
export function findRuntimeWeb(root, env = process.env) {
  const cache_file = cacheFile(env);
  const set = given(env.STRUCMED_RUNTIME_WEB);
  if (set) {
    const dir = path.resolve(set);
    return { path: dir, available: hasRuntime(dir), source: 'env', tried: [dir], cache_file, fetched_dir: fetchedDir(env) };
  }
  const cached = readCache(env);
  if (cached && hasRuntime(cached)) return { path: cached, available: true, source: 'cache', tried: [cached], cache_file, fetched_dir: fetchedDir(env) };
  const tried = [...(cached ? [cached] : []), ...candidates(root, env)];
  const hit = tried.find(hasRuntime);
  const fetched = fetchedDir(env);
  const source = hit ? (path.resolve(hit) === path.resolve(fetched) ? 'fetched' : 'search') : 'none';
  return { path: hit || tried[0], available: !!hit, source, tried, cache_file, fetched_dir: fetched };
}

// 找不到副本時「照著做」的訊息（form_preview、scripts/preview.mjs、scripts/check-env.mjs 共用）
export function helpText(web, env = process.env) {
  const cmd = process.platform === 'win32'
    ? 'setx STRUCMED_RUNTIME_WEB "<平台 web/ 副本的完整路徑>"'
    : 'export STRUCMED_RUNTIME_WEB=<平台 web/ 副本的完整路徑>';
  const tried = (web && web.tried) || [];
  const cache = web && 'cache_file' in web ? web.cache_file : cacheFile(env);
  return 'HTML 預覽需要 StrucMed 平台前端 web/ 目錄的本機副本（裡面要有 TempHtml.html）；編輯器匯出的 .htm 不能代替（引擎與函式庫都向站台載入，預覽會封鎖）。' +
    `設定方法：${cmd}（其他系統用 export；指令裡的路徑換成實際副本位置），設定後**重新啟動 AI 工具**（Claude Code／Codex／Antigravity）才讀得到。` +
    'Claude Code 也可以用 /plugin configure strucmed@strucmed-marketplace 填「平台前端 web/ 本機副本」。' +
    (cache ? `設定好後執行一次 scripts/check-env.mjs，路徑會寫進 ${cache}，之後換工作目錄也找得到。` : '本機快取已停用（STRUCMED_RUNTIME_WEB_CACHE=none），所以每次都得靠環境變數或目錄搜尋。') +
    (tried.length ? `找過 ${tried.length} 個位置：${tried.slice(0, 6).join('、')}${tried.length > 6 ? `…（其餘 ${tried.length - 6} 個略）` : ''}。` : '');
}
