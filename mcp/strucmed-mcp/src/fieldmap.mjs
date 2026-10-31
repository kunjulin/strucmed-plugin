// 字典助手（plugin 3.7.0）：把 draft 解析成「每個欄位的事實」，供找字典（dictionary_suggest）、寫補述（dictionary_memo_check）與 dictionary-annotator 使用。
// 事實全部來自表單本身（說明文字、datatype、選項、範圍、字典綁定、誰參照誰、AI 資料流）；derived 是依事實推得的補述草稿，給 AI 改寫，不直接寫入。
// 不連線、不碰病人資料。
import { walk, isControl, areaNode, referencesOf } from './formtree.mjs';
import { captions } from './formula-explain.mjs';
import { scriptFindings, tableControlIds } from './validate.mjs';
import * as dc from './dictcomment.mjs';
import { unitOf } from './dictsuggest.mjs';
import { compareUnits } from './units.mjs';

export { unitOf };

const CHOICE = new Set(['selection', 'combobox', 'radiobutton', 'checkbox']);
const AREA_LABEL = { form: '文字區塊', formtable: '固定表格', tab1: '垂直頁籤', tab2: '水平頁籤', table1: '欄向動態表格', table2: '列向動態表格' };
const REF_LABEL = { formula: '計算式', actionScript: '巨集或 LLM prompt', target: '巨集寫入', reference: '資料引用', further: '選項連動', actionID: '結果回傳', furActionID: '輸入後觸發' };
const optionValues = c => (Array.isArray(c.option) ? c.option : []).map(o => (o && typeof o === 'object' ? String(o.value ?? '') : String(o))).filter(Boolean);
const clip = (s, n = 300) => { const a = [...String(s)]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };

// 本機索引中的字典（dicid 優先，否則名稱比對範圍內第一筆）；pending＝待新建
function dictionaryOf(c, idx, draft) {
  if (!c.dictionary && !c.dicid) return null;
  const entries = (idx && idx.entries) || [];
  const e = (c.dicid && entries.find(x => x.id === c.dicid)) || null;
  const pend = (draft.pendingDictionaries || []).find(p => p.name === c.dictionary);
  if (e) { const x = dc.enrich(e, idx.deptNo); return { id: x.id, name: x.dicName, level: x.level, desc: x.desc || '', memo: x.memo || null, fhir: x.fhir || [], memo_by: x.memo_by || '', pending: false }; }
  if (pend) return { id: '', name: pend.name, level: '', desc: pend.comment || '', memo: pend.memo || null, fhir: [], pending: true };
  return { id: c.dicid || '', name: c.dictionary || '', level: '', desc: '', memo: null, fhir: [], pending: false, unknown: true };
}

