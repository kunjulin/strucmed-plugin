// Online write tools：經 strucmed API v2 新建／更新範本、建立字典、讀版本。
// 安全姿態（references/SecurityInvariants.md）：
//   - 每個寫入都是兩段式：第一次回 plan（給使用者看），第二次帶 confirm_token；token 綁定站台、登入者、draft 內容與參數
//   - 寫入不重試（伺服器端也不重試；502 pending 時提示不要重複保存）
//   - 不提供 trash／字典刪除／硬刪除；update 只允許「以該範本 import 後改版」的 draft，且帶 If-Match
//   - feature flags：templateUpdate（online_template_update）、dictionaryWrite（online_dictionary_create／batch）
import { E, fail } from './errors.mjs';
import * as store from './store.mjs';
import * as confirm from './confirm.mjs';
import * as online from './online.mjs';
import { validateDraft } from './validate.mjs';
import { buildArtifacts } from './export.mjs';
import { folderCode } from './package.mjs';
import { walk, isControl } from './formtree.mjs';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const WRITE_FOLDERS = ['usr', 'sub', 'dpt'];           // sys 需 V2:SystemListAdmins，本工具一律不寫
const MAX_BODY_CHARS = 2 * 1024 * 1024;                 // TemplateWriteService.MaxContentBytes
const BATCH_MAX = 500;                                  // V2:DictionaryBatchMax 預設

