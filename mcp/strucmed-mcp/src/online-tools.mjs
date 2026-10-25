// Online tools (mode: online) — call the strucmed V2 API. Listed only when STRUCMED_ONLINE_BASE_URL is set;
// otherwise every call returns E_ONLINE_DISABLED . Credentials and tokens: see online.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { E, fail } from './errors.mjs';
import * as store from './store.mjs';
import * as confirm from './confirm.mjs';
import * as online from './online.mjs';
import * as site from './site.mjs';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;                       // 與伺服器 TemplatePackage.IsValidId 相同
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;                    // 病歷號、門急住號、科部代碼等
const FOLDER_TYPES = ['usr', 'sub', 'dpt', 'sys', 'trash', 'ALL'];
// 伺服器只轉送倉儲 QueryDeviceDataDto 的 12 個欄位
const QUERY_FIELDS = ['fillID', 'chtno', 'deptNo', 'opdno', 'pacsno', 'sheetid', 'recType', 'recNo', 'status', 'user', 'recDateS', 'recDateE'];
const MAX_XML_CHARS = 5_000_000;

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
    description: '（online）以院內帳號登入 strucmed V2 API（POST api/v2/auth/token）。站台自動判斷院內（LVAIW）或院外（使用者設定的網址），回應的 site 標明。' +
      '帳密只從啟動 MCP 的環境變數 STRUCMED_USER／STRUCMED_PASS 讀取（/plugin configure 注入）；伺服器回「帳號或密碼錯誤」時回 E_AUTH 且 details.reconfigure，' +
      '請使用者以 /plugin configure 更新密碼，不要重試（同一組帳密本行程不會再送出）。' +
      '**沒有**帳密參數，請勿要求使用者在對話中提供密碼。token 只存在本次 MCP 行程的記憶體，不回傳、不寫檔；過期時其他線上 tool 會自動以 refresh token 換新。',
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
    description: '（online）清除本行程記憶體中的 token（不呼叫伺服器）。',
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
    name: 'online_records_query',
    description: '（online，病人資料，唯讀）查詢病人紀錄：kind=data → POST api/v2/records/query/data（key-value）；' +
      'kind=image → api/v2/records/query/image（XML 文件與影像）。**必須帶病歷號 query.chtno**；伺服器會記錄每次查詢（含病歷號與查詢者）。' +
      '只轉送 12 個欄位：' + QUERY_FIELDS.join('、') + '。只在使用者明確要求查某位病人時使用。',
    inputSchema: { type: 'object', required: ['kind', 'query'], properties: {
      kind: str('data 或 image', { enum: ['data', 'image'] }),
      query: { type: 'object', description: '查詢條件，例如 { chtno, sheetid, status:"XMLdoc", recDateS, recDateE }', properties: Object.fromEntries(QUERY_FIELDS.map(k => [k, { type: 'string' }])) },
      max_items: { type: 'number', description: '最多回傳筆數（預設 50，上限 200）' } } },
    async handler({ kind, query, max_items }) {
      if (!['data', 'image'].includes(kind)) fail(E.INVALID_INPUT, 'kind 必須是 data 或 image');
      if (!query || typeof query !== 'object' || Array.isArray(query)) fail(E.INVALID_INPUT, '缺少 query');
      const q = {};
      const dropped = [];
      for (const [k, v] of Object.entries(query)) {
        if (!QUERY_FIELDS.includes(k)) { dropped.push(k); continue; }
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' && typeof v !== 'number') fail(E.INVALID_INPUT, `query.${k} 必須是字串`);
        q[k] = String(v);
      }
      q.chtno = checkCode(q.chtno, 'query.chtno（病歷號）', true);
      if (q.chtno.toLowerCase() === 'shortcut') fail(E.INVALID_INPUT, 'query.chtno 必須是病歷號（範本查詢請用 online_template_get）');
      const limit = Math.min(Math.max(Number(max_items) || 50, 1), 200);
      const res = await online.call('POST', `api/v2/records/query/${kind}`, { body: { patient: q.chtno, source: 'strucmed-mcp', query: q } }, '查詢病人紀錄');
      const items = Array.isArray(res) ? res : [];
      const warnings = dropped.length ? [`W_QUERY_FIELD_DROPPED：伺服器不接受的欄位已略過：${dropped.join(', ')}`] : [];
      return { count: items.length, truncated: items.length > limit, items: items.slice(0, limit), warnings };
    }
  },
  {
    name: 'online_records_save',
    description: '（online，寫入病人紀錄）存病人紀錄（POST api/v2/records/save：key-value＋XML 文件）。兩段式：先不帶 confirm_token 取得 plan，' +
      '**必須把 plan（站台、登入者、病歷號、表單、新增或覆寫）給使用者確認**，同意後帶 confirm_token 再呼叫一次；內容改動後 token 失效。' +
      'iot.user 與科部由登入者決定；覆寫（xml_fill_id）只在伺服器確認是同病人、同表單、同建立者時生效，否則另存新紀錄。',
    inputSchema: { type: 'object', required: ['template_id', 'chtno', 'xml_content'], properties: {
      template_id: str('範本 ID（sheetid）'), chtno: str('病歷號'), opdno: str('門急住號（選填）'),
      dept_no: str('紀錄科部（選填，預設登入科部）'), rec_type: str('recType（選填）'), rec_no: str('recNo（選填）'),
      rec_date: str('存檔時間（選填，與 HIS 執行畫面相同格式）'),
      xml_content: str('XML 文件內容（上限 500 萬字元）'),
      detail: { type: 'array', items: { type: 'object' }, description: 'key-value 明細（IOTjson.detail，選填）' },
      xml_fill_id: str('要覆寫的 XML 紀錄 fillID（選填）'), iot_fill_id: str('對應的 key-value fillID（選填）'),
      confirm_token: str('第二次呼叫帶入') } },
    async handler(a) {
      const user = online.currentUser();
      const templateID = checkId(a.template_id, 'template_id');
      const chtno = checkCode(a.chtno, 'chtno（病歷號）', true);
      if (typeof a.xml_content !== 'string' || !a.xml_content) fail(E.INVALID_INPUT, '缺少 xml_content');
      if (a.xml_content.length > MAX_XML_CHARS) fail(E.INVALID_INPUT, 'xml_content 超過 500 萬字元上限');
      if (a.detail !== undefined && !Array.isArray(a.detail)) fail(E.INVALID_INPUT, 'detail 必須是陣列');
      const xmlfillID = a.xml_fill_id ? checkId(a.xml_fill_id, 'xml_fill_id') : '';
      const IOTfillID = a.iot_fill_id ? checkId(a.iot_fill_id, 'iot_fill_id') : '';
      const iot = {
        fillID: '', chtno, deptNo: checkCode(a.dept_no, 'dept_no') || user.deptNo, opdno: checkCode(a.opdno, 'opdno'),
        pacsno: '', sheetid: templateID, recType: String(a.rec_type || ''), recNo: String(a.rec_no || ''),
        status: '', user: user.userId, recDate: String(a.rec_date || ''), detail: a.detail || []
      };
      const body = { iot, xmlContent: a.xml_content, templateID, recType: iot.recType, recNo: iot.recNo, xmlfillID, IOTfillID };
      const base = online.baseUrl();
      const h = confirm.hashPayload({ base, user: user.userId, body });
      if (!a.confirm_token) {
        return {
          plan: {
            action: xmlfillID ? `覆寫 XML 紀錄 ${xmlfillID}（伺服器確認同病人、同表單、同建立者才覆寫，否則另存新紀錄）` : '新增病人紀錄',
            site: base, user_id: user.userId, dept_no: iot.deptNo, chtno, opdno: iot.opdno, template_id: templateID,
            rec_type: iot.recType, rec_no: iot.recNo, xml_chars: a.xml_content.length, detail_items: iot.detail.length
          },
          confirm_token: confirm.issue('online_records_save', h),
          next: '請把 plan 給使用者確認，同意後帶 confirm_token 再呼叫一次'
        };
      }
      confirm.verify('online_records_save', h, a.confirm_token);
      const r = await online.call('POST', 'api/v2/records/save', { body }, '存病人紀錄');
      const warnings = [];
      if (r && r.overwriteDenied) warnings.push('W_OVERWRITE_DENIED：原紀錄不是同病人、同表單或同建立者，已另存新紀錄');
      if (r && r.kv && r.kv.success !== 'Y') warnings.push(`W_KV_FAILED：key-value 儲存回覆 ${r.kv.success || '空白'}${r.kv.msg ? `：${r.kv.msg}` : ''}`);
      if (r && r.xml && r.xml.success !== 'Y') warnings.push(`W_XML_FAILED：XML 儲存回覆 ${r.xml.success || '空白'}${r.xml.msg ? `：${r.xml.msg}` : ''}`);
      return { result: r, warnings };
    }
  }
,
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
