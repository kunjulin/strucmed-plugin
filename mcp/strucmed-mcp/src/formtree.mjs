// 遞迴走訪表單結構（v1：既有表單改版）
// GetData() 的巢狀位置（平台 web/js/scripts.js:3680-3846）：
//   區塊.item[]、formtable 的 row.item[] → td.item[]、表格 td.item[]、picture 圖示 icon.item[]、
//   picture.itemtemp[]、彈出片語／群組控制項的 datavalue[]（子項陣列）
// 區塊與控制項共用同一個 itemid 編號空間（scripts.js:428-453）。

import { lintFormula, lintMacro } from './scriptlint.mjs';

const CHILD_KEYS = ['item', 'itemtemp'];

// draft.areas 的兩種型態：
//   imported：{ imported:true, area:<GetData 區塊原樣> }（既有表單載入，原封保留）
//   generated：{ itemid, type:'form', authread, authwrite, gettext, items:[…] }（本工具產生）
export function areaNode(a) {
  if (a.imported || a.structured) return a.area;
  return { itemtype: 'form', itemid: String(a.itemid), authread: a.authread, authwrite: a.authwrite, gettext: a.gettext, item: a.items };
}

// 走訪所有節點；visit(node, parentArray, index, areaRef, depth)
export function walk(draft, visit) {
  const rec = (node, arr, idx, area, depth) => {
    if (!node || typeof node !== 'object') return;
    visit(node, arr, idx, area, depth);
    for (const k of CHILD_KEYS) {
      if (Array.isArray(node[k])) node[k].forEach((c, i) => rec(c, node[k], i, area, depth + 1));
    }
    if (Array.isArray(node.datavalue)) node.datavalue.forEach((c, i) => rec(c, node.datavalue, i, area, depth + 1));
  };
  draft.areas.forEach((a, i) => rec(areaNode(a), draft.areas, i, a, 0));
}

export const isControl = n => n && n.datatype && n.datatype !== 'text' && n.datatype !== 'newline' && n.itemid !== undefined;
export const isArea = n => n && n.itemtype && n.itemid !== undefined && !n.datatype;

export function maxItemId(draft) {
  let max = 0;
  walk(draft, n => {
    if (n.itemid !== undefined && n.itemid !== '') {
      const v = parseInt(n.itemid, 10);
      if (!isNaN(v) && v > max) max = v;
    }
  });
  return max;
}

export function findControl(draft, itemid) {
  let hit = null;
  walk(draft, (n, arr, idx, area) => {
    if (!hit && isControl(n) && String(n.itemid) === String(itemid)) hit = { node: n, arr, idx, area };
  });
  return hit;
}

// 一個控制項對其他 itemid 的參照
const A_REF = /(^|[^A-Za-z0-9_])[Aa](\d+)(?![0-9A-Za-z_])/g;
export function formulaRefs(text) {
  const out = [];
  if (!text) return out;
  let m;
  const s = String(text);
  A_REF.lastIndex = 0;
  while ((m = A_REF.exec(s))) out.push(m[2]);
  return out;
}
// v0.2：計算式與巨集以語法樹取參照（字串內的 A1c 不算）；解析失敗時退回正規式
function scriptRefs(n) {
  const out = [];
  if (n.formula) {
    const r = lintFormula(n.formula, {}, { context: n.datatype === 'label' ? 'formula' : 'macro' });
    (r.info ? r.refs : formulaRefs(n.formula)).forEach(id => out.push(['formula', id]));
  }
  if (n.actionScript && n.datatype === 'action') {
    const r = lintMacro(n.actionScript, {});
    const refs = r.steps.length ? r.refs : formulaRefs(n.actionScript);
    refs.forEach(id => out.push(['actionScript', id]));
    r.targets.forEach(id => out.push(['target', id]));
  } else if (n.actionScript && n.datatype === 'action2') {
    const r = lintFormula(n.actionScript, {}, { context: 'macro' });
    (r.info ? r.refs : formulaRefs(n.actionScript)).forEach(id => out.push(['actionScript', id]));
  }
  return out;
}
export function referencesOf(n) {
  const refs = [];
  const add = (kind, id) => { if (id !== undefined && id !== null && String(id).trim() !== '' && String(id).trim() !== '0') refs.push({ kind, id: String(id).trim() }); };
  for (const o of Array.isArray(n.option) ? n.option : []) {
    if (o && typeof o === 'object' && o.further !== undefined) String(o.further).split(',').forEach(f => add('further', f));
  }
  add('reference', n.reference);
  if (n.datatype === 'action' || n.datatype === 'action2') add('actionID', n.actionID);
  add('furActionID', n.furActionID);
  for (const [kind, id] of scriptRefs(n)) add(kind, id);
  // 同一種參照重複出現只算一次
  const seen = new Set();
  return refs.filter(r => { const k = r.kind + ':' + r.id; if (seen.has(k)) return false; seen.add(k); return true; });
}

// 誰參照了 itemid
export function refsTo(draft, itemid) {
  const out = [];
  walk(draft, n => {
    if (!isControl(n)) return;
    for (const r of referencesOf(n)) if (r.id === String(itemid)) out.push({ from: n.itemid, kind: r.kind });
  });
  return out;
}

// 可在其中新增控制項的清單。
//   文字區塊 form：整個區塊；固定表格：cell {row, col}；頁籤／動態表格：cell {index}。
// 回傳 { items, type, where, tail }：tail=true 表示這個串流「結尾不留換行」（編輯器的 Quill／舊版格子都是如此），
// 新增時要在前面補換行；本工具新建的 form 區塊則是結尾換行、輸出時再去掉。
// 找不到或不支援時回傳 { error }。
export function editableItems(a, cell) {
  if (!a.imported && !a.structured) return { items: a.items, type: 'form', where: `區塊 #${a.itemid}`, tail: false };
  const node = a.area;
  const t = node.itemtype;
  const aid = `區塊 #${node.itemid}`;
  if (t === 'form') return { items: node.item, type: t, where: aid, tail: true };
  if (t === 'formtable') {
    if (!cell || cell.row === undefined || cell.col === undefined) return { error: `${aid} 是固定表格，請指定 cell: {row, col}（從 0 起算；共 ${node.item.length} 列，各列欄數 ${node.item.map(r => r.item.length).join('/')}）` };
    const r = node.item[cell.row];
    const c = r && r.item[cell.col];
    if (!c) return { error: `${aid} 沒有第 ${cell.row} 列第 ${cell.col} 欄（共 ${node.item.length} 列，各列欄數 ${node.item.map(x => x.item.length).join('/')}）` };
    return { items: c.item, type: t, where: `${aid} 第 ${cell.row} 列第 ${cell.col} 欄`, tail: true };
  }
  if (['tab1', 'tab2', 'table1', 'table2'].includes(t)) {
    const titles = node.item.map((x, i) => `${i}:${x.datatitle || '（無標題）'}`).join('、');
    if (!cell || cell.index === undefined) return { error: `${aid} 是${t === 'tab1' || t === 'tab2' ? '頁籤' : '動態表格'}，請指定 cell: {index}（${titles}）` };
    const c = node.item[cell.index];
    if (!c) return { error: `${aid} 沒有第 ${cell.index} 格（${titles}）` };
    return { items: c.item, type: t, where: `${aid}「${c.datatitle || cell.index}」`, tail: true };
  }
  return { error: `${aid}（${t}）不支援新增控制項：圖形、雙欄等區塊的結構由編輯器決定，請匯入後在編輯器調整` };
}
