// v0.2：計算式、巨集、HIS 參照的離線檢查。
// 每條規則都對應平台 runtime 的實際行為（平台 web/js/TempHtml.js），不是一般 Excel 規則。
// finding：{ code, level:'error'|'warn', message }。level=error 的項目由 validate 依「是否本次新增／修改」
// 決定要當 error 還是 warning（原表單既有）；level=warn 一律是 warning。
import { check } from './calx.mjs';
import { classify, STEP, FORMULA_REPLACED, LLM_MODELS, LLM_ALIASES, LLM_REMOVED, VISION_MODELS, ASR_PROVIDERS } from './calx-catalog.mjs';
import { checkAlias } from './policy.mjs';

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

// ── 平台的步驟切分（平台 web/js/TempHtml.js:3897-3918 extractPiplineSteps）──────────
// 只計算括號深度，不理會引號：字串裡的括號或逗號會打亂切分。
export function platformSplit(s) {
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
// 考慮引號的正確切分（用來偵測平台切分是否與作者意圖不同）
export function quoteAwareSplit(s) {
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
function functionFindings(info, context, out, what, ctx = {}) {
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
    if (cls === 'forbidden') out.push(err('E_FORBIDDEN_FUNCTION', `${f.raw}() 不在本工具允許範圍（任意程式、開網址、存檔、改寫身分或文件 header、連外）；確有需要請匯入後由人工在編輯器加入並審查`));
    else if (context === 'formula' && ['lookup', 'write', 'ai'].includes(cls)) out.push(err('E_FORMULA_MACRO_ONLY', `${f.raw}() 是巨集專用函數，不能放在計算式`));
    else if (cls === 'setting') out.push(warn('W_SETTING_FUNCTION', `${f.raw}() 會改變整張表單的行為（${what}）`));
    else if (cls === 'lookup') out.push(warn('W_PATIENT_DATA_READ', `${f.raw}() 會在 HIS 端讀取病人資料`));
  }
}

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
  functionFindings(r, context, out, what, ctx);
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
  const table = fn === 'LLMvision' ? VISION_MODELS : LLM_MODELS;
  if (fn === 'LLMQUERY' && LLM_ALIASES[m]) out.push(warn('W_LLM_MODEL_ALIAS', `模型「${lit}」是舊別名，實際使用 ${LLM_ALIASES[m]}`));
  else if (!(m in table)) {
    const removed = LLM_REMOVED.includes(m) ? '（已於 20260905 移除）' : '';
    out.push(err('E_LLM_MODEL_UNKNOWN', `${fn} 的模型「${lit}」不在清單${removed}：runtime 會靜默改用預設模型。可用：${Object.keys(table).filter(Boolean).join('、')}`));
  }
  const allowed = ctx.policy && Array.isArray(ctx.policy.llm_models) ? ctx.policy.llm_models : null;
  const canon = LLM_ALIASES[m] || m;
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
  const qa = quoteAwareSplit(s);
  if (qa.unterminated) out.push(err('E_MACRO_SYNTAX', '巨集有未結束的字串引號'));
  if (plat.depth !== 0 || qa.depth !== 0) out.push(err('E_MACRO_PARENS', '巨集的括號不對稱'));
  if (JSON.stringify(plat.steps) !== JSON.stringify(qa.steps)) {
    out.push(err('E_MACRO_SPLIT', `字串內的括號或逗號會打亂 runtime 的步驟切分（runtime 切成 ${plat.steps.filter(Boolean).length} 步，依語意應為 ${qa.steps.filter(Boolean).length} 步）；請避免在字串中使用半形括號，或改用 CHAR(40)／CHAR(41)`));
    return { findings: out, steps, refs: [], targets: [], ai: [] };
  }
  const refs = [], targets = [], ai = [];
  plat.steps.forEach((raw, i) => {
    let step = raw.trim();
    const no = `第 ${i + 1} 步`;
    if (!step) return;
    if ((step.startsWith('"') && step.endsWith('"')) || (step.startsWith("'") && step.endsWith("'"))) {
      step = step.slice(1, -1);
      out.push(warn('W_MACRO_QUOTED_STEP', `${no}整段被引號包住，runtime 會先去掉引號再執行（相容舊寫法）`));
    }
    const sub = (f, o) => f.forEach(x => out.push({ ...x, message: `${o}：${x.message}` }));
    const head = /^([A-Za-z]+)\s*\(/.exec(step);
    const kind = Object.keys(STEP).find(k => step.indexOf(k) === 0);
    if (kind === 'LLMQUERY' || kind === 'LLMvision' || kind === 'VOICETOTEXT') {
      const open = step.indexOf('('), close = step.lastIndexOf(')');
      if (open < 0 || close < open) { out.push(err('E_MACRO_SYNTAX', `${no} ${kind} 缺少括號`)); return; }
      if (step.slice(close + 1).trim()) out.push(err('E_MACRO_TRAILING', `${no} ${kind}(...) 之後的「${step.slice(close + 1).trim().slice(0, 20)}」會被忽略`));
      const params = platformSplit(step.substring(open + 1, close)).steps;
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
        if (p === null || !ASR_PROVIDERS.includes(p)) out.push(err('E_ASR_PROVIDER', `${no} VOICETOTEXT 的語音服務必須是 ${ASR_PROVIDERS.map(x => `'${x}'`).join(' 或 ')}`));
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
  const r = lintFormula(text, ctx, { context: 'macro', what: 'LLM 控制項的 prompt' });
  identifierWarning(r.functions, r.findings, 'LLM 控制項');
  promptDesignWarnings(text, r, r.findings, 'LLM 控制項');
  return { findings: r.findings, refs: r.refs, ai: [{ step: 1, kind: 'LLM 控制項', model: '（預設，不可指定）', inputs: [...new Set(r.refs)], sources: promptSources(r.functions) }] };
}

// prompt 中一次取出大量表單或病歷資料的函數（AI 資料流要明列，不能只列 A<n>）
const BULK_SOURCES = {
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