// draft → { fields, stats }
export function fieldMap(draft, idx, policy = {}) {
  const names = captions(draft);
  const nodes = [];
  walk(draft, (n, arr, i, area) => { if (isControl(n)) nodes.push({ n, area }); });
  const ctlMap = new Map(nodes.map(x => [String(x.n.itemid), x.n]));
  const tableIds = tableControlIds(draft);
  const name = id => names.get(String(id)) || ((ctlMap.get(String(id)) || {}).actionName ? `「${ctlMap.get(String(id)).actionName}」按鈕` : `#${id}`);
  // 反向參照與 AI 資料流
  const refsIn = new Map(), aiRole = new Map();
  const push = (m, k, v) => { const l = m.get(k) || []; l.push(v); m.set(k, l); };
  for (const { n } of nodes) {
    for (const r of referencesOf(n)) push(refsIn, r.id, { from: String(n.itemid), kind: r.kind, from_caption: name(n.itemid), from_datatype: n.datatype });
    if (n.datatype === 'action' || n.datatype === 'action2') {
      const sf = scriptFindings(n, ctlMap, policy, tableIds);
      for (const a of sf.ai) {
        for (const id of a.inputs || []) push(aiRole, String(id), `${a.kind || 'LLM'}（#${n.itemid}「${n.actionName || name(n.itemid)}」）的輸入`);
        if (a.target) push(aiRole, String(a.target), `${a.kind || 'LLM'}（#${n.itemid}「${n.actionName || name(n.itemid)}」）的回覆寫入`);
      }
    }
  }
  const fields = nodes.map(({ n, area }) => {
    const id = String(n.itemid);
    const node = areaNode(area);
    const caption = names.get(id) || '';
    const opts = CHOICE.has(n.datatype) ? optionValues(n) : [];
    const dict = dictionaryOf(n, idx, draft);
    const out = referencesOf(n).map(r => ({ ...r, to_caption: name(r.id) }));
    const inn = refsIn.get(id) || [];
    // derived.func：在表單中的角色（給 AI 改寫成 memo.func）
    const roles = [];
    if (n.datatype === 'label' && n.formula) roles.push(`計算結果：${clip(n.formula, 80)}（引用 ${out.filter(r => r.kind === 'formula').map(r => r.to_caption).join('、') || '無'}）`);
    if (n.datatype === 'label' && n.format === 'hisquery') roles.push('HIS 參照（顯示 HIS 查到的資料）');
    if (n.datatype === 'action') roles.push(`巨集按鈕「${n.actionName || caption}」`);
    if (n.datatype === 'action2') roles.push(`LLM 按鈕「${n.actionName || caption}」，回覆寫入 ${name(n.actionID)}`);
    const byKind = k => inn.filter(r => r.kind === k).map(r => r.from_caption);
    if (byKind('formula').length) roles.push(`計算式輸入（被 ${byKind('formula').join('、')} 引用）`);
    if (byKind('target').length) roles.push(`巨集寫入目標（${byKind('target').join('、')}）`);
    if (byKind('actionScript').length) roles.push(`巨集或 prompt 讀取（${byKind('actionScript').join('、')}）`);
    if (byKind('further').length) roles.push(`選項連動顯示（由 ${byKind('further').join('、')} 控制）`);
    if (byKind('reference').length) roles.push(`被資料引用（${byKind('reference').join('、')}）`);
    for (const r of aiRole.get(id) || []) roles.push(r);
    if (n.furActionID) roles.push(`輸入後觸發巨集 ${name(n.furActionID)}`);
    if (n.dicrole === 'fromhis') roles.push('開啟時由 HIS 帶入');
    else if (n.dicrole === 'puthis') roles.push('存檔時寫回 HIS');
    else if (n.dicrole === 'tohis' && dict) roles.push('存檔進倉儲（可被其他表單以字典引用）');
    if (n.required) roles.push('必填');
    if (!roles.length && !['action', 'action2'].includes(n.datatype)) roles.push('使用者輸入');
    const min = n.minval !== undefined && n.minval !== '' ? String(n.minval) : '', max = n.maxval !== undefined && n.maxval !== '' ? String(n.maxval) : '';
    const unit = unitOf(caption) || (dict && dict.memo && dict.memo.unit) || '';
    return {
      itemid: Number(n.itemid), caption, datatype: n.datatype,
      area: { itemid: node.itemid !== undefined ? String(node.itemid) : '', type: node.itemtype, label: AREA_LABEL[node.itemtype] || node.itemtype, title: area.title || '' },
      ...(opts.length && { options: opts }), ...(min || max ? { min, max } : {}), ...(unit && { unit }),
      ...(n.format && { format: n.format }), required: !!n.required, tocalc: n.tocalc !== false, dicrole: n.dicrole || 'nohis',
      dictionary: dict, refs_out: out, refs_in: inn, ai: aiRole.get(id) || [],
      derived: {
        func: clip(roles.join('；')),
        type: n.datatype,
        ...((min || max) && { range: `${min || '?'}-${max || '?'}` }),
        ...(opts.length && { range: clip(opts.join('／')) }),
        ...(unit && { unit })
      }
    };
  });
  const bound = fields.filter(f => f.dictionary);
  return {
    fields,
    stats: {
      controls: fields.length, with_dictionary: bound.length, pending: bound.filter(f => f.dictionary.pending).length,
      missing_memo: bound.filter(f => !f.dictionary.memo).length,
      missing_angles: bound.filter(f => !f.dictionary.memo || !['func', 'usecase', 'interop'].every(k => f.dictionary.memo[k])).length,
      unknown_dictionary: bound.filter(f => f.dictionary.unknown).length
    }
  };
}

