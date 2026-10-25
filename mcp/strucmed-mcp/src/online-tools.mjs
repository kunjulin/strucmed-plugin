// Online tools (mode: online) — call the strucmed V2 API. Listed only when STRUCMED_ONLINE_BASE_URL is set;
// otherwise every call returns E_ONLINE_DISABLED. Browser login and tokens: see online.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { E, fail } from './errors.mjs';
import * as store from './store.mjs';
import * as online from './online.mjs';
import * as site from './site.mjs';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;                       // 與伺服器 TemplatePackage.IsValidId 相同
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;                    // 科部、院區代碼等
const FOLDER_TYPES = ['usr', 'sub', 'dpt', 'sys', 'trash', 'ALL'];

function checkId(v, field) {
  if (!ID_RE.test(String(v ?? ''))) fail(E.INVALID_INPUT, `${field} 格式不正確（英數與 -，最多 64 字）`);
  return String(v);
}
function checkCode(v, field, required) {
  if (v === undefined || v === null || v === '') { if (required) fail(E.INVALID_INPUT, `缺少 ${field}`); return ''; }
  if (!CODE_RE.test(String(v))) fail(E.INVALID_INPUT, `${field} 格式不正確`);
  return String(v);
}

export const ONLINE_TOOLS = [
  {
    name: 'online_login',
    description: '（online）以瀏覽器登入 strucmed 站台（OAuth 2.0 授權碼 + PKCE，回呼到本機 127.0.0.1）。站台自動判斷院內（LVAIW）或院外（使用者設定的網址），回應的 site 標明。' +
      '會以系統瀏覽器開啟站台登入頁，**HIS 帳密由使用者在登入頁輸入，不經過 AI 工具**；本 tool 沒有帳密參數，絕不在對話中索取密碼。' +
      '最多等約 2 分鐘；還沒完成時回 pending:true 與 authorize_url（瀏覽器沒開時請使用者自行開啟），使用者完成後再呼叫一次即可，不會重開新的登入。' +
      '已登入時直接回目前狀態（already:true）。token 只存在本次 MCP 行程的記憶體，不回傳、不寫檔；access token 30 分鐘，其他線上 tool 會自動以 refresh token 換新，' +
      '同一次登入最長 8 小時，之後或 MCP 重啟（新對話、/reload-plugins）需重新登入。token 只能使用範本、字典與自己的 struNote 清單。',
    inputSchema: { type: 'object', properties: {
      dept_no: str('登入科部（token 的科部，選填）'), hospital: str('院區代碼（選填，預設 CGMH）') } },
    async handler({ dept_no, hospital }) {
      if (dept_no !== undefined) checkCode(dept_no, 'dept_no');
      if (hospital !== undefined) checkCode(hospital, 'hospital');
      return online.login({ dept_no, hospital });
    }
  },
  {
    name: 'online_logout',
    description: '（online）登出：呼叫站台 auth/revoke 作廢這次登入的 refresh token，並清除本行程記憶體中的 token。',
    inputSchema: { type: 'object', properties: {} },
    handler() { online.baseUrl(); return online.logout(); }
  },
  {
    name: 'online_folder_list',
    description: '（online，唯讀）列出資料夾中的範本（GET api/v2/folders/{type}/templates）。type：usr 個人、sub 次專科、dpt 科部、sys 系統、trash 垃圾桶、ALL 全部。',
    inputSchema: { type: 'object', required: ['type'], properties: {
      type: str('資料夾', { enum: FOLDER_TYPES }), q: str('名稱或捷徑關鍵字（選填）'),
      page: { type: 'number', description: '頁次（選填，從 1 起）' }, page_size: { type: 'number', description: '每頁筆數（選填，伺服器上限 200）' } } },
    async handler({ type, q, page, page_size }) {
      if (!FOLDER_TYPES.includes(type)) fail(E.INVALID_INPUT, `type 必須是 ${FOLDER_TYPES.join('／')}`);
      return online.call('GET', `api/v2/folders/${type}/templates`, { query: { q, page, pageSize: page_size } }, '讀取資料夾清單');
    }
  },
  {
    name: 'online_template_get',
    description: '（online，唯讀）讀取範本套件 v2（GET api/v2/templates/{id}，strucmed.template/v2：form、presets、dictionaries、template、integrity）。' +
      'save:true 時另存到 <workspace>/.strucmed/online/<id>.package.json，可接著用 form_import 載入為新 draft 修改。',
    inputSchema: { type: 'object', required: ['template_id'], properties: {
      template_id: str('範本 ID（templateID）'), save: { type: 'boolean', description: '另存到工作目錄供 form_import 使用' } } },
    async handler({ template_id, save }) {
      const id = checkId(template_id, 'template_id');
      const pkg = await online.call('GET', `api/v2/templates/${id}`, {}, '讀取範本');
      if (!save) return { package: pkg };
      const ws = store.workspace();
      const dir = path.join(ws.base, 'online');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.package.json`);
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
      return { package: pkg, saved: path.relative(ws.root, file).split(path.sep).join('/') };
    }
  },
  {
    name: 'online_me',
    description: '（online，唯讀）目前登入者（GET api/v2/me）：user_id、name、dept_no、可用資料夾代碼（usr／sub／dpt）、是否管理者、token 到期時間。',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const r = await online.call('GET', 'api/v2/me', {}, '讀取登入者');
      return { user_id: String(r.userId || ''), name: String(r.name || ''), dept_no: String(r.deptNo || ''),
        folders: r.folders && typeof r.folders === 'object' ? r.folders : {}, is_admin: !!r.isAdmin, token_expires_at: r.tokenExpiresAt || null };
    }
  },
  {
    name: 'online_features',
    description: '（online，唯讀）站台功能狀態：api/health、api/v2/runtime/features（登入者的存檔／查詢開關與白名單命中）、' +
      'api/llm-config（只回 enabled 與 base_url；不回傳任何 token）。任一端點失敗只標 available:false 並回 warnings，不中斷。',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const user = online.currentUser();
      const out = { site: site.describe(), health: { available: false }, runtime: { available: false }, llm_gateway: { available: false, enabled: false }, warnings: [] };
      if (out.site.profile === 'external') out.warnings.push('W_SITE_EXTERNAL：院外站台不提供 LlmGateway、LLM 與語音轉文字；模型白名單使用內建靜態表，AI 巨集請回院內實測');
      const probe = async (what, fn) => { try { return await fn(); } catch (e) { out.warnings.push(`${what} 無法讀取：${e.message}`); return null; } };
      const h = await probe('api/health', () => online.call('GET', 'api/health', {}, '讀取健康狀態'));
      if (h) out.health = { available: true, ok: !!h.ok, ts: h.ts || null };
      const f = await probe('api/v2/runtime/features', () => online.call('GET', 'api/v2/runtime/features', { query: { user: user.userId, deptNo: user.deptNo } }, '讀取 runtime 功能'));
      if (f) out.runtime = { available: true, presets: !!f.presets, record_delete: !!f.recordDelete, save: !!f.save, query: !!f.query };
      const g = await probe('api/llm-config', () => online.call('GET', 'api/llm-config', { headers: { 'X-Asr-Site': 'strucmed' } }, '讀取 LLM 閘道設定'));
      // 刻意只取狀態欄位：g.token 是瀏覽器型金鑰，不得進入回應、log 或檔案
      if (g) out.llm_gateway = { available: true, enabled: !!g.enabled, base_url: g.enabled ? String(g.baseUrl || '') : null, site: g.site ? String(g.site) : null,
        has_endpoints: Array.isArray(g.endpoints) ? g.endpoints.length > 0 : !!g.endpoints };
      return out;
    }
  },
  {
    name: 'online_dictionary_search',
    description: '（online，唯讀）以登入者科部搜尋線上字典（GET api/v2/dictionaries?scope=match|exact&q=）：match＝4 層科部比對（與編輯器相同），exact＝只比對 token 的科部。' +
      'update_index:true 時把結果寫成本機字典索引（取代 dictionary_load 的 CSV），之後 dictionary_search 與 form_add_control 的字典比對、dicid 驗證都依此索引；要完整索引請不帶 q。',
    inputSchema: { type: 'object', properties: {
      q: str('名稱關鍵字（選填，最多 50 字）'), scope: str('match（預設）或 exact', { enum: ['match', 'exact'] }),
      update_index: { type: 'boolean', description: '把結果寫入本機字典索引（.strucmed/dictionaries.json）' } } },
    async handler({ q, scope, update_index }) {
      if (q !== undefined && q !== null && String(q).length > 50) fail(E.INVALID_INPUT, 'q 最多 50 字');
      if (scope !== undefined && !['match', 'exact'].includes(scope)) fail(E.INVALID_INPUT, 'scope 必須是 match 或 exact');
      const user = online.currentUser();
      const r = await online.call('GET', 'api/v2/dictionaries', { query: { scope, q } }, '搜尋字典');
      const items = Array.isArray(r && r.items) ? r.items : [];
      const entries = items.map(d => ({ id: String(d.id || ''), dicType: String(d.dicType || ''), dicName: String(d.dicName || ''),
        dicComment: String(d.dicComment || ''), createUser: '', createDate: String(d.createDate || '') })).filter(e => e.dicName);
      const result = { dept_no: String((r && r.deptNo) || user.deptNo), scope: String((r && r.scope) || scope || 'match'), levels: (r && r.levels) || [],
        total: Number.isFinite(r && r.total) ? r.total : entries.length, truncated: !!(r && r.truncated),
        items: entries.map(e => ({ id: e.id, dic_type: e.dicType, name: e.dicName, comment: e.dicComment, create_date: e.createDate })), warnings: [] };
      if (update_index) {
        if (q) result.warnings.push('W_INDEX_PARTIAL：索引只包含符合關鍵字的字典；要完整索引請不帶 q 再呼叫一次');
        if (result.truncated) result.warnings.push('W_INDEX_TRUNCATED：伺服器截斷了清單，索引不完整');
        const byName = {};
        for (const e of entries) (byName[e.dicName] ||= []).push(e);
        store.saveDictIndex({ loadedAt: new Date().toISOString(), source: `online api/v2/dictionaries scope=${result.scope}`, deptNo: result.dept_no, hasIds: true,
          entries, deleted: 0, warnings: [], duplicates: Object.entries(byName).filter(([, v]) => v.length > 1).map(([name, v]) => ({ name, ids: v.map(x => x.id) })) });
        result.index_updated = true;
        result.index_count = entries.length;
      }
      return result;
    }
  }
];
