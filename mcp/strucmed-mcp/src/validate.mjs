// form_validate — checks the editor does NOT perform (round-trip verified).
// v1：以 formtree 遞迴走訪（表格格、圖示、群組子項），參照檢查涵蓋 further / reference /
// actionID / furActionID / 計算式與巨集中的 A<n>。
// 嚴重度：本工具新增或修改的部分 → error；既有表單原封保留的部分 → warning（標示「原表單既有」）。
// v0.2：計算式、巨集、HIS 參照的檢查（scriptlint）也依同一套分級；修改類別為 formula。
import { RUNTIME_ROLE, DATATYPES_V02, cellKind } from './model.mjs';
import { walk, isControl, isArea, referencesOf, areaNode } from './formtree.mjs';
import { lintFormula, lintMacro, lintHisQuery, lintPrompt } from './scriptlint.mjs';

// 由 scriptlint 以更精確的訊息回報的參照種類
const SCRIPT_REF_KINDS = new Set(['formula', 'actionScript', 'target', 'actionID']);
const TEXT_TARGETS = ['textarea', 'textbox', 'label'];

// 單一控制項的計算式／巨集／HIS 參照檢查（validate 與新增、修改工具共用）
export function scriptFindings(c, ctlMap, policy = {}, tableIds = null) {
  const ctx = { controls: ctlMap, policy, self: c.itemid, tableIds };
  const found = [], ai = [];
  let formulaRefs = null, macroIds = false;
  if (c.formula && (c.datatype === 'label' || c.datatype === 'imgbox')) {
    const r = lintFormula(c.formula, ctx, { context: 'formula', what: c.datatype === 'label' ? '計算式' : '圖片函數網址' });
    found.push(...r.findings);
    if (c.datatype === 'label') formulaRefs = r.refs;
    if (c.datatype === 'label' && c.format !== 'formula') found.push({ code: 'E_FORMULA_FORMAT', level: 'error', message: `format 是「${c.format || '（空）'}」但 formula 不是空的：runtime 仍會計算它（TempHtml.js:4368）` });
  }
  if (c.datatype === 'label' && c.format === 'hisquery') found.push(...lintHisQuery(c.hisquery).findings);
  if (c.datatype === 'action') {
    const r = lintMacro(c.actionScript, ctx);
    found.push(...r.findings);
    if (r.refs.length || r.targets.length) macroIds = true;
    r.ai.forEach(x => ai.push({ itemid: Number(c.itemid), name: c.actionName || '', ...x }));
  }
  if (c.datatype === 'action2') {
    const r = lintPrompt(c.actionScript, ctx);
    found.push(...r.findings);
    if (r.refs.length) macroIds = true;
    r.ai.forEach(x => ai.push({ itemid: Number(c.itemid), name: c.actionName || '', ...x, target: c.actionID }));
    if (!c.actionID) found.push({ code: 'E_MACRO_SYNTAX', level: 'error', message: 'LLM 按鈕沒有設定回覆寫入的 ID（actionID）' });
  }
  if ((c.datatype === 'action' || c.datatype === 'action2') && c.actionID && String(c.actionID) !== '0') {
    const t = ctlMap.get(String(c.actionID));
    if (!t) found.push({ code: 'E_REF_BROKEN', level: 'error', message: `結果回傳 ID #${c.actionID} 不存在` });
    else if (tableIds && tableIds.has(String(c.actionID))) found.push({ code: 'E_MACRO_TARGET_TABLE', level: 'error', message: `結果回傳 ID #${c.actionID} 在動態表格內：每一列共用同一個 itemid，會一次寫入所有列` });
    else if (!TEXT_TARGETS.includes(t.datatype)) found.push({ code: 'E_MACRO_TARGET_TYPE', level: 'error', message: `結果回傳 ID #${c.actionID} 是 ${t.datatype}，必須是 ${TEXT_TARGETS.join(' / ')}` });
  }
  if (c.furActionID) {
    const t = ctlMap.get(String(c.furActionID));
    if (t && t.datatype !== 'action' && t.datatype !== 'action2') found.push({ code: 'E_REF_TYPE', level: 'error', message: `furActionID 指向 #${c.furActionID}（${t.datatype}），必須是巨集按鈕或 LLM 按鈕` });
  }
  return { found, ai, formulaRefs, macroIds };
}
// 動態表格（table1／table2）內所有控制項的 itemid：巨集寫入這些欄位會一次改到所有列
export function tableControlIds(draft) {
  const ids = new Set();
  walk(draft, (n, arr, idx, area) => { if (isControl(n) && cellKind(areaNode(area).itemtype) === 'table') ids.add(String(n.itemid)); });
  return ids;
}
// 新增／修改時可以延後處理的錯誤（參照對象可能稍後才建立）；其餘錯誤當下就拒絕
export const DEFERRABLE = new Set(['E_REF_BROKEN', 'E_FORMULA_REF_NOT_CALC', 'E_MACRO_TARGET_TYPE', 'E_FORMULA_CYCLE', 'E_REF_TYPE']);

