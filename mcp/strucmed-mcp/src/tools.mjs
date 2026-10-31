// Tool definitions + handlers (v0.1 scope).
// Everything is offline: no network, no credentials, output only to the local workspace.
import fs from 'node:fs';
import path from 'node:path';
import { E, fail } from './errors.mjs';
import * as store from './store.mjs';
import * as dict from './dictionary.mjs';
import * as dc from './dictcomment.mjs';
import { buildControl, toFormJson, buildStructuredArea, cellKind, AREA_TYPES, FORMTABLE_PATTERNS, DATATYPES_V01, DATATYPES_V02, LABEL_FORMATS, RUNTIME_ROLE } from './model.mjs';
import { validateDraft, scriptFindings, tableControlIds, DEFERRABLE } from './validate.mjs';
import { lintFormula, lintMacro, lintHisQuery, lintPrompt } from './scriptlint.mjs';
import { captions, labelFormula, evaluate, sameValue } from './formula-explain.mjs';
import { preview } from './preview.mjs';
import { writeArtifacts, VERSION } from './export.mjs';
import { cardData } from './cards.mjs';
import * as files from './files.mjs';
import { publicBase, current as requestCurrent } from './reqctx.mjs';
import * as confirm from './confirm.mjs';
import { parseSource, sha256 } from './importer.mjs';
import { digestForm } from './formdiff.mjs';
import { fieldMap, checkMemo, unitOf, refChecks } from './fieldmap.mjs';
import { suggest } from './dictsuggest.mjs';
import { editableItems, findControl, refsTo, maxItemId, walk, isControl } from './formtree.mjs';

const GROUPS = ['門', '住', '急', '手術', '檢查', '助手', 'All'];
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = description => ({ type: 'boolean', description });
const MAX_SOURCE = 10 * 1024 * 1024;
// 路徑與內容擇一：HTTP 模式的呼叫端看不到伺服器的檔案系統，只能直接傳內容。回 true＝用內容。
// 空字串視同未提供：部分 agent 平台會把沒用到的選填參數填成 ''
function useInline(a, pathKey, textKey) {
  const given = v => v !== undefined && v !== null && v !== '';
  if (given(a[pathKey]) === given(a[textKey])) fail(E.INVALID_INPUT, `${pathKey} 與 ${textKey} 必須擇一提供`);
  return given(a[textKey]);
}

function draftHash(d) {
  const { updated, created, exported, ...rest } = d;   // exported：匯出紀錄（下載連結、資源用），不算表單內容
  return confirm.hashPayload(rest);
}
function nextId(d) { return d.nextItemId++; }
// 捷徑一律小寫：編輯器與平台寫入時都會轉（TemplateWriteService.cs、v2-editor.js），這裡保留大小寫也存不下來。有轉換時明講，免得被當成疑點
function shortcutNote(given) {
  const s = String(given ?? '');
  return s === s.toLowerCase() ? {} : { shortcut: s.toLowerCase(), shortcut_note: `捷徑一律存成小寫（平台規則）：${s} → ${s.toLowerCase()}` };
}
function findArea(d, areaId) {
  const a = d.areas.find(x => Number(x.imported ? x.area.itemid : x.itemid) === Number(areaId));
  if (!a) fail(E.NOT_FOUND, `找不到區塊 #${areaId}`);
  return a;
}
// 既有控制項 → buildControl 的輸入格式（修改時以同一套規則驗證新值）
function pickControlInput(n) {
  const opt = Array.isArray(n.option) ? n.option.map(o => (typeof o === 'string' ? o
    : { value: String(o.value), further: String(o.further === undefined ? '' : o.further).split(',').map(s => s.trim()).filter(Boolean).map(Number) })) : undefined;
  const out = { options: opt };
  for (const k of ['multiple', 'row', 'datagroup', 'filter', 'minval', 'maxval', 'numpad', 'format', 'required', 'reference']) {
    if (n[k] !== undefined && n[k] !== '') out[k] = n[k];
  }
  if (typeof n.datavalue === 'string') out.datavalue = n.datavalue;
  return out;
}
// 記錄改了什麼：validate 依類別決定嚴重度（只有被改到的面向才升級為 error）
//   added：新控制項（全面檢查）；label / value / flags / shape / dict：修改的類別
function markTouched(d, itemid, cats) {
  const id = Number(itemid);
  d.touched = d.touched || [];
  if (!d.touched.includes(id)) d.touched.push(id);
  d.touchedFields = d.touchedFields || {};
  d.touchedFields[id] = [...new Set([...(d.touchedFields[id] || []), ...cats])];
}
// v0.2：計算式／巨集／HIS 參照在寫入 draft 前先檢查。語法、函數、模型等錯誤當下拒絕；
// 參照類錯誤（對象可能稍後才建立）延後到 form_validate。
function scriptGate(d, node) {
  const map = new Map();
  walk(d, n => { if (isControl(n)) map.set(String(n.itemid), n); });
  map.set(String(node.itemid), node);
  const r = scriptFindings(node, map, store.loadPolicy(), tableControlIds(d));
  const errs = r.found.filter(f => f.level === 'error');
  const blocking = errs.filter(f => !DEFERRABLE.has(f.code));
  if (blocking.length) fail(E.INVALID_INPUT, `#${node.itemid} 的計算式／巨集有錯誤，未寫入 draft`, { errors: blocking });
  return {
    deferred: errs.map(f => `${f.code}：${f.message}`),
    script_warnings: r.found.filter(f => f.level === 'warn').map(f => `${f.code}：${f.message}`),
    ai: r.ai
  };
}
const hasScript = n => !!(n.formula || n.actionScript || (n.datatype === 'label' && n.format === 'hisquery') || n.furActionID);

// 依字典參照設定控制項的 dictionary / dicid / dicrole（新增與修改共用）
function applyDictionary(d, obj, ref, wantRole, warnings) {
  const res = dict.resolve(store.loadDictIndex(), ref, d.meta.dept_no);
  if (res.warnings) warnings.push(...res.warnings);
  if (res.kind === 'bound') {
    obj.dictionary = res.entry.dicName; obj.dicid = res.entry.id; obj.dicrole = wantRole || 'tohis';
    if (!res.entry.memo) warnings.push(`W_DICT_NO_MEMO：字典「${res.entry.dicName}」（${res.entry.id.slice(0, 8)}…）沒有補述 memo；上架時可用 online_dictionary_memo_set 補上`);
    if (['own', 'sub', 'dpt'].includes(res.entry.level)) warnings.push(`W_DICT_DEPT_LEVEL：字典「${res.entry.dicName}」是${dc.LEVEL_LABEL[res.entry.level]}層級（${res.entry.dicType}）；跨科共用時列入計畫的「體系升級建議」，由體系字典管理者在字典頁升級（id 不變）`);
    prunePending(d, obj);
  } else if (res.kind === 'pending') {
    obj.dictionary = ref.name; obj.dicid = ''; obj.dicrole = 'tohis';
    if (wantRole && wantRole !== 'tohis') warnings.push(`W_DICT_ROLE_FORCED：新字典匯入後角色一律為 tohis（要求的 ${wantRole} 需匯入後在編輯器手動調整）`);
    addPending(d, obj.dictionary, ref.comment, ref.memo);
    warnings.push(`W_NEW_DICTIONARY：「${obj.dictionary}」將於匯入時新建${res.otherTypes && res.otherTypes.length ? `（其他類別已有同名：${res.otherTypes.join(',')}）` : ''}`);
    if (!(ref.comment || '').trim()) warnings.push(`W_DICT_NO_DESC：新字典「${obj.dictionary}」沒有說明（dictionary.comment）；請在計畫中補一行語意`);
  } else {
    if (wantRole && wantRole !== 'nohis') fail(E.DICT_REQUIRED, `dicrole=${wantRole} 需要綁定字典`);
    obj.dictionary = ''; obj.dicid = ''; obj.dicrole = 'nohis';
    prunePending(d, obj);
  }
}
// 待新建字典清單：{ name, comment（一行語意＝desc）, memo（補述） }；重複加入時保留既有非空內容再補充
function addPending(d, name, comment, memo) {
  dc.checkStorable(name, '字典名稱');
  const cur = d.pendingDictionaries.find(p => p.name === name);
  const m = memo ? dc.validateMemo(memo) : null;
  if (!cur) {
    const entry = { name, comment: String(comment || '').trim(), ...(m && { memo: m }) };
    dc.build({ desc: entry.comment, memo: entry.memo });   // 先確認組起來不會超過長度
    d.pendingDictionaries.push(entry);
    return;
  }
  if (comment !== undefined && String(comment).trim()) cur.comment = String(comment).trim();
  if (m) cur.memo = dc.mergeMemo(cur.memo, m);
  dc.build({ desc: cur.comment, memo: cur.memo });
}
// 綁定既有字典、解除綁定或移除控制項後，把不再被任何「未綁 id」控制項使用的名稱移出待新建清單
// （否則 online_template_create 會一直回 E_DICT_PENDING）。just 是剛改好但可能尚未放進樹的控制項。
function prunePending(d, just) {
  if (!(d.pendingDictionaries || []).length) return;
  const still = new Set();
  walk(d, n => { if (isControl(n) && n !== just && n.dictionary && !n.dicid) still.add(n.dictionary); });
  d.pendingDictionaries = d.pendingDictionaries.filter(p => still.has(p.name));
}
function checkText(t, field) {
  if (t === undefined) return;
  if (typeof t !== 'string') fail(E.INVALID_INPUT, `${field} 必須是字串`);
  if (/[\r\n]/.test(t)) fail(E.INVALID_INPUT, `${field} 不可包含換行，請用 newline_after`);
}

