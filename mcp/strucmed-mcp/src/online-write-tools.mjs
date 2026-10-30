// Online write tools：經 strucmed API v2 新建／更新範本、建立字典、讀版本。
// 安全姿態（references/SecurityInvariants.md）：
//   - 每個寫入都是兩段式：第一次回 plan（給使用者看），第二次帶 confirm_token；token 綁定站台、登入者、draft 內容與參數
//   - 第二次呼叫還要使用者在瀏覽器確認頁按「確認寫入」（approve.mjs，2.3.0）；確認只能用一次，還沒按時回 pending、不寫入
//   - 寫入不重試（伺服器端也不重試；502 pending 時提示不要重複保存）
//   - 不提供 trash／字典刪除／硬刪除；update 只允許「來源就是該範本」的 draft，且帶 If-Match；名稱／捷徑／作業別預設沿用線上值
//   - feature flags：templateUpdate（online_template_update）、dictionaryWrite（online_dictionary_create／batch／memo_set／memo_batch）
//   - 字典說明是 JSON 容器（dictcomment.mjs，docs/14）：新建時一次寫好 desc＋memo；memo_set 帶 If-Match（etag），409 回目前內容讓 AI 合併後重來；體系升級／降級只由體系字典管理者在字典頁操作（寫入 sys 標記，id 不變），不提供 MCP 工具
import { E, fail } from './errors.mjs';
import * as store from './store.mjs';
import * as confirm from './confirm.mjs';
import * as approve from './approve.mjs';
import * as online from './online.mjs';
import { validateDraft } from './validate.mjs';
import { buildArtifacts } from './export.mjs';
import { folderCode } from './package.mjs';
import { walk, isControl } from './formtree.mjs';
import { digestForm, diffDigest, describeDiff } from './formdiff.mjs';
import * as dc from './dictcomment.mjs';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const WRITE_FOLDERS = ['usr', 'sub', 'dpt'];           // sys 需 V2:SystemListAdmins，本工具一律不寫
const MAX_BODY_CHARS = 2 * 1024 * 1024;                 // TemplateWriteService.MaxContentBytes
const BATCH_MAX = 500;                                  // V2:DictionaryBatchMax 預設
const MEMO_BATCH_MAX = 100;                             // V2:MemoBatchMax 預設
const MEMO_FALLBACK_MAX = 15;                           // 舊站台逐本寫入：寫入頻率每分鐘 20 次

const draftHash = d => { const { updated, created, exported, ...rest } = d; return confirm.hashPayload(rest); };   // exported：匯出紀錄，不算表單內容
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

