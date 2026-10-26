// 表單內容的逐項比對（GetData() 陣列）：online_template_update 的 plan 用它列出「這次會寫入的變更」與「線上自來源後被改的地方」。
// 只比對內容，不比對編輯器或伺服器每次保存都會改寫的欄位：
//   控制項的 panelId／id（編輯器依 itemid 產生）、表單 JS 開頭的 // generated-by 標記、
//   iot 的 sheetid／templateID／modifiedUser／modifiedDept／modifiedDate／d_url（伺服器寫入時補回，TemplateWriteService.PrepareForm）
import crypto from 'node:crypto';

const CONTROL_VOLATILE = new Set(['panelId', 'id']);
const IOT_VOLATILE = new Set(['sheetid', 'templateID', 'modifiedUser', 'modifiedDept', 'modifiedDate', 'd_url']);
const NESTED = ['item', 'itemtemp', 'datavalue', 'items', 'columns'];

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
// 鍵排序後序列化：同樣內容不因鍵順序不同而算成差異
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const isControl = n => n && typeof n === 'object' && n.datatype && n.itemid !== undefined && n.datatype !== 'text' && n.datatype !== 'newline';

// 區塊的版面（說明文字、表格與頁籤結構、權限）：控制項換成 {itemid} 佔位，控制項本身另外比對
function layout(n, controls) {
  if (Array.isArray(n)) return n.map(x => layout(x, controls));
  if (!n || typeof n !== 'object') return n;
  if (isControl(n)) {
    const o = {};
    for (const [k, v] of Object.entries(n)) if (!CONTROL_VOLATILE.has(k)) o[k] = NESTED.includes(k) && Array.isArray(v) ? layout(v, controls) : v;
    const id = String(n.itemid);
    controls[id] = controls[id] ? sha(controls[id] + stable(o)) : sha(stable(o));   // 動態表格等同 itemid 多次出現：合併計算
    return { itemid: id };
  }
  const o = {};
  for (const [k, v] of Object.entries(n)) o[k] = NESTED.includes(k) && Array.isArray(v) ? layout(v, controls) : v;
  return o;
}

// form → { controls: {itemid: hash}, areas: {key: hash}, js, iot }
export function digestForm(form) {
  const controls = {}, areas = {};
  let js = '', iot = '';
  (Array.isArray(form) ? form : []).forEach((x, i) => {
    if (!x || typeof x !== 'object') return;
    if (x.itemtype === 'javascript') js = sha(String(x.content || '').replace(/^(\/\/ generated-by:[^\n]*\n?)+/, ''));
    else if (x.itemtype === 'iot') iot = sha(stable(Object.fromEntries(Object.entries(x).filter(([k]) => !IOT_VOLATILE.has(k)))));
    else areas[x.itemid !== undefined ? String(x.itemid) : `#${i}`] = sha(stable(layout(x, controls)));
  });
  return { controls, areas, js, iot };
}

// a → b 的差異；areas 包含新增或移除的區塊
export function diffDigest(a, b) {
  const keys = (x, y) => [...new Set([...Object.keys(x), ...Object.keys(y)])];
  const ac = a.controls || {}, bc = b.controls || {}, aa = a.areas || {}, ba = b.areas || {};
  const r = {
    added_itemids: Object.keys(bc).filter(k => !(k in ac)),
    removed_itemids: Object.keys(ac).filter(k => !(k in bc)),
    changed_itemids: Object.keys(bc).filter(k => k in ac && ac[k] !== bc[k]),
    changed_areas: keys(aa, ba).filter(k => aa[k] !== ba[k]),
    js_changed: (a.js || '') !== (b.js || ''),
    iot_changed: (a.iot || '') !== (b.iot || '')
  };
  r.empty = !r.added_itemids.length && !r.removed_itemids.length && !r.changed_itemids.length && !r.changed_areas.length && !r.js_changed && !r.iot_changed;
  return r;
}

// 給人看的一行摘要
export function describeDiff(r) {
  const p = [];
  if (r.added_itemids.length) p.push(`新增控制項 ${r.added_itemids.map(x => '#' + x).join('、')}`);
  if (r.removed_itemids.length) p.push(`移除控制項 ${r.removed_itemids.map(x => '#' + x).join('、')}`);
  if (r.changed_itemids.length) p.push(`修改控制項 ${r.changed_itemids.map(x => '#' + x).join('、')}`);
  if (r.changed_areas.length) p.push(`區塊版面或說明文字 ${r.changed_areas.map(x => '#' + x.replace(/^#/, '')).join('、')}`);
  if (r.js_changed) p.push('表單 JS');
  if (r.iot_changed) p.push('表單選項（iot）');
  return p.join('；');
}
