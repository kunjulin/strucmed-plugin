// Tool definitions + handlers (v0.1 scope).
// Everything is offline: no network, no credentials, output only to the local workspace.
import fs from 'node:fs';
import path from 'node:path';
import { E, fail } from './errors.mjs';
import * as store from './store.mjs';
import * as dict from './dictionary.mjs';
import { buildControl, toFormJson, buildStructuredArea, cellKind, AREA_TYPES, FORMTABLE_PATTERNS, DATATYPES_V01, DATATYPES_V02, LABEL_FORMATS, RUNTIME_ROLE } from './model.mjs';
import { validateDraft, scriptFindings, tableControlIds, DEFERRABLE } from './validate.mjs';
import { lintFormula, lintMacro, lintHisQuery, lintPrompt } from './scriptlint.mjs';
import { preview } from './preview.mjs';
import { writeArtifacts, VERSION } from './export.mjs';
import * as confirm from './confirm.mjs';
import { parseSource, sha256 } from './importer.mjs';
import { editableItems, findControl, refsTo, maxItemId, walk, isControl } from './formtree.mjs';

const GROUPS = ['門', '住', '急', '手術', '檢查', '助手', 'All'];
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = description => ({ type: 'boolean', description });

function draftHash(d) {
  const { updated, created, ...rest } = d;
  return confirm.hashPayload(rest);
}
function nextId(d) { return d.nextItemId++; }
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
  if (res.kind === 'bound') {
    obj.dictionary = res.entry.dicName; obj.dicid = res.entry.id; obj.dicrole = wantRole || 'tohis';
    prunePending(d, obj);
  } else if (res.kind === 'pending') {
    obj.dictionary = ref.name; obj.dicid = ''; obj.dicrole = 'tohis';
    if (wantRole && wantRole !== 'tohis') warnings.push(`W_DICT_ROLE_FORCED：新字典匯入後角色一律為 tohis（要求的 ${wantRole} 需匯入後在編輯器手動調整）`);
    if (!d.pendingDictionaries.some(p => p.name === obj.dictionary)) d.pendingDictionaries.push({ name: obj.dictionary, comment: '' });
    warnings.push(`W_NEW_DICTIONARY：「${obj.dictionary}」將於匯入時新建${res.otherTypes && res.otherTypes.length ? `（其他類別已有同名：${res.otherTypes.join(',')}）` : ''}`);
  } else {
    if (wantRole && wantRole !== 'nohis') fail(E.DICT_REQUIRED, `dicrole=${wantRole} 需要綁定字典`);
    obj.dictionary = ''; obj.dicid = ''; obj.dicrole = 'nohis';
    prunePending(d, obj);
  }
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
    description: '載入使用者從 StrucMed 字典頁「Export」匯出的 CSV，建立本機字典索引（離線）。之後的字典比對與 dicid 驗證都依此索引。',
    inputSchema: { type: 'object', required: ['csv_path', 'dept_no'], properties: {
      csv_path: str('CSV 檔路徑（相對於工作目錄或絕對路徑）'), dept_no: str('登入編輯器時使用的科部代碼（決定比對範圍）') } },
    handler({ csv_path, dept_no }) {
      const p = path.resolve(store.workspace().root, csv_path);
      if (!fs.existsSync(p)) fail(E.NOT_FOUND, `找不到檔案：${csv_path}`);
      const idx = dict.buildIndex(fs.readFileSync(p, 'utf8'), String(dept_no), path.basename(p));
      store.saveDictIndex(idx);
      return { count: idx.entries.length, has_ids: idx.hasIds, deleted_skipped: idx.deleted,
        dic_types: [...new Set(idx.entries.map(e => e.dicType))], duplicates: idx.duplicates.slice(0, 20),
        warnings: idx.warnings };
    }
  },
  {
    name: 'dictionary_search',
    description: '在已載入的字典索引中搜尋（離線）。本科部比對範圍（deptNo／前4碼／前3碼／體系碼）的結果排在前面。',
    inputSchema: { type: 'object', required: ['query'], properties: {
      query: str('關鍵字'), dept_no: str('科部代碼，預設用載入時的代碼'),
      match: str('exact | prefix | fuzzy（預設 fuzzy）', { enum: ['exact', 'prefix', 'fuzzy'] }) } },
    handler({ query, dept_no, match }) {
      const idx = store.loadDictIndex();
      if (!idx) fail(E.NOT_FOUND, '尚未載入字典 CSV，請先 dictionary_load');
      const r = dict.search(idx, query, dept_no, match);
      return { total: r.length, results: r.slice(0, 50) };
    }
  },
  {
    name: 'dictionary_create',
    description: '【離線＝規劃】把新字典名稱加入 draft 的「待新建字典」清單；不寫入任何系統。實際建立由使用者以「匯入表單及字典」完成。',
    inputSchema: { type: 'object', required: ['draft_id', 'name'], properties: {
      draft_id: str('draft id'), name: str('字典名稱'), comment: str('說明（選填）') } },
    handler({ draft_id, name, comment }) {
      const d = store.loadDraft(draft_id);
      const idx = store.loadDictIndex();
      const collision = idx ? idx.entries.filter(e => e.dicName === name).map(e => ({ id: e.id, dicType: e.dicType })) : [];
      const inDept = collision.filter(c => dict.deptTypes(d.meta.dept_no).includes(c.dicType));
      if (inDept.length) fail(E.DICT_AMBIGUOUS, `本科部已有字典「${name}」，請直接綁定其 id，不要新建`, { existing: inDept });
      if (!d.pendingDictionaries.some(p => p.name === name)) d.pendingDictionaries.push({ name, comment: comment || '' });
      store.saveDraft(d);
      return { pending: d.pendingDictionaries, collision_other_types: collision };
    }
  },
  {
    name: 'form_create',
    description: '建立新的表單 draft（離線）。捷徑、作業別、Info 會寫進匯入說明，由使用者在編輯器畫面填寫（它們不在定義檔內）。',
    inputSchema: { type: 'object', required: ['name', 'dept_no'], properties: {
      name: str('表單名稱（≤36 字；也會是 .htm 檔名）'), dept_no: str('目標科部代碼'),
      shortcut: str('捷徑名稱（選填；測試表單請勿設定）'),
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
      return { draft_id: d.draft_id };
    }
  },
  {
    name: 'form_import',
    description: '【v1 改版】載入既有表單作為新 draft：範本套件 v2（.package.json 或含套件的 .htm）、舊版 .htm（var tempdata）、' +
      '編輯器「匯出 JSON 文件」的 .json。所有區塊（表格、圖形、頁籤、群組…）、計算式、巨集、表單 JS 都原封保留；輸出時是**新表單**，' +
      '不沿用原 templateID。捷徑與作業別預設不沿用（避免與原表單在 HIS 清單重複），需要時明確指定。',
    inputSchema: { type: 'object', required: ['source_path', 'name', 'dept_no'], properties: {
      source_path: str('來源檔路徑（相對於工作目錄，且必須在工作目錄內）'),
      name: str('新表單名稱（≤36 字；必須與原表單區分）'), dept_no: str('目標科部代碼'),
      shortcut: str('新捷徑（選填；預設空白＝不上架）'),
      groups: { type: 'array', items: { type: 'string', enum: GROUPS }, description: '作業別（選填；預設不勾）' },
      description: str('Info（選填；預設沿用原表單）'),
      folder_type: str('建議資料夾', { enum: ['usr', 'sub', 'dpt', 'sys'] }) } },
    handler(a) {
      const ws = store.workspace();
      const p = path.resolve(ws.root, String(a.source_path || ''));
      if (!p.startsWith(ws.root + path.sep)) fail(E.INVALID_INPUT, '來源檔必須在工作目錄內');
      if (!fs.existsSync(p)) fail(E.NOT_FOUND, `找不到檔案：${a.source_path}`);
      if (fs.statSync(p).size > 10 * 1024 * 1024) fail(E.INVALID_INPUT, '來源檔超過 10MB');
      const name = String(a.name || '').trim();
      if (!name) fail(E.INVALID_INPUT, '新表單名稱不可空白');
      if (name.length > 36) fail(E.INVALID_INPUT, '表單名稱超過 36 字');
      checkText(name, 'name');

      const src = parseSource(fs.readFileSync(p, 'utf8'), path.basename(p));
      const js = (src.form.find(x => x.itemtype === 'javascript') || {}).content || '';
      const iot = src.form.find(x => x.itemtype === 'iot');
      const srcName = (src.template && src.template.name) || path.basename(p).replace(/\.[^.]+$/, '').replace(/\.package$/, '');
      if (name === srcName) fail(E.INVALID_INPUT, '新表單名稱不可與原表單相同');
      const d = {
        draft_id: store.newDraftId(), created: new Date().toISOString(),
        meta: { name, dept_no: String(a.dept_no), shortcut: a.shortcut ? String(a.shortcut).toLowerCase() : '',
          groups: a.groups || [], description: a.description !== undefined ? a.description : ((src.template && src.template.description) || ''),
          folder_type: a.folder_type || '', options: {} },
        areas: src.form.filter(x => x.itemtype !== 'javascript' && x.itemtype !== 'iot')
          .map(x => ({ imported: true, area: structuredClone(x) })),
        source: {
          kind: src.kind, javascript: js, iot: structuredClone(iot),
          presets: src.presets || [], dictionaries: src.dictionaries || [],
          derivedFrom: {
            templateID: String((src.template && src.template.templateID) || iot.templateID || iot.sheetid || ''),
            name: srcName, sha256: sha256(JSON.stringify(src.form))
          }
        },
        pendingDictionaries: [], touched: [], nextItemId: 1
      };
      d.nextItemId = maxItemId(d) + 1;
      store.saveDraft(d);
      const v = validateDraft(d, store.loadDictIndex(), store.loadPolicy());
      const types = {};
      d.areas.forEach(x => { types[x.area.itemtype] = (types[x.area.itemtype] || 0) + 1; });
      return {
        draft_id: d.draft_id, source_kind: src.kind, derived_from: d.source.derivedFrom,
        area_types: types, controls: v.stats.controls, next_itemid: d.nextItemId,
        js_chars: js.length, presets: d.source.presets.length,
        notes: ['輸出為新表單，不沿用原 templateID', '捷徑與作業別預設不沿用（避免在 HIS 清單重複）'],
        validation: { valid: v.valid, errors: v.errors, warnings: v.warnings.slice(0, 20), warnings_total: v.warnings.length }
      };
    }
  },
  {
    name: 'form_update_meta',
    description: '修改 draft 的表單名稱、捷徑、作業別、Info、建議資料夾、科部（離線）。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: {
      draft_id: str('draft id'), name: str('表單名稱（≤36 字）'), shortcut: str('捷徑（空字串＝不上架）'),
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
      store.saveDraft(d);
      return { meta: d.meta };
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
        dictionary: { type: 'object', properties: { id: str('既有字典 id'), name: str('字典名稱') }, description: '重新綁定；傳 {} 表示解除綁定' },
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
      draft_id: str('draft id'), type: str('區塊類型（預設 form）', { enum: AREA_TYPES }), title: str('區塊標題（只用於預覽與說明）'),
      rows: { type: 'array', items: { type: 'string', enum: FORMTABLE_PATTERNS }, description: 'formtable：每列的欄寬（總和 6），預設 ["3,3"]' },
      titles: { type: 'array', items: { type: 'string' }, description: 'tab1/tab2：頁籤名稱；table1：欄標題；table2：列標題（不可含半形單引號）' },
      hidden: bool('刻意隱藏的區塊（authread 設為空）'), return_text: bool('false 表示不回傳 HIS（gettext:false）') } },
    handler({ draft_id, type = 'form', title, hidden, return_text, rows, titles }) {
      if (!AREA_TYPES.includes(type)) fail(E.UNSUPPORTED, `區塊類型 ${type} 不支援（可用：${AREA_TYPES.join(' / ')}；雙欄 form2 無法由編輯器建立，不支援）`);
      const d = store.loadDraft(draft_id);
      const auth = { authread: hidden ? [] : [RUNTIME_ROLE], authwrite: [RUNTIME_ROLE], gettext: return_text !== false };
      if (type === 'form') {
        const itemid = nextId(d);
        d.areas.push({ itemid, type, title: title || '', hidden: !!hidden, return_text: return_text !== false, ...auth, items: [] });
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
      '綁定字典時用 dictionary.id（須存在於字典 CSV）或 dictionary.name（本科部唯一符合則自動綁 id；查無則列為待新建，匯入後角色一律為 tohis）。',
    inputSchema: { type: 'object', required: ['draft_id', 'area_itemid', 'control'], properties: {
      draft_id: str('draft id'), area_itemid: { type: 'number' },
      cell: { type: 'object', description: '表格／頁籤區塊內的位置：formtable 用 {row, col}；tab1/tab2/table1/table2 用 {index}（皆從 0 起算）。文字區塊不用帶',
        properties: { row: { type: 'number' }, col: { type: 'number' }, index: { type: 'number' } } },
      label_text: str('控制項前的說明文字（不可含換行）'),
      newline_after: bool('控制項後換行（預設 true；只用於本工具新建的文字區塊）'),
      control: { type: 'object', required: ['datatype'], properties: {
        datatype: str('控制項類型', { enum: DATATYPES_V02 }),
        dictionary: { type: 'object', properties: { id: str('既有字典 id'), name: str('字典名稱') } },
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
        action_script: str('action：巨集步驟；action2：LLM prompt'), action_name: str('按鈕文字（空白＝隱藏）'),
        action_id: { type: ['number', 'string'], description: '結果回傳 ID（action2 必填）' },
        fur_action_id: { type: ['number', 'string'], description: 'textbox：輸入後觸發的巨集按鈕 itemid' } } } } },
    handler({ draft_id, area_itemid, label_text, newline_after = true, control, cell }) {
      const d = store.loadDraft(draft_id);
      const area = findArea(d, area_itemid);
      checkText(label_text, 'label_text');
      const target = editableItems(area, cell);
      if (target.error) fail(E.UNSUPPORTED, target.error);
      const items = target.items;
      const kind = cellKind(target.type);
      control = control || {};
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
      if (target.tail) {
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
      '帶 draft_id 時會一併檢查參照對象是否存在、是否勾「參與計算」。',
    inputSchema: { type: 'object', required: ['kind', 'text'], properties: {
      kind: str('formula（label 計算式）| macro（巨集按鈕腳本）| prompt（LLM 按鈕）| hisquery（HIS 參照）', { enum: ['formula', 'macro', 'prompt', 'hisquery'] }),
      text: str('要檢查的內容'), draft_id: str('draft id（選填）'), self_itemid: { type: 'number', description: '這段內容所屬的控制項（檢查自我參照）' } } },
    handler({ kind, text, draft_id, self_itemid }) {
      let controls = null;
      if (draft_id) {
        controls = new Map();
        walk(store.loadDraft(draft_id), n => { if (isControl(n)) controls.set(String(n.itemid), n); });
      }
      const ctx = { controls, policy: store.loadPolicy(), self: self_itemid };
      const r = kind === 'formula' ? lintFormula(text, ctx) : kind === 'macro' ? lintMacro(text, ctx)
        : kind === 'prompt' ? lintPrompt(text, ctx) : lintHisQuery(text);
      const errors = r.findings.filter(f => f.level === 'error'), warnings = r.findings.filter(f => f.level === 'warn');
      return {
        ok: errors.length === 0, errors, warnings,
        ...(r.refs && { refs: r.refs.map(id => 'A' + id) }),
        ...(r.functions && { functions: [...new Set(r.functions)] }),
        ...(r.steps && { steps: r.steps }), ...(r.targets && { targets: r.targets }), ...(r.ai && { ai: r.ai })
      };
    }
  },
  {
    name: 'form_validate',
    description: '驗證 draft：itemid 重複、參照、字典 id 是否存在、區塊權限、疑似個資等（這些檢查編輯器都不做）。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: { draft_id: str('draft id') } },
    handler({ draft_id }) {
      return validateDraft(store.loadDraft(draft_id), store.loadDictIndex(), store.loadPolicy());
    }
  },
  {
    name: 'form_preview',
    description: '呈現表單結構供使用者確認。tree / markdown：文字結構。html（v0.2，Claude 內部驗證用，見 SKILL §2c）：以 HIS 端 runtime（TempHtml）在本機離線呈現，' +
      '由 Claude 在內建瀏覽器設值、看計算式結果、執行巨集（LLM、語音、HIS 查詢改為顯示將送出的內容，不實際呼叫；網路由 CSP 封鎖），再把結果交給使用者檢查。' +
      'html 需要平台前端的本機副本（STRUCMED_RUNTIME_WEB，或 <workspace>/repo/strucmed/web）與 harness 伺服器（node scripts/preview.mjs 會自動啟動）。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: {
      draft_id: str('draft id'), format: str('tree | markdown | html', { enum: ['tree', 'markdown', 'html'] }) } },
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
          ...(hasRuntime ? [] : [`找不到 ${path.join(runtimeWeb(ws), 'TempHtml.html')}：HTML 預覽需要平台前端的本機副本（設定 STRUCMED_RUNTIME_WEB）`])
        ]
      };
    }
  },
  {
    name: 'form_export',
    description: '輸出 .htm（給編輯器匯入；內含舊版 tempdata 與範本套件 v2）、.package.json（範本套件 v2）、.manifest.md 到 output/。兩段式：先不帶 confirm_token 取得計畫並交給使用者確認，再帶 token 執行。驗證有錯誤時拒絕輸出。',
    inputSchema: { type: 'object', required: ['draft_id'], properties: {
      draft_id: str('draft id'), out_dir: str('輸出目錄（預設 <workspace>/output）'),
      overwrite: bool('覆寫同名檔案'), confirm_token: str('第二次呼叫帶入') } },
    handler({ draft_id, out_dir, overwrite, confirm_token }) {
      const d = store.loadDraft(draft_id);
      const v = validateDraft(d, store.loadDictIndex(), store.loadPolicy());
      if (!v.valid) fail(E.INVALID_INPUT, '驗證未通過，不能輸出', { errors: v.errors });
      const ws = store.workspace();
      const outDir = out_dir ? path.resolve(ws.root, out_dir) : ws.outDir;
      if (!outDir.startsWith(ws.root)) fail(E.INVALID_INPUT, '輸出目錄必須在工作目錄內');
      const w = writeArtifacts(outDir, d, v, overwrite, store.loadDictIndex());
      if (w.exists.length && !overwrite) fail(E.OUTPUT_EXISTS, `檔案已存在：${w.exists.map(f => path.basename(f)).join(', ')}；如要覆寫請帶 overwrite:true`);
      const h = confirm.hashPayload({ d: draftHash(d), outDir, overwrite: !!overwrite });
      if (!confirm_token) {
        return {
          plan: {
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
      return { files: Object.fromEntries(Object.entries(r.files).map(([k, f]) => [k, path.relative(ws.root, f)])), sha256: r.sha256, integrity: r.integrity, format: 'strucmed.template/v2', marker: r.marker };
    }
  }
];