// ── 計算式與引用對照補述（formula_check）───────────────────────────
const TEXT_TYPES = new Set(['textbox', 'textarea']);   // 選項、日期可以參與計算（評分、日期差），不算
const RANGE_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[-~－～至到]\s*(-?\d+(?:\.\d+)?)\s*$/;

// fields：fieldMap 的結果；refs：被引用的 itemid；formula：kind=formula 時的計算式原文；samples：試算例 → { ref_dictionary, findings }
export function refChecks(fields, refs, { formula, samples } = {}) {
  const ref_dictionary = {}, findings = [];
  const warn = (code, message) => findings.push({ level: 'warn', code, message });
  for (const id of refs || []) {
    const f = fields.find(x => String(x.itemid) === String(id));
    if (!f || !f.dictionary || f.dictionary.unknown) continue;
    const key = `A${id}`, who = `${key}「${f.caption || f.dictionary.name}」`, m = f.dictionary.memo;
    if (!m) { ref_dictionary[key] = { dictionary: f.dictionary.name }; warn('W_REF_NO_MEMO', `${who} 綁的字典「${f.dictionary.name}」沒有補述，無法確認單位與範圍`); continue; }
    ref_dictionary[key] = { dictionary: f.dictionary.name, ...Object.fromEntries(['unit', 'range', 'type', 'calx', 'llm'].filter(k => m[k]).map(k => [k, m[k]])) };
    const unit = unitOf(f.caption);
    const cmp = unit && m.unit ? compareUnits(unit, m.unit) : { kind: 'same' };
    if (cmp.kind === 'convertible') warn('W_REF_UNIT_MISMATCH', `${who} 的單位是 ${unit}，字典補述是 ${m.unit}（1 ${unit} = ${cmp.factor} ${m.unit}）：請確認計算式的換算`);
    else if (cmp.kind === 'different') warn('W_REF_UNIT_MISMATCH', `${who} 的單位是 ${unit}，字典補述是 ${m.unit}，兩者不是同一種量，不能直接換算`);
    else if (cmp.kind === 'unknown') warn('W_REF_UNIT_UNKNOWN', `${who} 的單位是 ${unit}，字典補述是 ${m.unit}：無法判定是否相同，請確認`);
    if (formula && TEXT_TYPES.has(m.type) && new RegExp(`[-+*/^]\\s*${key}\\b|\\b${key}\\s*[-+*/^]`).test(formula)) warn('W_REF_TYPE_MISMATCH', `${who} 參與運算，但字典補述的型別是 ${m.type}`);
    const r = RANGE_RE.exec(String(m.range || ''));
    if (!r) continue;
    for (const sm of samples || []) {
      const values = (sm && sm.values) || {}, v = values[key] ?? values[String(id)];
      const n = v === '' || v === null || v === undefined ? NaN : Number(v);
      if (!Number.isNaN(n) && (n < Number(r[1]) || n > Number(r[2]))) warn('W_SAMPLE_OUT_OF_RANGE', `試算例的 ${who}＝${v} 超出字典補述的範圍 ${m.range}`);
    }
  }
  return { ref_dictionary, findings };
}

// ── 補述草稿檢查（dictionary_memo_check）────────────────────────────────
const TW_ID = /[A-Z][12]\d{8}/;
const LONG_DIGITS = /(^|[^\d.])\d{7,10}([^\d.]|$)/;
const ANGLES = ['func', 'usecase', 'interop'];
const parseRange = r => { const m = String(r || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*[-~～–至]\s*(-?\d+(?:\.\d+)?)\s*$/); return m ? [Number(m[1]), Number(m[2])] : null; };

