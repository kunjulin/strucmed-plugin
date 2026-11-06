// 表單 JS 增益集：白名單片段模式（docs/13）。
//   D1：S1 style、S4 guard；D2：S2 derive、S3 lookup、S5 required；D4（flag formScriptAdvanced）：S6 autorun、S7 table-rows。
// draft.script.snippets 只存 { id, template, params }；JS 在匯出／上架時由這裡以固定樣板渲染，
// 使用者與模型都不提供 JS、CSS 或選擇器字串。兩層檢查：參數（型別、範圍、itemid 存在、CSS 白名單）
// 與渲染後的禁用 token 掃描（docs/13 §2.3；樣板來自固定字串，第二層是防呆）。
// 渲染的函數一律前綴 sm_，runtime（平台 web/js/TempHtml.js）沒有這個前綴。
import crypto from 'node:crypto';
import { isControl, walk, areaNode } from './formtree.mjs';
import { lintFormula, lintMacro } from './scriptlint.mjs';
import { enabled } from './flags.mjs';

export const TEMPLATE_IDS = ['style', 'guard', 'derive', 'lookup', 'required', 'autorun', 'table-rows'];
// 進階片段（docs/13 §九）：收回正規路徑的「查詢與 AI」「動態表格加列」；只在 flag formScriptAdvanced 開啟時可用
export const ADVANCED_IDS = ['autorun', 'table-rows'];
const PARAMS = {
  style: ['theme', 'rules'],
  guard: ['sources', 'condition', 'message', 'highlight'],
  derive: ['sources', 'target', 'expr', 'when'],
  lookup: ['name', 'source', 'table', 'target', 'miss', 'trigger'],
  required: ['targets', 'message'],
  autorun: ['action', 'only_if_empty'],
  'table-rows': ['table', 'rows', 'prefill']
};
export const THEMES = {
  clean: { label: '清爽：區塊留白、淡灰分隔線', css: ".area{margin-bottom:12px;padding:6px 10px;border-bottom:1px solid #e3e3e3}.area .panel-v{margin:0}" },
  compact: { label: '緊湊：縮小區塊間距與行高', css: ".area{margin-bottom:2px;padding:0 4px}.area .panel-body-v{line-height:1.3em}" },
  'zebra-table': { label: '表格斑馬紋與格線', css: ".area table.formtable td{border:1px solid #d9d9d9;padding:2px 6px}.area table.formtable tr:nth-child(even) td{background-color:#f7f7f7}" },
  'highlight-required': { label: '必填欄位淡黃底', css: ".area [itemid][data-value].spanblank,.area [itemid][data-value].numberblank,.area [itemid][data-value].divblank{background-color:#fff8d6 !important}" }
};
export const THEME_IDS = Object.keys(THEMES);

// ── CSS 白名單 ──────────────────────────────────────────────────────────────
const COLOR_NAMES = ['white', 'black', 'red', 'blue', 'green', 'gray', 'grey', 'yellow', 'orange', 'purple', 'pink', 'brown', 'transparent',
  'lightgray', 'lightgrey', 'lightyellow', 'lightblue', 'lightgreen', 'lightpink', 'darkred', 'darkblue', 'darkgreen', 'navy', 'teal', 'gold', 'silver'];
