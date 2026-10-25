// 站台自動判斷：院內（LVAIW）或院外；院外站台沒有 LlmGateway 與 FMapi。
// 院外站台不內建網址：只有使用者在 /plugin configure 填了「院外站台網址」（STRUCMED_EXTERNAL_URL）才會探測與登入。
// 登入改走瀏覽器（online.mjs），不需要事先設定帳密；STRUCMED_SITE=offline 可完全不連線。
//   - STRUCMED_ONLINE_BASE_URL（進階，啟動環境設定）：直接指定站台，不偵測
//   - STRUCMED_SITE=auto（預設）／internal／external／offline：強制院內、院外或離線
//   - auto：並行探測兩個站台的 api/health（不帶任何憑證），兩邊都通時用院內
// 偵測結果只存在本行程記憶體；兩邊都連不到時 30 秒後再探測（例如接上 VPN）。
const unset = v => { const s = String(v || '').trim(); return !s || s.startsWith('${'); };
const env = name => unset(process.env[name]) ? '' : String(process.env[name]).trim();

const PROBE_TIMEOUT_MS = 3_000;
const RETRY_MS = 30_000;

// STRUCMED_INTERNAL_URL 只供測試替換；STRUCMED_EXTERNAL_URL 由使用者設定
// 只接受 https（http 只限本機測試）；不可含帳密、查詢字串或 #
const externalBase = () => {
  const u = env('STRUCMED_EXTERNAL_URL');
  try {
    const x = new URL(u);
    const ok = x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname));
    return u && ok && !x.username && !x.password && !x.search && !x.hash ? u.replace(/\/+$/, '') : '';
  } catch { return ''; }
};
const hostOf = u => { try { return new URL(u).host; } catch { return u; } };
export const sites = () => ({
  internal: { label: '院內（LVAIW）', strucmed: env('STRUCMED_INTERNAL_URL') || 'https://lvaiw.cgmf.org.tw/strucmed',
    llmgw: 'https://lvaiw.cgmf.org.tw/llmgw', fmapi: 'https://lvaiw.cgmf.org.tw/FM' },
  external: externalBase() ? { label: `院外（${hostOf(externalBase())}）`, strucmed: externalBase(), llmgw: '', fmapi: '' } : null
});

let detected = null;   // { profile: 'internal'|'external'|null, at }
let pending = null;

export function mode() {
  const m = env('STRUCMED_SITE').toLowerCase();
  return ['internal', 'external', 'offline'].includes(m) ? m : 'auto';
}
export const explicitUrl = () => env('STRUCMED_ONLINE_BASE_URL');

async function probe(base) {
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/api/health`, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await r.arrayBuffer().catch(() => {});
    return r.status === 200;
  } catch { return false; }
}

// 並行探測兩個站台（只 GET api/health，不帶憑證）；check-env.mjs 也用這個
export async function probeAll() {
  const s = sites();
  const [internal, external] = await Promise.all([probe(s.internal.strucmed), s.external ? probe(s.external.strucmed) : false]);
  return { internal, external };
}

// 需要時探測一次；呼叫端（tools/list、tools/call）先 await 這個再讀 profile()
export function ready() {
  if (explicitUrl() || mode() !== 'auto') return Promise.resolve();
  if (detected && (detected.profile || Date.now() - detected.at < RETRY_MS)) return Promise.resolve();
  if (!pending) {
    pending = (async () => {
      const { internal, external } = await probeAll();
      detected = { profile: internal ? 'internal' : external ? 'external' : null, at: Date.now() };
    })().finally(() => { pending = null; });
  }
  return pending;
}

// internal／external／custom（明確指定的其他網址）／null（離線）
export function profile() {
  const url = explicitUrl();
  if (url) {
    try {
      const host = new URL(url).host;
      for (const [k, s] of Object.entries(sites())) if (s && new URL(s.strucmed).host === host) return k;
    } catch { /* 格式錯誤由 online.baseUrl 回報 */ }
    return 'custom';
  }
  const m = mode();
  if (m === 'offline') return null;
  if (m === 'external' && !sites().external) return null;
  if (m !== 'auto') return m;
  return (detected && detected.profile) || null;
}

const current = () => { const p = profile(); return p === 'internal' || p === 'external' ? sites()[p] : null; };

export function strucmedUrl() {
  if (explicitUrl()) return explicitUrl();
  return current() ? current().strucmed : '';
}
// LlmGateway 與 FMapi：環境變數優先；否則只有院內站台有預設網址
export const llmgwUrl = () => env('LLMGW_BASE_URL') || (current() ? current().llmgw : '');
export const fmapiUrl = () => env('FMAPI_BASE_URL') || (current() ? current().fmapi : '');

export function describe() {
  const p = profile();
  return { profile: p, label: p === 'custom' ? '自訂站台' : p && sites()[p] ? sites()[p].label : '離線',
    selected_by: explicitUrl() ? 'STRUCMED_ONLINE_BASE_URL' : mode() === 'auto' ? 'auto' : `STRUCMED_SITE=${mode()}` };
}

// 站台不可用的原因（給 E_ONLINE_DISABLED 的訊息）
export function unavailableReason() {
  if (mode() === 'offline') return '已設定 STRUCMED_SITE=offline（離線模式）';
  if (!sites().external) return '院內站台連不到（未設定院外站台網址），目前只能離線作業（30 秒後會重新偵測，例如接上 VPN 後）；院外使用請在 /plugin configure 填「院外站台網址」';
  return '院內與院外站台都連不到，目前只能離線作業（30 秒後會重新偵測，例如接上 VPN 後）';
}

// 測試用：清除偵測結果
export function _reset() { detected = null; pending = null; }