// update 要寫入的名稱／捷徑／作業別／Info：draft 明確設定過（form_import 參數、form_update_meta）的欄位用 draft 值，其餘沿用線上值。
// 伺服器 PUT 一律以 body.template 改寫 HIS 清單項目，捷徑或作業別變空＝從 HIS 清單消失，所以預設不覆寫。
const META_KEYS = ['name', 'shortcut', 'groups', 'description'];
const META_LABEL = { name: '名稱', shortcut: '捷徑', groups: '作業別', description: 'Info' };
const sameMeta = (k, x, y) => k === 'groups' ? JSON.stringify([...(x || [])].sort()) === JSON.stringify([...(y || [])].sort()) : String(x ?? '') === String(y ?? '');
const shown = v => [].concat(v).join('、') || '（空白）';
function chooseMeta(d, draftMeta, onlineTpl) {
  const t = onlineTpl || {};
  const online = { name: String(t.name || ''), shortcut: String(t.shortcut || '').toLowerCase(), groups: Array.isArray(t.groups) ? t.groups.map(String) : [], description: String(t.description || '') };
  const set = new Set(d.metaSet || []);
  const write = {}, meta = {}, warnings = [];
  for (const k of META_KEYS) {
    write[k] = set.has(k) ? draftMeta[k] : online[k];
    meta[k] = { online: online[k], draft: draftMeta[k], will_write: write[k] };
    if (!set.has(k) && !sameMeta(k, draftMeta[k], online[k])) warnings.push(`W_META_KEPT_ONLINE：draft 的${META_LABEL[k]}與線上不同但沒有明確修改，沿用線上值「${shown(online[k])}」；要改請 form_update_meta`);
  }
  if (!write.name) write.name = draftMeta.name;
  meta.name.will_write = write.name;
  if (!sameMeta('name', write.name, online.name)) warnings.push(`W_META_RENAME：範本會改名「${online.name}」→「${write.name}」`);
  const listed = !!(online.shortcut && online.groups.length), unlisted = listed && !(write.shortcut && write.groups.length);
  if (unlisted) warnings.push(`W_UNPUBLISH：寫入後${[!write.shortcut && '捷徑', !write.groups.length && '作業別'].filter(Boolean).join('與')}是空的，範本會從 HIS 清單消失`);
  for (const k of ['shortcut', 'groups', 'description'])
    if (!sameMeta(k, write[k], online[k]) && !(unlisted && k !== 'description')) warnings.push(`W_META_CHANGED：${META_LABEL[k]}會改為「${shown(write[k])}」（線上「${shown(online[k])}」）`);
  return { write, meta, warnings, changed: META_KEYS.some(k => !sameMeta(k, write[k], online[k])) };
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
      '第二次呼叫會在瀏覽器開啟寫入確認頁，使用者按「確認寫入」才寫入；還沒按時回 pending（附 approve_url），請使用者在頁面確認後帶同一個 confirm_token 再呼叫一次。' +
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
        const plan = { action: '新增範本', folder_type, folder_code: folderCode(folder_type, user.deptNo, user.userId), ...planCommon(d, v, built, user, base) };
        approve.offer('online_template_create', h, '新增範本', plan);
        return {
          plan,
          confirm_token: confirm.issue('online_template_create', h),
          next: '請把 plan 給使用者確認（閘門 G3），同意後帶 confirm_token 再呼叫一次'
        };
      }
      confirm.verify('online_template_create', h, confirm_token);
      const ok = await approve.awaitApproval('online_template_create', h);
      if (ok.pending) return ok;
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
    description: '（online，寫入範本，flag templateUpdate）更新線上既有範本（PUT api/v2/templates/{id}，If-Match）。只允許 draft 的來源就是該範本（derivedFrom.templateID＝template_id）：' +
      'online_template_get(save:true) 的套件，或 iot 的 templateID／sheetid 等於線上 ID 的 .htm，以 form_import（建議帶 for_update:true）載入。' +
      '名稱、捷徑、作業別、Info 預設沿用線上值，只有 draft 明確修改過的欄位才覆寫（plan.meta 並列線上／draft／寫入值；W_META_RENAME、W_UNPUBLISH 要特別提醒使用者）。' +
      'plan.diff 逐項比對內容：這次會寫入的變更（新增／移除／修改的控制項、區塊版面與說明文字、表單 JS、iot），以及線上自來源後被改的地方（W_ONLINE_CHANGED_SINCE_SOURCE：更新會蓋掉）。' +
      '兩段式：第一次呼叫讀線上目前版本取得 If-Match（ETag）並回 plan；**plan 必須原樣給使用者確認**，同意後帶 confirm_token 與 plan 的 if_match 再呼叫一次。' +
      '線上內容或名稱等在取得計畫後被修改 → E_CONFLICT 或 E_CONFIRM_MISMATCH，必須重新取得計畫。寫入不重試。' +
      '第二次呼叫會在瀏覽器開啟寫入確認頁，使用者按「確認寫入」才寫入；還沒按時回 pending（附 approve_url），請使用者在頁面確認後帶同一個 confirm_token 再呼叫一次。',
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
        fail(E.INVALID_INPUT, `這個 draft 不是以範本 ${id} 改版而來（derivedFrom=${from ? from.templateID || '（無）' : '（無）'}）；更新只允許來源就是該範本的 draft（online_template_get(save:true) 或 iot templateID＝${id} 的 .htm → form_import），否則請用 online_template_create 新建`);
      if (confirm_token && !stripEtag(if_match)) fail(E.INVALID_INPUT, '第二次呼叫必須帶 plan 的 if_match');
      // 兩段都讀線上目前版本：ETag、名稱等 meta 與內容差異都以當下為準；第二段與計畫不同時不開確認頁
      const cur = await online.callRaw('GET', `api/v2/templates/${id}`, {}, '讀取線上範本');
      if (cur.status !== 200) mapWriteError(cur, '讀取線上範本');
      const etag = stripEtag(cur.etag) || String((cur.json && cur.json.integrity && cur.json.integrity.sha256) || '');
      if (!etag) fail(E.UPSTREAM, '線上範本沒有 ETag，無法安全更新');
      if (confirm_token && stripEtag(if_match) !== etag)
        fail(E.CONFLICT, '線上範本在取得計畫後已被修改（ETag 不同）；請重新 online_template_get（save:true）→ form_import 後再改版', { currentSha256: etag });
      const m = chooseMeta(d, body.template, cur.json && cur.json.template);
      body.template = m.write;
      // iot 的 ID 沿用線上範本（伺服器寫入時也會補回，這裡不依賴它）；d_url 沿用來源
      const iot = body.form.find(x => x && x.itemtype === 'iot');
      if (iot) Object.assign(iot, { sheetid: id, templateID: id, d_url: String((d.source.iot && d.source.iot.d_url) || '') });
      const h = confirm.hashPayload({ action: 'update', base, user: user.userId, draft: draftHash(d), template_id: id, if_match: etag, meta: m.meta });
      if (!confirm_token) {
        const now = digestForm((cur.json && cur.json.form) || []), next = digestForm(body.form);
        const upd = diffDigest(now, next);
        const since = d.source.digest ? diffDigest(d.source.digest, now) : null;
        const warnings = [...m.warnings];
        if (since && !since.empty) warnings.push(`W_ONLINE_CHANGED_SINCE_SOURCE：線上版在你取得來源之後被改過（${describeDiff(since)}），這次更新會蓋掉這些修改；請確認，或重新 online_template_get(save:true) 再改版`);
        if (upd.empty && !m.changed) warnings.push('W_NO_CHANGE：內容與名稱等都和線上相同，更新只會多一個版本');
        const { empty, ...changes } = upd;
        const diff = { online_name: cur.json && cur.json.template && cur.json.template.name, online_sha256: etag,
          controls_before: Object.keys(now.controls).length, controls_after: Object.keys(next.controls).length,
          ...changes, summary: describeDiff(upd) || '（內容沒有變動）', touched_itemids: (d.touched || []).map(String),
          online_since_source: since ? (since.empty ? '（沒有變動）' : describeDiff(since)) : '（來源不是線上範本套件，無法判斷線上是否被改過；上面列出的就是這次會蓋掉的全部差異）' };
        const common = planCommon(d, v, built, user, base);
        const plan = { action: `更新範本 ${id}`, template_id: id, if_match: etag, meta: m.meta, diff, ...common,
          name: m.write.name, shortcut: m.write.shortcut, groups: m.write.groups, description: m.write.description,
          publish_on_save: !!(m.write.shortcut && m.write.groups.length), warnings: [...warnings, ...common.warnings] };
        approve.offer('online_template_update', h, `更新範本 ${id}`, plan);
        return {
          plan,
          confirm_token: confirm.issue('online_template_update', h),
          next: '請把 plan 給使用者確認（閘門 G3；特別是 meta 的名稱／捷徑／作業別、diff，以及 W_UNPUBLISH、W_META_RENAME、W_ONLINE_CHANGED_SINCE_SOURCE），同意後帶 confirm_token 與 if_match 再呼叫一次'
        };
      }
      confirm.verify('online_template_update', h, confirm_token);
      const ok = await approve.awaitApproval('online_template_update', h);
      if (ok.pending) return ok;
      const r = await online.callRaw('PUT', `api/v2/templates/${id}`, { body, headers: { 'If-Match': `"${etag}"` } }, '更新範本');
      if (r.status !== 200) mapWriteError(r, '更新範本');
      const j = r.json || {};
      d.published = { site: base, templateID: id, rev: j.rev, sha256: String(j.sha256 || ''), folder: j.folder, action: 'update', at: new Date().toISOString(), draft_sha256: draftHash(d) };
      store.saveDraft(d);
      const warnings = Array.isArray(j.warnings) ? j.warnings.map(String) : [];
      if (j.diverged) warnings.push('W_DIVERGED：線上內容在上次經 API 保存後曾被其他方式修改，已照常保存並記錄分歧');
      return { template_id: id, rev: j.rev, sha256: d.published.sha256, folder: j.folder, draft_sha256: d.published.draft_sha256, meta: m.write, warnings,
        next: `請以 online_template_versions(${id}) 回報新 rev，並以 online_template_get 取回確認名稱、捷徑、作業別與控制項數` };
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
      'dicComment 以字典 JSON 一次寫好：comment＝desc（一行語意）、memo＝補述（預設用規劃時 dictionary_create／form_add_control 給的）。' +
      '兩段式：先取得 plan 給使用者確認，再帶 confirm_token。同名未刪除字典存在時伺服器回 reused（沿用既有 id）；有自己可還原的同名已刪除字典時回 E_DELETED_EXISTS（候選列在 details），' +
      '**不自動 force**，由使用者決定還原（請管理者在字典頁操作）或帶 force:true 建立新的。成功後把 draft 內使用該名稱的控制項綁上 id、移出待新建清單、更新本機字典索引。' +
      '第二次呼叫會在瀏覽器開啟寫入確認頁，使用者按「確認寫入」才寫入；還沒按時回 pending（附 approve_url），請使用者在頁面確認後帶同一個 confirm_token 再呼叫一次。',
    inputSchema: { type: 'object', required: ['draft_id', 'name'], properties: {
      draft_id: str('draft id'), name: str('待新建字典名稱（必須在 draft 的 pendingDictionaries 內）'), comment: str('一行說明 desc（選填；預設用規劃時的 comment）'),
      memo: { type: 'object', description: '補述（選填；預設用規劃時的 memo）：meaning／type／unit／range／asr／calx／llm／scope' },
      force: { type: 'boolean', description: '有已刪除同名字典時仍建立新的（只在使用者明確決定後帶）' }, confirm_token: str('第二次呼叫帶入') } },
    async handler({ draft_id, name, comment, memo, force, confirm_token }) {
      const user = online.currentUser();
      const base = online.baseUrl();
      const d = store.loadDraft(draft_id);
      const pend = (d.pendingDictionaries || []).find(p => p.name === name);
      if (!pend) fail(E.INVALID_INPUT, `「${name}」不在 draft 的待新建字典清單中`, { pending: (d.pendingDictionaries || []).map(p => p.name) });
      const desc = String(comment !== undefined ? comment : (pend.comment || ''));
      const wanted = memo !== undefined ? (memo ? dc.validateMemo(memo) : null) : (pend.memo || null);
      const { memo: memoObj, warnings: keyWarnings } = forServer(wanted, name);
      const dicComment = dc.build({ desc, memo: memoObj });
      const usedBy = [];
      walk(d, n => { if (isControl(n) && n.dictionary === name && !n.dicid) usedBy.push(n.itemid); });
      const h = confirm.hashPayload({ action: 'dict-create', base, user: user.userId, draft_id, name, dicComment, force: !!force });
      if (!confirm_token) {
        const plan = { action: '新增字典', site: base, user_id: user.userId, dept_no: user.deptNo, scope: 'dept', name, comment: desc, memo: memoObj, dic_comment_json: dicComment, force: !!force, used_by_itemids: usedBy,
          note: '同名未刪除字典存在時會沿用既有（reused），不會重複建立', warnings: [...(desc ? [] : ['W_DICT_NO_DESC：沒有一行說明，字典建立後別人看不懂用途']), ...keyWarnings] };
        approve.offer('online_dictionary_create', h, '新增字典', plan);
        return {
          plan,
          confirm_token: confirm.issue('online_dictionary_create', h),
          next: '請把 plan 給使用者確認，同意後帶 confirm_token 再呼叫一次'
        };
      }
      confirm.verify('online_dictionary_create', h, confirm_token);
      const ok = await approve.awaitApproval('online_dictionary_create', h);
      if (ok.pending) return ok;
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
      '成功的字典會綁回 draft 並更新本機索引；失敗的留在待新建清單並回 warnings（例如 E_DELETED_EXISTS 需改用 online_dictionary_create 逐一決定）。' +
      '第二次呼叫會在瀏覽器開啟寫入確認頁，使用者按「確認寫入」才寫入；還沒按時回 pending（附 approve_url），請使用者在頁面確認後帶同一個 confirm_token 再呼叫一次。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: { draft_id: str('draft id'), confirm_token: str('第二次呼叫帶入') } },
    async handler({ draft_id, confirm_token }) {
      const user = online.currentUser();
      const base = online.baseUrl();
      const d = store.loadDraft(draft_id);
      const keyWarnings = [];
      const rows = (d.pendingDictionaries || []).map(p => {
        const r = forServer(p.memo || null, p.name);
        keyWarnings.push(...r.warnings);
        return { dicName: p.name, dicComment: dc.build({ desc: p.comment || '', memo: r.memo }) };
      });
      if (!rows.length) fail(E.INVALID_INPUT, 'draft 沒有待新建字典');
      if (rows.length > BATCH_MAX) fail(E.LIMIT, `待新建字典 ${rows.length} 筆超過批次上限 ${BATCH_MAX}`);
      const h = confirm.hashPayload({ action: 'dict-batch', base, user: user.userId, draft_id, rows });
      if (!confirm_token) {
        const plan = { action: '批次新增字典', site: base, user_id: user.userId, dept_no: user.deptNo, scope: 'dept',
          rows: (d.pendingDictionaries || []).map(p => ({ name: p.name, comment: p.comment || '', memo: p.memo || null })),
          warnings: [...(d.pendingDictionaries || []).filter(p => !(p.comment || '').trim()).map(p => `W_DICT_NO_DESC：「${p.name}」沒有一行說明`), ...keyWarnings] };
        approve.offer('online_dictionary_batch', h, '批次新增字典', plan);
        return { plan, confirm_token: confirm.issue('online_dictionary_batch', h),
          next: '請把 plan 給使用者確認，同意後帶 confirm_token 再呼叫一次' };
      }
      confirm.verify('online_dictionary_batch', h, confirm_token);
      const ok = await approve.awaitApproval('online_dictionary_batch', h);
      if (ok.pending) return ok;
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
  },
  {
    name: 'online_dictionary_memo_set',
    flag: 'dictionaryWrite',
    description: '（online，寫入字典補述，flag dictionaryWrite）更新一本字典的補述 memo 與 FHIR 對應 fhir（PUT api/v2/dictionaries/{id}/memo，If-Match: etag）。任何登入者都能寫，不會動到 desc（只有原作者或體系管理者能改 desc）。' +
      'memo 是「補充」：保留既有鍵、只覆寫有給的鍵（值給 "" 表示清除）；fhir 有給就整組取代。送出前在本機先做與平台相同的格式檢查（E_INVALID_FHIR；datatype 與 FHIR 型別不一致只警告 W_FHIR_TYPE_MISMATCH）。' +
      '兩段式：第一次呼叫讀線上目前內容，回 plan（改前 before／改後 after／etag）給使用者確認；同意後帶 confirm_token 與 plan 的 etag 再呼叫一次。' +
      '線上在取得計畫後被他人修改 → E_CONFLICT，details.current 是目前內容，請合併後重新取得計畫。第二次呼叫會在瀏覽器開啟寫入確認頁，使用者按「確認寫入」才寫入。',
    inputSchema: { type: 'object', required: ['dic_id'], properties: {
      dic_id: str('字典 id'), draft_id: str('選填：publish-form 合併在 G3 時帶入對應的 draft（hooks 會檢查該 draft 的上架計畫核准）'),
      memo: { type: 'object', description: '要補充的 memo 鍵：meaning／type／unit／range／asr（字串陣列）／calx／llm／scope' },
      fhir: { type: 'array', description: 'FHIR 對應（整組取代）：[{ res, path, code?, display?, ucum?, component?, note? }]', items: { type: 'object' } },
      etag: str('第二次呼叫帶入 plan 的 etag'), confirm_token: str('第二次呼叫帶入') } },
    async handler({ dic_id, memo, fhir, etag, confirm_token }) {
      const id = checkId(dic_id, 'dic_id');
      if (memo === undefined && fhir === undefined) fail(E.INVALID_INPUT, 'memo 與 fhir 至少要給一個');
      const user = online.currentUser();
      const base = online.baseUrl();
      const cur = await fetchDictionary(id, user);
      if (cur.dicName.startsWith('__')) fail(E.CONFLICT, `字典「${cur.dicName.slice(2)}」已刪除，不能寫補述`);
      const { after, warnings } = planMemo(cur, memo, fhir, user);
      if (!confirm_token) {
        const h = confirm.hashPayload({ action: 'dict-memo', base, user: user.userId, dic_id: id, etag: cur.etag, memo: memo ?? null, fhir: fhir ?? null });
        const plan = { action: `更新字典補述 ${cur.dicName}`, site: base, user_id: user.userId, dic_id: id, name: cur.dicName, dic_type: cur.dicType, level: dc.LEVEL_LABEL[cur.level] || cur.level,
          desc: cur.desc, before: { memo: cur.memo, fhir: cur.fhir }, after, etag: cur.etag, warnings };
        approve.offer('online_dictionary_memo_set', h, `更新字典補述 ${cur.dicName}`, plan);
        return { plan, confirm_token: confirm.issue('online_dictionary_memo_set', h), next: '請把 plan（改前／改後）給使用者確認，同意後帶 confirm_token 與 etag 再呼叫一次' };
      }
      const tag = stripEtag(etag);
      if (!tag) fail(E.INVALID_INPUT, '第二次呼叫必須帶 plan 的 etag');
      staleCheck(cur, tag, '更新字典補述');
      const h = confirm.hashPayload({ action: 'dict-memo', base, user: user.userId, dic_id: id, etag: tag, memo: memo ?? null, fhir: fhir ?? null });
      confirm.verify('online_dictionary_memo_set', h, confirm_token);
      const ok = await approve.awaitApproval('online_dictionary_memo_set', h);
      if (ok.pending) return ok;
      const body = {};
      if (memo !== undefined) body.memo = after.memo || {};
      if (fhir !== undefined) body.fhir = after.fhir;
      const r = await online.callRaw('PUT', `api/v2/dictionaries/${id}/memo`, { body, headers: { 'If-Match': `"${tag}"` } }, '更新字典補述');
      if (r.status !== 200) mapDictError(r, '更新字典補述');
      const j = r.json || {};
      const entry = updateIndexFromResponse(id, j, user);
      return { id, name: entry.dicName, level: entry.level, desc: entry.desc, memo: entry.memo, fhir: entry.fhir, memo_by: String(j.memoBy || user.userId), memo_at: String(j.memoAt || ''), etag: entry.etag,
        warnings: [...warnings, ...(Array.isArray(j.warnings) ? j.warnings.map(String) : [])] };
    }
  }
,
  {
    name: 'online_dictionary_memo_batch',
    flag: 'dictionaryWrite',
    description: '（online，寫入字典補述，flag dictionaryWrite）一次補多本字典的補述 memo 與 FHIR 對應（PUT api/v2/dictionaries/memo/batch，最多 100 本；逐本 If-Match）。' +
      'dictionary-assist 的「既有表單補述」用：合併規則與 online_dictionary_memo_set 相同（memo 保留既有鍵、只覆寫有給的鍵，值給 "" 清除；fhir 有給就整組取代）。' +
      '兩段式：第一次呼叫讀線上目前內容，plan 逐本列改前／改後與 etag（內容沒變的列在 no_change、不寫）；**plan 必須給使用者確認**，同意後帶 confirm_token 與 plan 的 etags 再呼叫一次。' +
      '第二次呼叫若有字典在取得計畫後被改 → E_CONFLICT（details.stale 附目前內容，不開確認頁），請合併後重取計畫；否則開瀏覽器寫入確認頁，使用者按「確認寫入」才寫入，逐本回報成功或衝突。' +
      '站台沒有批次端點時改為逐本寫入（最多 15 本，W_SERVER_OLD）。站台不支援 func／usecase／interop 時會略過並回 W_SERVER_OLD_MEMO_KEYS。',
    inputSchema: { type: 'object', required: ['items'], properties: {
      items: { type: 'array', description: '[{ dic_id, memo?, fhir? }]，1–100 本', items: { type: 'object', required: ['dic_id'], properties: {
        dic_id: str('字典 id'), memo: { type: 'object', description: '要補充的鍵：meaning／type／unit／range／func／usecase／interop／asr／calx／llm／scope' },
        fhir: { type: 'array', items: { type: 'object' }, description: 'FHIR 對應（整組取代）' } } } },
      draft_id: str('選填：補述計畫對應的 draft（hooks 會檢查 .strucmed/plans/<draft_id>/memo-plan.md 或 publish-plan.md 的核准）'),
      etags: { type: 'object', description: '第二次呼叫帶入 plan 的 etags（{ dic_id: etag }）' }, confirm_token: str('第二次呼叫帶入') } },
    async handler({ items, etags, confirm_token }) {
      if (!Array.isArray(items) || !items.length) fail(E.INVALID_INPUT, 'items 至少一本');
      if (items.length > MEMO_BATCH_MAX) fail(E.LIMIT, `一次最多 ${MEMO_BATCH_MAX} 本`);
      const ids = items.map(x => checkId(x && x.dic_id, 'items[].dic_id'));
      if (new Set(ids).size !== ids.length) fail(E.INVALID_INPUT, '同一本字典在 items 中出現多次');
      for (const x of items) if (x.memo === undefined && x.fhir === undefined) fail(E.INVALID_INPUT, `${x.dic_id}：memo 與 fhir 至少要給一個`);
      const user = online.currentUser();
      const base = online.baseUrl();
      const curs = await fetchDictionaries(ids, user);
      const rows = [], noChange = [], warnings = [];
      items.forEach((x, i) => {
        const cur = curs[i];
        if (cur.dicName.startsWith('__')) fail(E.CONFLICT, `字典「${cur.dicName.slice(2)}」已刪除，不能寫補述`);
        const { after, warnings: w } = planMemo(cur, x.memo, x.fhir, user);
        const same = JSON.stringify(after.memo || null) === JSON.stringify(cur.memo || null) && JSON.stringify(after.fhir || []) === JSON.stringify(cur.fhir || []);
        if (same) { noChange.push({ dic_id: cur.id, name: cur.dicName }); return; }
        rows.push({ cur, given: x, after, warnings: w });
      });
      if (!rows.length) return { plan: null, no_change: noChange, next: '補述都與線上相同，不需要寫入' };
      const payload = rows.map(r => ({ id: r.cur.id, etag: r.cur.etag, ...(r.given.memo !== undefined && { memo: r.after.memo || {} }), ...(r.given.fhir !== undefined && { fhir: r.after.fhir }) }));
      const h = confirm.hashPayload({ action: 'dict-memo-batch', base, user: user.userId, items: payload });
      if (!confirm_token) {
        for (const r of rows) warnings.push(...r.warnings.map(w => `${r.cur.dicName}：${w}`));
        const plan = { action: `批次更新字典補述（${rows.length} 本）`, site: base, user_id: user.userId,
          rows: rows.map(r => ({ dic_id: r.cur.id, name: r.cur.dicName, dic_type: r.cur.dicType, level: dc.LEVEL_LABEL[r.cur.level] || r.cur.level, desc: r.cur.desc,
            memo_by: r.cur.memo_by || '', memo_at: r.cur.memo_at || '', before: { memo: r.cur.memo, fhir: r.cur.fhir }, after: r.after })),
          etags: Object.fromEntries(rows.map(r => [r.cur.id, r.cur.etag])), no_change: noChange, warnings };
        approve.offer('online_dictionary_memo_batch', h, `批次更新字典補述（${rows.length} 本）`, plan);
        return { plan, etags: plan.etags, confirm_token: confirm.issue('online_dictionary_memo_batch', h),
          next: '請把 plan（逐本改前／改後）給使用者確認，同意後帶 confirm_token 與 etags 再呼叫一次' };
      }
      // 第二次呼叫：取得計畫後被改的字典先擋下（不開確認頁），附目前內容讓 AI 合併後重取計畫
      const planned = etags && typeof etags === 'object' ? etags : {};
      const stale = rows.filter(r => stripEtag(planned[r.cur.id]) !== r.cur.etag);
      if (stale.length) fail(E.CONFLICT, `有 ${stale.length} 本字典在取得計畫後已被修改（或沒有帶 plan 的 etags）；請以 details.stale 合併後重新取得計畫`,
        { stale: stale.map(r => ({ dic_id: r.cur.id, name: r.cur.dicName, etag: r.cur.etag, current: { desc: r.cur.desc, memo: r.cur.memo, fhir: r.cur.fhir } })) });
      confirm.verify('online_dictionary_memo_batch', h, confirm_token);
      const ok = await approve.awaitApproval('online_dictionary_memo_batch', h);
      if (ok.pending) return ok;
      const r = await online.callRaw('PUT', 'api/v2/dictionaries/memo/batch', { body: { items: payload } }, '批次更新字典補述');
      const results = [];
      if (r.status === 404 || (r.status === 403 && r.json && r.json.error && r.json.error.code === 'E_FORBIDDEN')) {
        // 舊站台沒有批次端點：逐本寫入（寫入頻率每分鐘 20 次，最多 15 本）
        if (payload.length > MEMO_FALLBACK_MAX) fail(E.UPSTREAM, `W_SERVER_OLD：站台沒有補述批次端點；逐本寫入一次最多 ${MEMO_FALLBACK_MAX} 本，請分批（這次 ${payload.length} 本）`);
        for (const x of payload) {
          const one = await online.callRaw('PUT', `api/v2/dictionaries/${x.id}/memo`, { body: { ...(x.memo !== undefined && { memo: x.memo }), ...(x.fhir !== undefined && { fhir: x.fhir }) }, headers: { 'If-Match': `"${x.etag}"` } }, '更新字典補述');
          const err = (one.json && one.json.error) || {};
          if (one.status === 200) { const e = updateIndexFromResponse(x.id, one.json || {}, user); results.push({ dic_id: x.id, name: e.dicName, ok: true, etag: e.etag }); }
          else results.push({ dic_id: x.id, ok: false, code: err.code || `HTTP ${one.status}`, message: String(err.message || '').slice(0, 200), current: err.details && err.details.current });
        }
        warnings.push('W_SERVER_OLD：站台沒有補述批次端點，已改為逐本寫入');
      } else {
        if (r.status !== 200) mapDictError(r, '批次更新字典補述');
        for (const x of (Array.isArray(r.json && r.json.results) ? r.json.results : [])) {
          if (x && x.ok && x.item) { const e = updateIndexFromResponse(String(x.id), x.item, user); results.push({ dic_id: String(x.id), name: e.dicName, ok: true, etag: e.etag }); }
          else results.push({ dic_id: String(x && x.id || ''), ok: false, code: x && x.code, message: String(x && x.message || '').slice(0, 200), current: x && x.details && x.details.current });
        }
      }
      const failed = results.filter(x => !x.ok);
      if (failed.some(x => x.code === 'E_CONFLICT')) warnings.push('W_PARTIAL_CONFLICT：有字典在寫入前被他人修改（results 的 current 是目前內容）；請合併後只對這些字典重新取得計畫');
      return { total: payload.length, succeeded: results.length - failed.length, results, no_change: noChange, warnings };
    }
  },
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
      '第二次呼叫會在瀏覽器開啟寫入確認頁，使用者按「確認寫入」才寫入；還沒按時回 pending（附 approve_url），請使用者在頁面確認後帶同一個 confirm_token 再呼叫一次。' +
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
        const plan = { action: '整份取代 struNote 表單清單', site: base, user_id: user.userId, before: current.length, after: next.length, ...diff, items: next };
        approve.offer('online_me_notes_set', h, '更新 struNote 表單清單', plan);
        return { plan,
          confirm_token: confirm.issue('online_me_notes_set', h), next: '請把 plan（新增／移除／改名）給使用者確認，同意後帶 confirm_token 再呼叫一次' };
      }
      confirm.verify('online_me_notes_set', h, confirm_token);
      const ok = await approve.awaitApproval('online_me_notes_set', h);
      if (ok.pending) return ok;
      const r = await online.callRaw('PUT', 'api/v2/me/notes', { body }, '寫入 struNote 清單');
      if (r.status !== 200) mapWriteError(r, '寫入 struNote 清單');
      return { fill_id: (r.json && r.json.fillID) || null, count: (r.json && r.json.count) ?? next.length, items: next };
    }
  }
];

