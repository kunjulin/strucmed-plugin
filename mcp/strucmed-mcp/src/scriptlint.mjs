// v0.2：計算式、巨集、HIS 參照的離線檢查。
// 每條規則都對應平台 runtime 的實際行為（平台 web/js/TempHtml.js），不是一般 Excel 規則。
// finding：{ code, level:'error'|'warn', message }。level=error 的項目由 validate 依「是否本次新增／修改」
// 決定要當 error 還是 warning（原表單既有）；level=warn 一律是 warning。
import { check } from './calx.mjs';
import { classify, STEP, FORMULA_REPLACED, LLM_MODELS, LLM_ALIASES, LLM_REMOVED, VISION_MODELS, ASR_PROVIDERS, ASR_REMOVED, ATTACH_MODELS, GATEWAY_ONLY_MODELS, GATEWAY_MODEL_MAX_BYTES, LLM_SUNSET, sunsetModel, sunsetPassed, ATTACH_KINDS, ATTACH_KIND_LABELS } from './calx-catalog.mjs';
import { checkAlias } from './policy.mjs';
import { checkUrl, launchBridge, BRIDGE_PAGE } from './embed.mjs';
import { enabled } from './flags.mjs';

// 需要 numeral.js／jStat 的內建函數（2026-09-28 以 tools/v0-harness/calx-parity.html 在真實 Calx 2.2.8 實測）。
// 舊版 TempHtml.html 沒有載入這兩個套件：
//   numeral.js 缺 → "#NAME?"：DOLLAR FIXED TEXT VALUE
//   jStat 缺 → "#ERROR_JSTAT_JS_REQUIRED!"：44 個統計函數
//   jStat 缺且沒有防呆 → 直接拋錯：STDEVA ERF ERFC
// 新版平台已補載入（實測全部可用），但 HIS 端要等該版本部署後才生效 → 只列警告。
// 確認已部署後，可在 .strucmed/policy.json 設 "runtime_has_numeral_jstat": true 關閉此警告。
export const UNAVAILABLE = new Map([
  ...['DOLLAR', 'FIXED', 'TEXT', 'VALUE'].map(n => [n, '缺 numeral.js，回傳 #NAME?']),
  ...['AVEDEV', 'AVERAGEA', 'BETADIST', 'BETAINV', 'BINOMDIST', 'BINOMINV', 'CHISQDIST', 'CHISQINV', 'CONFIDENCENORM', 'CONFIDENCET', 'CORREL', 'COVARIANCEP', 'COVARIANCES', 'DEVSQ', 'EXPONDIST', 'FDIST', 'FINV', 'FORECAST', 'GAMMA', 'GAMMALN', 'GAUSS', 'GEOMEAN', 'KURT', 'LINEST', 'LOGNORMDIST', 'LOGNORMINV', 'MEDIAN', 'NEGBINOMDIST', 'NORMDIST', 'NORMINV', 'NORMSDIST', 'NORMSINV', 'PEARSON', 'POISSONDIST', 'SKEW', 'SKEWP', 'SLOPE', 'STDEVPA', 'STEYX', 'TDIST', 'TINV', 'TRIMMEAN', 'VARA', 'VARPA'].map(n => [n, '缺 jStat，回傳 #ERROR_JSTAT_JS_REQUIRED!']),
  ...['STDEVA', 'ERF', 'ERFC'].map(n => [n, '缺 jStat，執行時拋錯'])
]);

const err = (code, message) => ({ code, level: 'error', message });
const warn = (code, message) => ({ code, level: 'warn', message });

// ── 平台的步驟與參數切分（平台 web/js/TempHtml.js extractPiplineSteps，20261124b 起；kunjulin/strucmed#264）──
// 引號（" 或 '，以同一種引號結束）內的逗號與括號不算分隔與深度；沒有反斜線跳脫（"" 是結束後立刻再開始，自然成立）。
// IE11 的 web/temp.html（20261118）與編輯器 scripts.js 的 AttachSplitTop 同一套切法。
export function platformSplit(s) {
  const steps = [];
  let cur = '', depth = 0, q = '';
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = ''; cur += ch; continue; }
    if (ch === ',' && depth === 0) { steps.push(cur.trim()); cur = ''; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    cur += ch;
  }
  if (cur) steps.push(cur.trim());
  return { steps, depth, unterminated: !!q };
}
// 20261124b 以前的 runtime：只計算括號深度，不理會引號（HIS 端還沒部署新版時，字串裡的逗號或括號會被切開）
export function legacySplit(s) {
  const steps = [];
  let cur = '', depth = 0;
  for (const ch of String(s)) {
    if (ch === ',' && depth === 0) { steps.push(cur.trim()); cur = ''; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    cur += ch;
  }
  if (cur) steps.push(cur.trim());
  return { steps, depth };
}
const sameSplit = (a, b) => JSON.stringify(a.steps) === JSON.stringify(b.steps);
// Calx 字串的切分（Calx 的字串可用 \" 跳脫；runtime 切分不認反斜線）：用來偵測 runtime 切分與 Calx 解析不一致
export function calxSplit(s) {
  const steps = [];
  let cur = '', depth = 0, q = null;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q) {
      cur += ch;
      if (ch === '\\' && i + 1 < str.length) { cur += str[++i]; continue; }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',' && depth === 0) { steps.push(cur.trim()); cur = ''; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    cur += ch;
  }
  if (cur) steps.push(cur.trim());
  return { steps, depth, unterminated: !!q };
}

