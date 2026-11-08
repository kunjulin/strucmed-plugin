// Builds GetData()-compatible objects in the editor's *post-load* shape, so that
// importing the file and saving it changes nothing but environment fields
// (F = G1; field sets taken from the
// v0 harness G1 output of the real editor).
import { E, fail } from './errors.mjs';
import { scriptBlock, COLOR_RE, COLOR_HELP } from './script-snippets.mjs';

export const RUNTIME_ROLE = 'doctor'; // 「所有人」 (平台 web/js/scripts.js:26; TempHtml.js:2223)
export const EDITORVER = '1.6';

// v0.1 scope : basic input controls + display label.
export const DATATYPES_V01 = ['textbox', 'numberbox', 'textarea', 'calendar', 'selection', 'combobox',
  'radiobutton', 'checkbox', 'submenu', 'label'];
// v0.2：label 的計算式與 HIS 參照、巨集按鈕 action、LLM 按鈕 action2
export const DATATYPES_V02 = [...DATATYPES_V01, 'action', 'action2'];
const LATER = { imgbox: '（不支援新增）', form: '（不支援新增）', subgroup: '（不支援新增）' };
export const LABEL_FORMATS = ['defaultValue', 'Reference', 'formula', 'hisquery'];
const CHOICE = new Set(['selection', 'combobox', 'radiobutton', 'checkbox']);
const DICROLES = new Set(['nohis', 'tohis', 'fromhis', 'puthis']);

function base(itemid, datatype) {
  return {
    itemid, datatype, datavalue: '', dictionary: '', dicid: '', dicrole: 'nohis', tag: '', formula: '',
    tocalc: true, toSAS: false, fromdict: false, efontcolor: '', efontsize: 14, ebackcolor: '', required: false,
    // editor-added metadata (Quill createControlElement, 平台 web/js/scripts.js:2975-3002)
    panelId: 'quill-form-editor', type: datatype, id: 'ctrl_' + itemid, format: '', hisquery: '', hisQueryTitle: '',
    textareaHeight: '', furActionID: '', multiple: false, datagroup: '', option: [], text: '選項控制項'
  };
}

// S0 控制項樣式欄位（docs/13 §4.0）：平台控制項 JSON 既有的 efontcolor／efontsize（px）／ebackcolor，
// 編輯器屬性面板有色票（平台 web/js/scripts.js:2794-2800），runtime 以 inline style 渲染（web/js/TempHtml.js:4562、4707）。
// 空字串或 0 清回預設（''／14／''）。只影響畫面，不影響 HIS 文字輸出與倉儲。
export const STYLE_DEFAULTS = { efontcolor: '', efontsize: 14, ebackcolor: '' };
export const STYLE_KEYS = { font_color: 'efontcolor', font_size: 'efontsize', back_color: 'ebackcolor' };
export function applyStyle(o, c) {
  const changed = [];
  for (const [k, field] of Object.entries(STYLE_KEYS)) {
    if (c[k] === undefined) continue;
    let v = c[k];
    if (v === '' || v === null || v === 0 || v === '0') { if (o[field] !== STYLE_DEFAULTS[field]) changed.push(k); o[field] = STYLE_DEFAULTS[field]; continue; }
    if (k === 'font_size') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 10 || n > 24) fail(E.INVALID_INPUT, 'font_size 必須是 10–24 的整數（px）；"" 或 0 清回預設 14');
      v = n;
    } else {
      v = String(v).trim();
      if (!COLOR_RE.test(v)) fail(E.INVALID_INPUT, `${k} 的值「${v.slice(0, 30)}」不在白名單：${COLOR_HELP}`);
    }
    if (o[field] !== v) changed.push(k);
    o[field] = v;
  }
  return changed;
}
// 非預設的樣式（form_fields、form_preview 顯示用）
export function styleOf(n) {
  const out = {};
  if (n.efontcolor) out.font_color = n.efontcolor;
  if (n.efontsize !== undefined && n.efontsize !== '' && Number(n.efontsize) !== STYLE_DEFAULTS.efontsize) out.font_size = Number(n.efontsize);
  if (n.ebackcolor) out.back_color = n.ebackcolor;
  return Object.keys(out).length ? out : null;
}

