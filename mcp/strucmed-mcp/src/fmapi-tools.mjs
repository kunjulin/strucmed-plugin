// FMapi tool：唯讀，站台健康與錯誤紀錄狀態。只在 FMAPI_BASE_URL 設定且 flag fmapi 開啟時列出。
import * as fmapi from './fmapi.mjs';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const RELEVANT = /strucmed|llmgw|llm|gateway|struc|structure|fm\b|fmapi|warehouse|倉儲|ollama|vllm/i;

export const FMAPI_TOOLS = [
  {
    name: 'fmapi_status',
    group: 'fmapi',
    description: '（FMapi，唯讀）錯誤紀錄 API 的狀態（GET api/errorlog/status：後端、筆數、最新時間、轉送 LlmGateway 的待送筆數）與站台可用性（GET api/uptime/summary：各站台可用率、最新探測、平均延遲）。' +
      '只回與 strucmed／LlmGateway／倉儲／FMapi 相關的站台；uptime 需要 FMAPI_API_KEY，拒絕時只回 warnings。供 build-form-app 的執行清單與 connect-strucmed 使用。',
    inputSchema: { type: 'object', properties: { window: str('uptime 視窗：6h、24h（預設）、7d', { enum: ['6h', '24h', '7d'] }), all_sites: { type: 'boolean', description: '回傳全部站台（預設只回相關站台）' } } },
    async handler({ window, all_sites }) {
      const out = { errorlog: { available: false }, uptime: { available: false }, warnings: [] };
      try {
        const r = await fmapi.get('api/errorlog/status', '讀取錯誤紀錄狀態');
        const j = r.json || {};
        out.errorlog = { available: true, provider: j.provider || null, count: j.count ?? null, latest: j.latest || null,
          gateway_forward: j.gateway ? { enabled: !!j.gateway.enabled, pending: j.gateway.pending ?? null } : null,
          retention: j.retention ? { last_run: j.retention.lastRun || null, last_deleted: j.retention.lastDeleted ?? null, last_error: j.retention.lastError || null } : null };
      } catch (e) { out.warnings.push(`errorlog/status 無法讀取：${e.message}`); }
      try {
        const r = await fmapi.get('api/uptime/summary', '讀取站台可用性', { query: { window: window || '24h', maxFailures: 20 } });
        const j = r.json || {};
        if (r.status === 501) out.uptime = { available: false, reason: 'FMapi 的儲存後端不支援可用性監測' };
        else if (j.enabled === false) out.uptime = { available: true, enabled: false };
        else {
          const sites = (Array.isArray(j.sites) ? j.sites : []).filter(s => all_sites || RELEVANT.test(`${s.key} ${s.name} ${s.url}`));
          out.uptime = { available: true, enabled: true, window: j.window || window || '24h', from: j.from || null, to: j.to || null,
            sites: sites.map(s => ({ key: s.key, name: s.name, checks: s.checks, failures: s.failures, uptime_pct: s.uptimePct ?? null, avg_latency_ms: s.avgLatencyMs ?? null,
              latest: s.latest ? { checked_at: s.latest.checkedAt, success: !!s.latest.success, status_code: s.latest.statusCode ?? null, latency_ms: s.latest.latencyMs, error: s.latest.error || null } : null })),
            error_groups: (Array.isArray(j.errorGroups) ? j.errorGroups : []).filter(g => all_sites || RELEVANT.test(`${g.siteKey} ${g.siteName}`)).slice(0, 20)
              .map(g => ({ site: g.siteName || g.siteKey, error: String(g.error || '').slice(0, 200), count: g.count, first: g.first, last: g.last })) };
          const down = out.uptime.sites.filter(s => s.latest && !s.latest.success).map(s => s.name || s.key);
          if (down.length) out.warnings.push(`W_SITE_DOWN：最新探測失敗：${down.join('、')}`);
        }
      } catch (e) { out.warnings.push(`uptime/summary 無法讀取：${e.message}`); }
      return out;
    }
  }
];