const isIntLiteral = t => /^\s*\d+\s*$/.test(t);
const strLiteral = t => { const m = /^\s*(["'])([\s\S]*)\1\s*$/.exec(t); return m ? m[2] : null; };

// ctx：{ controls: Map<string itemid, node>, policy: {llm_models?:string[]}, self?: itemid }
function refFindings(info, ctx, out, what) {
  const refs = [];
  for (const c of info.cells) {
    if (c.fixed) { out.push(err('E_FORMULA_REF', `${what}使用固定參照（$ 符號）：表單中取不到值（實測回傳 FALSE），請改寫成 ${c.addr}`)); continue; }
    const m = /^A(\d+)$/.exec(c.addr);
    if (!m) { out.push(err('E_FORMULA_REF', `${what}參照了「${c.addr}」：只能用 A<itemid> 參照控制項`)); continue; }
    refs.push(m[1]);
    if (!ctx.controls) continue;
    const n = ctx.controls.get(m[1]);
    if (!n) out.push(err('E_REF_BROKEN', `${what}參照的 A${m[1]} 不存在`));
    else if (n.tocalc === false) out.push(err('E_FORMULA_REF_NOT_CALC', `${what}參照的 A${m[1]}（${n.datatype}）沒有勾「參與計算」，runtime 取不到值`));
    if (ctx.self !== undefined && String(ctx.self) === m[1] && what === '計算式') out.push(err('E_FORMULA_CYCLE', `計算式參照自己（A${m[1]}）`));
  }
  if (info.ranges.length) out.push(warn('W_FORMULA_RANGE', `${what}使用範圍參照（${info.ranges.map(r => `${r.from}:${r.to}`).join('、')}）：itemid 不連續時會包含無關的欄位`));
  for (const r of info.ranges) {
    const a = /^A(\d+)$/.exec(r.from), b = /^A(\d+)$/.exec(r.to);
    if (a && b) for (let i = Number(a[1]); i <= Number(b[1]) && i - Number(a[1]) < 500; i++) refs.push(String(i));
  }
  if (info.sheets.length) out.push(err('E_FORMULA_REF', `${what}使用跨表參照（${info.sheets.map(s => s.sheet).join('、')}），表單中沒有其他工作表`));
  for (const v of info.variables) {
    if (!['TRUE', 'FALSE', 'NULL'].includes(v.name.toUpperCase())) {
      out.push(err('E_FORMULA_UNDEFINED_VARIABLE', `${what}中的「${v.name}」不是函數、字串或 A<itemid>，runtime 會得到 #UNDEFINED_VARIABLE!（文字請加引號）`));
    }
  }
  for (const s of info.strings) {
    if (/(^|[^A-Za-z0-9_])[Aa]\d+/.test(s.text)) {
      out.push(warn('W_RENUMBER_STRING', `${what}的字串「${s.text.slice(0, 20)}」含 A<數字> 樣式：編輯器「重新編號」會把它當成參照一起改掉`));
    }
  }
  return refs;
}

// context：'formula'（label 計算式、imgbox 函數網址）或 'macro'（巨集步驟、LLM 控制項 prompt）
function functionFindings(info, context, out, what, ctx = {}, src) {
  for (const f of info.functions) {
    const cls = classify(f.name);
    if (cls === null) {
      const stepName = Object.keys(STEP).find(k => k.toUpperCase() === f.name);
      if (stepName) out.push(err('E_MACRO_STEP_POSITION', `${stepName} 只能是巨集步驟的開頭，而且大小寫必須是「${stepName}」；寫在其他位置會得到 #NAME?`));
      else out.push(err('E_FORMULA_UNKNOWN_FUNCTION', `未知的函數 ${f.raw}()：runtime 會得到 #NAME?`));
      continue;
    }
    if (UNAVAILABLE.has(f.name) && !(ctx.policy && ctx.policy.runtime_has_numeral_jstat)) {
      out.push(warn('W_FORMULA_FN_NEEDS_DEPLOY', `${f.raw}() 需要新版平台部署到 HIS 端後才可用（舊版${UNAVAILABLE.get(f.name)}）`));
    }
    if (cls === 'custom') {
      // CUSTOMFUNC("name", …)＝window[name].apply（平台 TempHtml.js:465）：只放行本 draft 片段渲染出的函數，且第一個參數必須是字串字面值
      // ctx.scriptFunctions：null＝flag formScript 關（一律禁止）；陣列＝本 draft 目前定義的函數名（片段可以晚於巨集建立，缺的延後到 form_validate）
      const list = Array.isArray(ctx.scriptFunctions) ? ctx.scriptFunctions.map(String) : null;
      const arg = src !== undefined ? argText(src, f, 0) : null;
      const name = arg === null ? null : strLiteral(arg);
      if (context === 'formula') out.push(err('E_FORBIDDEN_FUNCTION', `${f.raw}() 不能放在計算式（每次重算都會執行）；只能在巨集呼叫本 draft 以 form_set_script 的 lookup 片段定義的函數`));
      else if (list === null) out.push(err('E_FORBIDDEN_FUNCTION', `${f.raw}() 不在本工具允許範圍（任意函數名）；feature flag formScript 開啟時只允許呼叫本 draft 以 form_set_script 的 lookup 片段（trigger customfunc）定義的函數`));
      else if (name === null) out.push(err('E_FORBIDDEN_FUNCTION', `${f.raw}() 的第一個參數必須是字串字面值（本 draft 片段定義的函數名）`));
      else if (!list.includes(name)) out.push(err('E_CUSTOMFUNC_UNDEFINED', `${f.raw}("${name}") 不是本 draft 片段定義的函數（${list.length ? `目前有 ${list.join('、')}` : '目前沒有'}）：請用 form_set_script 加 lookup 片段（trigger customfunc、name「${name.replace(/^sm_/, '')}」）`));
      continue;
    }
    if (cls === 'panel') {
      // OPENPANEL(url, title)：StrucForm 1.10.9 起開在右側子面板（更早開浮動面板，不取代表單），非 HIS 退回 window.open；網址規則與 embed 區塊的 url 相同（embed.mjs，
      // 平台 web/js/embed-block.js 的 checkUrl）。flag embedArea 關閉時與其他開網址函數一樣禁用；ctx.embedArea 可覆寫（測試用）
      const on = ctx.embedArea !== undefined ? !!ctx.embedArea : enabled('embedArea');
      if (!on) { out.push(err('E_FORBIDDEN_FUNCTION', `${f.raw}() 需要 feature flag embedArea（3.11.0 起預設開，目前被關閉）；flag 關閉時本工具不產生開網址的函數`)); continue; }
      if (context === 'formula') { out.push(err('E_FORMULA_MACRO_ONLY', `${f.raw}() 是巨集專用函數，不能放在計算式（每次重算都會開面板）`)); continue; }
      const arg = src !== undefined ? argText(src, f, 0) : null;
      const url = arg === null ? null : strLiteral(arg);
      if (url === null) { out.push(err('E_EMBED_URL', `${f.raw}() 的網址必須是字串字面值（不能用欄位或運算式組網址，離線才檢查得了 https 與主機）`)); continue; }
      const r = checkUrl(url);
      for (const e of r.errors) out.push(err(e.code, `${f.raw}()：${e.message}`));
      if (r.ok) out.push({ ...warn('W_EMBED_DATAFLOW', `${f.raw}() 按下時開啟院內頁面 ${r.host}（右側子面板或浮動面板；不帶參數、不送 strucmed.context、不寫回欄位）`), host: r.host, url: r.url });
      // 啟動橋接頁要收到 strucmed.context 才會向站台換啟動網址；OPENPANEL 不送 context，APP 永遠不會啟動
      if (r.ok && launchBridge(r.url)) out.push(warn('W_EMBED_BRIDGE_PANEL', `${f.raw}() 開的是站台的啟動橋接頁（${BRIDGE_PAGE}）：橋接頁要收到 strucmed.context 才啟動 APP，${f.raw}() 不送 context，面板只會停在「這個頁面要從結構化表單開啟」；請改用 embed 區塊`));
      continue;
    }
    if (cls === 'attach') {
      // ATTACHCOUNT／ATTACHTEXT（平台 web/js/attachbox.js）：flag attachBox 關閉時本工具不產生；第一個參數必須是附件容器的 itemid
      if (!attachOn(ctx)) { out.push(err('E_FEATURE_DISABLED', `${f.raw}() 需要 feature flag attachBox（附件容器，目前關閉）`)); continue; }
      if (context === 'formula' && f.name === 'ATTACHTEXT') { out.push(err('E_FORMULA_MACRO_ONLY', `${f.raw}() 只能用在巨集步驟或 LLM 按鈕的 prompt：放在計算式每次重算都會取一次容器全文`)); continue; }
      const arg = src !== undefined ? argText(src, f, 0) : null;
      if (arg === null || !isIntLiteral(arg)) out.push(err('E_ATTACH_SOURCE', `${f.raw}() 的第一個參數必須是附件容器的 itemid（直接寫數字）`));
      else attachSource(arg.trim(), ctx, out, f.raw + '()');
      continue;
    }
    if (cls === 'forbidden') out.push(err('E_FORBIDDEN_FUNCTION', `${f.raw}() 不在本工具允許範圍（任意程式、開網址、存檔、改寫身分或文件 header、連外）；確有需要請匯入後由人工在編輯器加入並審查`));
    else if (context === 'formula' && ['lookup', 'write', 'ai'].includes(cls)) out.push(err('E_FORMULA_MACRO_ONLY', `${f.raw}() 是巨集專用函數，不能放在計算式`));
    else if (cls === 'setting') out.push(warn('W_SETTING_FUNCTION', `${f.raw}() 會改變整張表單的行為（${what}）`));
    else if (cls === 'lookup') out.push(warn('W_PATIENT_DATA_READ', `${f.raw}() 會在 HIS 端讀取病人資料`));
  }
}

// ── 附件容器（flag attachBox）──────────────────────────────────────────────
const attachOn = ctx => (ctx.attachBox !== undefined ? !!ctx.attachBox : enabled('attachBox'));
// 容器可放入的類型：沒有 attachkinds 的舊容器只收影像（平台 attachbox.js kindsOf）
export function attachKindsOf(n) {
  const list = String((n && n.attachkinds) || 'image').split(/[\s,]+/).filter(k => ATTACH_KINDS.includes(k));
  return list.length ? list : ['image'];
}
// 檢查一個容器 id；回 { itemid, kinds } 或 null（不存在、不是容器）
function attachSource(id, ctx, out, fn) {
  if (!ctx.controls) return { itemid: Number(id), kinds: null };
  const n = ctx.controls.get(String(id));
  if (!n) { out.push(err('E_REF_BROKEN', `${fn} 的附件容器 #${id} 不存在`)); return null; }
  if (n.datatype !== 'attachbox') { out.push(err('E_ATTACH_SOURCE', `${fn} 的來源 #${id} 是 ${n.datatype}，必須是附件容器（attachbox）`)); return null; }
  return { itemid: Number(id), kinds: attachKindsOf(n) };
}
// 巨集步驟的容器清單（LLMATTACH 第四個以後、ATTACHTRANSCRIBE 全部）：平台不經計算，只把參數接回去、去掉引號，再以空白／逗號／分號切開
function attachSources(params, ctx, out, fn) {
  const text = params.join(',').replace(/["']/g, '').trim();
  if (!text) {
    // 省略＝頁面上所有容器
    if (!ctx.controls) return [];
    const all = [...ctx.controls.values()].filter(n => n.datatype === 'attachbox').map(n => ({ itemid: Number(n.itemid), kinds: attachKindsOf(n) }));
    if (!all.length) out.push(err('E_ATTACH_SOURCE', `${fn} 沒有指定容器，表單裡也沒有附件容器（attachbox）`));
    return all;
  }
  const found = [];
  for (const id of text.split(/[\s,;]+/).filter(Boolean)) {
    if (!/^\d+$/.test(id)) { out.push(err('E_ATTACH_SOURCE', `${fn} 的容器 id「${id.slice(0, 20)}」必須直接寫 itemid 數字：這個位置不經計算，A12 或運算式都無效`)); continue; }
    const s = attachSource(id, ctx, out, fn);
    if (s) found.push(s);
  }
  return found;
}
const kindsText = list => [...new Set(list.flatMap(s => s.kinds || []))].map(k => ATTACH_KIND_LABELS[k]).join('、');

// ── 計算式 ────────────────────────────────────────────────────────────────
export function lintFormula(text, ctx = {}, { context = 'formula', what = '計算式' } = {}) {
  const out = [];
  const src = String(text || '');
  if (!src.trim()) return { findings: out, refs: [], functions: [] };
  if (context === 'formula') {
    for (const bad of FORMULA_REPLACED) {
      if (src.includes(bad)) out.push(err('E_FORMULA_REPLACED', `計算式含「${bad}」（連字串內也算）：runtime 會把整條計算式換成錯誤訊息`));
    }
  }
  const r = check(src);
  if (!r.ok) { out.push(err(r.code, `${what}語法錯誤：${r.message}`)); return { findings: out, refs: [], functions: [] }; }
  const refs = refFindings(r, ctx, out, what);
  functionFindings(r, context, out, what, ctx, src);
  if (context === 'macro') {
    const nested = r.functions.filter(f => f.name === 'LLMQUERY');
    if (nested.length) out.push(warn('W_LLM_NOT_AWAITED', `${what}在一般運算式中呼叫 LLMQUERY：不受 IF 控制、每次都會執行，而且不會等待回覆就繼續下一步`));
  }
  return { findings: out, refs, functions: r.functions.map(f => f.name), info: r, src };
}

// 從 parse 資訊取出某函數第 n 個參數的原始文字
function argText(src, f, n) {
  const span = f.args && f.args[n];
  return span ? src.slice(span[0], span[1]).trim() : null;
}

function checkTarget(idText, ctx, out, fn, { want } = {}) {
  if (idText === null) return null;
  if (!isIntLiteral(idText)) { out.push(warn('W_MACRO_TARGET_DYNAMIC', `${fn} 的目標 id 是運算式「${idText.slice(0, 30)}」，無法離線檢查`)); return null; }
  const id = idText.trim();
  if (id === '0') return id;
  if (!ctx.controls) return id;
  const n = ctx.controls.get(id);
  if (!n) out.push(err('E_REF_BROKEN', `${fn} 的目標 #${id} 不存在`));
  else if (want && !want.includes(n.datatype)) out.push(err('E_MACRO_TARGET_TYPE', `${fn} 的目標 #${id} 是 ${n.datatype}，必須是 ${want.join(' / ')}`));
  // 動態表格每一列共用同一個 itemid：SetValueByID 會一次寫入所有列（v0 harness 實測）
  if (n && ctx.tableIds && ctx.tableIds.has(id)) out.push(err('E_MACRO_TARGET_TABLE', `${fn} 的目標 #${id} 在動態表格內：每一列共用同一個 itemid，會一次寫入所有列`));
  return id;
}

function checkModel(modelText, ctx, out, fn) {
  if (modelText === null) return '';
  let lit = strLiteral(modelText);
  const cell = /^\s*[Aa](\d+)\s*$/.exec(modelText);
  if (lit === null && cell) {
    // 模型從欄位讀取：只能檢查該欄位的預設值
    const n = ctx.controls && ctx.controls.get(cell[1]);
    if (!n) { if (ctx.controls) out.push(err('E_REF_BROKEN', `${fn} 的模型來源 A${cell[1]} 不存在`)); return null; }
    if (typeof n.datavalue !== 'string' || !n.datavalue.trim()) {
      out.push(warn('W_LLM_MODEL_DYNAMIC', `${fn} 的模型取自 A${cell[1]}（沒有預設值 → 預設模型）；使用者輸入的值無法離線檢查`));
      return null;
    }
    lit = n.datavalue.trim();
  }
  if (lit === null) {
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.test(modelText)) {
      out.push(err('E_LLM_MODEL_UNQUOTED', `${fn} 的模型「${modelText.trim()}」沒有加引號：會被當成未定義變數，靜默改用預設模型`));
    } else out.push(warn('W_LLM_MODEL_DYNAMIC', `${fn} 的模型是運算式，無法離線檢查`));
    return null;
  }
  const m = lit.toLowerCase();
  if (fn === 'LLMATTACH') return checkAttachModel(lit, ctx, out);
  const table = fn === 'LLMvision' ? VISION_MODELS : LLM_MODELS;
  if (fn === 'LLMQUERY' && LLM_ALIASES[m]) out.push(warn('W_LLM_MODEL_ALIAS', `模型「${lit}」是舊別名，實際使用 ${LLM_ALIASES[m]}`));
  else if (!(m in table)) {
    const removed = LLM_REMOVED.includes(m) ? '（已於 20260905 移除）' : '';
    out.push(err('E_LLM_MODEL_UNKNOWN', `${fn} 的模型「${lit}」不在清單${removed}：runtime 會靜默改用預設模型。可用：${Object.keys(table).filter(k => k && !sunsetModel(k)).join('、')}`));
  }
  else if (GATEWAY_ONLY_MODELS.includes(m)) out.push(gatewayOnlyWarn(fn, lit));
  const allowed = ctx.policy && Array.isArray(ctx.policy.llm_models) ? ctx.policy.llm_models : null;
  const canon = LLM_ALIASES[m] || m;
  const sunset = fn === 'LLMQUERY' ? sunsetFinding(fn, lit, canon, ctx) : null;
  if (sunset) out.push(sunset);
  if (allowed && !allowed.includes(canon)) out.push(err('E_LLM_MODEL_POLICY', `模型「${lit || '（預設）'}」不在本院允許清單（.strucmed/policy.json）：${allowed.join('、') || '（空）'}`));
  // LlmGateway 白名單快取（llmgateway_models）：別名對應到閘道模型後檢查存在、狀態、視覺能力
  const gw = ctx.policy && Array.isArray(ctx.policy.gateway_models) ? checkAlias(canon, fn === 'LLMvision' ? 'LLMvision' : 'LLMQUERY', ctx.policy.gateway_models) : null;
  if (gw && gw.gateway_model) {
    const shown = lit || '（預設）';
    if (!gw.found) out.push(err('E_LLM_MODEL_NOT_ON_GATEWAY', `${fn} 的模型「${shown}」對應的閘道模型 ${gw.gateway_model} 不在 LlmGateway 白名單（金鑰可用的模型）`));
    else if (/^deprecated$/i.test(gw.status)) out.push(err('E_LLM_MODEL_DEPRECATED', `${fn} 的模型「${shown}」（${gw.gateway_model}）在 LlmGateway 標示為 deprecated，請換模型`));
    else if (/^maintenance$/i.test(gw.status)) out.push(warn('W_LLM_MODEL_MAINTENANCE', `${fn} 的模型「${shown}」（${gw.gateway_model}）目前 maintenance，上線前請確認`));
    else if (fn === 'LLMvision' && !gw.vision) out.push(err('E_LLM_MODEL_NO_VISION', `LLMvision 的模型「${shown}」（${gw.gateway_model}）在 LlmGateway 沒有視覺能力，會被拒絕`));
  }
  return canon;
}

// 落日模型（calx-catalog.mjs LLM_SUNSET）：level=error，validate 依「是否本次新增／修改」決定：
// 新增或改到的巨集 → E_LLM_MODEL_SUNSET；原表單既有、沒動到的 → W_LLM_MODEL_SUNSET。下架日起改回 E_LLM_MODEL_DEPRECATED。
function sunsetFinding(fn, lit, name, ctx) {
  const hit = sunsetModel(name);
  if (!hit) return null;
  const to = hit.replacement;
  const fix = `請改用 "${to}"（整理、摘要、擷取、長文件用 nemotron35；推理用 tnemotron35，固定格式用 tnemotron35-low；只經院內 LlmGateway）`;
  if (sunsetPassed(ctx.policy && ctx.policy.now)) {
    return { ...err('E_LLM_MODEL_DEPRECATED', `${fn} 的模型「${lit}」屬 ${LLM_SUNSET.family}，已於 ${LLM_SUNSET.date} 自 LlmGateway 下架；${fix}`), sunset: true, replacement: to };
  }
  return { ...err('E_LLM_MODEL_SUNSET', `${fn} 的模型「${lit}」屬 ${LLM_SUNSET.family}：將於 ${LLM_SUNSET.date} 自 LlmGateway 下架，院方建議不採用，新寫或改到的巨集不得使用；${fix}`), sunset: true, replacement: to };
}

// 只經 LlmGateway 的模型代號（nemotron35 系列，平台 20261124）：站台沒啟用 Gateway 時 LLMQUERY 顯示提示、不送出；
// LLMvision／LLMATTACH 改用預設 gemma3:12b。LLMATTACH 另以模型的請求上限（Nemotron 8 MiB）在送出前擋下
function gatewayOnlyWarn(fn, lit) {
  const fallback = fn === 'LLMQUERY' ? '顯示「這個模型只能經院內 LLM Gateway 使用」、不送出' : '改用預設 gemma3:12b';
  const max = GATEWAY_MODEL_MAX_BYTES['Nemotron-3.5-Super-VL'];
  const size = fn === 'LLMATTACH' ? `；這個模型一次請求上限 ${max / 1048576} MiB（影像與 PDF 頁面影像都算），超過時平台在送出前擋下，請控制容器的 attachmax／attachpages` : '';
  return warn('W_LLM_MODEL_GATEWAY_ONLY', `${fn} 的模型「${lit}」只經院內 LlmGateway（Nemotron-3.5-Super-VL）：站台沒有啟用 Gateway 時${fallback}；院外站台用使用者在設定畫面選的模型${size}`);
}

// LLMATTACH 的模型：代號表與 LLMvision 相同；不在表內的名稱經 LlmGateway 時原樣當模型 id 送出（平台 attachbox.js buildRequest），所以不是錯誤
function checkAttachModel(lit, ctx, out) {
  const m = lit.toLowerCase();
  const known = m in ATTACH_MODELS;
  if (known && GATEWAY_ONLY_MODELS.includes(m)) out.push(gatewayOnlyWarn('LLMATTACH', lit));
  if (!known) out.push(warn('W_LLM_MODEL_PASSTHROUGH', `LLMATTACH 的模型「${lit}」不是內建代號（${Object.keys(ATTACH_MODELS).filter(Boolean).join('、')}）：經 LlmGateway 時原樣當模型 id 送出（必須與 llmgateway_models 的 id 完全相同），直連時改用預設 gemma3:12b；院外站台用使用者在設定畫面選的模型`));
  const sunset = known ? null : sunsetFinding('LLMATTACH', lit, m, ctx);
  if (sunset) out.push(sunset);
  const allowed = ctx.policy && Array.isArray(ctx.policy.llm_models) ? ctx.policy.llm_models : null;
  if (allowed && !allowed.includes(known ? m : lit)) out.push(err('E_LLM_MODEL_POLICY', `模型「${lit || '（預設）'}」不在本院允許清單（.strucmed/policy.json）：${allowed.join('、') || '（空）'}`));
  const models = ctx.policy && Array.isArray(ctx.policy.gateway_models) ? ctx.policy.gateway_models : null;
  if (models) {
    const shown = lit || '（預設）';
    const gw = known ? checkAlias(m, 'LLMATTACH', models) : (() => {
      const hit = models.find(x => String(x.id || '') === lit);
      return hit ? { gateway_model: lit, found: true, status: String(hit.status || ''), vision: !!hit.vision } : { gateway_model: lit, found: false };
    })();
    if (gw && gw.gateway_model) {
      if (!gw.found) out.push(err('E_LLM_MODEL_NOT_ON_GATEWAY', `LLMATTACH 的模型「${shown}」對應的閘道模型 ${gw.gateway_model} 不在 LlmGateway 白名單（金鑰可用的模型；名稱大小寫要完全相同）`));
      else if (/^deprecated$/i.test(gw.status)) out.push(err('E_LLM_MODEL_DEPRECATED', `LLMATTACH 的模型「${shown}」（${gw.gateway_model}）在 LlmGateway 標示為 deprecated，請換模型`));
      else if (/^maintenance$/i.test(gw.status)) out.push(warn('W_LLM_MODEL_MAINTENANCE', `LLMATTACH 的模型「${shown}」（${gw.gateway_model}）目前 maintenance，上線前請確認`));
      else if (!gw.vision) out.push({ ...warn('W_LLM_MODEL_NO_VISION', `LLMATTACH 的模型「${shown}」（${gw.gateway_model}）在 LlmGateway 沒有視覺能力`), novision: true });
    }
  }
  return known ? m : lit;
}

// HISQUERY("id,查詢;id2,查詢2")：runtime 以 ; 再以 , 切開，逗號數不對的組合會被靜默略過（TempHtml.js:878-893）
function lintHisQueryPairs(argSrc, ctx, out) {
  const lit = strLiteral(argSrc);
  if (lit === null) { out.push(warn('W_HISQUERY_DYNAMIC', 'HISQUERY 的參數是運算式，無法離線檢查')); return []; }
  const targets = [];
  for (const pair of lit.replace(/[\r\n]+/g, '').split(';')) {
    if (!pair.trim()) continue;
    const parts = pair.split(',');
    if (parts.length !== 2) { out.push(err('E_HISQUERY_PAIR', `HISQUERY 的「${pair.trim().slice(0, 40)}」不是「id,查詢」兩段（查詢內不能有逗號），runtime 會靜默略過`)); continue; }
    const key = parts[0].trim();
    if (key !== '0') {
      targets.push(key);
      if (!/^\d+$/.test(key)) out.push(err('E_HISQUERY_PAIR', `HISQUERY 的目標「${key}」不是 itemid`));
      else if (ctx.controls && !ctx.controls.get(key)) out.push(err('E_REF_BROKEN', `HISQUERY 的目標 #${key} 不存在`));
    }
    for (const f of lintHisQuery(parts[1].trim()).findings) out.push(f);
  }
  return targets;
}

// ── 巨集（action.actionScript）──────────────────────────────────────────
export function lintMacro(script, ctx = {}) {
  const out = [];
  const steps = [];
  let s = String(script || '');
  if (!s.trim()) return { findings: [err('E_MACRO_EMPTY', '巨集沒有任何步驟')], steps, refs: [], targets: [], ai: [] };
  if (s.startsWith('PIPLINE(') && s.endsWith(')')) { s = s.slice(8, -1); out.push(warn('W_MACRO_PIPLINE', '舊式 PIPLINE(...) 寫法，runtime 會自動拆開')); }
  const plat = platformSplit(s);
  const cx = calxSplit(s);
  if (plat.unterminated) out.push(err('E_MACRO_SYNTAX', '巨集有未結束的字串引號'));
  if (plat.depth !== 0) out.push(err('E_MACRO_PARENS', '巨集的括號不對稱'));
  if (!sameSplit(plat, cx)) {
    out.push(err('E_MACRO_SPLIT', `字串內的 \\" 在 runtime 切分時不算跳脫（runtime 切成 ${plat.steps.filter(Boolean).length} 步，Calx 解析應為 ${cx.steps.filter(Boolean).length} 步）；含雙引號的文字請改用單引號包住，或用 CHAR(34)`));
    return { findings: out, steps, refs: [], targets: [], ai: [] };
  }
  // 舊版 runtime（20261124b 以前）只算括號：步驟或參數切法不同時提醒一次（HIS 端部署後可在 policy 關閉）
  let legacyWarned = !!(ctx.policy && ctx.policy.runtime_quote_aware_split);
  // fixed：只比對前幾個參數，之後的是容器清單（LLMATTACH 第四個以後、ATTACHTRANSCRIBE 全部），runtime 會接回去再切，舊版切開也沒有影響
  const legacyCheck = (text, split, where, fixed = Infinity) => {
    const norm = st => fixed === Infinity ? st : [...st.slice(0, fixed), st.slice(fixed).join(',').replace(/["'\s]/g, '')];
    if (legacyWarned || JSON.stringify(norm(split.steps)) === JSON.stringify(norm(legacySplit(text).steps))) return;
    legacyWarned = true;
    out.push(warn('W_MACRO_SPLIT_NEEDS_DEPLOY', `${where}${/[A-Za-z0-9]$/.test(where) ? " " : ""}的字串含半形逗號或括號：平台 TempHtml.js 20261124b（kunjulin/strucmed#264）起 runtime 看引號、切分正確；舊版 runtime 會把字串切開（按鈕沒有反應）。HIS 端部署新版前，可改用全形標點或 CHAR(44)／CHAR(40)／CHAR(41)`));
  };
  // 參數切分：與步驟切分同一套（runtime 對步驟內的參數也呼叫 extractPiplineSteps）
  const splitParams = (inner, where, fixed) => {
    const p = platformSplit(inner), c = calxSplit(inner);
    if (!sameSplit(p, c)) { out.push(err('E_MACRO_SPLIT', `${where}${/[A-Za-z0-9]$/.test(where) ? " " : ""}的字串內的 \\" 在 runtime 切分時不算跳脫（runtime 切成 ${p.steps.length} 個參數，Calx 解析應為 ${c.steps.length} 個）；含雙引號的文字請改用單引號包住，或用 CHAR(34)`)); return null; }
    legacyCheck(inner, p, where, fixed);
    return p.steps;
  };
  const refs = [], targets = [], ai = [];
  plat.steps.forEach((raw, i) => {
    let step = raw.trim();
    const no = `第 ${i + 1} 步`;
    if (!step) return;
    if ((step.startsWith('"') && step.endsWith('"')) || (step.startsWith("'") && step.endsWith("'"))) {
      step = step.slice(1, -1);
      out.push(warn('W_MACRO_QUOTED_STEP', `${no}整段被引號包住，runtime 會先去掉引號再執行（相容舊寫法）`));
    } else if (/^["']/.test(step)) {
      // 舊式整段以引號包住的步驟裡又有同一種引號的字串：字串內的逗號落在引號外，runtime 會在這裡切開
      out.push(err('E_MACRO_SPLIT', `${no}「${step.slice(0, 30)}」以引號開頭但沒有以同一種引號結束：整段以引號包住的舊式步驟裡，同一種引號的字串內的逗號會被 runtime 切開；請去掉步驟外層的引號`));
      return;
    }
    const sub = (f, o) => f.forEach(x => out.push({ ...x, message: `${o}：${x.message}` }));
    const head = /^([A-Za-z]+)\s*\(/.exec(step);
    const kind = Object.keys(STEP).find(k => step.indexOf(k) === 0);
    if (kind === 'LLMQUERY' || kind === 'LLMvision' || kind === 'VOICETOTEXT') {
      const open = step.indexOf('('), close = step.lastIndexOf(')');
      if (open < 0 || close < open) { out.push(err('E_MACRO_SYNTAX', `${no} ${kind} 缺少括號`)); return; }
      if (step.slice(close + 1).trim()) out.push(err('E_MACRO_TRAILING', `${no} ${kind}(...) 之後的「${step.slice(close + 1).trim().slice(0, 20)}」會被忽略`));
      const params = splitParams(step.substring(open + 1, close), `${no} ${kind}`);
      if (!params) return;
      const need = kind === 'VOICETOTEXT' ? 1 : 2;
      if (params.length < need) { out.push(err('E_MACRO_SYNTAX', `${no} ${kind} 至少需要 ${need} 個參數`)); return; }
      params.forEach((p, j) => {
        const r = lintFormula(p, ctx, { context: 'macro', what: `${no} ${kind} 第 ${j + 1} 個參數` });
        sub(r.findings, no);
        refs.push(...r.refs);
      });
      const want = kind === 'LLMQUERY' ? ['textarea', 'textbox', 'label'] : ['textarea'];
      const target = checkTarget(params[0], ctx, out, kind, { want });
      if (target && target !== '0') targets.push(target);
      if (kind === 'VOICETOTEXT') {
        const p = params[1] !== undefined ? strLiteral(params[1]) : 'ASUS';
        if (p === null || !ASR_PROVIDERS.includes(p)) out.push(err('E_ASR_PROVIDER', `${no} VOICETOTEXT 的語音服務${p !== null && ASR_REMOVED[String(p).toUpperCase()] ? `「${p}」${ASR_REMOVED[String(p).toUpperCase()]}，請改用` : '必須是'} ${ASR_PROVIDERS.map(x => `'${x}'`).join(' 或 ')}`));
        ai.push({ step: i + 1, kind, target, provider: p, inputs: [] });
      } else {
        const model = checkModel(params[2] !== undefined ? params[2] : null, ctx, out, kind);
        const pr = lintFormula(params[1], {}, { context: 'macro' });
        ai.push({ step: i + 1, kind, target, model: model === null ? '（無法判斷）' : model, inputs: [...new Set(pr.refs)], sources: promptSources(pr.functions) });
        identifierWarning(pr.functions, out, `${no} ${kind}`);
        promptDesignWarnings(params[1], pr, out, `${no} ${kind}`);
      }
      steps.push({ step: i + 1, kind });
      return;
    }
    if (kind === 'LLMATTACH' || kind === 'ATTACHTRANSCRIBE') {
      if (!attachOn(ctx)) { out.push(err('E_FEATURE_DISABLED', `${no} ${kind} 需要 feature flag attachBox（附件容器，目前關閉）`)); steps.push({ step: i + 1, kind }); return; }
      const open = step.indexOf('('), close = step.lastIndexOf(')');
      if (open < 0 || close < open) { out.push(err('E_MACRO_SYNTAX', `${no} ${kind} 缺少括號`)); return; }
      if (step.slice(close + 1).trim()) out.push(err('E_MACRO_TRAILING', `${no} ${kind}(...) 之後的「${step.slice(close + 1).trim().slice(0, 20)}」會被忽略`));
      const params = splitParams(step.substring(open + 1, close), `${no} ${kind}`, kind === 'LLMATTACH' ? 3 : 0);
      if (!params) return;
      if (kind === 'ATTACHTRANSCRIBE') {
        const boxes = attachSources(params, ctx, out, `${no} ${kind}`);
        if (boxes.length && boxes.every(b => b.kinds && !b.kinds.includes('audio'))) out.push(warn('W_ATTACH_NO_AUDIO', `${no} ATTACHTRANSCRIBE 指到的容器都不收音檔（請在容器的 attach_kinds 加 audio）：這一步不會做任何事`));
        ai.push({ step: i + 1, kind, target: null, provider: '語音服務（院內 ASUS；院外為使用者選的語音服務商）', inputs: [], attachments: boxes, sources: boxes.length ? [`附件容器 ${boxes.map(b => '#' + b.itemid).join('、')} 的音檔`] : [] });
        steps.push({ step: i + 1, kind });
        return;
      }
      if (params.length < 2) { out.push(err('E_MACRO_SYNTAX', `${no} LLMATTACH 至少需要 2 個參數（回覆寫入的 id、提示詞）`)); return; }
      params.slice(0, 3).forEach((p, j) => {
        const r = lintFormula(p, ctx, { context: 'macro', what: `${no} LLMATTACH 第 ${j + 1} 個參數` });
        sub(r.findings, no);
        refs.push(...r.refs);
      });
      const target = checkTarget(params[0], ctx, out, kind, { want: ['textarea', 'textbox', 'label'] });
      if (target && target !== '0') targets.push(target);
      const boxes = attachSources(params.slice(3), ctx, out, `${no} LLMATTACH`);
      const before = out.length;
      const model = checkModel(params[2] !== undefined ? params[2] : null, ctx, out, kind);
      // 沒有視覺能力的模型：容器會收影像（或 PDF 可一併送頁面影像）才是問題；只收試算表、文字、音檔時文字模型也能用
      const sendsImages = boxes.some(b => !b.kinds || b.kinds.includes('image') || b.kinds.includes('pdf'));
      for (let k = before; k < out.length; k++) {
        if (!out[k].novision) continue;
        const { novision, ...f } = out[k];
        out[k] = sendsImages ? { ...f, code: 'E_LLM_MODEL_NO_VISION', level: 'error', message: `${f.message}，容器會送出影像，請換能讀影像的模型` } : { ...f, message: `${f.message}（容器只收文字類附件，可以使用）` };
      }
      const pr = lintFormula(params[1], {}, { context: 'macro' });
      const audio = boxes.some(b => b.kinds && b.kinds.includes('audio'));
      ai.push({ step: i + 1, kind, target, model: model === null ? '（無法判斷）' : model, inputs: [...new Set(pr.refs)], attachments: boxes,
        sources: [...promptSources(pr.functions), ...(boxes.length ? [`附件容器 ${boxes.map(b => '#' + b.itemid).join('、')} 的內容${kindsText(boxes) ? `（${kindsText(boxes)}）` : ''}：影像以影像送出，文件與逐字稿以文字附在提示詞後面`] : []),
          ...(audio ? ['還沒轉寫的音檔會先送語音服務轉成逐字稿'] : [])] });
      identifierWarning(pr.functions, out, `${no} ${kind}`);
      steps.push({ step: i + 1, kind });
      return;
    }
    if (kind === 'MACRO') {
      const norm = step.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (norm !== step.trim() && /["'][^"']*(\n|\s{2,})[^"']*["']/.test(step)) out.push(warn('W_MACRO_WHITESPACE', `${no} MACRO 執行前會把換行與連續空白壓成一個空白（字串內也是）`));
      const m = norm.match(/MACRO\(([^,]+),\s*(.+)\)/);
      if (!m) { out.push(err('E_MACRO_SYNTAX', `${no} MACRO 必須寫成 MACRO(id, 運算式)`)); return; }
      const tail = norm.slice(m.index + m[0].length).trim();
      if (tail) out.push(err('E_MACRO_TRAILING', `${no} MACRO(...) 之後的「${tail.slice(0, 20)}」會被忽略`));
      const r1 = lintFormula(m[1], ctx, { context: 'macro', what: `${no} MACRO 目標` });
      if (r1.findings.some(f => f.level === 'error')) out.push(err('E_MACRO_SYNTAX', `${no} MACRO 的第一個參數（目標 id）不能含逗號或運算錯誤：「${m[1].slice(0, 30)}」`));
      const target = checkTarget(m[1], ctx, out, 'MACRO');
      if (target && target !== '0') targets.push(target);
      const r2 = lintFormula(m[2], ctx, { context: 'macro', what: `${no} MACRO 運算式` });
      sub(r2.findings, no);
      refs.push(...r2.refs);
      steps.push({ step: i + 1, kind });
      return;
    }
    if (head && Object.keys(STEP).some(k => k.toLowerCase() === head[1].toLowerCase())) {
      const right = Object.keys(STEP).find(k => k.toLowerCase() === head[1].toLowerCase());
      if (right === 'LLMQUERY') out.push(warn('W_LLM_NOT_AWAITED', `${no} 寫成「${head[1]}」：大小寫與「LLMQUERY」不同，runtime 不會等待回覆就執行下一步`));
      else { out.push(err('E_MACRO_STEP_CASE', `${no} 寫成「${head[1]}」：必須是「${right}」（區分大小寫），否則 runtime 得到 #NAME?`)); return; }
    }
    // 一般步驟：整段交給 Calx evaluate
    const r = lintFormula(step, ctx, { context: 'macro', what: '運算式' });
    sub(r.findings, no);
    refs.push(...r.refs);
    if (r.info) {
      for (const f of r.info.functions) {
        if (f.name === 'SETVALUEBYID' || f.name === 'SETDICTATIONBYID') {
          const t = checkTarget(argText(r.src, f, 0), ctx, out, f.name);
          if (t && t !== '0') targets.push(t);
        }
        if (f.name === 'HISQUERY') {
          const a = argText(r.src, f, 0);
          if (a !== null) targets.push(...lintHisQueryPairs(a, ctx, out));
        }
        if (f.name === 'LLMQUERY') ai.push({ step: i + 1, kind: 'LLMQUERY（巢狀）', target: argText(r.src, f, 0), model: '（未檢查）', inputs: [] });
      }
    }
    steps.push({ step: i + 1, kind: 'calx' });
  });
  if (!out.some(f => f.code === 'E_MACRO_SPLIT')) legacyCheck(s, plat, '巨集');
  // LLMvision 只適合「描述所見」；推論要交給之後的 LLMQUERY 接力（PromptPatterns.md §4 D；GitBook 生成式 AI 巨集函數）
  const lastVision = steps.map(s => s.kind).lastIndexOf('LLMvision');
  if (lastVision >= 0 && !steps.slice(lastVision + 1).some(s => s.kind === 'LLMQUERY')) {
    out.push(warn('W_VISION_NO_FOLLOWUP', `第 ${steps[lastVision].step} 步 LLMvision 之後沒有 LLMQUERY 接力：視覺模型只適合描述影像，整理或推論請用文字模型接續（只要描述可忽略）`));
  }
  return { findings: out, steps, refs: [...new Set(refs)], targets: [...new Set(targets)], ai };
}

// ── HIS 參照（label format=hisquery、HISQUERY 巨集）──────────────────────────
// 鏈式語法 <函數>.<搜尋條件>….<取值條件>（01 §6.4；GB:JJ/ji-suan-shi-his-can-zhao/*）
const HIS_ROOTS = {
  LABDATA: { search: ['InDays', 'InDr', 'InName', 'InItem', 'InAbnormal'], get: ['GetValueByName', 'GetDateByName', 'GetAllString', 'GetLatestString', 'GetAllJson'] },
  OPDDATA: { search: ['InDays'], get: ['GetAllString', 'GetLatestString'] },
  ERDDATA: { search: ['InDays'], get: ['GetAllString', 'GetLatestString'] },
  Procedure: { search: ['InName', 'AddParameter'], get: ['GetValueByName'] }
};
export function lintHisQuery(q) {
  const out = [];
  const s = String(q || '').trim();
  if (!s) return { findings: [err('E_HISQUERY_EMPTY', 'HIS 參照是空的')], root: null };
  // 以括號外的 . 切段
  const segs = [];
  let cur = '', depth = 0;
  for (const ch of s) {
    if (ch === '.' && depth === 0) { segs.push(cur); cur = ''; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    cur += ch;
  }
  segs.push(cur);
  if (depth !== 0) return { findings: [err('E_HISQUERY_SYNTAX', `HIS 參照括號不對稱：「${s.slice(0, 40)}」`)], root: null };
  const rootName = Object.keys(HIS_ROOTS).find(r => r.toLowerCase() === segs[0].trim().toLowerCase());
  if (!rootName) return { findings: [err('E_HISQUERY_SYNTAX', `HIS 參照必須以 ${Object.keys(HIS_ROOTS).join(' / ')} 開頭：「${segs[0].slice(0, 20)}」`)], root: null };
  if (rootName !== segs[0].trim()) out.push(warn('W_HISQUERY_CASE', `「${segs[0].trim()}」大小寫與文件寫法「${rootName}」不同`));
  const spec = HIS_ROOTS[rootName];
  const methods = segs.slice(1).map(x => {
    const m = /^\s*([A-Za-z]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(x);
    return m ? { name: m[1], arg: m[2] } : { bad: x };
  });
  for (const m of methods) {
    if (m.bad !== undefined) { out.push(err('E_HISQUERY_SYNTAX', `HIS 參照無法解析「${m.bad.slice(0, 30)}」`)); continue; }
    if (![...spec.search, ...spec.get].includes(m.name)) out.push(warn('W_HISQUERY_METHOD', `${rootName} 的「${m.name}」不在文件列出的條件中，請確認拼字`));
    if (m.name === 'InDays') {
      const n = Number(m.arg);
      if (!Number.isInteger(n) || n < 1 || n > 180) out.push(err('E_HISQUERY_INDAYS', `InDays(${m.arg}) 必須是 1–180 的整數`));
    }
    if (m.name === 'InAbnormal' && !['H', 'L'].includes(String(m.arg).trim())) out.push(err('E_HISQUERY_SYNTAX', 'InAbnormal 只接受 H 或 L'));
  }
  const last = methods[methods.length - 1];
  if (!last || !last.name || !spec.get.includes(last.name)) out.push(err('E_HISQUERY_NO_GETTER', `HIS 參照必須以取值條件結尾（${spec.get.join(' / ')}）`));
  if (rootName === 'Procedure' && !methods.some(m => m.name === 'InName')) out.push(err('E_HISQUERY_SYNTAX', 'Procedure 必須指定 InName(<套件.程序>)'));
  out.push(warn('W_PATIENT_DATA_READ', `HIS 參照會在 HIS 端讀取病人資料（${rootName}）`));
  return { findings: out, root: rootName };
}

// ── LLM 控制項（action2）：actionScript 整段經 Calx 求值後當作 prompt（TempHtml.js:3923-3928）──
export function lintPrompt(text, ctx = {}) {
  // 整段是 LLMQUERY(...)：這是巨集按鈕（action）的腳本，不是 LLM 按鈕的 prompt；用錯檢查種類時只提示改用 kind=macro
  if (/^\s*LLMQUERY\s*\(/i.test(String(text || ''))) {
    const m = lintMacro(text, ctx);
    return { findings: [warn('W_KIND_MISMATCH', '內容以 LLMQUERY( 開頭，是巨集按鈕（action）的腳本：請用 formula_check 的 kind=macro 檢查；LLM 按鈕（action2）的 prompt 只寫要送出的文字運算式'),
      ...m.findings.filter(f => f.code !== 'W_LLM_NOT_AWAITED')], refs: m.refs, ai: m.ai };
  }
  const r = lintFormula(text, ctx, { context: 'macro', what: 'LLM 控制項的 prompt' });
  identifierWarning(r.functions, r.findings, 'LLM 控制項');
  promptDesignWarnings(text, r, r.findings, 'LLM 控制項');
  return { findings: r.findings, refs: r.refs, ai: [{ step: 1, kind: 'LLM 控制項', model: '（預設，不可指定）', inputs: [...new Set(r.refs)], sources: promptSources(r.functions) }] };
}

// prompt 中一次取出大量表單或病歷資料的函數（AI 資料流要明列，不能只列 A<n>）
const BULK_SOURCES = {
  ATTACHTEXT: 'ATTACHTEXT()：附件容器內 PDF、試算表、文字與音檔逐字稿的內容',
  GETTEXT: 'GETTEXT()：所有「回傳文字」區塊的報告全文（TempHtml.js GetTextblock）',
  GETVALUE: 'GETVALUE()：表單所有欄位的值',
  G_USERNM: 'G_USERNM()：使用者姓名', G_CHTNO: 'G_CHTNO()：病歷號', GETCHTNO: 'GETCHTNO()：病歷號',
  G_OPDNO: 'G_OPDNO()：就醫號', GETOPDNO: 'GETOPDNO()：就醫號', GETPACSNO: 'GETPACSNO()：PACS 號'
};
function promptSources(functions = []) {
  return [...new Set(functions.filter(f => BULK_SOURCES[f]).map(f => BULK_SOURCES[f]))];
}
const IDENTIFIERS = ['G_USERNM', 'G_CHTNO', 'GETCHTNO', 'G_OPDNO', 'GETOPDNO', 'GETPACSNO'];
function identifierWarning(functions = [], out, where) {
  const hit = [...new Set(functions.filter(f => IDENTIFIERS.includes(f)))];
  if (hit.length) out.push(warn('W_AI_IDENTIFIER', `${where} 的 prompt 帶入識別資料（${hit.map(f => f + '()').join('、')}），會送到 LLM；除非必要請移除`));
}

// ── prompt 設計檢查（references/PromptPatterns.md §1、§5；GitBook「Prompt 文字指令」）──────────
// 只看「有帶入資料」的 prompt：引用 A<n>，或用 GETTEXT()／GETVALUE() 一次送出整份內容。純問答不檢查。
// 兩條都是 warn：由 reviewer 列出、使用者決定，不阻擋建置。
const BULK_INPUTS = ['GETTEXT', 'GETVALUE'];
const SCOPE_HINTS = /只根據|只依|僅根據|僅依|僅就|依據下列|根據下列|根據以下|依下列|only (?:based|according)|based only|based solely|solely on|not available|無相關資料|無資料|沒有資料|no data|只提供答案|只給答案|only the answer|answer only|do not respond|do not response|不要開場白|不要前言/i;
function promptDesignWarnings(exprSrc, pr, out, where) {
  const src = String(exprSrc || '');
  const hasData = (pr.refs && pr.refs.length > 0) || (pr.functions || []).some(f => BULK_INPUTS.includes(f));
  if (!hasData) return;
  if (!(/\bIF\s*\(/i.test(src) && /\bLEN\s*\(/i.test(src))) {
    out.push(warn('W_PROMPT_NO_GUARD', `${where} 的 prompt 帶入欄位資料，但沒有 IF(LEN(A<n>) < 10, "not available", …) 防呆：資料不足時模型會自行編造（PromptPatterns.md P1）`));
  }
  const literals = pr.info && Array.isArray(pr.info.strings) ? pr.info.strings.map(s => s.text).join('\n') : src;
  if (!SCOPE_HINTS.test(literals)) {
    out.push(warn('W_PROMPT_NO_SCOPE', `${where} 的 prompt 沒有「只根據下列紀錄」「無資料時回答 not available」「只提供答案」任一句，模型可能混入紀錄以外的內容或加開場白（PromptPatterns.md P2～P4）`));
  }
}