// 讀字典的目前內容：先線上 GET api/v2/dictionaries（scope match，含 etag／level）；不在比對範圍內的（他科、他體系）以本機索引的名稱查 scope=all。
// 都找不到時，單本退回本機索引（舊行為），批次則回 E_NOT_FOUND。回 dictcomment.fromItem 形狀（與 ids 同順序）。
async function fetchDictionaries(ids, user, { allowLocal = false } = {}) {
  const r = await online.call('GET', 'api/v2/dictionaries', { query: { scope: 'match' } }, '讀取字典');
  store.rememberMemoKeys(Array.isArray(r && r.memoKeys) ? r.memoKeys : dc.LEGACY_MEMO_KEYS);
  const deptNo = String((r && r.deptNo) || user.deptNo);
  const byId = new Map((Array.isArray(r && r.items) ? r.items : []).map(d => [String(d.id), d]));
  const idx = store.loadDictIndex();
  const local = id => idx && idx.entries.find(x => x.id === id);
  for (const id of ids) {
    if (byId.has(id) || !local(id) || !local(id).dicName) continue;
    const q = local(id).dicName.slice(0, 50);
    const a = await online.callRaw('GET', 'api/v2/dictionaries', { query: { scope: 'all', q } }, '讀取字典');
    if (a.status === 200) for (const d of (Array.isArray(a.json && a.json.items) ? a.json.items : [])) if (!byId.has(String(d.id))) byId.set(String(d.id), d);
  }
  return ids.map(id => {
    const hit = byId.get(id);
    if (hit) {
      if (hit.etag === undefined) fail(E.UPSTREAM, 'W_SERVER_OLD：站台尚未支援字典 JSON 說明（回應沒有 etag），無法寫補述');
      const e = dc.fromItem(hit, deptNo);
      upsertIndex(e, deptNo);
      return e;
    }
    if (allowLocal && local(id)) return dc.enrich(local(id), deptNo);
    fail(E.NOT_FOUND, `找不到字典 ${id}：線上查不到（id 不正確，或不在登入科部的比對範圍內且本機索引沒有它的名稱）`);
  });
}
async function fetchDictionary(id, user) { return (await fetchDictionaries([id], user, { allowLocal: true }))[0]; }