const furtherStr = f => (Array.isArray(f) && f.length ? f.map(n => String(parseInt(n, 10))).join(',') : '');

export function buildControl(itemid, c) {
  const dt = c && c.datatype;
  if (!DATATYPES_V02.includes(dt)) {
    fail(E.UNSUPPORTED, LATER[dt] ? `datatype「${dt}」${LATER[dt]}` : `未知的 datatype「${dt}」`,
      { supported: DATATYPES_V02 });
  }
  const o = base(itemid, dt);
  if (c.datavalue !== undefined) o.datavalue = String(c.datavalue);
  if (c.required !== undefined) o.required = !!c.required;
  if (c.tocalc !== undefined) o.tocalc = !!c.tocalc;
  if (c.toSAS !== undefined) o.toSAS = !!c.toSAS;
  if (c.dicrole !== undefined && !DICROLES.has(c.dicrole)) fail(E.INVALID_INPUT, `dicrole 必須是 ${[...DICROLES].join('/')}`);
  applyStyle(o, c);

  if (['textbox', 'numberbox', 'textarea', 'label'].includes(dt)) o.reference = c.reference ? String(c.reference) : '';
  if (dt === 'numberbox') {
    o.minval = c.minval !== undefined ? String(c.minval) : '';
    o.maxval = c.maxval !== undefined ? String(c.maxval) : '';
    o.numpad = !!c.numpad;
    if (o.minval !== '' && o.maxval !== '' && Number(o.minval) > Number(o.maxval)) fail(E.INVALID_INPUT, 'minval 大於 maxval');
  }
  if (dt === 'textarea') {
    if (c.from_template_id) fail(E.UNSUPPORTED, '子表單綁定（from_template_id）排在 v1');
    o.fromTemplate = false;
    o.fromTemplateID = '';
  }
  if (dt === 'calendar') {
    o.format = c.format || 'date';
    if (!['date', 'time', 'datetime'].includes(o.format)) fail(E.INVALID_INPUT, 'calendar.format 必須是 date/time/datetime');
  }
  if (CHOICE.has(dt)) {
    const opts = c.options || [];
    if (!Array.isArray(opts) || opts.length === 0) fail(E.INVALID_INPUT, `${dt} 至少需要一個選項`);
    o.option = opts.map(x => (typeof x === 'string' ? { value: x, further: '' } : { value: String(x.value), further: furtherStr(x.further) }));
    const vals = o.option.map(x => x.value);
    if (new Set(vals).size !== vals.length) fail(E.INVALID_INPUT, `${dt} 選項值重複`);
    o.datagroup = c.datagroup ? String(c.datagroup) : '';
    if (dt === 'selection' || dt === 'combobox') o.multiple = !!c.multiple;
    if (dt === 'combobox') o.filter = c.filter !== undefined ? !!c.filter : true;
    if (dt === 'radiobutton' || dt === 'checkbox') o.row = c.row !== undefined ? parseInt(c.row, 10) : (dt === 'radiobutton' ? 2 : 4);
  }
  if (dt === 'submenu') {
    const lines = c.options || [];
    if (!Array.isArray(lines) || !lines.length) fail(E.INVALID_INPUT, 'submenu 需要 options（字串陣列）');
    for (const l of lines) if (!/^-{1,3}[^-]/.test(String(l))) fail(E.INVALID_INPUT, `submenu 選項須以 - / -- / --- 開頭：${l}`);
    o.option = lines.map(String);
  }
  if (dt === 'label') {
    const f = c.format || (c.formula ? 'formula' : c.hisquery ? 'hisquery' : c.reference ? 'Reference' : 'defaultValue');
    if (!LABEL_FORMATS.includes(f)) fail(E.INVALID_INPUT, `label.format 必須是 ${LABEL_FORMATS.join(' / ')}`);
    o.format = f;
    // runtime 只要 formula 非空就會計算，不看 format（平台 web/js/TempHtml.js:4368）→ 其他 format 一律清空
    // formula 可以先留空：計算式常要引用之後才建的欄位，建好後再 form_update_control 補上；仍是空的由 form_validate 報 E_FORMULA_EMPTY
    if (f === 'formula') {
      o.formula = c.formula ? String(c.formula) : '';
    } else if (c.formula) fail(E.INVALID_INPUT, `format=${f} 不能帶 formula（runtime 仍會計算它）`);
    if (f === 'hisquery') {
      if (!c.hisquery || !String(c.hisquery).trim()) fail(E.INVALID_INPUT, 'format=hisquery 需要 hisquery（HIS 參照）');
      o.hisquery = String(c.hisquery).trim();
      o.hisQueryTitle = c.his_query_title !== undefined ? String(c.his_query_title) : '';
    } else if (c.hisquery) fail(E.INVALID_INPUT, `format=${f} 不能帶 hisquery`);
    if (f === 'Reference' && !c.reference) fail(E.INVALID_INPUT, 'format=Reference 需要 reference（資料引用來源 itemid）');
  }
  if (dt === 'action' || dt === 'action2') {
    // 編輯器巨集面板的三個欄位（平台 web/js/scripts.js:2849-2854）；actionID 存成字串
    // action_script 可以先留空：腳本常要引用之後才建的欄位，建好後再 form_update_control 補上；仍是空的由 form_validate 報 E_ACTION_EMPTY
    o.actionName = c.action_name !== undefined ? String(c.action_name) : '';
    o.actionID = c.action_id === undefined || c.action_id === null || c.action_id === '' ? '' : String(parseInt(c.action_id, 10));
    if (o.actionID === 'NaN') fail(E.INVALID_INPUT, 'action_id 必須是 itemid（數字）');
    o.actionScript = c.action_script === undefined || c.action_script === null ? '' : String(c.action_script);
    if (dt === 'action2' && !o.actionID) fail(E.INVALID_INPUT, 'LLM 按鈕（action2）需要 action_id：回覆要寫入哪個控制項');
  }
  if (c.fur_action_id !== undefined && c.fur_action_id !== '' && c.fur_action_id !== null) {
    if (dt !== 'textbox') fail(E.INVALID_INPUT, 'fur_action_id（輸入後觸發巨集）只適用 textbox（平台 web/js/scripts.js:2414）');
    o.furActionID = String(parseInt(c.fur_action_id, 10));
  }
  return o;
}