// 平台前端（web/）的本機副本：HTML 預覽與 runtime 驗證需要 TempHtml.html。
// 以 STRUCMED_RUNTIME_WEB 指定（plugin 安裝後工作目錄不在本 repo）；未設定時沿用 <workspace>/repo/strucmed/web。
export function runtimeWeb(ws) {
  const env = String(process.env.STRUCMED_RUNTIME_WEB || '').trim();
  return env && !env.startsWith('${') ? path.resolve(env) : path.join(ws.root, 'repo', 'strucmed', 'web');
}

export const TOOLS = [
  {
    name: 'dictionary_load',
    description: '載入使用者從 StrucMed 字典頁「Export」匯出的 CSV，建立本機字典索引（離線）。之後的字典比對與 dicid 驗證都依此索引。csv_path 與 csv_text 擇一：伺服器端 agent 平台（HTTP 模式）讀不到使用者的檔案，請用 csv_text 傳 CSV 內容。',
    inputSchema: { type: 'object', required: ['dept_no'], properties: {
      csv_path: str('CSV 檔路徑（相對於工作目錄或絕對路徑；HTTP 模式必須在工作目錄內）'),
      csv_text: str('CSV 內容（UTF-8 文字，含表頭列；與 csv_path 擇一）'),
      csv_name: str('csv_text 的來源檔名（選填，只用於紀錄）'),
      dept_no: str('登入編輯器時使用的科部代碼（決定比對範圍）') } },
    handler(a) {
      const { csv_path, dept_no } = a;
      let text, name;
      if (useInline(a, 'csv_path', 'csv_text')) {
        text = String(a.csv_text);
        name = path.basename(String(a.csv_name || 'inline.csv'));
      } else {
        const p = path.resolve(store.workspace().root, String(csv_path));
        // 本機使用者的 CSV 常在下載資料夾；HTTP 呼叫端不是伺服器的使用者，範圍要先於存在與否檢查，才不會洩漏檔案是否存在
        if (requestCurrent().path && !store.insideWorkspace(p)) fail(E.INVALID_INPUT, 'HTTP 模式下 CSV 檔必須在工作目錄內；或用 csv_text 傳內容');
        if (!fs.existsSync(p)) fail(E.NOT_FOUND, `找不到檔案：${csv_path}`);
        if (!fs.statSync(p).isFile()) fail(E.INVALID_INPUT, `不是檔案：${csv_path}`);
        text = fs.readFileSync(p, 'utf8');
        name = path.basename(p);
      }
      const idx = dict.buildIndex(text, String(dept_no), name);
      store.saveDictIndex(idx);
      return { count: idx.entries.length, has_ids: idx.hasIds, deleted_skipped: idx.deleted,
        dic_types: [...new Set(idx.entries.map(e => e.dicType))], duplicates: idx.duplicates.slice(0, 20),
        warnings: idx.warnings };
    }
  },
  {
    name: 'dictionary_search',
    description: '在已載入的字典索引中搜尋（離線）。本科部比對範圍（deptNo／前4碼／前3碼／體系碼）的結果排在前面，同範圍內體系（sys）優先；fuzzy 也比對 desc（說明）與 memo（補述）。每筆回 level（sys／own／sub／dpt／system）、desc、sys（體系標記）、memo、fhir、alias_of、etag；帶體系標記的同體系他科字典也在比對範圍內。',
    inputSchema: { type: 'object', required: ['query'], properties: {
      query: str('關鍵字'), dept_no: str('科部代碼，預設用載入時的代碼'),
      match: str('exact | prefix | fuzzy（預設 fuzzy）', { enum: ['exact', 'prefix', 'fuzzy'] }) } },
    handler({ query, dept_no, match }) {
      const idx = store.loadDictIndex();
      if (!idx) fail(E.NOT_FOUND, '尚未載入字典 CSV，請先 dictionary_load');
      const r = dict.search(idx, query, dept_no, match);
      return { total: r.length, results: r.slice(0, 50).map(e => ({ id: e.id, dicType: e.dicType, level: e.level, dicName: e.dicName, desc: e.desc, sys: e.sys || null, memo: e.memo || null, fhir: e.fhir || [],
        alias_of: e.alias_of || '', etag: e.etag || '', createUser: e.createUser, createDate: e.createDate, deptMatch: e.deptMatch })) };
    }
  },
  {
    name: 'dictionary_create',
    description: '【離線＝規劃】把新字典名稱加入 draft 的「待新建字典」清單；不寫入任何系統。實際建立由 online_dictionary_create／batch 或使用者「匯入表單及字典」完成。' +
      'comment＝一行語意（寫進字典 JSON 的 desc），memo＝補述（meaning／type／unit／range／asr／calx／llm／scope）；重複呼叫同名時保留既有內容再補充。',
    inputSchema: { type: 'object', required: ['draft_id', 'name'], properties: {
      draft_id: str('draft id'), name: str('字典名稱'), comment: str('說明（一行語意，建議必填）'),
      memo: { type: 'object', description: '補述：meaning、type（datatype）、unit、range、asr（字串陣列）、calx、llm、scope', properties: {
        meaning: str('欄位語意'), type: str('建議 datatype'), unit: str('單位'), range: str('合理範圍'), asr: { type: 'array', items: { type: 'string' }, description: '語音辨識別名' },
        calx: str('計算式用途（白話）'), llm: str('LLM prompt 用的欄位描述'), scope: str('適用範圍／科別') } } } },
    handler({ draft_id, name, comment, memo }) {
      const d = store.loadDraft(draft_id);
      const idx = store.loadDictIndex();
      const collision = idx ? idx.entries.filter(e => e.dicName === name).map(e => ({ id: e.id, dicType: e.dicType })) : [];
      const inDept = collision.filter(c => dict.deptTypes(d.meta.dept_no).includes(c.dicType));
      if (inDept.length) fail(E.DICT_AMBIGUOUS, `本科部已有字典「${name}」，請直接綁定其 id，不要新建`, { existing: inDept });
      addPending(d, name, comment, memo);
      store.saveDraft(d);
      return { pending: d.pendingDictionaries, collision_other_types: collision, warnings: (comment || '').trim() ? [] : [`W_DICT_NO_DESC：新字典「${name}」沒有說明（comment）；請補一行語意`] };
    }
  },
  {
    name: 'form_fields',
    description: '（離線，唯讀；字典助手）把 draft 解析成逐欄的事實：說明文字、datatype、選項、min／max、單位、所在區塊、字典（id、層級、說明、目前補述）、dicrole、' +
      '它參照誰（refs_out）與誰參照它（refs_in：計算式、巨集、LLM prompt、選項連動）、AI 資料流角色（ai）。derived 是依這些事實推得的補述草稿（func 表單功能、type、range、unit），' +
      '寫 memo 時以它為底改寫成給人看的句子。只看 itemids 時帶 itemids；only:"dictionary" 只回有綁字典的欄位。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: {
      draft_id: str('draft id'), itemids: { type: 'array', items: { type: 'number' }, description: '只回這些欄位（選填）' },
      only: str('dictionary＝只回有綁字典（或待新建）的欄位', { enum: ['dictionary'] }) } },
    handler({ draft_id, itemids, only }) {
      const r = fieldMap(store.loadDraft(draft_id), store.loadDictIndex(), store.loadPolicy());
      let fields = r.fields;
      if (Array.isArray(itemids) && itemids.length) { const want = new Set(itemids.map(Number)); fields = fields.filter(f => want.has(f.itemid)); }
      if (only === 'dictionary') fields = fields.filter(f => f.dictionary);
      const warnings = [];
      if (!store.loadDictIndex()) warnings.push('W_NO_DICT_INDEX：沒有本機字典索引，字典的層級與補述都是空的；請先 online_dictionary_search(update_index:true) 或 dictionary_load');
      if (r.stats.unknown_dictionary) warnings.push(`W_DICT_NOT_IN_INDEX：${r.stats.unknown_dictionary} 個欄位綁的字典不在本機索引（可能是他科字典），請以 online_dictionary_search(scope:"all", q:名稱, update_index:true) 補進索引`);
      return { stats: r.stats, fields, warnings };
    }
  },
  {
    name: 'dictionary_suggest',
    description: '（離線，唯讀；字典助手）為一個欄位找合適的字典：帶 draft_id＋itemid（用 form_fields 的事實），或 field:{ caption, datatype, unit, options, intent }。' +
      '每筆回 confidence（high＝名稱或補述別名 asr 與欄位說明相同、在比對範圍內、型別與單位不衝突，可自動選入計畫）。從本機字典索引計分排序（名稱、說明與補述命中、控制項型別、單位、選項、層級體系優先、使用表單數），每筆附 reasons（為什麼推薦）與 cite（引用方式：綁定用的 dictionary.id、' +
      '寫 LLM prompt 可用的欄位描述 memo.llm、計算式說明 memo.calx、計算式與巨集用的 A<itemid>）。要找別科的字典：先 online_dictionary_search(scope:"all", q, update_index:true)，再帶 include_other:true。' +
      '使用表單數來自 online_dictionary_usage（不帶 dic_id）寫進索引的計數。',
    inputSchema: { type: 'object', properties: {
      draft_id: str('draft id（與 itemid 一起用）'), itemid: { type: 'number', description: '欄位 itemid' },
      field: { type: 'object', description: '不用 draft 時直接描述欄位', properties: { caption: str('欄位說明文字'), datatype: str('控制項類型'), unit: str('單位'),
        options: { type: 'array', items: { type: 'string' } }, intent: str('用途或要存的語意（例：門診初診體重，供 BMI 計算）'),
        aliases: { type: 'array', items: { type: 'string' }, description: '欄位的同義詞與英文縮寫（例：["BW","weight"]）；與字典名稱或補述 asr 完全相同時加分，最高 medium' } } },
      aliases: { type: 'array', items: { type: 'string' }, description: '同 field.aliases（與 draft 一起用時）' },
      intent: str('補充用途（與 draft 一起用時）'), include_other: bool('也列出他科、他體系的字典（level=other）'), limit: { type: 'number', description: '最多幾筆（預設 8，最多 30）' } } },
    handler({ draft_id, itemid, field, aliases, intent, include_other, limit }) {
      const idx = store.loadDictIndex();
      if (!idx) fail(E.INVALID_INPUT, '沒有本機字典索引：請先 online_dictionary_search(update_index:true) 或 dictionary_load');
      let f = field ? { ...field, unit: field.unit || unitOf(field.caption) } : null, current = null;
      if (draft_id !== undefined) {
        if (itemid === undefined) fail(E.INVALID_INPUT, '帶 draft_id 時要帶 itemid');
        const fm = fieldMap(store.loadDraft(draft_id), idx, store.loadPolicy());
        const x = fm.fields.find(y => y.itemid === Number(itemid));
        if (!x) fail(E.NOT_FOUND, `draft 中找不到 #${itemid}`);
        f = { caption: x.caption, datatype: x.datatype, unit: x.unit || '', options: x.options || [], intent: [intent, x.derived.func].filter(Boolean).join(' '), aliases, itemid: x.itemid };
        current = x.dictionary;
      }
      if (!f || !String(f.caption || f.intent || '').trim()) fail(E.INVALID_INPUT, '請帶 draft_id＋itemid，或 field.caption／field.intent');
      const candidates = suggest(idx, f, { deptNo: idx.deptNo, usage: idx.usage, include_other: !!include_other, limit });
      const warnings = [];
      if (!idx.usage) warnings.push('W_NO_USAGE：索引沒有使用表單數（online_dictionary_usage 不帶 dic_id 可寫入）；排序未考慮多少表單在用');
      if (!candidates.length) warnings.push('W_NO_CANDIDATE：本機索引沒有相關字典；可試 online_dictionary_search(scope:"all", q:關鍵字, update_index:true) 找別科，或規劃新建字典');
      return { field: f, current, candidates, warnings };
    }
  },
  {
    name: 'dictionary_memo_check',
    description: '（離線，唯讀；字典助手）檢查一份補述草稿（memo 11 個鍵＋選填 fhir）：鍵與長度、Big5 字元、FHIR 格式、整段 1800 字上限、疑似個資；' +
      '帶 dic_id 時先與本機索引中的既有補述做補充合併（既有鍵保留）；帶 draft_id＋itemid 時再比對欄位：控制項型別、單位、範圍與 min／max、選項，並提示缺的角度（表單功能、使用情境、交換引用）。' +
      '新字典（待新建）帶 draft_id＋itemid、不帶 dic_id。回 ok、errors、warnings、合併後的 merged 與字數。',
    inputSchema: { type: 'object', required: ['memo'], properties: {
      memo: { type: 'object', description: 'meaning／type／unit／range／func／usecase／interop／asr／calx／llm／scope' },
      fhir: { type: 'array', items: { type: 'object' }, description: 'FHIR 對應（選填，整組）' },
      dic_id: str('既有字典 id（選填：與目前補述合併後檢查）'), draft_id: str('draft id（選填）'), itemid: { type: 'number', description: '欄位 itemid（與 draft_id 一起用）' } } },
    handler({ memo, fhir, dic_id, draft_id, itemid }) {
      const idx = store.loadDictIndex();
      let existing = null, field = null;
      if (dic_id) {
        const e = idx && idx.entries.find(x => x.id === dic_id);
        if (!e) fail(E.NOT_FOUND, `本機索引沒有字典 ${dic_id}；請先 online_dictionary_search(update_index:true)`);
        existing = dc.enrich(e, idx.deptNo);
      }
      if (draft_id !== undefined) {
        if (itemid === undefined) fail(E.INVALID_INPUT, '帶 draft_id 時要帶 itemid');
        field = fieldMap(store.loadDraft(draft_id), idx, store.loadPolicy()).fields.find(y => y.itemid === Number(itemid)) || null;
        if (!field) fail(E.NOT_FOUND, `draft 中找不到 #${itemid}`);
      }
      const r = checkMemo({ memo, fhir, existing, field });
      const keys = store.serverMemoKeys();
      if (r.merged && keys) { const lost = Object.keys(r.merged).filter(k => !keys.includes(k)); if (lost.length) r.warnings.push({ code: 'W_SERVER_OLD_MEMO_KEYS', message: `站台還不支援 ${lost.join('、')}，寫入時會略過` }); }
      return r;
    }
  },
  {
    name: 'form_create',
    description: '建立新的表單 draft（離線）。捷徑、作業別、Info 會寫進匯入說明，由使用者在編輯器畫面填寫（它們不在定義檔內）。',
    inputSchema: { type: 'object', required: ['name', 'dept_no'], properties: {
      name: str('表單名稱（≤36 字；也會是 .htm 檔名）'), dept_no: str('目標科部代碼'),
      shortcut: str('捷徑名稱（選填；一律存成小寫；測試表單請勿設定）'),
      groups: { type: 'array', items: { type: 'string', enum: GROUPS }, description: '作業別' },
      description: str('Info 說明'),
      folder_type: str('建議資料夾：usr / sub / dpt / sys（寫入套件 v2 供參考；實際存放於使用者開啟的資料夾）', { enum: ['usr', 'sub', 'dpt', 'sys'] }),
      options: { type: 'object', description: '表單選項', properties: {
        f_chtno: bool('依病歷號查近期紀錄（預設 true）'), f_opdno: bool('依就醫號只查當次'),
        f_day: { type: 'number', description: '查詢天數（預設 30）' },
        histext: str('block | dict', { enum: ['block', 'dict'] }),
        hide_assist: bool('隱藏小助手按鈕'), hide_preset: bool('隱藏預設按鈕群組') } } } },
    handler(a) {
      const name = String(a.name || '').trim();
      if (!name) fail(E.INVALID_INPUT, '表單名稱不可空白');
      if (name.length > 36) fail(E.INVALID_INPUT, '表單名稱超過 36 字');
      checkText(name, 'name');
      const d = {
        draft_id: store.newDraftId(), created: new Date().toISOString(),
        meta: { name, dept_no: String(a.dept_no), shortcut: a.shortcut ? String(a.shortcut).toLowerCase() : '',
          groups: a.groups || [], description: a.description || '', folder_type: a.folder_type || '', options: a.options || {} },
        areas: [], pendingDictionaries: [], nextItemId: 1
      };
      store.saveDraft(d);
      return { draft_id: d.draft_id, ...shortcutNote(a.shortcut) };
    }
  },
  {
    name: 'form_import',
    description: '【v1 改版】載入既有表單作為新 draft：範本套件 v2（.package.json 或含套件的 .htm）、舊版 .htm（var tempdata）、' +
      '編輯器「匯出 JSON 文件」的 .json。所有區塊（表格、圖形、頁籤、群組…）、計算式、巨集、表單 JS 都原封保留；輸出時是**新表單**，' +
      '不沿用原 templateID。捷徑與作業別預設不沿用（避免與原表單在 HIS 清單重複），需要時明確指定。' +
      '要更新同一張線上範本（online_template_update）時帶 for_update:true：名稱可省略或與原表單相同、捷徑／作業別／Info 沿用來源，' +
      '上架時沒有明確修改的名稱、捷徑、作業別、Info 一律沿用線上值（不會改名或下架）。' +
      'source_path 與 source_text 擇一：伺服器端 agent 平台（HTTP 模式）讀不到使用者的檔案，請用 source_text 傳檔案內容。',
    inputSchema: { type: 'object', required: ['dept_no'], properties: {
      source_path: str('來源檔路徑（相對於工作目錄，且必須在工作目錄內）'),
      source_text: str('來源檔內容（.htm 或 JSON 文字；與 source_path 擇一，上限 10MB）'),
      source_name: str('source_text 的原始檔名（選填；來源是舊版 .htm 或 .json 時作為原表單名稱）'),
      name: str('新表單名稱（≤36 字；必須與原表單區分；for_update:true 時選填，可與原表單相同）'), dept_no: str('目標科部代碼'),
      shortcut: str('新捷徑（選填；一律存成小寫；預設空白＝不上架；for_update:true 時預設沿用來源）'),
      groups: { type: 'array', items: { type: 'string', enum: GROUPS }, description: '作業別（選填；預設不勾；for_update:true 時預設沿用來源）' },
      description: str('Info（選填；預設沿用原表單）'),
      folder_type: str('建議資料夾', { enum: ['usr', 'sub', 'dpt', 'sys'] }),
      for_update: bool('要以 online_template_update 更新來源範本（來源必須帶 templateID：online_template_get(save:true) 的套件，或 iot 有 templateID／sheetid 的 .htm）') } },
    handler(a) {
      const ws = store.workspace();
      let text, fileName;
      if (useInline(a, 'source_path', 'source_text')) {
        text = String(a.source_text);
        if (Buffer.byteLength(text) > MAX_SOURCE) fail(E.INVALID_INPUT, '來源檔超過 10MB');
        fileName = a.source_name ? path.basename(String(a.source_name)) : '';
      } else {
        const p = path.resolve(ws.root, String(a.source_path));
        if (!store.insideWorkspace(p)) fail(E.INVALID_INPUT, '來源檔必須在工作目錄內');
        if (!fs.existsSync(p)) fail(E.NOT_FOUND, `找不到檔案：${a.source_path}`);
        if (fs.statSync(p).size > MAX_SOURCE) fail(E.INVALID_INPUT, '來源檔超過 10MB');
        text = fs.readFileSync(p, 'utf8');
        fileName = path.basename(p);
      }
      const forUpdate = !!a.for_update;
      const src = parseSource(text, fileName);
      const js = (src.form.find(x => x.itemtype === 'javascript') || {}).content || '';
      const iot = src.form.find(x => x.itemtype === 'iot');
      const srcName = (src.template && src.template.name) || fileName.replace(/\.[^.]+$/, '').replace(/\.package$/, '');
      const srcID = String((src.template && src.template.templateID) || iot.templateID || iot.sheetid || '');
      if (forUpdate && !srcID) fail(E.INVALID_INPUT, '來源沒有 templateID（套件 template.templateID 或 iot 的 templateID／sheetid），不能用來更新線上範本；請先 online_template_get(save:true)');
      const name = String(a.name !== undefined ? a.name : forUpdate ? srcName.slice(0, 36) : '').trim();
      if (!name) fail(E.INVALID_INPUT, '新表單名稱不可空白');
      if (name.length > 36) fail(E.INVALID_INPUT, '表單名稱超過 36 字');
      checkText(name, 'name');
      if (!forUpdate && name === srcName) fail(E.INVALID_INPUT, '新表單名稱不可與原表單相同（要更新同一張範本請帶 for_update:true）');
      const st = (forUpdate && src.template) || {};
      // metaSet：使用者明確指定的欄位；online_template_update 只寫入這些欄位的 draft 值，其餘沿用線上值
      const metaSet = ['name', 'shortcut', 'groups', 'description'].filter(k => a[k] !== undefined);
      const d = {
        draft_id: store.newDraftId(), created: new Date().toISOString(),
        meta: { name, dept_no: String(a.dept_no),
          shortcut: a.shortcut !== undefined ? String(a.shortcut).toLowerCase() : String(st.shortcut || '').toLowerCase(),
          groups: a.groups || (Array.isArray(st.groups) ? st.groups.slice() : []),
          description: a.description !== undefined ? a.description : ((src.template && src.template.description) || ''),
          folder_type: a.folder_type || '', options: {} },
        metaSet, forUpdate,
        areas: src.form.filter(x => x.itemtype !== 'javascript' && x.itemtype !== 'iot')
          .map(x => ({ imported: true, area: structuredClone(x) })),
        source: {
          kind: src.kind, javascript: js, iot: structuredClone(iot),
          presets: src.presets || [], dictionaries: src.dictionaries || [],
          derivedFrom: { templateID: srcID, name: srcName, sha256: sha256(JSON.stringify(src.form)) },
          // 套件（online_template_get 存檔或匯出的套件）是當時的線上內容：上架更新時用它比對「線上自來源後被改的地方」。
          // 外部產生的 .htm／JSON 本身已含修改，無法分辨，不記錄
          digest: src.template ? digestForm(src.form) : null
        },
        pendingDictionaries: [], touched: [], nextItemId: 1
      };
      d.nextItemId = maxItemId(d) + 1;
      store.saveDraft(d);
      const v = validateDraft(d, store.loadDictIndex(), store.loadPolicy());
      const types = {};
      d.areas.forEach(x => { types[x.area.itemtype] = (types[x.area.itemtype] || 0) + 1; });
      return {
        draft_id: d.draft_id, source_kind: src.kind, derived_from: d.source.derivedFrom, ...shortcutNote(a.shortcut),
        area_types: types, controls: v.stats.controls, next_itemid: d.nextItemId,
        js_chars: js.length, presets: d.source.presets.length,
        notes: forUpdate
          ? [`用於更新範本 ${srcID}（online_template_update）`, '上架時名稱、捷徑、作業別、Info 沿用線上值；要改請用 form_update_meta 明確設定']
          : ['輸出為新表單，不沿用原 templateID', '捷徑與作業別預設不沿用（避免在 HIS 清單重複）'],
        validation: { valid: v.valid, errors: v.errors, warnings: v.warnings.slice(0, 20), warnings_total: v.warnings.length }
      };
    }
  },
  {
    name: 'form_update_meta',
    description: '修改 draft 的表單名稱、捷徑、作業別、Info、建議資料夾、科部（離線）。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: {
      draft_id: str('draft id'), name: str('表單名稱（≤36 字）'), shortcut: str('捷徑（一律存成小寫；空字串＝不上架）'),
      groups: { type: 'array', items: { type: 'string', enum: GROUPS } }, description: str('Info'),
      folder_type: str('建議資料夾', { enum: ['usr', 'sub', 'dpt', 'sys', ''] }), dept_no: str('科部代碼') } },
    handler(a) {
      const d = store.loadDraft(a.draft_id);
      if (a.name !== undefined) {
        const n = String(a.name).trim();
        if (!n || n.length > 36) fail(E.INVALID_INPUT, '表單名稱必填且 ≤36 字');
        checkText(n, 'name');
        d.meta.name = n;
      }
      if (a.shortcut !== undefined) d.meta.shortcut = String(a.shortcut).toLowerCase();
      if (a.groups !== undefined) d.meta.groups = a.groups;
      if (a.description !== undefined) d.meta.description = String(a.description);
      if (a.folder_type !== undefined) d.meta.folder_type = a.folder_type;
      if (a.dept_no !== undefined) d.meta.dept_no = String(a.dept_no);
      d.metaSet = [...new Set([...(d.metaSet || []), ...['name', 'shortcut', 'groups', 'description'].filter(k => a[k] !== undefined)])];
      store.saveDraft(d);
      return { meta: d.meta, ...shortcutNote(a.shortcut) };
    }
  },
  {
    name: 'form_update_control',
    description: '修改既有控制項（含原表單的控制項）：說明文字、預設值、必填、選項、字典綁定，以及（v0.2）計算式、HIS 參照、巨集腳本。' +
      '選項類與數字範圍只適用 v0.1 支援的 datatype。公式與腳本寫入前會先檢查（語法、函數、模型），錯誤就不寫入；參照類問題留到 form_validate。',
    inputSchema: { type: 'object', required: ['draft_id', 'itemid'], properties: {
      draft_id: str('draft id'), itemid: { type: 'number' },
      label_text: str('控制項前的說明文字（不可含換行）'),
      changes: { type: 'object', properties: {
        datavalue: str('預設值（禁止放病人資料）'), required: bool('必填'), tocalc: bool('參與計算'), toSAS: bool('To SAS'),
        options: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { value: { type: 'string' }, further: { type: 'array', items: { type: 'number' } } } }] } },
        multiple: bool('多選'), row: { type: 'number' }, datagroup: str('連動群組'), filter: bool('篩選'),
        minval: { type: 'number' }, maxval: { type: 'number' }, numpad: bool('數字鍵盤'), format: str('calendar：date|time|datetime'),
        dictionary: { type: 'object', properties: { id: str('既有字典 id'), name: str('字典名稱'), comment: str('新字典的一行說明（desc）'), memo: { type: 'object', description: '新字典的補述（meaning／type／unit／range／asr／calx／llm／scope）' } }, description: '重新綁定；傳 {} 表示解除綁定' },
        dicrole: str('nohis | tohis | fromhis | puthis', { enum: ['nohis', 'tohis', 'fromhis', 'puthis'] }),
        label_format: str('label：defaultValue | Reference | formula | hisquery', { enum: LABEL_FORMATS }),
        formula: str('label 計算式（Calx；以 A<itemid> 參照，比較運算子兩側加空白）'),
        hisquery: str('label HIS 參照（例：Procedure.InName(pkg.proc).GetValueByName(X)）'), his_query_title: str('HIS 參照標題'),
        reference: { type: 'number', description: 'label 資料引用來源 itemid（format=Reference）' },
        action_script: str('action：巨集步驟（最外層逗號分隔）；action2：LLM prompt（Calx 運算式）'),
        action_name: str('按鈕文字（空白＝隱藏按鈕）'), action_id: { type: ['number', 'string'], description: '結果回傳 ID（0 或空白＝不回傳）' },
        fur_action_id: { type: ['number', 'string'], description: 'textbox：輸入後觸發的巨集按鈕 itemid（空白＝取消）' } } } } },
    handler({ draft_id, itemid, label_text, changes = {} }) {
      const d = store.loadDraft(draft_id);
      const hit = findControl(d, itemid);
      if (!hit) fail(E.NOT_FOUND, `找不到控制項 #${itemid}`);
      const n = hit.node;
      const warnings = [];
      const shapeKeys = ['options', 'multiple', 'row', 'datagroup', 'filter', 'minval', 'maxval', 'numpad', 'format'];
      const wantsShape = shapeKeys.some(k => changes[k] !== undefined && !(k === 'format' && n.datatype === 'label'));
      if (n.datatype === 'label' && changes.format !== undefined) fail(E.INVALID_INPUT, 'label 的格式請用 changes.label_format');
      // v0.2：計算式／HIS 參照／巨集。先在副本上套用並檢查，通過才寫回
      const scriptKeys = ['label_format', 'formula', 'hisquery', 'his_query_title', 'reference', 'action_script', 'action_name', 'action_id', 'fur_action_id'];
      let gate = null;
      if (scriptKeys.some(k => changes[k] !== undefined)) {
        const cand = structuredClone(n);
        const isLabel = n.datatype === 'label', isAction = n.datatype === 'action' || n.datatype === 'action2';
        const labelKeys = ['label_format', 'formula', 'hisquery', 'his_query_title', 'reference'];
        const actionKeys = ['action_script', 'action_name', 'action_id'];
        if (labelKeys.some(k => changes[k] !== undefined)) {
          if (!isLabel) fail(E.INVALID_INPUT, `${labelKeys.filter(k => changes[k] !== undefined).join(', ')} 只適用 label（#${itemid} 是 ${n.datatype}）`);
          const fmt = changes.label_format || n.format || 'defaultValue';
          const probe = buildControl(Number(itemid), {
            datatype: 'label', format: fmt,
            formula: fmt === 'formula' ? (changes.formula !== undefined ? changes.formula : n.formula) : undefined,
            hisquery: fmt === 'hisquery' ? (changes.hisquery !== undefined ? changes.hisquery : n.hisquery) : undefined,
            his_query_title: changes.his_query_title !== undefined ? changes.his_query_title : n.hisQueryTitle,
            reference: fmt === 'Reference' ? (changes.reference !== undefined ? changes.reference : n.reference) : undefined
          });
          cand.format = probe.format; cand.formula = probe.formula; cand.hisquery = probe.hisquery;
          cand.hisQueryTitle = fmt === 'hisquery' ? probe.hisQueryTitle : (n.hisQueryTitle || '');
          cand.reference = probe.reference || '';
        }
        if (actionKeys.some(k => changes[k] !== undefined)) {
          if (!isAction) fail(E.INVALID_INPUT, `${actionKeys.filter(k => changes[k] !== undefined).join(', ')} 只適用 action / action2（#${itemid} 是 ${n.datatype}）`);
          const probe = buildControl(Number(itemid), {
            datatype: n.datatype,
            action_script: changes.action_script !== undefined ? changes.action_script : n.actionScript,
            action_name: changes.action_name !== undefined ? changes.action_name : n.actionName,
            action_id: changes.action_id !== undefined ? changes.action_id : n.actionID
          });
          cand.actionScript = probe.actionScript; cand.actionName = probe.actionName; cand.actionID = probe.actionID;
        }
        if (changes.fur_action_id !== undefined) {
          if (n.datatype !== 'textbox') fail(E.INVALID_INPUT, 'fur_action_id 只適用 textbox');
          cand.furActionID = changes.fur_action_id === '' || changes.fur_action_id === null ? '' : String(parseInt(changes.fur_action_id, 10));
        }
        gate = scriptGate(d, cand);
        for (const k of ['format', 'formula', 'hisquery', 'hisQueryTitle', 'reference', 'actionScript', 'actionName', 'actionID', 'furActionID']) {
          if (cand[k] !== undefined && JSON.stringify(cand[k]) !== JSON.stringify(n[k])) n[k] = cand[k];
        }
      }
      if (wantsShape) {
        if (!DATATYPES_V01.includes(n.datatype) || n.datatype === 'label') fail(E.UNSUPPORTED, `#${itemid}（${n.datatype}）的結構屬性請匯入後在編輯器調整`);
        // 以 v0.1 建構器驗證並正規化新值，只套用有指定的欄位
        const merged = { datatype: n.datatype, ...pickControlInput(n), ...changes };
        const probe = buildControl(Number(itemid), merged);
        if (changes.options !== undefined) n.option = probe.option;
        for (const k of ['multiple', 'row', 'datagroup', 'filter', 'minval', 'maxval', 'numpad', 'format']) if (changes[k] !== undefined) n[k] = probe[k];
      }
      if (changes.datavalue !== undefined) {
        if (Array.isArray(n.datavalue)) fail(E.UNSUPPORTED, `#${itemid}（${n.datatype}）的預設值是子項陣列，不能以文字取代`);
        n.datavalue = String(changes.datavalue);
      }
      for (const k of ['required', 'tocalc', 'toSAS']) if (changes[k] !== undefined) n[k] = !!changes[k];
      if (changes.dictionary !== undefined || changes.dicrole !== undefined) {
        const ref = changes.dictionary !== undefined ? changes.dictionary : (n.dicid ? { id: n.dicid } : (n.dictionary ? { name: n.dictionary } : null));
        applyDictionary(d, n, ref && (ref.id || ref.name) ? ref : null, changes.dicrole, warnings);
      }
      if (label_text !== undefined) {
        checkText(label_text, 'label_text');
        const prev = hit.arr[hit.idx - 1];
        if (prev && prev.datatype === 'text') prev.datavalue = label_text;
        else hit.arr.splice(hit.idx, 0, { datatype: 'text', datavalue: label_text });
      }
      const cats = [];
      if (label_text !== undefined) cats.push('label');
      if (changes.datavalue !== undefined) cats.push('value');
      if (['required', 'tocalc', 'toSAS'].some(k => changes[k] !== undefined)) cats.push('flags');
      if (wantsShape) cats.push('shape');
      if (changes.dictionary !== undefined || changes.dicrole !== undefined) cats.push('dict');
      if (['label_format', 'formula', 'hisquery', 'reference', 'action_script', 'action_id', 'fur_action_id'].some(k => changes[k] !== undefined)) cats.push('formula');
      if (['action_name', 'his_query_title'].some(k => changes[k] !== undefined)) cats.push('label');
      markTouched(d, itemid, cats);
      store.saveDraft(d);
      return { itemid: Number(itemid), datatype: n.datatype, dictionary: n.dictionary || null, dicid: n.dicid || null, dicrole: n.dicrole, warnings,
        ...(gate && { deferred_errors: gate.deferred, script_warnings: gate.script_warnings, ai: gate.ai }) };
    }
  },
  {
    name: 'form_remove_control',
    description: '從 draft 移除控制項（含前方說明文字；兩段式確認）。若仍被其他控制項參照（further、reference、公式或巨集中的 A<n>）則拒絕。只影響本機 draft。',
    inputSchema: { type: 'object', required: ['draft_id', 'itemid'], properties: {
      draft_id: str('draft id'), itemid: { type: 'number' }, confirm_token: str('第二次呼叫帶入') } },
    handler({ draft_id, itemid, confirm_token }) {
      const d = store.loadDraft(draft_id);
      const hit = findControl(d, itemid);
      if (!hit) fail(E.NOT_FOUND, `找不到控制項 #${itemid}`);
      // 控制項及其子項（群組／彈出片語）一起移除；外部仍參照其中任何一個就拒絕
      const removed = new Set();
      const collect = x => { if (x && x.itemid !== undefined && x.datatype) removed.add(String(x.itemid)); if (Array.isArray(x && x.datavalue)) x.datavalue.forEach(collect); };
      collect(hit.node);
      const blockers = [...removed].flatMap(id => refsTo(d, id).filter(r => !removed.has(String(r.from))).map(r => ({ target: Number(id), from: Number(r.from), kind: r.kind })));
      if (blockers.length) fail(E.REF_BROKEN, `#${itemid} 仍被參照，請先修改參照它的控制項`, { blockers });
      const prev = hit.arr[hit.idx - 1];
      const label = prev && prev.datatype === 'text' ? prev.datavalue : '';
      const h = confirm.hashPayload({ d: draftHash(d), itemid: Number(itemid) });
      if (!confirm_token) {
        return {
          plan: `將從 draft 移除 #${itemid}（${hit.node.datatype}${label ? `，說明文字「${label}」` : ''}）${removed.size > 1 ? `及其子項 ${[...removed].filter(x => x !== String(itemid)).map(x => '#' + x).join('、')}` : ''}。只影響本機 draft。`,
          confirm_token: confirm.issue('form_remove_control', h)
        };
      }
      confirm.verify('form_remove_control', h, confirm_token);
      const arr = hit.arr;
      let pos = hit.idx;
      arr.splice(pos, 1);
      if (label) { arr.splice(pos - 1, 1); pos -= 1; }
      // 收拾換行：避免留下連續空行或區塊結尾換行
      if (arr[pos] && arr[pos].datatype === 'newline' && (pos === 0 || (arr[pos - 1] && arr[pos - 1].datatype === 'newline'))) arr.splice(pos, 1);
      if (arr.length && arr[arr.length - 1].datatype === 'newline' && (hit.area.imported || hit.area.structured)) arr.pop();
      d.touched = (d.touched || []).filter(id => !removed.has(String(id)));
      for (const id of removed) if (d.touchedFields) delete d.touchedFields[id];
      d.removed = [...new Set([...(d.removed || []), ...[...removed].map(Number)])];
      prunePending(d);
      store.saveDraft(d);
      return { removed: [...removed].map(Number) };
    }
  },
  {
    name: 'form_search',
    description: '搜尋本機 draft（離線）。',
    inputSchema: { type: 'object', properties: { query: str('名稱關鍵字（選填）') } },
    handler({ query }) {
      const q = String(query || '').toLowerCase();
      return { items: store.listDrafts().filter(d => d.meta.name.toLowerCase().includes(q))
        .map(d => ({ draft_id: d.draft_id, name: d.meta.name, dept_no: d.meta.dept_no, areas: d.areas.length, updated: d.updated })) };
    }
  },
  {
    name: 'form_delete',
    description: '刪除本機 draft（兩段式確認）。不會刪除編輯器或倉儲中的任何表單。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: { draft_id: str('draft id'), confirm_token: str('第二次呼叫帶入') } },
    handler({ draft_id, confirm_token }) {
      const d = store.loadDraft(draft_id);
      const h = draftHash(d);
      if (!confirm_token) {
        return { plan: `將刪除本機 draft ${draft_id}「${d.meta.name}」（${d.areas.length} 個區塊）。不影響編輯器中的任何表單。`,
          confirm_token: confirm.issue('form_delete', h) };
      }
      confirm.verify('form_delete', h, confirm_token);
      store.deleteDraft(draft_id);
      return { deleted: draft_id };
    }
  },
  {
    name: 'form_add_area',
    description: '新增區塊（加在表單最後）。form＝文字區塊；formtable＝固定表格（rows 指定每列欄寬，例 ["3,3","2,2,2"]）；' +
      'tab1＝垂直頁籤、tab2＝水平頁籤（titles＝頁籤名稱）；table1＝欄向動態表格（titles＝欄標題，使用者按「+」新增列）、table2＝列向動態表格（titles＝列標題，按「+」新增欄）。' +
      '權限預設為所有人（doctor）可顯示、可編輯，並回傳文字；要隱藏或不回傳時，必須明確宣告 hidden 或 return_text:false。雙欄 form2 不支援。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: {
      draft_id: str('draft id'), type: str('區塊類型（預設 form）', { enum: AREA_TYPES }),
      title: str('區塊標題：**不會顯示在 HIS 表單上**，只用於預覽與計畫；要讓使用者看到標題請帶 visible_title:true，或第一個控制項的說明文字寫成標題'),
      visible_title: bool('文字區塊（form）：在區塊第一行插入一行可見的標題文字（內容＝title）'),
      rows: { type: 'array', items: { type: 'string', enum: FORMTABLE_PATTERNS }, description: 'formtable：每列的欄寬（總和 6），預設 ["3,3"]' },
      titles: { type: 'array', items: { type: 'string' }, description: 'tab1/tab2：頁籤名稱；table1：欄標題；table2：列標題（不可含半形單引號）' },
      hidden: bool('刻意隱藏的區塊（authread 設為空）'), return_text: bool('false 表示不回傳 HIS（gettext:false）') } },
    handler({ draft_id, type = 'form', title, visible_title, hidden, return_text, rows, titles }) {
      if (!AREA_TYPES.includes(type)) fail(E.UNSUPPORTED, `區塊類型 ${type} 不支援（可用：${AREA_TYPES.join(' / ')}；雙欄 form2 無法由編輯器建立，不支援）`);
      if (visible_title) {
        if (type !== 'form') fail(E.UNSUPPORTED, `visible_title 只適用文字區塊（form）；${type} 的標題請放在前一個文字區塊的最後一行，或第一格控制項的說明文字`);
        if (!String(title || '').trim()) fail(E.INVALID_INPUT, 'visible_title 需要 title');
        checkText(title, 'title');
      }
      const d = store.loadDraft(draft_id);
      const auth = { authread: hidden ? [] : [RUNTIME_ROLE], authwrite: [RUNTIME_ROLE], gettext: return_text !== false };
      if (type === 'form') {
        const itemid = nextId(d);
        const items = visible_title ? [{ datatype: 'text', datavalue: String(title).trim() }, { datatype: 'newline' }] : [];
        d.areas.push({ itemid, type, title: title || '', hidden: !!hidden, return_text: return_text !== false, ...auth, items });
        store.saveDraft(d);
        return { area_itemid: itemid };
      }
      // v1：表格與頁籤。先建構（驗證參數）再占用 itemid
      const itemid = d.nextItemId;
      const area = buildStructuredArea(itemid, type, { rows, titles }, auth);
      d.nextItemId++;
      d.areas.push({ structured: true, itemid, type, title: title || '', hidden: !!hidden, return_text: return_text !== false, ...auth, area });
      store.saveDraft(d);
      const cells = type === 'formtable'
        ? area.item.map((r, i) => `第 ${i} 列：${r.item.length} 欄（${r.columns}）`)
        : area.item.map((c, i) => `${i}:${c.datatitle}`);
      const kind = cellKind(type);
      return {
        area_itemid: itemid, type, cells,
        how_to_add: type === 'formtable' ? 'form_add_control 帶 cell: {row, col}' : 'form_add_control 帶 cell: {index}',
        notes: kind === 'table'
          ? ['動態表格：HIS 端開啟時沒有任何列，由使用者按「+」新增；每一列複製同一組欄位', '格子內的欄位不參與計算、不綁字典、不上傳 HIS；計算式與巨集請放在表格外']
          : kind === 'tab'
            ? ['頁籤內的欄位執行時不上傳 HIS、不能綁字典（編輯器載入時會改成 nohis）；報告文字以「[頁籤名稱:]」分段']
            : ['固定表格的格子與文字區塊相同：可綁字典並上傳 HIS；報告文字每列一行、格子之間沒有分隔字元']
      };
    }
  },
  {
    name: 'form_add_control',
    description: `在區塊末端加入「說明文字＋控制項（＋換行）」。支援的 datatype：${DATATYPES_V02.join(', ')}。` +
      'label 可用 format=formula（計算式）或 hisquery（HIS 參照）；action 為巨集按鈕、action2 為 LLM 按鈕。公式與腳本寫入前會先檢查。' +
      'after_itemid 指定插在同一區塊（或同一格）的哪個控制項之後，不帶則加在末端；平台平行呼叫時順序不保證，要控制順序請依序呼叫並帶 after_itemid。' +
      '綁定字典時用 dictionary.id（須存在於字典索引）或 dictionary.name（本科部比對範圍內體系優先、同層級唯一才自動綁 id；有 alias_of 改綁目標；查無則列為待新建，匯入後角色一律為 tohis）。新字典請帶 dictionary.comment（一行說明）與 dictionary.memo（補述），會寫進字典 JSON。',
    inputSchema: { type: 'object', required: ['draft_id', 'area_itemid', 'control'], properties: {
      draft_id: str('draft id'), area_itemid: { type: 'number' },
      cell: { type: 'object', description: '表格／頁籤區塊內的位置：formtable 用 {row, col}；tab1/tab2/table1/table2 用 {index}（皆從 0 起算）。文字區塊不用帶',
        properties: { row: { type: 'number' }, col: { type: 'number' }, index: { type: 'number' } } },
      label_text: str('控制項前的說明文字（不可含換行）'),
      after_itemid: { type: 'number', description: '插在這個控制項之後（須在同一區塊，或 cell 指定的同一格）；不帶則加在末端' },
      newline_after: bool('控制項後換行（預設 true；只用於本工具新建的文字區塊）'),
      control: { type: 'object', required: ['datatype'], properties: {
        datatype: str('控制項類型', { enum: DATATYPES_V02 }),
        dictionary: { type: 'object', properties: { id: str('既有字典 id'), name: str('字典名稱'), comment: str('新字典的一行說明（desc）'), memo: { type: 'object', description: '新字典的補述（meaning／type／unit／range／asr／calx／llm／scope）' } } },
        dicrole: str('nohis | tohis | fromhis | puthis', { enum: ['nohis', 'tohis', 'fromhis', 'puthis'] }),
        datavalue: str('預設值（禁止放病人資料）'), required: bool('必填（只在 HIS 端提醒）'),
        tocalc: bool('參與計算（預設 true）'), toSAS: bool('To SAS'),
        options: { type: 'array', description: '選項類：[{value, further?:number[]}] 或字串；submenu：以 -/--/--- 開頭的字串',
          items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { value: { type: 'string' }, further: { type: 'array', items: { type: 'number' } } } }] } },
        multiple: bool('下拉/組合框多選'), row: { type: 'number', description: '單選/核取每列數量' },
        datagroup: str('連動群組名稱'), filter: bool('組合框篩選'),
        minval: { type: 'number' }, maxval: { type: 'number' }, numpad: bool('數字鍵盤'),
        format: str('calendar: date|time|datetime；label: defaultValue|Reference|formula|hisquery'),
        reference: { type: 'number', description: '資料引用來源 itemid' },
        formula: str('label 計算式（Calx；以 A<itemid> 參照，比較運算子兩側加空白，不能用 &）'),
        hisquery: str('label HIS 參照'), his_query_title: str('HIS 參照標題'),
        action_script: str('action：巨集步驟；action2：LLM prompt（可先留空，引用的欄位建好後再以 form_update_control 補上；空的會在 form_validate 報 E_ACTION_EMPTY）'), action_name: str('按鈕文字（空白＝隱藏）'),
        action_id: { type: ['number', 'string'], description: '結果回傳 ID（action2 必填）' },
        fur_action_id: { type: ['number', 'string'], description: 'textbox：輸入後觸發的巨集按鈕 itemid' } } } } },
    handler({ draft_id, area_itemid, label_text, after_itemid, newline_after = true, control, cell }) {
      const d = store.loadDraft(draft_id);
      const area = findArea(d, area_itemid);
      checkText(label_text, 'label_text');
      const target = editableItems(area, cell);
      if (target.error) fail(E.UNSUPPORTED, target.error);
      const items = target.items;
      const kind = cellKind(target.type);
      control = control || {};
      const anchor = after_itemid === undefined || after_itemid === null ? -1 : items.findIndex(n => isControl(n) && Number(n.itemid) === Number(after_itemid));
      if (after_itemid !== undefined && after_itemid !== null && anchor < 0) fail(E.NOT_FOUND, `${target.where} 沒有控制項 #${after_itemid}`);
      // 頁籤／動態表格的格子：載入時字典角色一律變 nohis、執行時不上傳 HIS（SetData2，scripts.js:4418-4466；TempHtml.js:6035-6039）
      if (kind === 'tab' || kind === 'table') {
        if ((control.dictionary && (control.dictionary.id || control.dictionary.name)) || (control.dicrole && control.dicrole !== 'nohis')) {
          fail(E.UNSUPPORTED, `${target.where}：頁籤與動態表格內的欄位執行時不上傳 HIS，編輯器載入時也會把字典角色改成 nohis；需要寫入倉儲請改放固定表格或文字區塊`);
        }
      }
      // 動態表格：每新增一列就複製同一組 itemid → 不能參與計算、不能放計算式／HIS 參照／巨集
      if (kind === 'table') {
        if (control.tocalc === true) fail(E.UNSUPPORTED, `${target.where}：動態表格每一列共用同一個 itemid，欄位不能參與計算（tocalc 必須 false）`);
        if (['action', 'action2'].includes(control.datatype) || (control.datatype === 'label' && (control.formula || control.hisquery || ['formula', 'hisquery'].includes(control.format)))) {
          fail(E.UNSUPPORTED, `${target.where}：動態表格每一列會複製同一組欄位，計算式、HIS 參照與巨集請放在表格外`);
        }
      }
      const itemid = d.nextItemId;
      const obj = buildControl(itemid, control);
      if (kind === 'table') obj.tocalc = false;   // 與編輯器在表格格子內新增控制項相同（scripts.js:689-692）
      const gate = hasScript(obj) ? scriptGate(d, obj) : null;
      const warnings = [];
      applyDictionary(d, obj, control.dictionary, control.dicrole, warnings);
      d.nextItemId++;
      if (anchor >= 0) {
        const line = [...(label_text ? [{ datatype: 'text', datavalue: label_text }] : []), obj];
        const next = anchor + 1;
        if (target.tail && next === items.length) items.push({ datatype: 'newline' }, ...line);
        else items.splice(items[next]?.datatype === 'newline' ? next + 1 : next, 0, ...line, ...(target.tail || newline_after ? [{ datatype: 'newline' }] : []));
      } else if (target.tail) {
        // 既有區塊與表格／頁籤格子：沿用編輯器的串流格式（結尾沒有換行），在前面補換行
        if (items.length && items[items.length - 1].datatype !== 'newline') items.push({ datatype: 'newline' });
        if (label_text) items.push({ datatype: 'text', datavalue: label_text });
        items.push(obj);
      } else {
        if (label_text) items.push({ datatype: 'text', datavalue: label_text });
        items.push(obj);
        if (newline_after) items.push({ datatype: 'newline' });
      }
      markTouched(d, itemid, ['added']);
      store.saveDraft(d);
      return { itemid, where: target.where, dictionary: obj.dictionary || null, dicid: obj.dicid || null, dicrole: obj.dicrole, warnings,
        ...(gate && { deferred_errors: gate.deferred, script_warnings: gate.script_warnings, ai: gate.ai }) };
    }
  },
  {
    name: 'formula_check',
    description: '【v0.2】檢查一段計算式、巨集、LLM prompt 或 HIS 參照（不修改 draft）。規則依平台 runtime 實際行為：' +
      'Calx 語法（已與真實 Calx 2.2.8 逐條比對）、未知或巨集專用函數、禁用函數、A<itemid> 參照、LLM 模型名稱、巨集步驟切分等。' +
      '帶 draft_id 時會一併檢查參照對象是否存在、是否勾「參與計算」，並回傳 labeled（A<itemid> 換成欄位名稱）與 ref_labels：用它確認每個參照都是計畫裡的那個欄位（例如 BMI 的身高、體重沒有對調）。' +
      '有字典索引時另回 ref_dictionary（被引用欄位的字典補述：unit、range、type、calx、llm），並以補述檢查：W_REF_NO_MEMO、W_REF_UNIT_MISMATCH（單位不同，可換算時附倍率）、W_REF_UNIT_UNKNOWN（無法判定）、W_REF_TYPE_MISMATCH、W_SAMPLE_OUT_OF_RANGE。' +
      'kind=formula 可帶 samples（計畫的試算例）實際計算；有 expect 而結果不符時回 E_FORMULA_SAMPLE_MISMATCH。只支援常用運算與函數，不支援的回報 reason，不猜。',
    inputSchema: { type: 'object', required: ['kind', 'text'], properties: {
      kind: str('formula（label 計算式）| macro（巨集按鈕腳本）| prompt（LLM 按鈕）| hisquery（HIS 參照）', { enum: ['formula', 'macro', 'prompt', 'hisquery'] }),
      text: str('要檢查的內容'), draft_id: str('draft id（選填）'), self_itemid: { type: 'number', description: '這段內容所屬的控制項（檢查自我參照）' },
      samples: { type: 'array', description: '試算例（kind=formula）：[{ "values": { "A2": 170, "A3": 65 }, "expect": 22.5 }]；expect 選填', items: { type: 'object', required: ['values'], properties: {
        values: { type: 'object', description: '參照 → 試算值（鍵可寫 A3 或 3）' }, expect: { description: '預期結果（數字、文字或 true／false）' } } } } } },
    handler({ kind, text, draft_id, self_itemid, samples }) {
      let controls = null, names = null, d = null;
      if (draft_id) {
        controls = new Map();
        d = store.loadDraft(draft_id);
        walk(d, n => { if (isControl(n)) controls.set(String(n.itemid), n); });
        names = captions(d);
      }
      const ctx = { controls, policy: store.loadPolicy(), self: self_itemid };
      const r = kind === 'formula' ? lintFormula(text, ctx) : kind === 'macro' ? lintMacro(text, ctx)
        : kind === 'prompt' ? lintPrompt(text, ctx) : lintHisQuery(text);
      const parsed = kind === 'formula' && r.info;
      const tried = parsed && Array.isArray(samples) ? samples.map(sm => {
        const e = evaluate(text, sm && sm.values);
        const res = { values: sm && sm.values, ...(e.ok ? { value: e.value } : { reason: e.reason }), ...(sm && 'expect' in sm && { expect: sm.expect }) };
        if (e.ok && sm && 'expect' in sm && !sameValue(e.value, sm.expect)) {
          res.match = false;
          // 只差最後一位：多半是 runtime（Calx）進位不補浮點誤差，不是參照放錯
          const x = Number(e.value), y = Number(sm.expect), dp = (String(sm.expect).split('.')[1] || '').length;
          const lastDigit = typeof e.value === 'number' && Number.isFinite(y) && Math.abs(Math.abs(x - y) - Math.pow(10, -dp)) < 1e-9;
          const hint = lastDigit
            ? '只差最後一位：HIS runtime（Calx）的 ROUND 不補浮點誤差（例如 80/1.6^2＝31.249999…，ROUND 到 1 位顯示 31.2），表單實際會顯示試算值；請把試算例改成試算值，或改寫公式'
            : '請確認參照的欄位（見 labeled）與運算';
          r.findings.push({ level: 'error', code: 'E_FORMULA_SAMPLE_MISMATCH', message: `試算 ${JSON.stringify(sm.values)} 得到 ${JSON.stringify(e.value)}，預期 ${JSON.stringify(sm.expect)}：${hint}` });
        } else if (e.ok && sm && 'expect' in sm) res.match = true;
        return res;
      }) : null;
      // 沒有字典索引時不比對：讀不到補述不代表字典沒有補述
      const idx = d && store.loadDictIndex();
      const memo = idx && r.refs ? refChecks(fieldMap(d, idx, store.loadPolicy()).fields, r.refs, { formula: kind === 'formula' ? text : '', samples }) : null;
      if (memo) r.findings.push(...memo.findings);
      const errors = r.findings.filter(f => f.level === 'error'), warnings = r.findings.filter(f => f.level === 'warn');
      return {
        ok: errors.length === 0, errors, warnings,
        ...(r.refs && { refs: r.refs.map(id => 'A' + id) }),
        ...(memo && Object.keys(memo.ref_dictionary).length && { ref_dictionary: memo.ref_dictionary }),
        ...(names && parsed && { labeled: labelFormula(text, names), ref_labels: Object.fromEntries(r.refs.map(id => ['A' + id, names.get(String(id)) || null])) }),
        ...(tried && { samples: tried }),
        ...(r.functions && { functions: [...new Set(r.functions)] }),
        ...(r.steps && { steps: r.steps }), ...(r.targets && { targets: r.targets }), ...(r.ai && { ai: r.ai })
      };
    }
  },
  {
    name: 'form_validate',
    description: '驗證 draft：itemid 重複、參照、字典 id 是否存在、區塊權限、疑似個資等（這些檢查編輯器都不做）。回傳 updated_at（draft 最後修改時間）；' +
      '平台會把同參數的重複呼叫去重時，重新驗證請帶上一次的 updated_at，讓參數不同。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: { draft_id: str('draft id'),
      updated_at: str('上一次 form_validate 回傳的 updated_at（選填，只用來區分呼叫，不影響驗證結果）') } },
    handler({ draft_id }) {
      const d = store.loadDraft(draft_id);
      return { updated_at: d.updated, ...validateDraft(d, store.loadDictIndex(), store.loadPolicy()) };
    }
  },
  {
    name: 'form_preview',
    description: '呈現表單結構供使用者確認。tree / markdown：文字結構。html（v0.2，Claude 內部驗證用，見 SKILL §2c）：以 HIS 端 runtime（TempHtml）在本機離線呈現，' +
      '由 Claude 在內建瀏覽器設值、看計算式結果、執行巨集（LLM、語音、HIS 查詢改為顯示將送出的內容，不實際呼叫；網路由 CSP 封鎖），再把結果交給使用者檢查。' +
      'html 需要平台前端的本機副本（STRUCMED_RUNTIME_WEB，或 <workspace>/repo/strucmed/web）與 harness 伺服器（node scripts/preview.mjs 會自動啟動）。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: {
      draft_id: str('draft id'), format: str('tree | markdown | html', { enum: ['tree', 'markdown', 'html'] }) } },
    card(_data, { draft_id, format }) {
      if (format === 'html') return null;
      return cardData(store.loadDraft(draft_id), 'preview');
    },
    handler({ draft_id, format }) {
      const d = store.loadDraft(draft_id);
      if (format !== 'html') return { content: preview(d, format || 'tree') };
      // 預覽資料只寫到工作目錄的 .strucmed/preview/（已 gitignore），不是可匯入的輸出檔，所以不需要兩段式確認
      const ws = store.workspace();
      const dir = path.join(ws.base, 'preview');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, d.draft_id + '.json');
      fs.writeFileSync(file, JSON.stringify(toFormJson(d, `strucmed-skill v${VERSION} preview draft=${d.draft_id}`)));
      const hasRuntime = fs.existsSync(path.join(runtimeWeb(ws), 'TempHtml.html'));
      return {
        url: `http://127.0.0.1:8765/__preview/${d.draft_id}`,
        file: path.relative(ws.root, file),
        // 檢查伺服器、沒開就在背景啟動、印出可點的連結（本 MCP 不連線，所以不自己探測埠）
        open: `node tools/v0-harness/preview.mjs ${d.draft_id}`,
        runtime_available: hasRuntime,
        notes: [
          '只在本機離線呈現；不存檔、不匯入。draft 修改後要重新呼叫本工具並重新整理頁面',
          'LLM／影像 LLM／語音：在目標欄位顯示「將送出的 prompt 與模型」，不實際呼叫',
          'HIS 參照：在欄位顯示查詢字串，不實際查詢；倉儲與 HIS API 請求一律封鎖，頁面底部列出封鎖與模擬紀錄',
          ...(hasRuntime ? [] : [`找不到 ${path.join(runtimeWeb(ws), 'TempHtml.html')}：HTML 預覽需要平台前端的本機副本（設定 STRUCMED_RUNTIME_WEB）；編輯器匯出的 .htm 不能代替（引擎與函式庫都向站台載入，預覽會封鎖）`])
        ]
      };
    }
  },
  {
    name: 'form_export',
    description: '輸出 .htm（給編輯器匯入；內含舊版 tempdata 與範本套件 v2）、.package.json（範本套件 v2）、.manifest.md 到 output/（相對於回傳的 workspace，請告訴使用者完整路徑）。兩段式：先不帶 confirm_token 取得計畫並交給使用者確認，再帶 token 執行。驗證有錯誤時拒絕輸出。' +
      '輸出檔可用 resources/read 讀 resources 欄位的 strucmed://export/<draft_id>/<kind>；伺服器端（HTTP 模式）另回傳 download 簽章連結供使用者下載。include_content:true 時 .htm 以內嵌資源（content 的 resource 區塊）回傳、不放在文字結果，整份 .htm 會進對話，只在平台既沒有下載入口也不能讀資源時使用。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: {
      draft_id: str('draft id'), out_dir: str('輸出目錄（預設 <workspace>/output）'),
      overwrite: bool('覆寫同名檔案'), confirm_token: str('第二次呼叫帶入'),
      include_content: bool('第二段呼叫時把 .htm 以內嵌資源回傳（會進對話；盡量改用 download 連結或 resources/read）') } },
    card(data, { draft_id }) {
      const d = store.loadDraft(draft_id);
      if (data.plan) return cardData(d, 'export_plan', { plan: data.plan, confirm_token: data.confirm_token, import_mode: data.plan.import_mode });
      const names = { htm: '.htm', json: '.package.json', manifest: '.manifest.md' };
      const list = Object.entries(data.files || {}).map(([kind, rel]) => ({ kind, name: path.basename(rel), path: rel, url: data.download && data.download[kind], sha256: kind === 'htm' ? data.sha256 && data.sha256.htm : undefined }));
      return cardData(d, 'exported', { files: list, import_mode: d.pendingDictionaries.length ? '匯入表單及字典' : '匯入表單' });
    },
    handler({ draft_id, out_dir, overwrite, confirm_token, include_content }) {
      const d = store.loadDraft(draft_id);
      const v = validateDraft(d, store.loadDictIndex(), store.loadPolicy());
      if (!v.valid) fail(E.INVALID_INPUT, '驗證未通過，不能輸出', { errors: v.errors });
      const ws = store.workspace();
      const outDir = out_dir ? path.resolve(ws.root, out_dir) : ws.outDir;
      if (!store.insideWorkspace(outDir)) fail(E.INVALID_INPUT, '輸出目錄必須在工作目錄內');
      const w = writeArtifacts(outDir, d, v, overwrite, store.loadDictIndex());
      if (w.exists.length && !overwrite) fail(E.OUTPUT_EXISTS, `檔案已存在：${w.exists.map(f => path.basename(f)).join(', ')}；如要覆寫請帶 overwrite:true`);
      const h = confirm.hashPayload({ d: draftHash(d), outDir, overwrite: !!overwrite });
      if (!confirm_token) {
        return {
          plan: {
            workspace: ws.root,
            files: Object.values(w.files).map(f => path.relative(ws.root, f)),
            overwrite: w.exists.map(f => path.relative(ws.root, f)),
            new_dictionaries: d.pendingDictionaries.map(p => p.name),
            import_mode: d.pendingDictionaries.length ? '匯入表單及字典（必須）' : '匯入表單',
            warnings: v.warnings, stats: v.stats
          },
          confirm_token: confirm.issue('form_export', h),
          next: '請把 plan 給使用者確認，同意後帶 confirm_token 再呼叫一次'
        };
      }
      confirm.verify('form_export', h, confirm_token);
      const r = w.write();
      // 匯出紀錄寫回 draft（不更新 updated）：下載連結與 strucmed://export 資源以這裡記下的實際路徑取檔，不用表單名稱回推
      d.exported = { at: new Date().toISOString(), files: r.files, sha256: r.sha256 };
      store.saveDraft(d, { touch: false });
      const out = { workspace: ws.root, files: Object.fromEntries(Object.entries(r.files).map(([k, f]) => [k, path.relative(ws.root, f)])), sha256: r.sha256, integrity: r.integrity, format: 'strucmed.template/v2', marker: r.marker, resources: files.resourceUris(d.draft_id) };
      // 下載連結只在 HTTP 模式提供（簽章、綁 draft 與 kind、指向該 draft 最新一次匯出）；任何工作目錄內的 out_dir 都可以
      const base = publicBase();
      if (base) out.download = files.links(base, requestCurrent().path || '/mcp', d.draft_id);
      // include_content：.htm 以內嵌資源回傳（server.mjs 把 __content 併進 content），不放進文字結果
      if (include_content) out.__content = [files.embedded(d.draft_id, 'htm')].filter(Boolean);
      return out;
    }
  }
];
