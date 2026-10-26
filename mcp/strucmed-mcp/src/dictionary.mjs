// Dictionary index：線上 online_dictionary_search（update_index）或字典頁 Export 的 CSV。
// Two export shapes exist (平台 web/js/dictionary.js):
//   Export 選單  : "id","dicType","dictName","dicComment","createUser","createDate"  (979-1006)
//                  rows are the API object's values in object order, quotes NOT escaped
//   批次匯出所選 : name,type,info,creator,createDate — no id (535-552) → cannot bind by id
// 每筆 entry 另有 desc／sys／memo／fhir／alias_of／etag／level（docs/14：dicComment 是 JSON 容器；舊純文字＝desc）。
import { E, fail } from './errors.mjs';
import * as dc from './dictcomment.mjs';

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
  let deleted = 0, malformed = 0, brokenJson = 0;
  for (const r of rows.slice(1)) {
    if (r.length !== head.length) malformed++;
    const get = k => (map[k] >= 0 ? (r[map[k]] ?? '').trim() : '');
    const e = dc.fromItem({ id: get('id'), dicType: get('dicType'), dicName: get('dicName'), dicComment: get('dicComment'),
      createUser: get('createUser'), createDate: get('createDate') }, deptNo);
    if (!e.dicName) { malformed++; continue; }
    if (e.dicName.startsWith('__')) { deleted++; continue; }        // soft-deleted (01 §3.4)
    if (dc.parse(e.dicComment).broken) brokenJson++;                 // 說明是 JSON 但被 CSV 的逗號斷欄（舊版匯出未跳脫）
    entries.push(e);
  }
  if (malformed) warnings.push(`${malformed} 列欄位數與表頭不符（編輯器匯出未跳脫引號或逗號），已盡量解析，請抽查。`);
  if (brokenJson) warnings.push(`W_DICT_CSV_JSON_BROKEN：${brokenJson} 筆字典的 JSON 說明在 CSV 中被逗號斷欄，memo／fhir 讀不到；請改用 online_dictionary_search(update_index:true) 取得完整索引。`);
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

// 索引 entry 補齊 desc／memo／sys／level（舊索引檔只有 dicComment）；層級依登入科部重算，帶體系標記的他科字典算體系
const withLevel = (e, deptNo) => {
  const x = dc.enrich(e, deptNo);
  const sysCode = (x.sys || dc.parse(e.dicComment).sys || {}).code || '';
  return deptNo && e.dicType !== undefined ? { ...x, sys: x.sys || dc.parse(e.dicComment).sys, level: dc.level(e.dicType, deptNo, sysCode) } : x;
};
// 本科部比對範圍：4 層 dicType，或帶體系標記且 code＝登入者體系代碼（升級時 id 與 dicType 不變）
const inScope = (e, deptNo) => deptTypes(deptNo).includes(e.dicType) || (!!deptNo && String(deptNo).length >= 3 && !!e.sys && String(e.sys.code || '').toLowerCase() === String(deptNo).substr(1, 2).toLowerCase());
const memoText = m => (m ? Object.values(m).map(v => (Array.isArray(v) ? v.join(' ') : String(v))).join(' ') : '');

// 搜尋：fuzzy 也比對 desc、memo（補述）與 FHIR display；排序依 dc.LEVELS（體系 → 本科 → 次專 → 科部 → 全院 → 其他），再依名稱
export function search(idx, query, deptNo, match = 'fuzzy') {
  if (!idx) return [];
  const q = String(query || '').toLowerCase();
  const dept = deptNo || idx.deptNo;
  const hit = e => {
    const n = e.dicName.toLowerCase();
    if (match === 'exact') return n === q;
    if (match === 'prefix') return n.startsWith(q);
    return n.includes(q) || String(e.desc || '').toLowerCase().includes(q) || memoText(e.memo).toLowerCase().includes(q)
      || (e.fhir || []).some(f => String(f.display || '').toLowerCase().includes(q));
  };
  return idx.entries.map(e => withLevel(e, dept)).filter(hit)
    .map(e => ({ ...e, deptMatch: inScope(e, dept) }))
    .sort((a, b) => Number(b.deptMatch) - Number(a.deptMatch) || dc.levelRank(a.level) - dc.levelRank(b.level) || a.dicName.localeCompare(b.dicName));
}

