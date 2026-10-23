// Dictionary index built from the CSV the user exports on the StrucMed 字典 page.
// Two export shapes exist (平台 web/js/dictionary.js):
//   Export 選單  : "id","dicType","dictName","dicComment","createUser","createDate"  (979-1006)
//                  rows are the API object's values in object order, quotes NOT escaped
//   批次匯出所選 : name,type,info,creator,createDate — no id (535-552) → cannot bind by id
import { E, fail } from './errors.mjs';

// Lenient CSV: handles quoted fields and CRLF; a stray quote inside a quoted
// field (unescaped by the editor) is kept when not followed by , or EOL.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else if (text[i + 1] === ',' || text[i + 1] === '\r' || text[i + 1] === '\n' || i + 1 === text.length) q = false;
        else field += '"';
      } else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(v => v !== '')) rows.push(row); }
  return rows;
}

export function buildIndex(csvText, deptNo, source) {
  const rows = parseCsv(csvText);
  if (rows.length < 1) fail(E.INVALID_INPUT, 'CSV 是空的');
  const head = rows[0].map(h => h.trim());
  const warnings = [];
  let map;
  if (head.includes('id') && (head.includes('dictName') || head.includes('dicName'))) {
    map = { id: head.indexOf('id'), dicType: head.indexOf('dicType'), dicName: head.indexOf(head.includes('dictName') ? 'dictName' : 'dicName'),
      dicComment: head.indexOf('dicComment'), createUser: head.indexOf('createUser'), createDate: head.indexOf('createDate') };
  } else if (head.includes('name') && head.includes('type')) {
    map = { id: -1, dicType: head.indexOf('type'), dicName: head.indexOf('name'), dicComment: head.indexOf('info'),
      createUser: head.indexOf('creator'), createDate: head.indexOf('createDate') };
    warnings.push('這是「批次匯出所選」格式，沒有字典 id：只能依名稱比對，無法綁定既有 dicid。請改用字典頁選單的 Export。');
  } else {
    fail(E.INVALID_INPUT, `無法辨識的 CSV 表頭：${head.join(',')}`);
  }
  const entries = [];
  let deleted = 0, malformed = 0;
  for (const r of rows.slice(1)) {
    if (r.length !== head.length) malformed++;
    const get = k => (map[k] >= 0 ? (r[map[k]] ?? '').trim() : '');
    const e = { id: get('id'), dicType: get('dicType'), dicName: get('dicName'), dicComment: get('dicComment'),
      createUser: get('createUser'), createDate: get('createDate') };
    if (!e.dicName) { malformed++; continue; }
    if (e.dicName.startsWith('__')) { deleted++; continue; }        // soft-deleted (01 §3.4)
    entries.push(e);
  }
  if (malformed) warnings.push(`${malformed} 列欄位數與表頭不符（編輯器匯出未跳脫引號或逗號），已盡量解析，請抽查。`);
  const byName = {};
  for (const e of entries) (byName[e.dicName] ||= []).push(e);
  const duplicates = Object.entries(byName).filter(([, v]) => v.length > 1).map(([name, v]) => ({ name, ids: v.map(x => x.id) }));
  return {
    loadedAt: new Date().toISOString(), source, deptNo, hasIds: map.id >= 0,
    entries, deleted, warnings, duplicates
  };
}

// Same dicType rule the editor uses when binding by name (平台 web/js/scripts.js:4387-4393)
export function deptTypes(deptNo) {
  const d = String(deptNo || '');
  return [d, d.substr(0, 4), d.substr(0, 3), d.substr(1, 2)].filter(Boolean);
}

export function search(idx, query, deptNo, match = 'fuzzy') {
  if (!idx) return [];
  const q = String(query || '').toLowerCase();
  const types = deptTypes(deptNo || idx.deptNo);
  const hit = e => {
    const n = e.dicName.toLowerCase();
    if (match === 'exact') return n === q;
    if (match === 'prefix') return n.startsWith(q);
    return n.includes(q) || e.dicComment.toLowerCase().includes(q);
  };
  return idx.entries.filter(hit)
    .map(e => ({ ...e, deptMatch: types.includes(e.dicType) }))
    .sort((a, b) => Number(b.deptMatch) - Number(a.deptMatch) || a.dicName.localeCompare(b.dicName));
}

// Resolve a control's dictionary reference.
//   {id}   → must exist in index (editor would otherwise keep a bogus id; 04 結論 2)
//   {name} → exact name within dept-matching types; unique → bind id; none → pending new
export function resolve(idx, ref, deptNo) {
  if (!ref || (!ref.id && !ref.name)) return { kind: 'none' };
  if (ref.id) {
    if (!idx) fail(E.DICT_UNKNOWN_ID, `指定了 dicid「${ref.id}」，但尚未載入字典 CSV，無法驗證。請先 dictionary_load。`);
    const e = idx.entries.find(x => x.id === ref.id);
    if (!e) fail(E.DICT_UNKNOWN_ID, `dicid「${ref.id}」不在已載入的字典 CSV 中（編輯器不會驗證，會原樣存成無效綁定）。`);
    return { kind: 'bound', entry: e };
  }
  const types = deptTypes(deptNo);
  const all = idx ? idx.entries.filter(x => x.dicName === ref.name) : [];
  const inDept = all.filter(x => types.includes(x.dicType));
  if (inDept.length > 1) {
    fail(E.DICT_AMBIGUOUS, `字典名稱「${ref.name}」在本科部比對範圍內有 ${inDept.length} 筆；編輯器只會綁第一筆。請改用 id 指定。`,
      { candidates: inDept.map(x => ({ id: x.id, dicType: x.dicType, dicComment: x.dicComment })) });
  }
  if (inDept.length === 1) {
    if (!inDept[0].id) return { kind: 'pending', note: '字典 CSV 無 id 欄位，只能在匯入時依名稱綁定（角色會變成 tohis）' };
    return { kind: 'bound', entry: inDept[0] };
  }
  return { kind: 'pending', otherTypes: all.map(x => x.dicType) };
}
