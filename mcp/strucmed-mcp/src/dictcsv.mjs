// 字典 CSV（docs/15 §3.5、§3.6、§4）：G2 前讓使用者在 Excel 一次看完、補完 draft 用到的字典。
// 讀 CSV 用 dictionary.mjs 的 parseCsv（有 BOM、無 BOM、CRLF、LF 都接受）。
import { E, fail } from './errors.mjs';
import { parseCsv } from './dictionary.mjs';
import * as dc from './dictcomment.mjs';

const FHIR_COLS = ['res', 'path', 'code', 'display', 'ucum'];
export const COLUMNS = ['action', 'id', 'dicType', 'dicName', 'level', 'role', 'used_by', 'desc', ...dc.MEMO_KEYS,
  ...FHIR_COLS.map(k => 'fhir_' + k), 'fhir_more', 'fhir_status', 'memo_by', 'candidates', 'note'];
const REQUIRED = ['action', 'dicName'];
// 表頭寫明 asr 的分隔符（F-05）；讀回時去掉結尾的全形括號註解，舊 CSV 的 asr 也認得
const HEADER = { asr: 'asr（多值以／分隔）' };
const headerName = h => h.trim().replace(/（[^）]*）$/, '');

// Excel 開 CSV 時會把 = + - @ 開頭當公式、1-3 當日期，存回去內容就換了（補述常有「=體重/身高^2」「1-12」）。
// 這些值前面加一個 '：Excel 原樣顯示與存回，import 再拿掉；本來就以 ' 開頭的值也加，才能往返
const needsGuard = v => /^['=+\-@]/.test(v) || /^\d{1,4}[-/]\d{1,2}([-/]\d{1,4})?$/.test(v);
const guard = v => (needsGuard(v) ? `'${v}` : v);
const unguard = v => (v[0] === "'" && needsGuard(v.slice(1)) ? v.slice(1) : v);
const quote = v => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(rows) {
  const line = cells => cells.map(c => quote(guard(String(c ?? '')))).join(',');
  return '﻿' + [line(COLUMNS.map(k => HEADER[k] || k)), ...rows.map(r => line(COLUMNS.map(k => r[k])))].join('\r\n') + '\r\n';
}

// CSV 文字 → [{ row（試算表列號，表頭＝1）, <欄名>: 值 }]；缺必要欄回 E_INVALID_INPUT
export function parsePlan(text) {
  const [head, ...body] = parseCsv(String(text));
  const names = (head || []).map(headerName);
  const missing = REQUIRED.filter(k => !names.includes(k));
  if (missing.length) fail(E.INVALID_INPUT, `CSV 表頭缺少必要欄：${missing.join('、')}`, { missing });
  return body.map((cells, i) => {
    const r = { row: i + 2 };
    COLUMNS.forEach(k => { const at = names.indexOf(k); r[k] = at < 0 ? '' : unguard(String(cells[at] ?? '')); });
    return r;
  });
}

// asr 多值：匯出用／；AI 或使用者常寫 ; , |（含全形），一律當分隔符，統一成／（F-05）。
// → { cell, used: 用到的其他分隔符, count, unsplit: 只有一筆但含「、」（可能是沒拆開的多值；/ 常見於單位，不算） }
const ASR_SPLIT = /[／;；,，|｜]/;
export function normalizeAsr(cell) {
  const text = String(cell ?? '');
  const parts = text.split(ASR_SPLIT).map(x => x.trim()).filter(Boolean);
  const used = [...new Set(text.match(/[;；,，|｜]/g) || [])];
  return { cell: parts.join('／'), used, count: parts.length, unsplit: parts.length === 1 && parts[0].includes('、') };
}

const memoCells = memo => Object.fromEntries(dc.MEMO_KEYS.map(k => [k, memo && memo[k] !== undefined ? [].concat(memo[k]).join(k === 'asr' ? '／' : '') : '']));
const fhirCells = fhir => {
  const [first, ...more] = fhir || [];
  return { ...Object.fromEntries(FHIR_COLS.map(k => ['fhir_' + k, (first && first[k]) || ''])), fhir_more: more.length ? JSON.stringify(more) : '' };
};

// draft 的字典清單（一本一列）：fields 是 fieldMap 的結果；ask(field) 回待新建字典的候選（dictionary_suggest 前 3 名）
export function planRows(d, idx, fields, ask) {
  const entries = (idx && idx.entries) || [];
  const rows = new Map();
  for (const f of fields) {
    const x = f.dictionary;
    if (!x) continue;
    const key = x.id ? `id:${x.id}` : `new:${x.name}`;
    if (!rows.has(key)) {
      rows.set(key, { action: x.pending ? 'new' : 'bind', id: x.id, dicType: x.pending ? d.meta.dept_no : (entries.find(e => e.id === x.id) || {}).dicType || '', dicName: x.name, level: x.level,
        desc: x.desc, ...memoCells(x.memo), ...fhirCells(x.fhir), fhir_status: x.pending ? '待人工確認' : '沿用既有', memo_by: x.memo_by || '',
        candidates: x.pending && ask ? ask(f) : '', note: '', pending: !!x.pending, unknown: !!x.unknown, memo: x.memo, fhir: x.fhir, roles: new Set(), used: [], itemids: [] });
    }
    const r = rows.get(key);
    r.roles.add(f.dicrole); r.used.push(`${f.itemid}:${f.caption}`); r.itemids.push(f.itemid);
  }
  // dictionary_create 規劃了、還沒有欄位用到的字典也要列
  for (const p of d.pendingDictionaries || []) {
    if (!rows.has(`new:${p.name}`)) rows.set(`new:${p.name}`, { action: 'new', id: '', dicType: d.meta.dept_no, dicName: p.name, level: '', desc: p.comment || '', ...memoCells(p.memo), ...fhirCells(p.fhir),
      fhir_status: '待人工確認', memo_by: '', candidates: '', note: '', pending: true, memo: p.memo || null, fhir: p.fhir || [], roles: new Set(), used: [], itemids: [] });
  }
  return [...rows.values()].map(r => ({ ...r, role: [...r.roles].join(';'), used_by: r.used.join(';') }));
}

const lf = s => String(s ?? '').replace(/\r\n/g, '\n');
const normFhir = list => (list || []).map(f => Object.fromEntries(dc.FHIR_KEYS.filter(k => f[k]).map(k => [k, f[k]])));

// 只留有變的補述鍵；清空的鍵給 ''（mergeMemo 視為刪除）
function memoPatch(row, cur) {
  const before = memoCells(cur.memo), patch = {};
  for (const k of dc.MEMO_KEYS) {
    if (lf(row[k]) === lf(before[k])) continue;
    patch[k] = !row[k].trim() ? '' : k === 'asr' ? row[k].split('／').map(s => s.trim()).filter(Boolean) : row[k];
  }
  return patch;
}
// 欄位只放第一組的五個鍵，component、note 沿用目前內容，否則每次匯入都會洗掉
function rowFhir(row, cur) {
  let more = [];
  if (row.fhir_more.trim()) {
    try { more = JSON.parse(row.fhir_more); } catch (e) { fail(E.INVALID_FHIR, `fhir_more 不是合法的 JSON：${e.message}`); }
    if (!Array.isArray(more)) fail(E.INVALID_FHIR, 'fhir_more 必須是 JSON 陣列');
  }
  const cols = Object.fromEntries(FHIR_COLS.filter(k => row['fhir_' + k].trim()).map(k => [k, row['fhir_' + k].trim()]));
  const kept = (cur.fhir || [])[0] || {};
  const first = Object.keys(cols).length ? [{ ...cols, ...(kept.component && { component: kept.component }), ...(kept.note && { note: kept.note }) }] : [];
  return normFhir([...first, ...more]);
}

// 逐列套用；CSV 沒列到的字典不動。ops：check({ memo, fhir, dic_id, itemid }) 跑 dictionary_memo_check；rename(pending, 新名稱)；rebind(目前的列, 目標 id) 回 rebinds。note 欄由 skill 自己讀 CSV
export function importPlan(d, rows, current, ops) {
  const out = { applied: [], memo_items: [], rebinds: [], skipped: [], checks: [] };
  const byId = new Map(current.filter(c => c.id).map(c => [c.id, c]));
  const byName = new Map(current.filter(c => !c.id).map(c => [c.dicName, c]));
  // 待新建字典可以改名：名稱對不上時用唯讀的 used_by 找回原本那一列
  const locate = row => {
    if (row.id) {
      const hit = byId.get(row.id);
      if (!hit) fail(E.INVALID_INPUT, `id「${row.id}」不是這張表單綁定的字典：id 欄不可改，要換字典請用 action rebind:<id>`);
      return hit;
    }
    const first = /^(\d+):/.exec(row.used_by);
    const hit = byName.get(row.dicName) || (first && current.find(c => c.pending && c.itemids.includes(Number(first[1]))));
    if (!hit) fail(E.NOT_FOUND, `draft 沒有待新建字典「${row.dicName}」`);
    return hit;
  };
  const record = (cur, c, extra = []) => {
    out.checks.push({ name: cur.dicName, errors: c.errors.map(e => e.code), warnings: [...c.warnings.map(w => w.code), ...extra] });
    if (c.errors.length) fail(c.errors[0].code, c.errors.map(e => e.message).join('；'));
  };
  const applyPending = (row, cur) => {
    const p = d.pendingDictionaries.find(x => x.name === cur.dicName);
    if (!p) fail(E.NOT_FOUND, `draft 沒有待新建字典「${cur.dicName}」`);
    const patch = memoPatch(row, cur), fhir = rowFhir(row, cur), desc = row.desc.trim(), name = row.dicName.trim();
    const memo = dc.mergeMemo(p.memo, patch);
    const fhirChanged = JSON.stringify(fhir) !== JSON.stringify(normFhir(p.fhir));
    record(cur, ops.check({ memo: memo || {}, fhir, itemid: cur.itemids[0] }));
    dc.build({ desc, memo, fhir });
    const changed = [...(name !== cur.dicName ? ['dicName'] : []), ...(desc !== (p.comment || '') ? ['desc'] : []), ...Object.keys(patch), ...(fhirChanged ? ['fhir'] : [])];
    if (!changed.length) return;
    p.comment = desc;
    if (memo) p.memo = memo; else delete p.memo;
    if (fhir.length) p.fhir = fhir; else delete p.fhir;
    if (name !== cur.dicName) ops.rename(p, name);
    out.applied.push({ name, action: 'new', changed });
  };
  const applyExisting = (row, cur) => {
    const patch = memoPatch(row, cur), fhir = rowFhir(row, cur);
    const fhirChanged = JSON.stringify(fhir) !== JSON.stringify(normFhir(cur.fhir));
    const changed = [...Object.keys(patch), ...(fhirChanged ? ['fhir'] : [])];
    const extra = row.desc.trim() !== String(cur.desc || '').trim() ? ['W_DESC_READONLY'] : [];
    if (cur.unknown) {
      out.checks.push({ name: cur.dicName, errors: [], warnings: ['W_DICT_NOT_IN_INDEX', ...extra] });
      if (changed.length) fail(E.NOT_FOUND, `字典「${cur.dicName}」不在本機索引，無法檢查補述；請先 online_dictionary_search(update_index:true)`);
      return;
    }
    record(cur, ops.check({ memo: patch, ...(fhirChanged && { fhir }), dic_id: cur.id }), extra);
    if (!changed.length) return;
    out.memo_items.push({ dic_id: cur.id, ...(Object.keys(patch).length && { memo: patch }), ...(fhirChanged && { fhir }) });
    out.applied.push({ name: cur.dicName, action: 'memo', changed });
  };
  for (const row of rows) {
    const action = row.action.trim();
    if (action === 'skip') { out.skipped.push({ row: row.row, reason: 'action=skip（使用者略過）' }); continue; }
    try {
      const target = /^rebind:(.+)$/.exec(action);
      if (!target && !['bind', 'new', 'memo'].includes(action)) fail(E.INVALID_INPUT, `action「${action}」不認識（bind／new／memo／rebind:<id>／skip）`);
      const cur = locate(row);
      if (target) { out.rebinds.push(...ops.rebind(cur, target[1].trim())); continue; }
      if (action === 'new' && !cur.pending) fail(E.INVALID_INPUT, `「${cur.dicName}」是既有字典，不能用 action new`);
      if (action === 'memo' && cur.pending) fail(E.INVALID_INPUT, `「${cur.dicName}」是待新建字典，請用 action new`);
      if (cur.pending) applyPending(row, cur); else applyExisting(row, cur);
    } catch (e) {
      if (!e.code) throw e;
      out.skipped.push({ row: row.row, reason: `${e.code}：${e.message}` });
    }
  }
  return out;
}