// 站台接受的補述欄位：最近一次 GET api/v2/dictionaries 回報的 memoKeys；沒有回報＝舊站台（8 個鍵）
function forServer(memo, name) {
  const { memo: kept, dropped } = dc.restrictMemo(memo, store.serverMemoKeys() || dc.LEGACY_MEMO_KEYS);
  return { memo: kept, warnings: dropped.length ? [`W_SERVER_OLD_MEMO_KEYS：站台還不支援補述欄位 ${dropped.map(k => `${k}（${dc.MEMO_LABEL[k] || k}）`).join('、')}，「${name}」的這些內容不會寫入`] : [] };
}
// 補述的改後內容（memo 補充合併、fhir 整組取代、只留站台接受的鍵、長度檢查）：memo_set 與批次共用
function planMemo(cur, memo, fhir, user) {
  const merged = memo !== undefined ? dc.mergeMemo(cur.memo, memo) : cur.memo;
  const { memo: kept, warnings } = forServer(merged, cur.dicName);
  const after = { memo: kept, fhir: fhir !== undefined ? (fhir ? fhir : []) : cur.fhir };
  const fv = dc.validateFhir(after.fhir || [], after.memo && after.memo.type);
  after.fhir = fv.fhir;
  warnings.push(...fv.warnings);
  const nextRaw = dc.build({ desc: cur.desc, memo: after.memo, fhir: after.fhir, memo_by: user.userId, memo_at: new Date().toISOString(), sys: cur.sys, promote: cur.promote, alias_of: cur.alias_of }, { forceJson: true });
  if (dc.checkLength(nextRaw) > dc.MAX_CHARS * 0.9) warnings.push('W_DICT_COMMENT_NEAR_LIMIT：寫入後接近長度上限');
  return { after, warnings };
}
function upsertIndex(e, deptNo) {
  let idx = store.loadDictIndex();
  if (!idx) idx = { loadedAt: new Date().toISOString(), source: 'online dictionary', deptNo, hasIds: true, entries: [], deleted: 0, warnings: [], duplicates: [] };
  const i = idx.entries.findIndex(x => x.id === e.id);
  if (i >= 0) idx.entries[i] = { ...idx.entries[i], ...e }; else idx.entries.push(e);
  store.saveDictIndex(idx);
  return e;
}
function updateIndexFromResponse(id, j, user) {
  const e = dc.fromItem({ id, dicType: j.dicType, dicName: j.dicName, dicComment: j.dicComment, createUser: j.createUser, createDate: j.createDate,
    desc: j.desc, memo: j.memo, fhir: j.fhir, sys: j.sys, promote: j.promote, aliasOf: j.aliasOf, etag: j.etag, level: j.level }, user.deptNo);
  return upsertIndex(e, user.deptNo);
}
// 第二次呼叫時線上內容已不是取得計畫時的版本 → 不開確認頁，直接回目前內容讓 AI 合併後重新取得計畫
function staleCheck(cur, tag, what) {
  if (cur.etag === tag) return;
  fail(E.CONFLICT, `${what}：字典「${cur.dicName}」在取得計畫後已被修改；請以 details.current 合併後重新取得計畫`,
    { etag: cur.etag, current: { desc: cur.desc, sys: cur.sys, memo: cur.memo, fhir: cur.fhir, aliasOf: cur.alias_of } });
}
// 字典補述的伺服器錯誤 → 本工具錯誤碼（409 附目前內容讓 AI 合併後重取計畫）
function mapDictError(r, what) {
  const err = (r.json && typeof r.json.error === 'object' && r.json.error) || {};
  const det = { status: r.status, path: r.path, code: err.code, details: err.details };
  const msg = err.message ? `：${String(err.message).slice(0, 300)}` : '';
  if (r.status === 400 && err.code === 'E_INVALID_FHIR') fail(E.INVALID_FHIR, `${what}失敗${msg}`, det);
  if (r.status === 400 && err.code === 'E_LIMIT') fail(E.LIMIT, `${what}失敗${msg}`, det);
  if (r.status === 409) fail(E.CONFLICT, `${what}失敗：線上內容已被他人修改或狀態不符${msg}；請以 details.current 合併後重新取得計畫`,
    { ...det, etag: err.details && err.details.etag, current: err.details && err.details.current });
  if (r.status === 403) fail(E.AUTH, `${what}失敗：沒有權限${msg}`, det);
  if (r.status === 404) fail(E.NOT_FOUND, `${what}失敗：找不到字典${msg}`, det);
  mapWriteError(r, what);
}

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