// ── v1：表格與頁籤區塊────────────────────────────────────────────
// 結構與 key 順序依 GetData（平台 web/js/scripts.js:3683-3810），並以 v0 harness 實測 load→save 不變：
//   formtable：{itemtype,itemid,authread,authwrite,gettext,item:[{itemtype:'row',columns:'3,3',item:[{itemtype:'form',item:[串流]}…]}]}
//   tab1／tab2／table1／table2：{itemtype,authread,authwrite,gettext,item:[{itemtype:'td',datatitle,item:[串流]}…],itemid}
// 列、格、頁籤沒有 itemid（不占編號）。tab1＝垂直頁籤、tab2＝水平頁籤；table1＝欄向動態表格、table2＝列向動態表格。
// form2（雙欄）無法由編輯器 UI 建立、載入路徑不穩，不支援新增。
export const AREA_TYPES = ['form', 'formtable', 'tab1', 'tab2', 'table1', 'table2'];
export const STRUCTURED_TYPES = ['formtable', 'tab1', 'tab2', 'table1', 'table2'];
// 編輯器固定表格的欄寬選項（總和 6；scripts.js:873-881）
export const FORMTABLE_PATTERNS = ['1,1,1,1,1,1', '1,2,1,2', '2,1,1,1,1', '2,2,2', '2,4', '3,3', '4,2', '6'];
// 格子類型：formtable 格子與一般區塊相同（Quill 串流、字典可上傳）；
// tab 格子走舊版載入（SetData2）：dicrole 保留、依角色上傳（平台 20261101 起）；
// table 格子也走 SetData2：dicrole 一律變 nohis、執行時不上傳 HIS；
// table 另外每新增一列就複製一份同 itemid 的欄位 → tocalc 必須 false、不能放計算式與巨集
export function cellKind(areaType) {
  if (areaType === 'table1' || areaType === 'table2') return 'table';
  if (areaType === 'tab1' || areaType === 'tab2') return 'tab';
  if (areaType === 'formtable') return 'formtable';
  return 'form';
}