const draftHash = d => { const { updated, created, ...rest } = d; return confirm.hashPayload(rest); };
const stripEtag = v => String(v || '').replace(/^W\//, '').replace(/^"|"$/g, '').trim();
const checkId = (v, field) => { if (!ID_RE.test(String(v ?? ''))) fail(E.INVALID_INPUT, `${field} 格式不正確（英數與 -，最多 64 字）`); return String(v); };

// 載入 draft、驗證、確認沒有待新建字典；回 { d, idx, v, built }
function prepareDraft(draft_id) {
  const d = store.loadDraft(draft_id);
  const idx = store.loadDictIndex();
  const v = validateDraft(d, idx, store.loadPolicy());
  if (!v.valid) fail(E.INVALID_INPUT, '驗證未通過，不能上架', { errors: v.errors });
  if ((d.pendingDictionaries || []).length)
    fail(E.DICT_PENDING, `尚有 ${d.pendingDictionaries.length} 個待新建字典，請先用 online_dictionary_create（flag dictionaryWrite）建立，或改走 form_export 由使用者「匯入表單及字典」`,
      { pending: d.pendingDictionaries.map(p => p.name) });
  const built = buildArtifacts(d, idx);
  const body = { template: { name: built.pkg.template.name, shortcut: built.pkg.template.shortcut, groups: built.pkg.template.groups, description: built.pkg.template.description }, form: built.form };
  const size = JSON.stringify(body).length;
  if (size > MAX_BODY_CHARS) fail(E.LIMIT, `範本本文 ${size} 字元超過伺服器上限 ${MAX_BODY_CHARS}`);
  return { d, idx, v, built, body, size };
}

// 把伺服器的寫入錯誤對應到本工具的錯誤碼
function mapWriteError(r, what) {
  const err = (r.json && typeof r.json.error === 'object' && r.json.error) || {};
  const det = { status: r.status, path: r.path, code: err.code, details: err.details };
  const msg = err.message ? `：${String(err.message).slice(0, 300)}` : '';
  switch (r.status) {
    case 428: fail(E.PRECONDITION, `${what}失敗：伺服器要求 If-Match（請重新取得計畫）${msg}`, det);
    case 409: fail(E.CONFLICT, `${what}失敗：線上內容已被他人修改${msg}；請重新 online_template_get（save:true）→ form_import 後再改版`, { ...det, currentSha256: err.details && err.details.currentSha256 });
    case 413: case 429: fail(E.LIMIT, `${what}失敗（HTTP ${r.status}）${msg}`, det);
    case 503: fail(err.code === 'E_WRITES_DISABLED' ? E.WRITES_DISABLED : E.UPSTREAM, `${what}失敗（HTTP 503 ${err.code || ''}）${msg}`, det);
    case 502: fail(E.UPSTREAM, `${what}失敗：倉儲寫入在步驟「${(err.details && err.details.step) || '?'}」中斷${msg}。**請勿重複保存**（寫入不冪等），請以 online_template_versions 與 online_folder_list 確認狀態`,
      { ...det, pending: !!(err.details && err.details.pending), step: err.details && err.details.step, templateID: err.details && err.details.templateID });
    default: fail(r.status === 401 ? E.AUTH : E.UPSTREAM, `${what}失敗（HTTP ${r.status} ${err.code || ''}）${msg}`, det);
  }
}

// 收集 GetData 陣列中的控制項 itemid（任何巢狀層級）
function collectIds(form) {
  const ids = new Set();
  const rec = n => {
    if (Array.isArray(n)) return n.forEach(rec);
    if (!n || typeof n !== 'object') return;
    if (n.datatype && n.itemid !== undefined && n.datatype !== 'text' && n.datatype !== 'newline') ids.add(String(n.itemid));
    for (const k of ['item', 'itemtemp', 'datavalue', 'items', 'columns']) if (Array.isArray(n[k])) rec(n[k]);
  };
  rec(form);
  return ids;
}

function planCommon(d, v, built, user, base) {
  const t = built.pkg.template;
  return {
    site: base, user_id: user.userId, dept_no: user.deptNo,
    name: t.name, shortcut: t.shortcut, groups: t.groups, description: t.description,
    publish_on_save: !!(t.shortcut && t.groups.length),
    areas: d.areas.length, controls: v.stats && v.stats.controls,
    dictionaries: built.pkg.dictionaries.map(x => ({ id: x.id, name: x.dicName })),
    draft_sha256: draftHash(d), body_chars: built.size, warnings: v.warnings
  };
}

export const ONLINE_WRITE_TOOLS = [
  {
    name: 'online_template_create',
    description: '（online，寫入範本）把已驗證的 draft 新建成線上範本（POST api/v2/folders/{type}/templates，回 201）。兩段式：先不帶 confirm_token 取得 plan，' +
      '**必須把 plan（站台、登入者、資料夾、名稱、捷徑、作業別、是否保存即上架、字典、警告）原樣給使用者確認**，同意後帶 confirm_token 再呼叫一次。' +
      '前置：form_validate 無 error、沒有待新建字典（否則 E_DICT_PENDING）。資料夾只能 usr／sub／dpt（sys 需管理者）。寫入不重試；502 pending 時不要重複保存。',
    inputSchema: { type: 'object', required: ['draft_id', 'folder_type'], properties: {
      draft_id: str('draft id'), folder_type: str('目標資料夾', { enum: WRITE_FOLDERS }), confirm_token: str('第二次呼叫帶入') } },
    async handler({ draft_id, folder_type, confirm_token }) {
      if (!WRITE_FOLDERS.includes(folder_type)) fail(E.INVALID_INPUT, `folder_type 必須是 ${WRITE_FOLDERS.join('／')}（sys 需管理者，本工具不提供）`);
      const user = online.currentUser();
      const base = online.baseUrl();
      const { d, v, built, body, size } = prepareDraft(draft_id);
      built.size = size;
      const h = confirm.hashPayload({ action: 'create', base, user: user.userId, draft: draftHash(d), folder_type });
      if (!confirm_token) {
        return {
          plan: { action: '新增範本', folder_type, folder_code: folderCode(folder_type, user.deptNo, user.userId), ...planCommon(d, v, built, user, base) },
          confirm_token: confirm.issue('online_template_create', h),
          next: '請把 plan 給使用者確認（閘門 G3），同意後帶 confirm_token 再呼叫一次'
        };
      }
      confirm.verify('online_template_create', h, confirm_token);
      const r = await online.callRaw('POST', `api/v2/folders/${folder_type}/templates`, { body }, '新增範本');
      if (r.status !== 201 && r.status !== 200) mapWriteError(r, '新增範本');
      const j = r.json || {};
      d.published = { site: base, templateID: String(j.templateID || ''), rev: j.rev, sha256: String(j.sha256 || ''), folder: j.folder || { type: folder_type }, action: 'create', at: new Date().toISOString(), draft_sha256: draftHash(d) };
      store.saveDraft(d);
      const warnings = Array.isArray(j.warnings) ? j.warnings.map(String) : [];
      if (j.diverged) warnings.push('W_DIVERGED：伺服器回報分歧（head 不是任何已保存版本）');
      return { template_id: d.published.templateID, rev: j.rev, sha256: d.published.sha256, folder: j.folder, draft_sha256: d.published.draft_sha256, warnings,
        next: `最後請以 online_template_get(${d.published.templateID}) 取回，確認 template.name 與控制項數與 draft 相同（伺服器 sha256 是 head 內容雜湊，與套件 integrity 不同，不能直接比對）` };
    }
  },
  {
    name: 'online_template_update',
    flag: 'templateUpdate',
    description: '（online，寫入範本，flag templateUpdate）更新線上既有範本（PUT api/v2/templates/{id}，If-Match）。只允許 draft 是以該範本 online_template_get → form_import 改版而來（derivedFrom.templateID 相同）。' +
      '兩段式：第一次呼叫會讀線上目前版本取得 If-Match（ETag）與差異摘要並回 plan；**plan 必須原樣給使用者確認**，同意後帶 confirm_token 與 plan 的 if_match 再呼叫一次。' +
      '線上內容在取得計畫後被他人修改 → E_CONFLICT，必須重新 import 改版。寫入不重試。',
    inputSchema: { type: 'object', required: ['draft_id', 'template_id'], properties: {
      draft_id: str('draft id（derivedFrom.templateID 必須等於 template_id）'), template_id: str('要更新的範本 ID'),
      if_match: str('第二次呼叫帶入 plan 的 if_match'), confirm_token: str('第二次呼叫帶入') } },
    async handler({ draft_id, template_id, if_match, confirm_token }) {
      const id = checkId(template_id, 'template_id');
      const user = online.currentUser();
      const base = online.baseUrl();
      const { d, v, built, body, size } = prepareDraft(draft_id);
      built.size = size;
      const from = d.source && d.source.derivedFrom;
      if (!from || String(from.templateID) !== id)
        fail(E.INVALID_INPUT, `這個 draft 不是以範本 ${id} 改版而來（derivedFrom=${from ? from.templateID || '（無）' : '（無）'}）；更新只允許 online_template_get(save:true) → form_import 的 draft，否則請用 online_template_create 新建`);
      let etag = stripEtag(if_match);
      let diff = null;
      if (!confirm_token) {
        const cur = await online.callRaw('GET', `api/v2/templates/${id}`, {}, '讀取線上範本');
        if (cur.status !== 200) mapWriteError(cur, '讀取線上範本');
        etag = stripEtag(cur.etag) || String((cur.json && cur.json.integrity && cur.json.integrity.sha256) || '');
        if (!etag) fail(E.UPSTREAM, '線上範本沒有 ETag，無法安全更新');
        const before = collectIds((cur.json && cur.json.form) || []), after = collectIds(built.form);
        diff = { online_name: cur.json && cur.json.template && cur.json.template.name, online_sha256: etag,
          controls_before: before.size, controls_after: after.size,
          added_itemids: [...after].filter(x => !before.has(x)), removed_itemids: [...before].filter(x => !after.has(x)),
          touched_itemids: (d.touched || []).map(String) };
      }
      if (!etag) fail(E.INVALID_INPUT, '第二次呼叫必須帶 plan 的 if_match');
      const h = confirm.hashPayload({ action: 'update', base, user: user.userId, draft: draftHash(d), template_id: id, if_match: etag });
      if (!confirm_token) {
        return {
          plan: { action: `更新範本 ${id}`, template_id: id, if_match: etag, diff, ...planCommon(d, v, built, user, base) },
          confirm_token: confirm.issue('online_template_update', h),
          next: '請把 plan 給使用者確認（閘門 G3），同意後帶 confirm_token 與 if_match 再呼叫一次'
        };
      }
      confirm.verify('online_template_update', h, confirm_token);
      const r = await online.callRaw('PUT', `api/v2/templates/${id}`, { body, headers: { 'If-Match': `"${etag}"` } }, '更新範本');
      if (r.status !== 200) mapWriteError(r, '更新範本');
      const j = r.json || {};
      d.published = { site: base, templateID: id, rev: j.rev, sha256: String(j.sha256 || ''), folder: j.folder, action: 'update', at: new Date().toISOString(), draft_sha256: draftHash(d) };
      store.saveDraft(d);
      const warnings = Array.isArray(j.warnings) ? j.warnings.map(String) : [];
      if (j.diverged) warnings.push('W_DIVERGED：線上內容在上次經 API 保存後曾被其他方式修改，已照常保存並記錄分歧');
      return { template_id: id, rev: j.rev, sha256: d.published.sha256, folder: j.folder, draft_sha256: d.published.draft_sha256, warnings,
        next: `請以 online_template_versions(${id}) 回報新 rev，並以 online_template_get 取回確認 template.name 與控制項數` };
    }
  },
  {
    name: 'online_template_versions',
    description: '（online，唯讀）範本的版本清單（GET api/v2/templates/{id}/versions）：每筆 rev、fillID、建立者、時間、sha256、current／restorable／verified；最上層 currentRev、diverged。供上架後回報與人工回復。',
    inputSchema: { type: 'object', required: ['template_id'], properties: { template_id: str('範本 ID'), max_items: { type: 'number', description: '最多回傳筆數（預設 20）' } } },
    async handler({ template_id, max_items }) {
      const id = checkId(template_id, 'template_id');
      const r = await online.call('GET', `api/v2/templates/${id}/versions`, {}, '讀取版本');
      // 平台回傳的鍵是 versions（V2Endpoints.VersionsAsync）；items 保留相容
      const items = Array.isArray(r && r.versions) ? r.versions : Array.isArray(r && r.items) ? r.items : (Array.isArray(r) ? r : []);
      const limit = Math.min(Math.max(Number(max_items) || 20, 1), 200);
      return { template_id: id, current_rev: r && r.currentRev !== undefined ? r.currentRev : null, diverged: !!(r && r.diverged), total: items.length, truncated: items.length > limit,
        items: items.slice(0, limit).map(x => ({ rev: x.rev, fill_id: x.fillID, create_user: x.createUser, create_date: x.createDate, sha256: x.sha256, current: !!x.current, restorable: !!x.restorable, verified: !!x.verified, problem: x.problem || null })) };
    }
  },
  {
    name: 'online_dictionary_create',
    flag: 'dictionaryWrite',
    description: '（online，寫入字典，flag dictionaryWrite）把 draft 的一個「待新建字典」建立到線上（POST api/v2/dictionaries，scope 固定 dept：建立者＝登入者、類型＝登入科部）。' +
      '兩段式：先取得 plan 給使用者確認，再帶 confirm_token。同名未刪除字典存在時伺服器回 reused（沿用既有 id）；有自己可還原的同名已刪除字典時回 E_DELETED_EXISTS（候選列在 details），' +
      '**不自動 force**，由使用者決定還原（請管理者在字典頁操作）或帶 force:true 建立新的。成功後把 draft 內使用該名稱的控制項綁上 id、移出待新建清單、更新本機字典索引。',
    inputSchema: { type: 'object', required: ['draft_id', 'name'], properties: {
      draft_id: str('draft id'), name: str('待新建字典名稱（必須在 draft 的 pendingDictionaries 內）'), comment: str('說明（選填；預設用規劃時的 comment）'),
      force: { type: 'boolean', description: '有已刪除同名字典時仍建立新的（只在使用者明確決定後帶）' }, confirm_token: str('第二次呼叫帶入') } },
    async handler({ draft_id, name, comment, force, confirm_token }) {
      const user = online.currentUser();
      const base = online.baseUrl();
      const d = store.loadDraft(draft_id);
      const pend = (d.pendingDictionaries || []).find(p => p.name === name);
      if (!pend) fail(E.INVALID_INPUT, `「${name}」不在 draft 的待新建字典清單中`, { pending: (d.pendingDictionaries || []).map(p => p.name) });
      const dicComment = String(comment !== undefined ? comment : (pend.comment || ''));
      const usedBy = [];
      walk(d, n => { if (isControl(n) && n.dictionary === name && !n.dicid) usedBy.push(n.itemid); });
      const h = confirm.hashPayload({ action: 'dict-create', base, user: user.userId, draft_id, name, dicComment, force: !!force });
      if (!confirm_token) {
        return {
          plan: { action: '新增字典', site: base, user_id: user.userId, dept_no: user.deptNo, scope: 'dept', name, comment: dicComment, force: !!force, used_by_itemids: usedBy,
            note: '同名未刪除字典存在時會沿用既有（reused），不會重複建立' },
          confirm_token: confirm.issue('online_dictionary_create', h),
          next: '請把 plan 給使用者確認，同意後帶 confirm_token 再呼叫一次'
        };
      }
      confirm.verify('online_dictionary_create', h, confirm_token);
      const body = { dicName: name, dicComment, scope: 'dept', ...(force ? { force: true } : {}) };
      const r = await online.callRaw('POST', 'api/v2/dictionaries', { body }, '新增字典');
      if (r.status === 409 && r.json && r.json.error && r.json.error.code === 'E_DELETED_EXISTS')
        fail(E.DELETED_EXISTS, `有已刪除的同名字典「${name}」：請使用者決定「還原」（在字典頁垃圾桶操作後重新搜尋綁定）或「建立新的」（再呼叫一次並帶 force:true，需重新取得 plan）`,
          { candidates: r.json.error.details && r.json.error.details.candidates });
      if (r.status !== 200 && r.status !== 201) mapWriteError(r, '新增字典');
      const j = r.json || {};
      const id = String(j.id || '');
      if (!id) fail(E.UPSTREAM, '伺服器回應缺少字典 id');
      const bound = bindDictionary(d, name, { id, dicType: String(j.dicType || user.deptNo), dicName: String(j.dicName || name), dicComment: String(j.dicComment || dicComment), createUser: String(j.createUser || user.userId) });
      return { id, dic_type: String(j.dicType || ''), name: String(j.dicName || name), created: !!j.created, reused: !!j.reused, bound_itemids: bound, pending_left: d.pendingDictionaries.map(p => p.name),
        warnings: j.reused ? [`W_DICT_REUSED：「${name}」已存在，沿用既有字典 ${id.slice(0, 8)}…`] : [] };
    }
  },
  {
    name: 'online_dictionary_batch',
    flag: 'dictionaryWrite',
    description: '（online，寫入字典，flag dictionaryWrite）把 draft 的全部「待新建字典」一次建立（POST api/v2/dictionaries/batch，最多 500 筆，逐筆回報）。兩段式：先取得 plan 給使用者確認。' +
      '成功的字典會綁回 draft 並更新本機索引；失敗的留在待新建清單並回 warnings（例如 E_DELETED_EXISTS 需改用 online_dictionary_create 逐一決定）。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: { draft_id: str('draft id'), confirm_token: str('第二次呼叫帶入') } },
    async handler({ draft_id, confirm_token }) {
      const user = online.currentUser();
      const base = online.baseUrl();
      const d = store.loadDraft(draft_id);
      const rows = (d.pendingDictionaries || []).map(p => ({ dicName: p.name, dicComment: String(p.comment || '') }));
      if (!rows.length) fail(E.INVALID_INPUT, 'draft 沒有待新建字典');
      if (rows.length > BATCH_MAX) fail(E.LIMIT, `待新建字典 ${rows.length} 筆超過批次上限 ${BATCH_MAX}`);
      const h = confirm.hashPayload({ action: 'dict-batch', base, user: user.userId, draft_id, rows });
      if (!confirm_token) {
        return { plan: { action: '批次新增字典', site: base, user_id: user.userId, dept_no: user.deptNo, scope: 'dept', rows }, confirm_token: confirm.issue('online_dictionary_batch', h),
          next: '請把 plan 給使用者確認，同意後帶 confirm_token 再呼叫一次' };
      }
      confirm.verify('online_dictionary_batch', h, confirm_token);
      const r = await online.callRaw('POST', 'api/v2/dictionaries/batch', { body: { rows } }, '批次新增字典');
      if (r.status !== 200) mapWriteError(r, '批次新增字典');
      const results = Array.isArray(r.json && r.json.results) ? r.json.results : [];
      const done = [], warnings = [];
      results.forEach((x, i) => {
        const name = rows[i] && rows[i].dicName;
        if (x && x.ok && x.id && name) { done.push({ name, id: String(x.id), action: x.action, bound_itemids: bindDictionary(d, name, { id: String(x.id), dicType: user.deptNo, dicName: name, dicComment: rows[i].dicComment, createUser: user.userId }) }); }
        else warnings.push(`「${name || '?'}」未建立：${(x && x.code) || '?'} ${(x && x.message) || ''}`);
      });
      return { total: rows.length, succeeded: done.length, done, pending_left: d.pendingDictionaries.map(p => p.name), warnings };
    }
  }
,
  {
    name: 'online_me_notes_get',
    description: '（online，唯讀）登入者在 struNote（行動紀錄 APP，/strucmed/note/）的表單清單（GET api/v2/me/notes）：items[{ template_id, name }]。擁有者一律是 token 的使用者。',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const r = await online.call('GET', 'api/v2/me/notes', {}, '讀取 struNote 清單');
      const items = Array.isArray(r && r.items) ? r.items : [];
      return { fill_id: (r && r.fillID) || null, count: items.length, items: items.map(x => ({ template_id: String(x.dictID || ''), name: String(x.dictVal || '') })) };
    }
  },
  {
    name: 'online_me_notes_set',
    description: '（online，寫入 struNote 清單）整份取代登入者的 struNote 表單清單（PUT api/v2/me/notes，最多 500 筆；B2 的 H1 做法：把已上架的範本加進既有 struNote）。' +
      '兩段式：第一次不帶 confirm_token，會先讀目前清單並回 plan（新增／移除／保留的差異），**plan 必須給使用者確認**；同意後帶 confirm_token 再呼叫一次。' +
      '建議用 add／remove 做增量，items 則是整份指定。',
    inputSchema: { type: 'object', properties: {
      items: { type: 'array', items: { type: 'object', required: ['template_id', 'name'], properties: { template_id: str('範本 ID'), name: str('顯示名稱（≤4000 字）') } }, description: '整份清單（與 add／remove 擇一）' },
      add: { type: 'array', items: { type: 'object', required: ['template_id', 'name'], properties: { template_id: str('範本 ID'), name: str('顯示名稱') } }, description: '要加入的範本（已存在則更新名稱）' },
      remove: { type: 'array', items: { type: 'string' }, description: '要移除的範本 ID' },
      confirm_token: str('第二次呼叫帶入') } },
    async handler({ items, add, remove, confirm_token }) {
      const user = online.currentUser();
      const base = online.baseUrl();
      const cur = await online.call('GET', 'api/v2/me/notes', {}, '讀取 struNote 清單');
      const current = (Array.isArray(cur && cur.items) ? cur.items : []).map(x => ({ template_id: String(x.dictID || ''), name: String(x.dictVal || '') }));
      const norm = x => { const id = checkId(x && x.template_id, 'template_id'); const name = String(x && x.name || '').trim(); if (!name) fail(E.INVALID_INPUT, `${id} 缺少 name`); if (name.length > 4000) fail(E.INVALID_INPUT, `${id} 的 name 超過 4000 字`); return { template_id: id, name }; };
      let next;
      if (Array.isArray(items)) next = items.map(norm);
      else {
        next = current.slice();
        for (const a of (Array.isArray(add) ? add : []).map(norm)) { const i = next.findIndex(x => x.template_id === a.template_id); if (i >= 0) next[i] = a; else next.push(a); }
        const rm = new Set((Array.isArray(remove) ? remove : []).map(x => checkId(x, 'remove[]')));
        next = next.filter(x => !rm.has(x.template_id));
      }
      const seen = new Set();
      next = next.filter(x => { if (seen.has(x.template_id)) return false; seen.add(x.template_id); return true; });
      if (next.length > 500) fail(E.LIMIT, `清單 ${next.length} 筆超過上限 500`);
      const curIds = new Set(current.map(x => x.template_id)), nextIds = new Set(next.map(x => x.template_id));
      const diff = { added: next.filter(x => !curIds.has(x.template_id)), removed: current.filter(x => !nextIds.has(x.template_id)),
        renamed: next.filter(x => curIds.has(x.template_id) && current.find(c => c.template_id === x.template_id).name !== x.name), kept: next.filter(x => curIds.has(x.template_id)).length };
      const body = { items: next.map(x => ({ dictID: x.template_id, dictVal: x.name })) };
      const h = confirm.hashPayload({ action: 'me-notes-set', base, user: user.userId, body });
      if (!confirm_token) {
        if (!diff.added.length && !diff.removed.length && !diff.renamed.length) return { plan: null, no_change: true, current, next: '清單沒有變化，不需要寫入' };
        return { plan: { action: '整份取代 struNote 表單清單', site: base, user_id: user.userId, before: current.length, after: next.length, ...diff, items: next },
          confirm_token: confirm.issue('online_me_notes_set', h), next: '請把 plan（新增／移除／改名）給使用者確認，同意後帶 confirm_token 再呼叫一次' };
      }
      confirm.verify('online_me_notes_set', h, confirm_token);
      const r = await online.callRaw('PUT', 'api/v2/me/notes', { body }, '寫入 struNote 清單');
      if (r.status !== 200) mapWriteError(r, '寫入 struNote 清單');
      return { fill_id: (r.json && r.json.fillID) || null, count: (r.json && r.json.count) ?? next.length, items: next };
    }
  }
];

// 字典建立成功後：綁回 draft 控制項、移出待新建、更新本機索引（讓 form_validate 的 dicid 檢查通過）
function bindDictionary(d, name, entry) {
  const bound = [];
  walk(d, n => { if (isControl(n) && n.dictionary === name && !n.dicid) { n.dicid = entry.id; n.dicrole = n.dicrole || 'tohis'; bound.push(n.itemid); } });
  d.pendingDictionaries = (d.pendingDictionaries || []).filter(p => p.name !== name);
  if (Array.isArray(d.touched)) for (const id of bound) if (!d.touched.map(String).includes(String(id))) d.touched.push(id);
  store.saveDraft(d);
  let idx = store.loadDictIndex();
  if (!idx) idx = { loadedAt: new Date().toISOString(), source: 'online dictionary create', deptNo: d.meta.dept_no, hasIds: true, entries: [], deleted: 0, warnings: [], duplicates: [] };
  if (!idx.entries.some(e => e.id === entry.id)) idx.entries.push({ ...entry, createDate: new Date().toISOString().slice(0, 10).replace(/-/g, '') });
  store.saveDictIndex(idx);
  return bound;
}