const COLOR = `(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*\\)|rgba\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*(?:0|1|0?\\.\\d{1,2})\\s*\\)|${COLOR_NAMES.join('|')})`;
const LEN = '(?:0|\\d{1,4}(?:\\.\\d{1,2})?(?:px|em|rem|%))';
const re = s => new RegExp(`^${s}$`);
export const COLOR_RE = re(COLOR);   // S0 控制項樣式欄位（model.mjs applyStyle）也用這一套
export const COLOR_HELP = '#rrggbb／#rgb／rgb()／色名（' + COLOR_NAMES.slice(0, 12).join('、') + '…）';
export const CSS_PROPS = {
  'color': re(COLOR), 'background-color': re(COLOR), 'background': re(COLOR),
  'font-size': re(LEN), 'font-weight': re('(?:bold|normal|[1-9]00)'),
  'width': re(`(?:auto|${LEN})`), 'min-width': re(LEN),
  'border': re(`(?:none|\\d{1,2}px (?:solid|dashed|dotted) ${COLOR})`),
  'border-left': re(`(?:none|\\d{1,2}px (?:solid|dashed|dotted) ${COLOR})`),
  'border-bottom': re(`(?:none|\\d{1,2}px (?:solid|dashed|dotted) ${COLOR})`),
  'border-radius': re(LEN), 'text-align': re('(?:left|center|right)'),
  'padding': re(`${LEN}(?: ${LEN}){0,3}`), 'margin': re(`(?:auto|${LEN})(?: (?:auto|${LEN})){0,3}`)
};
// 控制項的 color／font-size／background-color 是 runtime 的 inline style（TempHtml.js cformat），stylesheet 要 !important 才蓋得過
const CONTROL_IMPORTANT = new Set(['color', 'font-size', 'background-color', 'background']);
const CSS_VALUE_BAD = /url\(|expression\(|@import|[;{}\\<>]|\/\*/i;
const SCOPE = /^(form|area:(\d+)( table)?|control:(\d+))$/;
const MAX_RULES = 50, MAX_PROPS = 12, MAX_SNIPPETS = 20, MAX_MESSAGE = 200, MAX_TABLE = 200, MAX_ROWS = 30;
const ID_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const FN_RE = /^[a-z][a-z0-9_]{1,30}$/;
// 訊息與參數文字：不接受可組成程式碼的字元（§2.3 第二層只掃程式碼，字串內容靠這裡）
const TEXT_BAD = /[<>{}\[\]()=\\`$;]|[\u0000-\u001f]/;
// 對照表的鍵與值、預填值（藥名、診斷常含括號與等號）：放寬到只擋引號以外會組成標籤或程式區塊的字元
const VALUE_BAD = /[<>{}\\`$;]|[\u0000-\u001f]/;
const TEXT_WORDS = /\b(ck_\w+|window|document|eval|location|fetch|script)\b/i;
// SetValueByID 寫得進去的控制項（label 的值由計算式決定、按鈕與圖片沒有值）
const NOT_WRITABLE = new Set(['label', 'action', 'action2', 'imgbox', 'drawbox', 'picture']);

// ── 渲染後的禁用 token（docs/13 §2.3）：掃的是去掉字串字面值後的程式碼 ───────────────
export const FORBIDDEN_TOKENS = [
  [/\$\.(ajax|get|post|getJSON|getScript|load)\b/, '連外（jQuery ajax）'], [/\bfetch\s*\(/, '連外（fetch）'], [/XMLHttpRequest|WebSocket|EventSource|sendBeacon/, '連外'],
  [/window\.open|\blocation\b|boundAsync|window\.external|CefSharp|importScripts|\bimport\s*\(/, '跳轉或橋接'],
  [/IOTjson|Importjson|v2Token|url_root|WEB_ROOT|HISapiUrl|getheader|getIOTheader|setIOTHeader|setHeaderByValue|S_USERID|S_DEPTNO/, '身分與病歷脈絡'],
  [/\bck_\w+\s*(?:=[^=]|\+=|-=|\+\+|--)/, 'runtime 設定賦值'], [/\b(lookupdefault|shortcuts|tempdata2|parentTemplateValue)\b/, 'runtime 設定'],
  [/\b(SaveDoc\w*|SaveXMLDoc|SaveTemplate|SaveReadonlyTemplate|SaveDrawImage|LoadDoc|LoadXML|LoadTemplate|LoadChildTemplate|LoadReadonlyChildTemplate|getDoc|checkDoc|filterParentDocs|IOTupload|runtimeSavePost|runtimeQueryAjax|runtimeFeatures|scut_save|scut_cancel|insertTemplateText|getShortcuts|GetTempIDbyShortcut|fetchTemplatejsonByID|buildStructureUrl)\b/, '存檔、載入、上傳'],
  [/\b(HISquery|LLMquery|LLMvision|DWlookup\w*|IOTlookup|LookupData\w*|getLookupObj|setLookupdefault|restLookupdefault|errorLog)\b/, '查詢與 AI（繞過巨集 lint）'],
  [/\b(GetValue\w*|SetValue\d*|jsonToXml|xml2json|xmlToJson|collectDicidAndItemid|setKeyValue)\s*\(/, '整份資料'],
  [/\b(PanelAdd|RenderData\w*|RenderComponent|initComponet|initData|initF2|initF4|AddIcon|AreaAddIcon|AreaDeleteIcon|PaintLine|PaintBodyLine|loadIOTImage|RenderImage|GetImage|submenutreeBuilder\w*|show\w*picker|PopOpen|PopSure|PopClose|Auth|toggleOverlay|showThinkingDisplay)\s*\(/, '內部渲染'],
  [/\beval\s*\(|new\s+Function|setTimeout\s*\(\s*['"]|setInterval\s*\(\s*['"]|document\.write|\.html\s*\(|innerHTML|window\s*\[|globalThis|\bself\s*\[|fromCharCode|\batob\b|\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/, '動態程式'],
  [/document\.cookie|localStorage|sessionStorage|indexedDB/, '儲存']
];

// 去掉字串字面值（'…'、"…"）與註解，再掃 token；字串內容另由參數檢查管
export function stripLiterals(js) {
  return String(js).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
// 禁用 token 的命中清單（渲染後的片段與原表單 JS 共用）：[{ token, why }]
export function forbiddenHits(js) {
  const code = stripLiterals(js);
  const out = [];
  const esc = String(js).match(/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/);
  if (esc) out.push({ token: esc[0], why: '動態程式（跳脫序列）' });
  for (const [rx, why] of FORBIDDEN_TOKENS) {
    const m = code.match(rx);
    if (m) out.push({ token: m[0].trim(), why });
  }
  return out;
}
export function scanTokens(js) {
  return forbiddenHits(js).map(h => ({ code: 'E_SCRIPT_FORBIDDEN_API', level: 'error', message: `渲染後的 JS 含禁用的「${h.token}」（${h.why}）：這不該發生，是樣板的問題，請用 /strucmed:report-issue 回報` }));
}
// 原表單 JS（form_import 原封保留的 draft.source.javascript）：同一套 token 掃描，只告知不擋不改（W_CUSTOM_JS_FINDINGS）
export function scanCustomJs(js) {
  return forbiddenHits(js);
}

// ── 參數檢查 ────────────────────────────────────────────────────────────────
const bad = (id, message) => ({ code: 'E_INVALID_INPUT', level: 'error', message: `片段 ${id}：${message}` });
const int = v => Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

function areaIds(draft) {
  const ids = new Map();
  for (const a of draft.areas || []) { const n = a.area || a; ids.set(String(a.itemid ?? n.itemid), n.itemtype || 'form'); }
  return ids;
}
function controlMap(draft) {
  const m = new Map();
  walk(draft, n => { if (isControl(n)) m.set(String(n.itemid), n); });
  return m;
}
// 動態表格（table1／table2）內的控制項 itemid → 所屬區塊 itemid：每一列共用同一個 itemid，不能當單一目標
function tableControls(draft) {
  const m = new Map();
  walk(draft, (n, arr, idx, area) => {
    const a = areaNode(area);
    if (isControl(n) && (a.itemtype === 'table1' || a.itemtype === 'table2')) m.set(String(n.itemid), String(a.itemid));
  });
  return m;
}
function checkText(id, field, v, out, { required = true, rx = TEXT_BAD, max = MAX_MESSAGE } = {}) {
  if (v === undefined || v === null || v === '') { if (required) out.push(bad(id, `${field} 必填且是字串`)); return ''; }
  if (typeof v !== 'string' || !v.trim()) { out.push(bad(id, `${field} 必填且是字串`)); return ''; }
  if (v.length > max) out.push(bad(id, `${field} 超過 ${max} 字`));
  if (rx.test(v)) out.push(bad(id, `${field} 含不接受的字元（${rx === TEXT_BAD ? '<>{}[]()=\\`$; 或控制字元' : '<>{}\\`$; 或控制字元'}）`));
  if (TEXT_WORDS.test(v)) out.push(bad(id, `${field} 含不接受的字（${v.match(TEXT_WORDS)[0]}）`));
  return v;
}
function checkIds(id, field, list, ctl, out, { required = true } = {}) {
  if (list === undefined) { if (required) out.push(bad(id, `${field} 必填`)); return []; }
  if (!Array.isArray(list) || (required && !list.length)) { out.push(bad(id, `${field} 必須是 itemid 陣列`)); return []; }
  const ids = [];
  for (const x of list) {
    const n = int(x);
    if (n === null) { out.push(bad(id, `${field} 的「${x}」不是 itemid`)); continue; }
    if (!ctl.has(String(n))) out.push({ code: 'E_REF_BROKEN', level: 'error', message: `片段 ${id}：${field} 的 #${n} 不存在或不是控制項` });
    ids.push(n);
  }
  return ids;
}
function checkOneId(id, field, v, ctl, out, { required = true } = {}) {
  if (v === undefined || v === null || v === '') { if (required) out.push(bad(id, `${field} 必填（一個 itemid）`)); return null; }
  const n = int(v);
  if (n === null) { out.push(bad(id, `${field} 的「${v}」不是 itemid`)); return null; }
  if (!ctl.has(String(n))) { out.push({ code: 'E_REF_BROKEN', level: 'error', message: `片段 ${id}：${field} 的 #${n} 不存在或不是控制項` }); return null; }
  return n;
}
// 寫值目標（S2／S3）：存在、SetValueByID 寫得進去、不在動態表格
function checkWriteTarget(id, field, v, draft, ctl, out) {
  const n = checkOneId(id, field, v, ctl, out);
  if (n === null) return null;
  const c = ctl.get(String(n));
  if (NOT_WRITABLE.has(c.datatype)) out.push({ code: 'E_REF_TYPE', level: 'error', message: `片段 ${id}：${field} 的 #${n} 是 ${c.datatype}，不能用 SetValueByID 寫值（label 的值請用計算式）` });
  if (tableControls(draft).has(String(n))) out.push({ code: 'E_MACRO_TARGET_TABLE', level: 'error', message: `片段 ${id}：${field} 的 #${n} 在動態表格內：每一列共用同一個 itemid，會一次寫入所有列` });
  return n;
}
function checkExpr(id, field, v, ctl, out, what) {
  if (typeof v !== 'string' || !v.trim()) { out.push(bad(id, `${field} 必填（Calx 運算式，以 A<itemid> 參照）`)); return { expr: '', refs: [] }; }
  const expr = v.trim();
  if (/[;{}\\`]|[\u0000-\u001f]/.test(expr)) out.push(bad(id, `${field} 含不接受的字元`));
  // 純運算式：巨集專用（lookup／write／ai）與禁用函數都由 lint 擋下
  const r = lintFormula(expr, { controls: ctl }, { context: 'formula', what });
  for (const f of r.findings) out.push({ ...f, message: `片段 ${id}：${f.message}` });
  return { expr, refs: (r.refs || []).map(Number) };
}
function warnNotCalc(id, field, ids, ctl, out) {
  for (const s of ids) if (ctl.get(String(s)) && ctl.get(String(s)).tocalc === false) out.push({ code: 'W_FORMULA_REF_NOT_CALC', level: 'warn', message: `片段 ${id}：${field} 的 #${s} 沒有勾「參與計算」，改值不會觸發` });
}
const uniq = a => [...new Set(a.filter(x => x !== null && x !== undefined))];

function checkStyle(id, p, draft, out) {
  const areas = areaIds(draft), ctl = controlMap(draft);
  const theme = p.theme === undefined || p.theme === '' ? null : p.theme;
  const rules = p.rules === undefined ? [] : p.rules;
  if (theme !== null && !THEMES[theme]) out.push(bad(id, `theme 必須是 ${THEME_IDS.join(' / ')}`));
  if (!Array.isArray(rules)) { out.push(bad(id, 'rules 必須是陣列')); return { theme, rules: [], affects: [] }; }
  if (theme === null && !rules.length) out.push(bad(id, 'theme 與 rules 至少要有一個'));
  if (rules.length > MAX_RULES) out.push(bad(id, `rules 最多 ${MAX_RULES} 條`));
  const affects = new Set(), norm = [];
  rules.forEach((r, i) => {
    const where = `rules[${i}]`;
    const m = SCOPE.exec(String(r && r.scope || ''));
    if (!m) { out.push(bad(id, `${where}.scope 必須是 form｜area:<itemid>｜area:<itemid> table｜control:<itemid>`)); return; }
    let selector, important = false;
    if (m[1] === 'form') selector = '.body-content';
    else if (m[2] !== undefined) {
      if (!areas.has(m[2])) out.push({ code: 'E_REF_BROKEN', level: 'error', message: `片段 ${id}：${where}.scope 的區塊 #${m[2]} 不存在` });
      selector = m[3] ? `.area[itemid='${m[2]}'] table td` : `.area[itemid='${m[2]}']`;
      affects.add(Number(m[2]));
    } else {
      if (!ctl.has(m[4])) out.push({ code: 'E_REF_BROKEN', level: 'error', message: `片段 ${id}：${where}.scope 的控制項 #${m[4]} 不存在` });
      selector = `[itemid='${m[4]}']`; important = true; affects.add(Number(m[4]));
    }
    const css = r.css;
    if (!css || typeof css !== 'object' || Array.isArray(css)) { out.push(bad(id, `${where}.css 必須是 { 屬性: 值 }`)); return; }
    const props = Object.entries(css);
    if (!props.length) out.push(bad(id, `${where}.css 是空的`));
    if (props.length > MAX_PROPS) out.push(bad(id, `${where}.css 最多 ${MAX_PROPS} 個屬性`));
    const decl = [];
    for (const [k, v] of props) {
      const rx = CSS_PROPS[k];
      if (!rx) { out.push(bad(id, `${where}.css 不接受屬性「${k}」；可用：${Object.keys(CSS_PROPS).join('、')}`)); continue; }
      const val = String(v).trim();
      if (CSS_VALUE_BAD.test(val) || !rx.test(val)) { out.push(bad(id, `${where}.css 的 ${k} 值「${val.slice(0, 40)}」不在白名單（顏色 #hex／rgb()／色名、長度 數字+px|em|rem|%、邊框「Npx solid 顏色」）`)); continue; }
      decl.push(`${k}:${val}${important && CONTROL_IMPORTANT.has(k) ? ' !important' : ''}`);
    }
    if (decl.length) norm.push({ selector, decl });
  });
  return { theme, rules: norm, affects: [...affects] };
}

function checkGuard(id, p, draft, out) {
  const ctl = controlMap(draft);
  const sources = checkIds(id, 'sources', p.sources, ctl, out);
  const highlight = checkIds(id, 'highlight', p.highlight, ctl, out, { required: false });
  const message = checkText(id, 'message', p.message, out);
  const { expr: condition } = checkExpr(id, 'condition', p.condition, ctl, out, '條件');
  warnNotCalc(id, 'sources', sources, ctl, out);
  return { sources, highlight, message, condition, affects: uniq([...sources, ...highlight]) };
}

const WHEN = ['change', 'docload', 'both'];
// S2 derive：sources 改值（或開文件）後以 Calx 算 expr，寫進 target（非 label 的欄位）
function checkDerive(id, p, draft, out) {
  const ctl = controlMap(draft);
  const sources = checkIds(id, 'sources', p.sources, ctl, out);
  const target = checkWriteTarget(id, 'target', p.target, draft, ctl, out);
  const { expr, refs } = checkExpr(id, 'expr', p.expr, ctl, out, '運算式');
  const when = p.when === undefined ? 'change' : p.when;
  if (!WHEN.includes(when)) out.push(bad(id, `when 必須是 ${WHEN.join(' / ')}`));
  if (target !== null && sources.includes(target)) out.push(bad(id, `target #${target} 不能同時在 sources（會自己觸發自己）`));
  if (target !== null && refs.includes(target)) out.push(bad(id, `expr 參照了 target 自己（A${target}）`));
  warnNotCalc(id, 'sources', sources, ctl, out);
  return { sources, target, expr, when, affects: uniq([...sources, target]) };
}

const TRIGGER = ['change', 'customfunc'];
// S3 lookup：依 source 的值查固定對照表寫進 target；trigger customfunc 時由巨集 CUSTOMFUNC("sm_<name>") 呼叫
function checkLookup(id, p, draft, out) {
  const ctl = controlMap(draft);
  let name = '';
  if (typeof p.name !== 'string' || !FN_RE.test(p.name)) out.push(bad(id, 'name 必填：小寫英數與 _，字母開頭，2–31 字（渲染成函數 sm_<name>）'));
  else name = p.name;
  const source = checkOneId(id, 'source', p.source, ctl, out);
  const target = checkWriteTarget(id, 'target', p.target, draft, ctl, out);
  if (source !== null && target !== null && source === target) out.push(bad(id, 'source 與 target 不能是同一個欄位'));
  const table = {};
  if (!p.table || typeof p.table !== 'object' || Array.isArray(p.table)) out.push(bad(id, 'table 必填：{ 鍵: 值 }（字串對字串）'));
  else {
    const entries = Object.entries(p.table);
    if (!entries.length) out.push(bad(id, 'table 是空的'));
    if (entries.length > MAX_TABLE) out.push(bad(id, `table 最多 ${MAX_TABLE} 筆`));
    entries.forEach(([k, v], i) => {
      if (i >= MAX_TABLE) return;
      const key = checkText(id, `table 第 ${i + 1} 筆的鍵`, k, out, { rx: VALUE_BAD });
      const val = typeof v === 'number' ? String(v) : v;
      const value = checkText(id, `table「${String(k).slice(0, 20)}」的值`, val, out, { rx: VALUE_BAD });
      if (key) table[key] = value;
    });
  }
  const miss = {};
  if (p.miss !== undefined) {
    if (!p.miss || typeof p.miss !== 'object' || Array.isArray(p.miss)) out.push(bad(id, 'miss 必須是 { message?, value? }'));
    else {
      const unknown = Object.keys(p.miss).filter(k => !['message', 'value'].includes(k));
      if (unknown.length) out.push(bad(id, `miss 不認識 ${unknown.join('、')}`));
      if (p.miss.message !== undefined) miss.message = checkText(id, 'miss.message', p.miss.message, out);
      if (p.miss.value !== undefined) miss.value = checkText(id, 'miss.value', typeof p.miss.value === 'number' ? String(p.miss.value) : p.miss.value, out, { required: false, rx: VALUE_BAD });
    }
  }
  const trigger = p.trigger === undefined ? 'change' : p.trigger;
  if (!TRIGGER.includes(trigger)) out.push(bad(id, `trigger 必須是 ${TRIGGER.join(' / ')}`));
  if (source !== null && trigger === 'change') warnNotCalc(id, 'source', [source], ctl, out);
  return { name, source, target, table, miss, trigger, affects: uniq([source, target]) };
}

// S5 required：必填欄位失焦仍空白時立即提示並標示（runtime 只在存檔時檢查）
function checkRequired(id, p, draft, out) {
  const ctl = controlMap(draft);
  const targets = checkIds(id, 'targets', p.targets, ctl, out);
  const tbl = tableControls(draft);
  for (const t of targets) {
    const c = ctl.get(String(t));
    if (c && !c.required) out.push(bad(id, `targets 的 #${t} 不是必填欄位（required:false）；先用 form_update_control 設 required`));
    if (tbl.has(String(t))) out.push(bad(id, `targets 的 #${t} 在動態表格內，不支援`));
  }
  const message = checkText(id, 'message', p.message, out);
  return { targets, message, affects: uniq(targets) };
}

// S6 autorun（進階）：開文件（ck_getDocDone）後執行一顆既有的巨集按鈕；巨集本身照舊過 lint、列 AI 資料流
function checkAutorun(id, p, draft, out) {
  const ctl = controlMap(draft);
  const action = checkOneId(id, 'action', p.action, ctl, out);
  let name = '', ai = [];
  if (action !== null) {
    const c = ctl.get(String(action));
    if (c.datatype !== 'action') out.push({ code: 'E_REF_TYPE', level: 'error', message: `片段 ${id}：action 的 #${action} 是 ${c.datatype}，只能是巨集按鈕（action；LLM 按鈕 action2 不支援）` });
    else {
      name = String(c.actionName || '').trim();
      const r = lintMacro(c.actionScript, { controls: ctl, self: action });
      ai = r.ai || [];
      out.push({ code: 'W_SCRIPT_AUTORUN', level: 'warn', message: `片段 ${id}：開文件時會自動執行巨集 #${action}${name ? `「${name}」` : ''}，不需按鈕${ai.length ? `；AI／查詢步驟 ${ai.map(a => `${a.kind}→#${a.target || '?'}`).join('、')} 會自動送出` : ''}；verify-runtime 必跑並看送出了什麼` });
    }
  }
  const onlyIfEmpty = checkOneId(id, 'only_if_empty', p.only_if_empty, ctl, out, { required: false });
  return { action, onlyIfEmpty, name, ai, affects: uniq([action, onlyIfEmpty]) };
}

// S7 table-rows（進階）：開文件（或來源欄位改值）後把 table1 動態表格補到指定列數並預填
function checkTableRows(id, p, draft, out) {
  const areas = areaIds(draft), ctl = controlMap(draft), tbl = tableControls(draft);
  let table = null;
  const n = int(p.table);
  if (n === null) out.push(bad(id, 'table 必填（table1 動態表格的區塊 itemid）'));
  else if (!areas.has(String(n))) out.push({ code: 'E_REF_BROKEN', level: 'error', message: `片段 ${id}：table 的區塊 #${n} 不存在` });
  else if (areas.get(String(n)) !== 'table1') out.push({ code: 'E_REF_TYPE', level: 'error', message: `片段 ${id}：區塊 #${n} 是 ${areas.get(String(n))}，只有 table1（可加列的動態表格）支援加列` });
  else table = n;
  let count = null, source = null;
  if (!p.rows || typeof p.rows !== 'object' || Array.isArray(p.rows)) out.push(bad(id, 'rows 必填：{ count: N } 或 { source: itemid }'));
  else {
    const keys = Object.keys(p.rows);
    if (keys.length !== 1 || !['count', 'source'].includes(keys[0])) out.push(bad(id, 'rows 只能是 { count: N } 或 { source: itemid } 其中一種'));
    else if (keys[0] === 'count') {
      count = int(p.rows.count);
      if (count === null || count < 1 || count > MAX_ROWS) out.push(bad(id, `rows.count 必須是 1–${MAX_ROWS}`));
    } else {
      source = checkOneId(id, 'rows.source', p.rows.source, ctl, out);
      if (source !== null) {
        const c = ctl.get(String(source));
        if (!['numberbox', 'selection', 'radiobutton', 'textbox'].includes(c.datatype)) out.push({ code: 'E_REF_TYPE', level: 'error', message: `片段 ${id}：rows.source 的 #${source} 是 ${c.datatype}，要是值為數字的 numberbox／selection／radiobutton／textbox` });
        if (tbl.has(String(source))) out.push(bad(id, `rows.source 的 #${source} 不能在動態表格內`));
        warnNotCalc(id, 'rows.source', [source], ctl, out);
      }
    }
  }
  const prefill = {};
  if (p.prefill !== undefined) {
    if (!p.prefill || typeof p.prefill !== 'object' || Array.isArray(p.prefill)) out.push(bad(id, 'prefill 必須是 { "<欄位 itemid>": [第 1 列的值, 第 2 列的值, …] }'));
    else for (const [k, vals] of Object.entries(p.prefill)) {
      const cid = int(k);
      if (cid === null || !ctl.has(String(cid))) { out.push({ code: 'E_REF_BROKEN', level: 'error', message: `片段 ${id}：prefill 的 #${k} 不存在或不是控制項` }); continue; }
      if (table !== null && tbl.get(String(cid)) !== String(table)) { out.push(bad(id, `prefill 的 #${cid} 不在表格 #${table} 內`)); continue; }
      if (NOT_WRITABLE.has(ctl.get(String(cid)).datatype)) { out.push({ code: 'E_REF_TYPE', level: 'error', message: `片段 ${id}：prefill 的 #${cid} 是 ${ctl.get(String(cid)).datatype}，寫不進值` }); continue; }
      if (!Array.isArray(vals) || !vals.length) { out.push(bad(id, `prefill 的 #${cid} 必須是值的陣列（依列順序）`)); continue; }
      if (vals.length > MAX_ROWS) { out.push(bad(id, `prefill 的 #${cid} 最多 ${MAX_ROWS} 個值`)); continue; }
      prefill[cid] = vals.map((v, i) => checkText(id, `prefill #${cid} 第 ${i + 1} 列`, typeof v === 'number' ? String(v) : v, out, { required: false, rx: VALUE_BAD }));
    }
  }
  return { table, count, source, prefill, affects: uniq([table, source, ...Object.keys(prefill).map(Number)]) };
}

const CHECK = { style: checkStyle, guard: checkGuard, derive: checkDerive, lookup: checkLookup, required: checkRequired, autorun: checkAutorun, 'table-rows': checkTableRows };

// 正規化後要存進 draft 的 params（只留認識的鍵、去掉 undefined）
function normParams(template, p, n) {
  switch (template) {
    case 'style': return { ...(n.theme && { theme: n.theme }), ...(p.rules !== undefined && { rules: p.rules }) };
    case 'guard': return { sources: n.sources, condition: n.condition, message: n.message, ...(n.highlight.length && { highlight: n.highlight }) };
    case 'derive': return { sources: n.sources, target: n.target, expr: n.expr, when: n.when };
    case 'lookup': return { name: n.name, source: n.source, table: n.table, target: n.target, ...(Object.keys(n.miss).length && { miss: n.miss }), trigger: n.trigger };
    case 'required': return { targets: n.targets, message: n.message };
    case 'autorun': return { action: n.action, ...(n.onlyIfEmpty !== null && { only_if_empty: n.onlyIfEmpty }) };
    case 'table-rows': return { table: n.table, rows: n.count !== null ? { count: n.count } : { source: n.source }, ...(Object.keys(n.prefill).length && { prefill: n.prefill }) };
  }
}

// 哪些片段參照到這個 itemid（form_remove_control／form_remove_area 的阻擋用）
export function snippetRefsTo(draft, itemid) {
  const list = (draft.script && draft.script.snippets) || [];
  if (!list.length) return [];
  const { snippets } = checkSnippets(draft, list);
  return snippets.filter(s => s.affects.includes(Number(itemid))).map(s => ({ from: `snippet:${s.id}`, kind: `snippet:${s.template}` }));
}
// 巨集 CUSTOMFUNC 可呼叫的函數名：lookup 片段（trigger customfunc）渲染出的 sm_<name>
export function scriptFunctions(draft) {
  const list = (draft && draft.script && draft.script.snippets) || [];
  return list.filter(s => s.template === 'lookup' && s.params && s.params.trigger === 'customfunc' && FN_RE.test(String(s.params.name || ''))).map(s => `sm_${s.params.name}`);
}

// 檢查整份 snippets；回 { snippets（正規化）, findings }。findings 有 error 時呼叫端不得儲存。
export function checkSnippets(draft, snippets) {
  const findings = [], out = [];
  if (!Array.isArray(snippets)) return { snippets: [], findings: [{ code: 'E_INVALID_INPUT', level: 'error', message: 'snippets 必須是陣列（空陣列＝清除）' }] };
  if (snippets.length > MAX_SNIPPETS) findings.push({ code: 'E_INVALID_INPUT', level: 'error', message: `snippets 最多 ${MAX_SNIPPETS} 個` });
  const seen = new Set(), names = new Set();
  const advanced = enabled('formScriptAdvanced');
  snippets.forEach((s, i) => {
    const id = s && s.id !== undefined ? String(s.id) : `s${i + 1}`;
    if (!ID_RE.test(id)) findings.push({ code: 'E_INVALID_INPUT', level: 'error', message: `snippets[${i}].id「${id}」必須是小寫英數、- 或 _，1–31 字，字母開頭` });
    if (seen.has(id)) findings.push({ code: 'E_INVALID_INPUT', level: 'error', message: `片段 id「${id}」重複` });
    seen.add(id);
    const template = s && s.template;
    if (!TEMPLATE_IDS.includes(template)) { findings.push(bad(id, `template 必須是 ${TEMPLATE_IDS.join(' / ')}`)); return; }
    if (ADVANCED_IDS.includes(template) && !advanced) findings.push({ code: 'E_FEATURE_DISABLED', level: 'error', message: `片段 ${id}：樣板 ${template} 是進階片段，需要 feature flag formScriptAdvanced（feature-flags.json，預設關）` });
    const p = s.params && typeof s.params === 'object' ? s.params : {};
    const allowed = PARAMS[template];
    const unknown = Object.keys(p).filter(k => !allowed.includes(k));
    if (unknown.length) findings.push(bad(id, `params 不認識 ${unknown.join('、')}；可用：${allowed.join('、')}`));
    const norm = CHECK[template](id, p, draft, findings);
    if (template === 'lookup' && norm.name) {
      if (names.has(norm.name)) findings.push(bad(id, `name「${norm.name}」與另一個 lookup 片段重複`));
      names.add(norm.name);
    }
    out.push({ id, template, params: normParams(template, p, norm), affects: norm.affects, advanced: ADVANCED_IDS.includes(template) });
  });
  return { snippets: out, findings };
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
const q = s => JSON.stringify(String(s));
const PRELUDE = "function sm_style_add(css){var s=document.getElementById('sm_style');if(!s){s=document.createElement('style');s.id='sm_style';document.head.appendChild(s);}s.appendChild(document.createTextNode(css));}";
const GUARD_CSS = ".sm-guard{background-color:#ffd8d8 !important;border-left:solid 5px red !important;padding-left:5px}";
const wrap = (id, body) => `try {\n${body}\n} catch (e) { console.error('strucmed-skill snippet ${id}', e); }`;
const fnName = (kind, id) => `sm_${kind}_${id.replace(/-/g, '_')}`;
const sel = ids => ids.map(s => `[itemid='${s}']`).join(',');
// 文件載入完成（ck_getDocDone 只讀，沒有事件）：每 500ms 看一次、最多 60 次；逾時放棄並 console.warn。
// 沒有病人（ck_hasPatient false：預覽頁、沒有 HIS header）時 runtime 不會 getDoc，ck_getDocDone 永遠是 false → 1 秒後直接執行
const onDocLoad = (fn, id) => `(function sm_wait(n) { var done = (typeof ck_getDocDone !== 'undefined' && ck_getDocDone === true) || (typeof ck_hasPatient !== 'undefined' && ck_hasPatient === false && n <= 58); if (done) { ${fn}(); } else if (n > 0) { setTimeout(function () { sm_wait(n - 1); }, 500); } else { console.warn('strucmed-skill snippet ${id}: ck_getDocDone 逾時'); } })(60);`;
// sources 的 keyup／change／blur 以 150ms 去抖
const onChange = (fn, ids) => `$(document).on('keyup change blur', ${q(sel(ids))}, function () { clearTimeout(${fn}_t); ${fn}_t = setTimeout(${fn}, 150); });`;
const evalExpr = expr => `$(targetid).calx('evaluate', ${q(expr)})`;

function renderStyle(id, p, draft) {
  const n = checkStyle(id, p, draft, []);
  const css = [n.theme ? THEMES[n.theme].css : '', ...n.rules.map(r => `${r.selector}{${r.decl.join(';')}}`)].filter(Boolean).join('\n');
  return { js: wrap(id, `sm_style_add(${q(css)});`), css, summary: `樣式：${[n.theme && `主題 ${n.theme}`, n.rules.length && `${n.rules.length} 條規則`].filter(Boolean).join('、')}`, affects: n.affects };
}
function renderGuard(id, p, draft) {
  const n = checkGuard(id, p, draft, []);
  const fn = fnName('guard', id);
  const hl = sel(n.highlight);
  // 只在「沒問題 → 有問題」時提示一次（keyup、change、blur 會連續觸發）
  const body = [
    `var ${fn}_last = false, ${fn}_t = null;`,
    `function ${fn}() {`,
    `  var v = ${evalExpr(n.condition)};`,
    `  var hit = v === true || v === 1 || String(v).toUpperCase() === 'TRUE';`,
    hl ? `  $(${q(hl)}).toggleClass('sm-guard', hit);` : '',
    `  if (hit && !${fn}_last) errormessage(${q(n.message)});`,
    `  ${fn}_last = hit;`,
    `}`,
    onChange(fn, n.sources),
    onDocLoad(fn, id)
  ].filter(Boolean).join('\n');
  return { js: wrap(id, body), summary: `條件提示：${n.condition} → 「${n.message}」`, affects: n.affects };
}
function renderDerive(id, p, draft) {
  const n = checkDerive(id, p, draft, []);
  const fn = fnName('derive', id);
  // 值沒變就不寫（SetValueByID 會 refresh 整張 Calx，避免無謂重算）
  const body = [
    `var ${fn}_t = null;`,
    `function ${fn}() {`,
    `  var v = ${evalExpr(n.expr)};`,
    `  if (v === undefined || v === null) return;`,
    `  var cur = ${evalExpr(`A${n.target}`)};`,
    `  if (String(v) !== String(cur === undefined || cur === null ? '' : cur)) SetValueByID(${n.target}, v);`,
    `}`,
    n.when !== 'docload' ? onChange(fn, n.sources) : '',
    n.when !== 'change' ? onDocLoad(fn, id) : ''
  ].filter(Boolean).join('\n');
  const whenText = { change: '改值後', docload: '開文件時', both: '改值後與開文件時' }[n.when];
  return { js: wrap(id, body), summary: `連動寫值：#${n.sources.join('、#')} ${whenText}把 ${n.expr} 寫進 #${n.target}`, affects: n.affects };
}
function renderLookup(id, p, draft) {
  const n = checkLookup(id, p, draft, []);
  const fn = `sm_${n.name}`;
  const miss = [n.miss.value !== undefined ? `SetValueByID(${n.target}, ${q(n.miss.value)});` : '', n.miss.message ? `errormessage(${q(n.miss.message)});` : ''].filter(Boolean).join(' ');
  const body = [
    `var ${fn}_t = null;`,
    `function ${fn}() {`,
    `  var r = ${evalExpr(`A${n.source}`)};`,
    `  var k = String(r === undefined || r === null ? '' : r).trim();`,
    `  var t = ${JSON.stringify(n.table)};`,
    `  if (Object.prototype.hasOwnProperty.call(t, k)) { SetValueByID(${n.target}, t[k]); return t[k]; }`,
    miss ? `  ${miss}` : '',
    `  return '';`,
    `}`,
    n.trigger === 'change' ? onChange(fn, [n.source]) : ''
  ].filter(Boolean).join('\n');
  const count = Object.keys(n.table).length;
  return { js: wrap(id, body), summary: `對照表：依 #${n.source} 查 ${count} 筆寫進 #${n.target}（${n.trigger === 'customfunc' ? `巨集 CUSTOMFUNC("${fn}")` : '改值後'}${n.miss.message ? `；查無時提示「${n.miss.message}」` : ''}${n.miss.value !== undefined ? `；查無時寫「${n.miss.value}」` : ''}）`, affects: n.affects };
}
function renderRequired(id, p, draft) {
  const n = checkRequired(id, p, draft, []);
  // 失焦（focusout；委派的 blur 也會映射成 focusout，兩個都綁會提示兩次）時沒有文字也沒有勾選就提示並標示；填了就移除。
  // 不看 runtime 的 spanblank 類別：它在我們的 handler 之後才更新（harness 實測填了值仍是 spanblank）
  const body = [
    `$(document).on('focusout', ${q(sel(n.targets))}, function () {`,
    `  var el = $(this);`,
    `  var txt = el.is('input,textarea,select') ? el.val() : el.text();`,
    `  var empty = !String(txt === undefined || txt === null ? '' : txt).trim() && !el.find('input:checked').length;`,
    `  el.toggleClass('sm-guard', empty);`,
    `  if (empty) errormessage(${q(n.message)});`,
    `});`
  ].join('\n');
  return { js: wrap(id, body), summary: `必填提示：#${n.targets.join('、#')} 失焦仍空白時提示「${n.message}」`, affects: n.affects };
}
function renderAutorun(id, p, draft) {
  const n = checkAutorun(id, p, draft, []);
  const fn = fnName('autorun', id);
  const body = [
    `function ${fn}() {`,
    n.onlyIfEmpty !== null ? `  var cur = ${evalExpr(`A${n.onlyIfEmpty}`)};\n  if (cur !== undefined && cur !== null && String(cur).trim() !== '') return;` : '',
    `  performActionByID(${n.action});`,
    `}`,
    onDocLoad(fn, id)
  ].filter(Boolean).join('\n');
  return { js: wrap(id, body), summary: `開文件後自動執行巨集 #${n.action}${n.name ? `「${n.name}」` : ''}${n.onlyIfEmpty !== null ? `（#${n.onlyIfEmpty} 已有值時不執行）` : ''}${n.ai.length ? `；AI／查詢步驟 ${n.ai.map(a => `${a.kind}→#${a.target || '?'}`).join('、')} 會自動送出` : ''}`, affects: n.affects, advanced: true };
}
function renderTableRows(id, p, draft) {
  const n = checkTableRows(id, p, draft, []);
  const fn = fnName('rows', id);
  // rowid='0' 是 runtime 的隱藏樣板列（加列按鈕那一列沒有 rowid，不算）；TableRowAdd(table) 複製它、回傳新列的 rowid；預填以該列內的元素在 [itemid] 清單中的序號呼叫 SetValueByID(id, val, subid)
  const body = [
    `var ${fn}_t = null;`,
    `function ${fn}() {`,
    `  var table = $(".area[itemid='${n.table}'] table").first();`,
    `  if (!table.length) return;`,
    n.count !== null ? `  var want = ${n.count};` : `  var r = ${evalExpr(`A${n.source}`)};\n  var want = parseInt(r, 10);`,
    `  if (!(want > 0)) return;`,
    `  if (want > ${MAX_ROWS}) want = ${MAX_ROWS};`,
    `  var have = table.find("tbody > tr[rowid]").filter(function () { return $(this).attr('rowid') !== '0'; }).length;`,
    `  var pre = ${JSON.stringify(n.prefill)};`,
    `  for (var i = have; i < want; i++) {`,
    `    var rowIndex = TableRowAdd(table);`,
    `    var tr = table.find("tbody > tr[rowid='" + rowIndex + "']");`,
    `    for (var id in pre) {`,
    `      if (!Object.prototype.hasOwnProperty.call(pre, id) || pre[id][i] === undefined) continue;`,
    `      var all = $("[itemid='" + id + "']");`,
    `      var sub = all.index(tr.find("[itemid='" + id + "']").first());`,
    `      if (sub >= 0) SetValueByID(parseInt(id, 10), pre[id][i], sub);`,
    `    }`,
    `  }`,
    `}`,
    n.source !== null ? onChange(fn, [n.source]) : '',
    onDocLoad(fn, id)
  ].filter(Boolean).join('\n');
  const pre = Object.keys(n.prefill).length ? `，預填 #${Object.keys(n.prefill).join('、#')}` : '';
  return { js: wrap(id, body), summary: `動態表格加列：區塊 #${n.table} 開文件時補到 ${n.count !== null ? `${n.count} 列` : `#${n.source} 的值那麼多列（改值後也補）`}${pre}`, affects: n.affects, advanced: true };
}
const RENDER = { style: renderStyle, guard: renderGuard, derive: renderDerive, lookup: renderLookup, required: renderRequired, autorun: renderAutorun, 'table-rows': renderTableRows };

// 渲染整份；回 { js（不含標記行）, snippets:[{id,template,summary,affects,advanced?}], findings（token 掃描）, hash }
export function renderSnippets(draft) {
  const list = (draft.script && draft.script.snippets) || [];
  if (!list.length) return { js: '', snippets: [], findings: [], hash: '' };
  const parts = [PRELUDE];
  if (list.some(s => s.template === 'guard' || s.template === 'required')) parts.push(wrap('guard-css', `sm_style_add(${q(GUARD_CSS)});`));
  const snippets = [];
  for (const s of list) {
    const r = RENDER[s.template](s.id, s.params, draft);
    parts.push(`// snippet ${s.id} (${s.template})`, r.js);
    snippets.push({ id: s.id, template: s.template, summary: r.summary, affects: r.affects, ...(r.advanced && { advanced: true }) });
  }
  const js = parts.join('\n');
  return { js, snippets, findings: scanTokens(js), hash: hashOf(js) };
}

// form_export／online_template_create／update 第一次呼叫 plan 的「表單 JS」段（閘門 G2 核准的對象）
export function scriptPlan(draft) {
  const r = renderSnippets(draft);
  if (!r.js) return {};
  const adv = r.snippets.filter(s => s.advanced);
  return { script: { snippets: r.snippets.map(s => `${s.template}#${s.id}${s.advanced ? '（進階）' : ''}：${s.summary}`), ...(adv.length && { advanced: adv.map(s => `${s.template}#${s.id}：${s.summary}`) }), sha256: r.hash, rendered: r.js } };
}

export const hashOf = js => crypto.createHash('sha256').update(String(js)).digest('hex').slice(0, 12);
const MARKER_RE = /^\/\/ strucmed-skill snippets=\[([^\]\n]*)\] sha256=([0-9a-f]{12})[ \t]*$/m;
// 寫進表單 javascript 區塊的內容（標記行＋片段清單＋程式碼）；沒有片段時回 ''
export function scriptBlock(draft) {
  const r = renderSnippets(draft);
  if (!r.js) return '';
  return `// strucmed-skill snippets=[${r.snippets.map(s => `${s.template}#${s.id}`).join(',')}] sha256=${r.hash}\n${r.js}`;
}
// 上架後比對：表單 JS 區塊若有本工具的標記行，重算標記行之後的程式碼雜湊；不符＝被人工改過（W_SCRIPT_MODIFIED）。沒有標記行回 null
export function verifyScriptBlock(content) {
  const s = String(content || '');
  const m = MARKER_RE.exec(s);
  if (!m) return null;
  const rendered = s.slice(m.index + m[0].length).replace(/^\r?\n/, '').replace(/\s+$/, '');
  const actual = hashOf(rendered);
  return { snippets: m[1] ? m[1].split(',') : [], sha256: m[2], actual, matches: actual === m[2] };
}