export const checkTitle = t => {
  const s = String(t === undefined || t === null ? '' : t);
  if (/[\r\n]/.test(s)) fail(E.INVALID_INPUT, `標題不可包含換行：${s}`);
  if (s.includes("'")) fail(E.INVALID_INPUT, `標題不可包含半形單引號（runtime 直接插入 HTML 屬性，會破壞版面）：${s}`);
  if (s.length > 50) fail(E.INVALID_INPUT, `標題超過 50 字：${s}`);
  return s;
};

export function buildStructuredArea(itemid, type, spec, auth) {
  const { authread, authwrite, gettext } = auth;
  if (type === 'formtable') {
    const rows = spec.rows && spec.rows.length ? spec.rows : ['3,3'];
    const item = rows.map(r => {
      const columns = String(r).replace(/\s+/g, '');
      if (!FORMTABLE_PATTERNS.includes(columns)) fail(E.INVALID_INPUT, `固定表格的欄寬「${r}」不在編輯器選項內：${FORMTABLE_PATTERNS.join(' / ')}`);
      return { itemtype: 'row', columns, item: columns.split(',').map(() => ({ itemtype: 'form', item: [] })) };
    });
    return { itemtype: 'formtable', itemid: String(itemid), authread, authwrite, gettext, item };
  }
  if (!STRUCTURED_TYPES.includes(type)) fail(E.UNSUPPORTED, `區塊類型 ${type} 不支援（可用：${AREA_TYPES.join(' / ')}）`);
  const titles = spec.titles || [];
  if (!titles.length) fail(E.INVALID_INPUT, `${type} 需要 titles（${cellKind(type) === 'tab' ? '頁籤名稱' : type === 'table1' ? '欄標題' : '列標題'}，至少一個）`);
  if (titles.length > 20) fail(E.INVALID_INPUT, `${type} 最多 20 個標題`);
  return { itemtype: type, authread, authwrite, gettext, item: titles.map(t => ({ itemtype: 'td', datatitle: checkTitle(t), item: [] })), itemid: String(itemid) };
}

// ── 嵌入頁面（embed）區塊（flag embedArea）──────────────────────────────
// 與 form、table1 平行的區塊；平台 PLAN-STRUCFORM-1.10.9 §1.1、契約 docs/EMBED-APP-GUIDE.md §4。
// key 順序依編輯器 EmbedGetAreaData（平台 web/js/scripts.js）：itemtype、itemid、設定欄位、authread、authwrite、gettext。
// 區塊沒有子項（item），不占格子；GetText 對 embed 回空字串（gettext 只是與其他區塊一致）。
// inputs／outputs 存成 { key: itemid(數字) }：編輯器「重新編號」與附加表單時會跟著調整（EmbedRemapMap／EmbedShiftMap）。
export const EMBED_FIELDS = ['title', 'url', 'params', 'height', 'inputs', 'outputs'];
// 呼叫端可寫 12、"12" 或 "A12"，一律存成數字；其他值原樣留給檢查（E_EMBED_MAP）
const idMap = m => Object.fromEntries(Object.entries(m).map(([k, v]) => { const x = /^\s*[Aa]?(\d+)\s*$/.exec(String(v)); return [k, x ? parseInt(x[1], 10) : v]; }));
export function embedConfig(spec) {
  const s = spec || {};
  return {
    title: s.title === undefined || s.title === null ? '' : String(s.title),
    url: String(s.url === undefined || s.url === null ? '' : s.url).trim(),
    params: s.params === undefined || s.params === null ? {} : (typeof s.params === 'object' && !Array.isArray(s.params) ? Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])) : s.params),
    height: s.height === undefined || s.height === null || s.height === '' ? 600 : (/^\s*\d+\s*(px)?\s*$/i.test(String(s.height)) ? parseInt(s.height, 10) : s.height),
    inputs: s.inputs && typeof s.inputs === 'object' && !Array.isArray(s.inputs) ? idMap(s.inputs) : (s.inputs === undefined || s.inputs === null ? {} : s.inputs),
    outputs: s.outputs && typeof s.outputs === 'object' && !Array.isArray(s.outputs) ? idMap(s.outputs) : (s.outputs === undefined || s.outputs === null ? {} : s.outputs)
  };
}
export function buildEmbedArea(itemid, spec, auth) {
  const { authread, authwrite, gettext } = auth;
  return { itemtype: 'embed', itemid: String(itemid), ...embedConfig(spec), authread, authwrite, gettext };
}