// memo（＋fhir）草稿 → { ok, errors, warnings, merged, chars }。existing 有給時先做補充合併（mergeMemo）；field 是 fieldMap 的一筆（選填）
export function checkMemo({ memo, fhir, existing, field, desc = '' }) {
  const errors = [], warnings = [];
  const err = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  let merged = null;
  try { merged = existing ? dc.mergeMemo(existing.memo || null, memo || {}) : (memo ? dc.validateMemo(memo) : null); }
  catch (e) { err(e.code || 'E_INVALID_INPUT', e.message); }
  let fv = { fhir: [], warnings: [] };
  const fhirFinal = fhir !== undefined ? (fhir || []) : (existing && existing.fhir) || [];
  try { fv = dc.validateFhir(fhirFinal, merged && merged.type); warnings.push(...fv.warnings.map(w => ({ code: String(w).split('：')[0], message: String(w) }))); }
  catch (e) { err(e.code || 'E_INVALID_FHIR', e.message); }
  let chars = 0;
  if (!errors.length) {
    try {
      const raw = dc.build({ desc: (existing && existing.desc) || desc, memo: merged, fhir: fv.fhir, memo_by: 'U0000000', memo_at: '2026-01-01T00:00:00.000Z' }, { forceJson: true });
      chars = dc.checkLength(raw);
      if (chars > dc.MAX_CHARS * 0.9) warn('W_DICT_COMMENT_NEAR_LIMIT', `寫入後約 ${chars} 字，接近上限 ${dc.MAX_CHARS}`);
    } catch (e) { err(e.code || 'E_INVALID_INPUT', e.message); }
  }
  const m = merged || {};
  for (const [k, v] of Object.entries(m)) {
    const text = [].concat(v).join(' ');
    if (TW_ID.test(text)) err('E_PHI_SUSPECT', `補述「${dc.MEMO_LABEL[k] || k}」疑似含身分證字號`);
    else if (LONG_DIGITS.test(text)) warn('W_PHI_SUSPECT', `補述「${dc.MEMO_LABEL[k] || k}」含 7–10 位數字，請確認不是病歷號`);
  }
  const missing = ANGLES.filter(k => !m[k]);
  if (missing.length) warn('W_MEMO_INCOMPLETE', `還沒寫：${missing.map(k => dc.MEMO_LABEL[k]).join('、')}（表單功能、使用情境、交換引用三個角度，references/DictionaryMemo.md）`);
  if (!m.meaning) warn('W_MEMO_NO_MEANING', '沒有「語意」：別人搜尋與引用時看不懂這個欄位記錄什麼');
  if (field) {
    if (m.type && m.type !== field.datatype) warn('W_MEMO_TYPE_MISMATCH', `「控制項」寫 ${m.type}，表單上是 ${field.datatype}`);
    if (m.unit && field.unit && compareUnits(m.unit, field.unit).kind !== 'same') warn('W_MEMO_UNIT_MISMATCH', `「單位」寫 ${m.unit}，欄位說明是 ${field.unit}`);
    const rr = parseRange(m.range);
    if (rr && (field.min || field.max)) {
      const [lo, hi] = rr;
      if ((field.min !== '' && field.min !== undefined && Number(field.min) !== lo) || (field.max !== '' && field.max !== undefined && Number(field.max) !== hi))
        warn('W_MEMO_RANGE_MISMATCH', `「範圍」寫 ${m.range}，數字欄位設定是 ${field.min || '?'}-${field.max || '?'}`);
    }
    if (field.options && field.options.length && m.range) {
      const absent = field.options.filter(o => !String(m.range).includes(o));
      if (absent.length) warn('W_MEMO_OPTIONS_MISSING', `「範圍」沒有列出選項：${absent.slice(0, 8).join('、')}`);
    }
    if (!m.func && field.derived && field.derived.func) warn('W_MEMO_NO_FUNC', `沒有「表單功能」；依表單推得：${field.derived.func}`);
  }
  return { ok: !errors.length, errors, warnings, merged, fhir: fv.fhir, chars, limit: dc.MAX_CHARS };
}
