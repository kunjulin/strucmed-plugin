// runtime 副本的取得與檢查：runtime_fetch（從站台抓，兩段式）、runtime_status（唯讀，比對版本與雜湊）。
// 這是 MCP 裡唯一不需要憑證卻會連外的功能，所以：
//   - 只連 site.mjs 判斷出來的站台（https；http 只限本機測試），絕不連第三方 CDN
//   - 第一次抓之前要使用者同意：第一段呼叫只回 plan，第二段帶 confirm_token 才真的連外
//   - flag runtimeFetch 可整個關掉（資安審查要求完全不對外抓檔時）
import { E, fail } from './errors.mjs';
import * as confirm from './confirm.mjs';
import * as site from './site.mjs';
import { findRuntimeWeb, helpText } from './runtime-web.mjs';
import { discover, fetchRuntime, fetchedDir, localStamp, manifestPath, readDrift, readManifest, runtimeBase, saveDrift, siteStamp, verifyRuntime } from './runtime-fetch.mjs';
import * as store from './store.mjs';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = description => ({ type: 'boolean', description });

function base() {
  const b = runtimeBase();
  if (!b) fail(E.ONLINE_DISABLED, `找不到可用的站台，無法從站台抓 runtime：${site.unavailableReason()}。離線時請改用 STRUCMED_RUNTIME_WEB 指向自己的平台 web/ 副本。`);
  return b;
}