export function areaObject(a) {
  return {
    itemtype: 'form',
    authread: a.authread, authwrite: a.authwrite, gettext: a.gettext,
    item: stripTrailingNewline(a.items),
    itemid: String(a.itemid)
  };
}

// GetQuillFormData drops the final newline of an area (平台 web/js/scripts.js:3385-3388)
function stripTrailingNewline(items) {
  const out = items.slice();
  while (out.length && out[out.length - 1].datatype === 'newline') out.pop();
  return out;
}

export function iotObject(meta, generator) {
  const o = meta.options || {};
  return {
    itemtype: 'iot', editorver: EDITORVER, sheetid: '',
    f_opdno: !!o.f_opdno, f_chtno: o.f_chtno !== undefined ? !!o.f_chtno : true,
    templateID: '',
    f_histext: o.histext === 'dict' ? 'histextbydict' : 'histextbyblock',
    f_hideprevicon: !!o.hide_prev_icon, f_hideAssist: !!o.hide_assist, f_hidePreset: !!o.hide_preset,
    f_day: String(o.f_day !== undefined ? o.f_day : 30),
    d_url: '',                           // filled by the editor with its warehouse URL
    modifiedUser: generator, modifiedDept: '', modifiedDate: 0
  };
}

export function toFormJson(draft, generatorTag) {
  // imported：原封輸出（深拷貝）；generated：依編輯器匯入後格式輸出
  const arr = draft.areas.map(a => (a.imported || a.structured ? structuredClone(a.area) : areaObject(a)));
  const marker = `// generated-by: ${generatorTag}`;
  // 白名單片段（docs/13）：有片段時接在標記行之後；改版且保留原 JS 時原 JS 在前、片段在後
  const snippets = scriptBlock(draft);
  if (draft.source) {
    // v1 改版：保留原表單的 JS（只在最前面加一行標記註解）與 iot 表單選項；
    // 新表單不得沿用原 ID → sheetid / templateID 清空，d_url 交給編輯器填入
    // 來源若本身是本工具的輸出，先移除舊標記，避免改版一次多一行
    const js = (draft.source.javascript || '').replace(/^(\/\/ generated-by: strucmed-skill [^\n]*\n?)+/, '');
    arr.push({ itemtype: 'javascript', content: [marker, js, snippets].filter(Boolean).join('\n') });
    arr.push({ ...structuredClone(draft.source.iot), sheetid: '', templateID: '', d_url: '', modifiedUser: 'strucmed-skill', modifiedDept: '', modifiedDate: 0 });
  } else {
    arr.push({ itemtype: 'javascript', content: [marker, snippets].filter(Boolean).join('\n') });   // 沒有片段時只有標記行 (02 §5.2)
    arr.push(iotObject(draft.meta, 'strucmed-skill'));
  }
  return arr;
}