// 跟著 alias_of 綁到目標字典（最多 3 層；目標不在索引或已刪除時維持原字典並警告）
function followAlias(idx, entry, warnings) {
  let cur = entry;
  for (let i = 0; i < 3 && cur.alias_of; i++) {
    const t = idx.entries.find(x => x.id === cur.alias_of);
    if (!t) { warnings.push(`W_DICT_ALIAS_TARGET_MISSING：字典「${cur.dicName}」（${cur.id.slice(0, 8)}…）的 alias_of 指向 ${cur.alias_of.slice(0, 8)}…，但它不在索引中；維持綁定原字典`); return cur; }
    warnings.push(`W_DICT_ALIAS：字典「${cur.dicName}」（${cur.id.slice(0, 8)}…）已併入 ${t.dicName}（${t.id.slice(0, 8)}…，${dc.LEVEL_LABEL[dc.level(t.dicType, idx.deptNo)] || t.dicType}），改綁目標`);
    cur = t;
  }
  return cur;
}

// Resolve a control's dictionary reference.
//   {id}   → must exist in index (editor would otherwise keep a bogus id; 04 結論 2)；有 alias_of 就改綁目標
//   {name} → exact name within dept-matching types：
//            依層級分組（sys → own → sub → dpt），取最優先層級那一組；該組剛好一筆 → bind（多層同名時附 W_DICT_PREFER_SYSTEM）；
//            同一層級內多筆 → E_DICT_AMBIGUOUS；都沒有 → pending new
export function resolve(idx, ref, deptNo) {
  if (!ref || (!ref.id && !ref.name)) return { kind: 'none' };
  const warnings = [];
  if (ref.id) {
    if (!idx) fail(E.DICT_UNKNOWN_ID, `指定了 dicid「${ref.id}」，但尚未載入字典索引，無法驗證。請先 online_dictionary_search(update_index:true) 或 dictionary_load。`);
    const e = idx.entries.find(x => x.id === ref.id);
    if (!e) fail(E.DICT_UNKNOWN_ID, `dicid「${ref.id}」不在已載入的字典索引中（編輯器不會驗證，會原樣存成無效綁定）。`);
    return { kind: 'bound', entry: withLevel(followAlias(idx, withLevel(e, deptNo), warnings), deptNo), warnings };
  }
  const all = idx ? idx.entries.filter(x => x.dicName === ref.name).map(e => withLevel(e, deptNo)) : [];
  const inDept = all.filter(x => inScope(x, deptNo));
  if (inDept.length) {
    const best = Math.min(...inDept.map(x => dc.levelRank(x.level)));
    const top = inDept.filter(x => dc.levelRank(x.level) === best);
    if (top.length > 1) {
      fail(E.DICT_AMBIGUOUS, `字典名稱「${ref.name}」在${dc.LEVEL_LABEL[top[0].level] || '同一'}層級有 ${top.length} 筆；編輯器只會綁第一筆。請改用 id 指定。`,
        { candidates: top.map(x => ({ id: x.id, dicType: x.dicType, level: x.level, desc: x.desc, dicComment: x.dicComment })) });
    }
    const pick = top[0];
    if (!pick.id) return { kind: 'pending', note: '字典 CSV 無 id 欄位，只能在匯入時依名稱綁定（角色會變成 tohis）', warnings };
    if (inDept.length > 1) {
      const others = inDept.filter(x => x !== pick).map(x => `${dc.LEVEL_LABEL[x.level] || x.dicType} ${x.id.slice(0, 8)}…`).join('、');
      warnings.push(`W_DICT_PREFER_SYSTEM：「${ref.name}」有多個層級同名，優先綁${dc.LEVEL_LABEL[pick.level] || pick.dicType}字典 ${pick.id.slice(0, 8)}…（其他：${others}）`);
    }
    return { kind: 'bound', entry: withLevel(followAlias(idx, pick, warnings), deptNo), warnings };
  }
  return { kind: 'pending', otherTypes: all.map(x => x.dicType), warnings };
}