export const RUNTIME_TOOLS = [
  {
    name: 'runtime_fetch',
    flag: 'runtimeFetch',
    description: '（只產生計畫，不連外）第一次呼叫不帶 confirm_token，只回 plan：要連的站台、網址、版本戳記、要抓幾個檔案、存到哪裡。' +
      '（連外並寫入本機快取，需 confirm_token）第二次帶 confirm_token 才真的抓。' +
      'HTML 預覽需要平台前端 web/ 的本機副本；plugin 不內附它（TempHtml.html 引用約 25 個第三方元件，內附會把它們拉進 plugin 的合規與 SBOM 範圍）。' +
      '本工具從**站台**抓一份放到 <HOME>/.strucmed/runtime/，並寫一份 manifest（來源網址、抓取時間、版本戳記、每個檔案的 SHA-256）。' +
      '只抓 https 且與站台同源的網址（院內 LVAIW／院外站台），**不從任何第三方 CDN 抓**；必要檔案（TempHtml.html 與它直接引用的 js／css）少一個就整批失敗，不留半套。' +
      '抓好之後 form_preview 會自動用它，並在開預覽前重算雜湊比對。使用者已經有自己的副本（STRUCMED_RUNTIME_WEB 或本機快取）時不需要用這個工具。',
    inputSchema: { type: 'object', properties: {
      confirm_token: str('第二次呼叫帶入'),
      refetch: bool('已經有快取時也重抓（站台版本比較新時用）') } },
    async handler({ confirm_token, refetch }) {
      const b = base();
      const dir = fetchedDir();
      const have = verifyRuntime(dir);
      if (have.ok && !refetch && !confirm_token) {
        return { already: true, dir, version_stamp: have.stamp, files: have.checked, manifest_file: manifestPath(dir),
          next: '已經有驗證通過的快取，不需要重抓。站台版本比較新時帶 refetch: true 重新取得計畫' };
      }
      const d = await discover(b);                        // 第一段也會連站台讀 TempHtml.html（只讀一個檔，為了把 plan 寫實）
      const plan = {
        action: '從站台抓 runtime 副本到本機快取',
        site: b.label, base_url: b.base, host: b.host,
        version_stamp: d.stamp || '（TempHtml.html 沒有版本註解）',
        required_files: d.required.length + 1,
        note: 'required_files 是 TempHtml.html 與它直接引用的 js／css；CSS 內 url(…) 的字型與圖片會一起抓，抓不到只記 skipped。',
        target_dir: dir,
        manifest: manifestPath(dir),
        outbound: `這是對外連線：只會 GET ${b.host} 上與站台同源的檔案，不帶任何憑證，也不連第三方 CDN`,
        replaces: have.ok || readManifest(dir) ? `會覆蓋目前的快取（版本 ${have.stamp || '未知'}）` : '（目前沒有快取）'
      };
      const h = confirm.hashPayload({ action: 'runtime_fetch', base: b.base, stamp: d.stamp, files: d.required.length });
      if (!confirm_token) {
        return { plan, confirm_token: confirm.issue('runtime_fetch', h),
          next: '請把 plan 給使用者確認（這是對外連線），同意後帶 confirm_token 再呼叫一次' };
      }
      confirm.verify('runtime_fetch', h, confirm_token);
      const r = await fetchRuntime(b, dir);
      const v = verifyRuntime(dir);
      if (!v.ok) fail(E.UPSTREAM, `抓完之後雜湊驗證沒通過（${v.reason}），快取不可信，請重抓`, { mismatched: v.mismatched, missing: v.missing });
      saveDrift({ base: b.base, site: b.label, site_stamp: r.stamp, local_stamp: r.stamp, newer_on_site: false });
      return { dir: r.dir, version_stamp: r.stamp, files: r.files, bytes: r.bytes, manifest_file: r.manifest_file,
        skipped: r.skipped, verified: true,
        warnings: r.skipped.length ? [`W_RUNTIME_SKIPPED：CSS 內 ${r.skipped.length} 個選用資源抓不到（字型或圖片），預覽的版面可能略有差異：${r.skipped.map(x => x.file).join('、')}`] : [],
        notes: ['這份快取是使用者機器上的檔案，不是 plugin 的一部分，也不隨 plugin 發佈；manifest 可當 SBOM／provenance 證據（scripts/sbom.mjs 會把它收成第 3 份）',
          'form_preview 會自動用它，並在開預覽前重算每個檔案的 sha256 比對；不符就拒絕開',
          '站台更新後請再執行 runtime_status 比對版本，需要時 runtime_fetch(refetch: true) 重抓'] };
    }
  },
  {
    name: 'runtime_status',
    description: '（唯讀）回報 HTML 預覽用的 runtime 副本狀態：目前用哪一份（STRUCMED_RUNTIME_WEB／本機快取／目錄搜尋／站台抓來的）、版本戳記、' +
      '抓來的那份雜湊驗證是否通過，以及（站台連得到時）站台目前的版本戳記與是否比本機新。**開預覽前先呼叫這個**（verify-runtime 的第 0 步）：' +
      '版本漂移不會在預覽畫面上自己顯示，站台比較新時要告知使用者並問要不要 runtime_fetch(refetch: true)，不要自動覆蓋。' +
      'check_site: false 可完全不連外（只看本機）。',
    inputSchema: { type: 'object', properties: {
      check_site: bool('比對站台目前的版本戳記（預設 true；站台連不到時只回本機狀態，不算錯誤）') } },
    async handler({ check_site = true }) {
      const ws = store.workspace();
      const web = findRuntimeWeb(ws.root);
      const dir = fetchedDir();
      const fetched = verifyRuntime(dir);
      const out = {
        runtime_available: web.available, runtime_web: web.path, source: web.source,
        version_stamp: web.available ? localStamp(web.path) : '',
        cache_file: web.cache_file,
        fetched_cache: { dir, present: !!readManifest(dir), verified: fetched.ok, ...(fetched.manifest ? { version_stamp: fetched.stamp, files: fetched.checked, fetched_at: fetched.manifest.fetched_at, source: fetched.manifest.source } : {}),
          ...(fetched.ok ? {} : { reason: fetched.reason, mismatched: fetched.mismatched, missing: fetched.missing }) },
        warnings: [], notes: []
      };
      if (web.source === 'fetched' && !fetched.ok) {
        out.runtime_available = false;
        out.warnings.push(`E_RUNTIME_HASH：抓來的快取雜湊驗證沒通過（${fetched.reason}；不符 ${fetched.mismatched.length} 個、缺 ${fetched.missing.length} 個），不會用它開預覽。請 runtime_fetch(refetch: true) 重抓。`);
      }
      if (!web.available) out.notes.push(helpText(web), '也可以用 runtime_fetch 從站台抓一份（兩段式，第一次只回 plan）');
      const cached = readDrift();
      if (cached) out.last_site_check = { checked_at: cached.checked_at, age_hours: cached.age_hours, site_stamp: cached.site_stamp, newer_on_site: !!cached.newer_on_site };
      const b = check_site ? runtimeBase() : null;
      if (!b) {
        out.site_checked = false;
        out.notes.push(check_site ? `站台連不到或離線，這次沒有比對版本（${site.unavailableReason()}）` : 'check_site: false，這次沒有比對站台版本');
        return out;
      }
      let s;
      try { s = await siteStamp(b); } catch (e) {
        out.site_checked = false;
        out.notes.push(`比對站台版本失敗（不影響預覽）：${String(e && e.message || e).slice(0, 160)}`);
        return out;
      }
      const local = out.version_stamp || fetched.stamp || '';
      const newer = !!(s.stamp && local && s.stamp !== local);
      out.site_checked = true;
      out.site = { label: b.label, base_url: b.base, version_stamp: s.stamp };
      out.newer_on_site = newer;
      saveDrift({ base: b.base, site: b.label, site_stamp: s.stamp, local_stamp: local, newer_on_site: newer });
      if (newer) {
        out.warnings.push(`W_RUNTIME_STALE：本機的 runtime 是 ver ${local}，站台已經是 ver ${s.stamp}。` +
          '預覽畫面不會提示這件事，計算式與巨集的行為可能與 HIS 端不同。要更新請執行 runtime_fetch(refetch: true)（會覆蓋本機快取）；' +
          '本機副本是使用者自己管理的（STRUCMED_RUNTIME_WEB）時請自行更新，本工具不會動它。');
      } else if (s.stamp && local) {
        out.notes.push(`本機與站台同版（ver ${local}）`);
      }
      return out;
    }
  }
];