const TW_ID = /[A-Z][12]\d{8}/;               // 身分證字號樣式
const LONG_DIGITS = /\b\d{7,10}\b/;            // 可能是病歷號（僅警告）
const PHI_WORDS = /(病歷號|身分證|姓名)\s*[:：]\s*\S/;

export function validateDraft(draft, dictIndex, policy = {}) {
  const errors = [], warnings = [];
  const touched = new Set((draft.touched || []).map(String));
  const tf = draft.touchedFields || {};
  // 依「改了什麼」決定嚴重度：新產生（非匯入區塊）或新增的控制項 → 全面；修改 → 只有被改到的類別
  const cats = node => tf[node.itemid] || tf[String(node.itemid)] || [];
  const freshFor = (node, area, ...wanted) => !area.imported || cats(node).includes('added') || wanted.some(c => cats(node).includes(c));
  // 依來源決定嚴重度
  const report = (fresh, code, message, itemid) => {
    const entry = { code, message: fresh ? message : `${message}（原表單既有）`, ...(itemid !== undefined && { itemid: Number(itemid) }) };
    (fresh ? errors : warnings).push(entry);
  };
  const warn = (code, message, itemid) => warnings.push({ code, message, ...(itemid !== undefined && { itemid: Number(itemid) }) });
  const m = draft.meta;

  if (!m.name || !m.name.trim()) report(true, 'E_INVALID_INPUT', '表單名稱不可空白');
  if ((m.name || '').length > 36) report(true, 'E_INVALID_INPUT', '表單名稱超過 36 字（平台 web/editor.html:463）');
  if ((m.groups || []).length && !m.shortcut) warn('W_NO_SHORTCUT', '有作業別但沒有捷徑名稱：表單不會出現在 HIS 清單（GB:biao-dan-shi-yong/biao-dan-shang-jia）');
  if (!draft.areas.length) report(true, 'E_INVALID_INPUT', '表單沒有任何區塊');

  const ids = new Map();          // itemid → [{fresh}]
  const controls = [];            // { node, fresh }
  const addId = (id, fresh) => { const k = String(id); (ids.get(k) || ids.set(k, []).get(k)).push(fresh); };

  for (const a of draft.areas) {
    if (a.imported) continue;
    const where = `區塊 #${a.itemid}`;
    if (!a.hidden && !(a.authread || []).includes(RUNTIME_ROLE)) warn('W_AREA_AUTH', `${where}：所有人未勾「顯示」且未宣告 hidden，runtime 會隱藏`, a.itemid);
    if (!(a.authwrite || []).includes(RUNTIME_ROLE)) warn('W_AREA_AUTH', `${where}：所有人未勾「編輯」，runtime 會鎖定`, a.itemid);
    if (a.gettext !== true && a.return_text !== false) warn('W_AREA_AUTH', `${where}：未勾「回傳文字」且未宣告 return_text:false，不會帶回 HIS`, a.itemid);
    if (!a.structured && !a.items.some(i => i.itemid !== undefined)) warn('W_EMPTY_AREA', `${where} 沒有控制項`, a.itemid);
    if (a.structured) {
      // 表格／頁籤：每一格都要有控制項，否則 HIS 端會出現空白格或空白頁籤
      const cells = a.area.itemtype === 'formtable' ? a.area.item.flatMap((r, ri) => r.item.map((c, ci) => [`第 ${ri} 列第 ${ci} 欄`, c.item]))
        : a.area.item.map((c, i) => [`「${c.datatitle || i}」`, c.item]);
      const empty = cells.filter(([, items]) => !items.some(i => i.itemid !== undefined)).map(([w]) => w);
      if (empty.length) warn('W_EMPTY_AREA', `${where}（${a.area.itemtype}）有空白格子：${empty.join('、')}`, a.itemid);
      // 固定表格的報告文字把同一列各格直接相接（例：「 - 身高：170體重：65」）：
      // 前一格以控制項結尾、下一格說明文字又不是空白或標點開頭時，兩個值會黏在一起（references/LayoutPatterns.md §3）
      if (a.area.itemtype === 'formtable') {
        const sep = /^[\s　,，;；:：、.。()（）/／|｜-]/;
        const glued = [];
        a.area.item.forEach((row, ri) => row.item.forEach((cell, ci) => {
          const next = row.item[ci + 1];
          if (!next) return;
          const items = cell.item.filter(i => i.datatype !== 'newline');
          const last = items[items.length - 1];
          const first = next.item.find(i => i.datatype !== 'newline');
          if (!last || last.itemid === undefined || !first) return;
          // 前一格以「純文字型 label」結尾（format=defaultValue）：它的文字（或其前的說明文字）以冒號等收尾就算有分隔
          if (last.datatype === 'label' && (last.format || 'defaultValue') === 'defaultValue') {
            const before = items[items.length - 2];
            const tail = String(last.datavalue || '') || (before && before.datatype === 'text' ? String(before.datavalue || '') : '');
            if (/[\s　,，;；:：、.。()（）/／|｜-]$/.test(tail)) return;
          }
          const firstText = first.datatype === 'text' ? String(first.datavalue || '') : '';
          if (first.datatype === 'text' && sep.test(firstText)) return;
          glued.push(`第 ${ri} 列第 ${ci} 欄→第 ${ci + 1} 欄`);
        }));
        if (glued.length) warn('W_LAYOUT_CELL_SEP', `${where}（formtable）相鄰格子的報告文字會直接相接：${glued.join('、')}；請在下一格的說明文字開頭加空白、單位或標點（例「 cm 體重：」）`, a.itemid);
      }
    }
  }

  walk(draft, (n, arr, idx, area) => {
    if (isArea(n) && n.itemid !== undefined) { addId(n.itemid, !area.imported); return; }
    if (n.datatype === 'text') {
      const next = arr[idx + 1];
      const fresh = !area.imported || (next && next.itemid !== undefined && freshFor(next, area, 'label'));
      if (TW_ID.test(n.datavalue || '') || PHI_WORDS.test(n.datavalue || '')) report(fresh, 'E_PHI_SUSPECT', `文字疑似含個資：「${String(n.datavalue).slice(0, 20)}…」`);
      return;
    }
    if (!isControl(n)) return;
    addId(n.itemid, freshFor(n, area));
    controls.push({ node: n, area, touched: !area.imported || touched.has(String(n.itemid)) });
  });

  for (const [id, list] of ids) if (list.length > 1) report(list.some(Boolean), 'E_DUP_ITEMID', `itemid ${id} 重複 ${list.length} 次（編輯器不檢查）`, id);

  const existing = new Set([...ids.keys()]);
  const knownIds = new Set(dictIndex ? dictIndex.entries.map(e => e.id).filter(Boolean) : []);
  for (const { node: c, area } of controls) {
    const fresh = freshFor(c, area);
    if (fresh && !draft.source && !DATATYPES_V02.includes(c.datatype)) report(true, 'E_UNSUPPORTED_DATATYPE', `datatype ${c.datatype} 不在本工具支援範圍`, c.itemid);
    // v1：表格與頁籤格子的規則（實測 load→save 與 runtime 行為）
    const kind = cellKind(areaNode(area).itemtype);
    if (kind === 'tab' || kind === 'table') {
      if ((c.dicrole && c.dicrole !== 'nohis') || c.dicid) {
        report(freshFor(c, area, 'dict'), 'E_CELL_DICT', `#${c.itemid}：${kind === 'tab' ? '頁籤' : '動態表格'}內的欄位執行時不上傳 HIS，編輯器載入時也會把字典角色改成 nohis（目前 ${c.dicrole}${c.dictionary ? `，字典 ${c.dictionary}` : ''}）`, c.itemid);
      }
    }
    if (kind === 'table') {
      if (c.tocalc !== false) report(freshFor(c, area, 'flags'), 'E_TABLE_TOCALC', `#${c.itemid}：動態表格每一列共用同一個 itemid，欄位不能參與計算（tocalc 必須 false）`, c.itemid);
      if (['action', 'action2'].includes(c.datatype) || (c.datatype === 'label' && (c.formula || c.format === 'hisquery'))) {
        report(freshFor(c, area, 'formula'), 'E_TABLE_SCRIPT', `#${c.itemid}：動態表格每一列會複製同一組欄位，計算式、HIS 參照與巨集請放在表格外`, c.itemid);
      }
    }
    for (const r of referencesOf(c)) {
      if (SCRIPT_REF_KINDS.has(r.kind)) continue;
      const refFresh = r.kind === 'further' ? freshFor(c, area, 'shape') : fresh;
      if (!existing.has(r.id)) report(refFresh, 'E_REF_BROKEN', `${r.kind} 指向不存在的 itemid ${r.id}`, c.itemid);
    }
    const dictFresh = freshFor(c, area, 'dict');
    const valueFresh = freshFor(c, area, 'value', 'shape');
    if (c.dicid) {
      if (dictIndex && !knownIds.has(c.dicid)) {
        if (dictFresh) report(true, 'E_DICT_UNKNOWN_ID', `dicid ${c.dicid} 不在字典 CSV 中`, c.itemid);
        else warn('W_DICT_NOT_IN_INDEX', `dicid ${String(c.dicid).slice(0, 8)}… 不在已載入的字典 CSV（可能屬上層科部；原表單既有）`, c.itemid);
      } else if (!dictIndex && dictFresh) report(true, 'E_DICT_UNKNOWN_ID', `指定了 dicid ${c.dicid}，但尚未載入字典 CSV，無法驗證`, c.itemid);
    }
    if (dictFresh && !c.dicid && c.dictionary && c.dicrole !== 'tohis') warn('W_DICT_ROLE_FORCED', `只以名稱綁定「${c.dictionary}」：匯入後角色一律變成 tohis`, c.itemid);
    if (!c.dicid && !c.dictionary && c.dicrole && c.dicrole !== 'nohis') report(dictFresh, 'E_DICT_REQUIRED', `dicrole=${c.dicrole} 但沒有綁字典（匯入後會被改成 nohis）`, c.itemid);
    const dv = (typeof c.datavalue === 'string' ? c.datavalue : '') + ' ' +
      (Array.isArray(c.option) ? c.option.map(o => (typeof o === 'string' ? o : (o && o.value) || '')).join(' ') : '');
    if (TW_ID.test(dv)) report(valueFresh, 'E_PHI_SUSPECT', '預設值或選項疑似含身分證字號', c.itemid);
    else if (typeof c.datavalue === 'string' && LONG_DIGITS.test(c.datavalue)) warn('W_PHI_SUSPECT', '預設值含 7–10 位數字，請確認不是病歷號', c.itemid);
  }

  // ── v0.2：計算式、巨集、HIS 參照 ──
  const ctlMap = new Map(controls.map(x => [String(x.node.itemid), x.node]));
  const tableIds = tableControlIds(draft);
  const ai = [];
  const formulaGraph = new Map();
  let macroIds = false;
  for (const { node: c, area } of controls) {
    const sFresh = freshFor(c, area, 'formula');
    const r = scriptFindings(c, ctlMap, policy, tableIds);
    const found = r.found;
    if (r.formulaRefs) formulaGraph.set(String(c.itemid), r.formulaRefs);
    if (r.macroIds) macroIds = true;
    ai.push(...r.ai);
    const seen = new Set();
    for (const f of found) {
      const key = f.code + f.message;
      if (seen.has(key)) continue;
      seen.add(key);
      if (f.level === 'warn') warn(f.code, `#${c.itemid}：${f.message}`, c.itemid);
      else report(sFresh, f.code, `#${c.itemid}：${f.message}`, c.itemid);
    }
  }
  // 計算式循環參照（只看 label 計算式之間）
  const state = new Map();
  const cycles = [];
  const dfs = (id, stack) => {
    state.set(id, 1);
    for (const nx of formulaGraph.get(id) || []) {
      if (!formulaGraph.has(nx)) continue;
      if (state.get(nx) === 1) cycles.push([...stack.slice(stack.indexOf(nx)), nx]);
      else if (!state.get(nx)) dfs(nx, [...stack, nx]);
    }
    state.set(id, 2);
  };
  for (const id of formulaGraph.keys()) if (!state.get(id)) dfs(id, [id]);
  for (const cyc of cycles) {
    if (cyc.length === 2) continue;   // 自我參照已由 scriptlint 回報
    const fresh = cyc.some(id => { const x = controls.find(k => String(k.node.itemid) === id); return x && freshFor(x.node, x.area, 'formula'); });
    report(fresh, 'E_FORMULA_CYCLE', `計算式循環參照：${cyc.map(id => 'A' + id).join(' → ')}`, cyc[0]);
  }
  if (macroIds) warn('W_RENUMBER_MACRO', '表單有巨集或 LLM 按鈕：編輯器「重新編號」不會更新巨集內容中的 A<n> 與目標 id，匯入後請勿按「重新編號」');
  if (ai.length) {
    warn('W_AI_DATAFLOW', `有 ${ai.length} 個 AI 步驟會把表單內容送到院內 LLM／語音服務（清單見 manifest「AI 資料流」；交付時必須告知使用者）`);
    if (!Array.isArray(policy.gateway_models)) warn('W_LLM_WHITELIST_STALE', '模型白名單尚未從 LlmGateway 取得（llmgateway_models），只以內建靜態表檢查模型名稱');
    else if (policy.gateway_stale) warn('W_LLM_WHITELIST_STALE', `LlmGateway 白名單快取已 ${policy.gateway_age_days} 天，建議重新 llmgateway_models`);
  }

  const pending = draft.pendingDictionaries || [];
  if (pending.length) warn('W_NEW_DICTIONARY', `有 ${pending.length} 個新字典：必須用「匯入表單及字典」匯入，否則綁定會靜默消失（04 結論 2）`);
  if (draft.source && draft.source.javascript) warn('W_CUSTOM_JS', `保留原表單 JS（${draft.source.javascript.length} 字元），本工具未審查其內容，請人工審查後再使用`);

  const nodes = controls.map(x => x.node);
  return {
    valid: errors.length === 0,
    errors, warnings, ai,
    stats: {
      areas: draft.areas.length, controls: nodes.length,
      new_or_modified: controls.filter(x => x.touched).length,
      dict_bound: nodes.filter(c => c.dicid).length,
      dict_new: pending.length,
      required: nodes.filter(c => c.required).length,
      formulas: nodes.filter(c => c.formula).length,
      macros: nodes.filter(c => c.datatype === 'action' || c.datatype === 'action2').length,
      ai_steps: ai.length
    }
  };
}
