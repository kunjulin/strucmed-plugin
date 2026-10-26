// 字典說明（倉儲 Struct_DictionaryUpload.DicComment）的 JSON v1 容器：說明 desc、體系標記 sys、補述 memo、FHIR 對應 fhir、alias_of。
// 體系標記 sys { code, by, at }：體系管理者在字典頁升級時寫入（倉儲不允許同 id 改 dicType，所以 id 與 dicType 都不變）；
//   帶標記且 code＝登入者體系代碼（deptNo 第 2–3 碼）的字典，層級視為 sys（體系）。舊的 promote 申請紀錄只讀取保留，不再產生。
// 與平台 `V2/DictComment.cs` 使用同一份規格（docs/14）：
//   - 壓縮存放、鍵順序固定（v、desc 永遠在最前面，舊畫面看到原文仍可讀）；空的段落省略
//   - 舊純文字字典：整段視為 desc；第一次寫 sys／memo／fhir／alias 才轉成 JSON
//   - 整段 ≤ MAX_CHARS（正式倉儲實測中文 1800 字完整保留）；desc ≤ 300 字且不可含換行
//   - 只允許倉儲（Oracle Big5／CP950）存得下的字元（cp950.mjs，與平台 DictComment.IsStorable 同一份）
//   - memo 只允許固定鍵；fhir 逐筆檢查 res／path／code system 白名單；datatype 與 FHIR 型別不一致只警告
// 本模組不連線、不碰倉儲；只做解析、組裝與檢查，供 dictionary.mjs、tools.mjs、export.mjs 與 online 工具共用。
import crypto from 'node:crypto';
import { E, fail } from './errors.mjs';
import { firstUnstorable } from './cp950.mjs';

export const MAX_CHARS = 1800;                 // 平台 V2:DictionaryCommentMax 預設值；正式倉儲實測中文 1800 字完整保留
export const DESC_MAX = 300;
export const MEMO_KEYS = ['meaning', 'type', 'unit', 'range', 'asr', 'calx', 'llm', 'scope'];
export const FHIR_KEYS = ['res', 'path', 'code', 'display', 'ucum', 'component', 'note'];
export const FHIR_SYSTEMS = ['http://loinc.org', 'http://snomed.info/sct', 'http://hl7.org/fhir/sid/icd-10-cm', 'http://hl7.org/fhir/sid/icd-10', 'http://unitsofmeasure.org'];
export const FHIR_SYSTEM_PREFIXES = ['http://cgmh.org.tw/fhir/CodeSystem/'];   // 院內 CodeSystem（平台 V2:FhirCodeSystemPrefixes）
export const PROMOTE_STATUS = ['pending', 'done', 'rejected', 'alias'];
export const FHIR_MAX = 10;
const RES_RE = /^[A-Z][A-Za-z0-9]{1,63}$/;
const PATH_RE = /^[A-Za-z0-9.\[\]():'=_,-]+$/;
const CODE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const JSON_HEAD = /^\s*\{"v":/;

// datatype → 建議的 FHIR 值型別（不一致只警告 W_FHIR_TYPE_MISMATCH）
export const TYPE_HINT = {
  numberbox: ['valueQuantity'],
  radiobutton: ['valueCodeableConcept'], selection: ['valueCodeableConcept'], combobox: ['valueCodeableConcept'], submenu: ['valueCodeableConcept'],
  checkbox: ['valueBoolean', 'valueCodeableConcept'],
  calendar: ['valueDateTime'],
  textbox: ['valueString'], textarea: ['valueString']
};

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const s = v => (v === undefined || v === null ? '' : String(v));

export function isJson(raw) {
  if (!JSON_HEAD.test(s(raw))) return false;
  try { const j = JSON.parse(s(raw)); return isObj(j) && j.v === 1; } catch { return false; }
}

// 解析成固定形狀；不是 JSON 時整段為 desc（isJson:false）。壞掉的 JSON（例如 CSV 斷欄）也回 isJson:false 並附 broken:true。
export function parse(raw) {
  const text = s(raw);
  const out = { isJson: false, broken: false, desc: text.trim(), sys: null, memo: null, fhir: [], memo_by: '', memo_at: '', promote: null, alias_of: '' };
  if (!JSON_HEAD.test(text)) return out;
  let j;
  try { j = JSON.parse(text); } catch { out.broken = true; return out; }
  if (!isObj(j) || j.v !== 1) return out;   // 合法 JSON 但不是 v1（v:2、"1"…）：與平台相同當舊純文字；不是 CSV 斷欄，不標 broken
  out.isJson = true;
  out.desc = s(j.desc).trim();
  out.sys = pickSys(j.sys);
  out.memo = isObj(j.memo) && Object.keys(j.memo).length ? pickMemo(j.memo) : null;
  out.fhir = Array.isArray(j.fhir) ? j.fhir.filter(isObj).map(pickFhir) : [];
  out.memo_by = s(j.memo_by); out.memo_at = s(j.memo_at);
  out.promote = isObj(j.promote) && j.promote.status ? { to: s(j.promote.to), by: s(j.promote.by), reason: s(j.promote.reason), at: s(j.promote.at), status: s(j.promote.status) } : null;
  out.alias_of = s(j.alias_of);
  return out;
}
const pickMemo = m => Object.fromEntries(MEMO_KEYS.filter(k => m[k] !== undefined && m[k] !== null && m[k] !== '' && !(Array.isArray(m[k]) && !m[k].length))
  .map(k => [k, k === 'asr' ? (Array.isArray(m[k]) ? m[k].map(s) : [s(m[k])]) : s(m[k])]));
const pickFhir = f => Object.fromEntries(FHIR_KEYS.filter(k => f[k] !== undefined && f[k] !== null && f[k] !== '').map(k => [k, s(f[k])]));
// 體系標記：code 必須是 2 碼英數，否則當作沒有標記（與平台 DictComment.NormalizeSys 相同）
export const SYS_KEYS = ['code', 'by', 'at'];
export function pickSys(x) {
  if (!isObj(x) || !/^[A-Za-z0-9]{2}$/.test(s(x.code))) return null;
  return Object.fromEntries(SYS_KEYS.filter(k => s(x[k])).map(k => [k, s(x[k])]));
}

// 組成正規化字串。只有 desc 且原本不是 JSON（或 forceJson 為 false）時維持純文字。
//   parts：{ desc, sys, memo, fhir, memo_by, memo_at, promote, alias_of }；會先驗證 memo 與 fhir。鍵順序 v→desc→sys→memo→fhir→memo_by→memo_at→promote→alias_of（與平台相同）。
export function build(parts = {}, { forceJson = false } = {}) {
  const desc = checkDesc(parts.desc);
  const memo = parts.memo ? validateMemo(parts.memo) : null;
  const fhir = parts.fhir && parts.fhir.length ? validateFhir(parts.fhir, memo && memo.type).fhir : [];
  const promote = parts.promote ? checkPromote(parts.promote) : null;
  const sys = parts.sys ? pickSys(parts.sys) : null;
  const alias = s(parts.alias_of).trim();
  if (alias.length > 64) fail(E.INVALID_INPUT, 'alias_of 超過 64 字');
  const hasExtra = !!(sys || memo || fhir.length || promote || alias || s(parts.memo_by) || s(parts.memo_at));
  if (!hasExtra && !forceJson) { checkLength(desc); return desc; }
  const j = { v: 1, desc };
  if (sys) j.sys = sys;
  if (memo) j.memo = memo;
  if (fhir.length) j.fhir = fhir;
  if (s(parts.memo_by)) j.memo_by = s(parts.memo_by);
  if (s(parts.memo_at)) j.memo_at = s(parts.memo_at);
  if (promote) j.promote = promote;
  if (alias) j.alias_of = alias;
  const text = JSON.stringify(j);
  checkLength(text);
  return text;
}

// 倉儲（Oracle）是 Big5／CP950 字集。正式倉儲實測（2026-10-26）：emoji 被存成「？」；上標「²」除了被換掉還吃掉後面的字元，整段 JSON 損毀。
// 與平台 DictComment.CheckStorable 相同：只允許 ASCII 與 CP950 存得下的字（cp950.mjs），其他一律拒絕並指出字元、碼位與位置。
export function checkStorable(text, what = '字典說明') {
  const bad = firstUnstorable(s(text));
  if (bad) fail(E.INVALID_INPUT, `${what}含有倉儲（Big5／CP950）無法保存的字元「${bad.char}」（${bad.code}，第 ${bad.index + 1} 字）；會被換掉並可能弄壞整段內容。請改用文字，例如「²」寫成「^2」或「平方」，emoji 請刪除`,
    { char: bad.char, code: bad.code, index: bad.index });
  return text;
}

export function checkLength(text) {
  checkStorable(text);
  const n = [...s(text)].length;
  if (n > MAX_CHARS) fail(E.LIMIT, `字典說明過長（${n}／${MAX_CHARS} 字）：請精簡 memo 或 fhir`);
  return n;
}
function checkDesc(desc) {
  const d = s(desc).trim();
  if (/[\r\n]/.test(d)) fail(E.INVALID_INPUT, 'desc 不可含換行（一行語意）');
  if ([...d].length > DESC_MAX) fail(E.INVALID_INPUT, `desc 超過 ${DESC_MAX} 字`);
  return d;
}
function checkPromote(p) {
  if (!isObj(p)) fail(E.INVALID_INPUT, 'promote 必須是物件');
  const status = s(p.status);
  if (!PROMOTE_STATUS.includes(status)) fail(E.INVALID_INPUT, `promote.status 必須是 ${PROMOTE_STATUS.join('／')}`);
  if ([...s(p.reason)].length > 200) fail(E.INVALID_INPUT, 'promote.reason 超過 200 字');
  return { to: s(p.to), by: s(p.by), reason: s(p.reason), at: s(p.at), status };
}

// memo：只允許固定鍵、字串 ≤ 300 字；asr 字串陣列 ≤ 20 項、每項 ≤ 40 字。回正規化後的物件（空值鍵移除）。
export function validateMemo(memo) {
  if (!isObj(memo)) fail(E.INVALID_INPUT, 'memo 必須是物件');
  const unknown = Object.keys(memo).filter(k => !MEMO_KEYS.includes(k));
  if (unknown.length) fail(E.INVALID_INPUT, `memo 有未知欄位：${unknown.join('、')}（只允許 ${MEMO_KEYS.join('、')}）`);
  const out = {};
  for (const k of MEMO_KEYS) {
    const v = memo[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'asr') {
      const arr = Array.isArray(v) ? v : [v];
      if (arr.length > 20) fail(E.INVALID_INPUT, 'memo.asr 最多 20 項');
      const items = arr.map(x => s(x).trim()).filter(Boolean);
      if (items.some(x => [...x].length > 40)) fail(E.INVALID_INPUT, 'memo.asr 每項最多 40 字');
      if (items.length) out.asr = items;
      continue;
    }
    if (typeof v !== 'string' && typeof v !== 'number') fail(E.INVALID_INPUT, `memo.${k} 必須是字串`);
    const t = s(v).trim();
    if ([...t].length > 300) fail(E.INVALID_INPUT, `memo.${k} 超過 300 字`);
    if (t) out[k] = t;
  }
  return out;
}

export function systemAllowed(system) {
  return FHIR_SYSTEMS.includes(system) || FHIR_SYSTEM_PREFIXES.some(p => system.startsWith(p));
}

// fhir：逐筆檢查；不符 → E_INVALID_FHIR。memoType（memo.type）給了才做型別一致性警告。回 { fhir, warnings }。
export function validateFhir(fhir, memoType) {
  if (!Array.isArray(fhir)) fail(E.INVALID_FHIR, 'fhir 必須是陣列');
  if (fhir.length > FHIR_MAX) fail(E.INVALID_FHIR, `fhir 最多 ${FHIR_MAX} 筆`);
  const out = [], warnings = [];
  fhir.forEach((f, i) => {
    const at = `fhir[${i}]`;
    if (!isObj(f)) fail(E.INVALID_FHIR, `${at} 必須是物件`);
    const unknown = Object.keys(f).filter(k => !FHIR_KEYS.includes(k));
    if (unknown.length) fail(E.INVALID_FHIR, `${at} 有未知欄位：${unknown.join('、')}`);
    const res = s(f.res).trim(), path = s(f.path).trim();
    if (!RES_RE.test(res)) fail(E.INVALID_FHIR, `${at}.res「${res}」不是合法的 resource 名稱（大寫開頭英數）`);
    if (!PATH_RE.test(path)) fail(E.INVALID_FHIR, `${at}.path 只允許英數字、. [ ] ( ) : ' = _ , -`);
    if (path !== res && !path.startsWith(res + '.')) fail(E.INVALID_FHIR, `${at}.path「${path}」必須以 res「${res}」開頭`);
    const e = { res, path };
    if (s(f.code).trim()) {
      const code = s(f.code).trim();
      const bar = code.indexOf('|');
      if (bar <= 0) fail(E.INVALID_FHIR, `${at}.code 必須是 system|code`);
      const system = code.slice(0, bar), c = code.slice(bar + 1);
      if (!systemAllowed(system)) fail(E.INVALID_FHIR, `${at}.code 的 system「${system}」不在白名單（${FHIR_SYSTEMS.join('、')}，或院內 CodeSystem 前綴）`);
      if (!CODE_RE.test(c)) fail(E.INVALID_FHIR, `${at}.code 的代碼「${c}」格式不正確`);
      e.code = code;
    }
    for (const [k, max] of [['display', 200], ['component', 200], ['note', 200], ['ucum', 40]]) {
      const v = s(f[k]).trim();
      if ([...v].length > max) fail(E.INVALID_FHIR, `${at}.${k} 超過 ${max} 字`);
      if (v) e[k] = v;
    }
    const w = typeMismatch(memoType, path);
    if (w) warnings.push(`W_FHIR_TYPE_MISMATCH：${at} ${w}`);
    out.push(e);
  });
  return { fhir: out, warnings };
}

export function typeMismatch(memoType, path) {
  const hints = TYPE_HINT[s(memoType).trim()];
  if (!hints) return null;
  return hints.some(h => s(path).includes(h)) ? null : `memo.type=${memoType} 建議對應 ${hints.join(' 或 ')}，但 path 是「${path}」`;
}

// etag＝DicComment 原始字串（UTF-8）的 sha256 小寫十六進位（與平台相同）；平台回應沒有 etag 時才用它推算
export function etag(raw) {
  return crypto.createHash('sha256').update(s(raw), 'utf8').digest('hex');
}

// 層級（相對於登入者科部，例 33F00）：own 本科／sub 次專（前 4 碼）／dpt 科部（前 3 碼）／sys 體系（第 2–3 碼，或帶體系標記且 code＝登入者體系代碼）／system 全院／other
// 綁定與排序順序（docs/14 C.1）：體系 → 本科 → 次專 → 科部 → 全院 → 其他
export const LEVELS = ['sys', 'own', 'sub', 'dpt', 'system', 'other'];
export const LEVEL_LABEL = { system: '全院', sys: '體系', dpt: '科部', sub: '次專', own: '本科', other: '其他' };
export function level(dicType, deptNo, sysCode = '') {
  const t = s(dicType), d = s(deptNo), c = s(sysCode);
  if (t.toLowerCase() === 'system') return 'system';
  if (c.length === 2 && d.length >= 3 && c.toLowerCase() === d.substr(1, 2).toLowerCase()) return 'sys';
  if (!d) return 'other';
  if (t === d) return 'own';
  if (d.length >= 4 && t === d.slice(0, 4)) return 'sub';
  if (d.length >= 3 && t === d.slice(0, 3)) return 'dpt';
  if (d.length >= 3 && t === d.substr(1, 2)) return 'sys';
  return 'other';
}
export const levelRank = lv => { const i = LEVELS.indexOf(lv); return i < 0 ? LEVELS.length : i; };

// api/v2/dictionaries 的 item（新舊伺服器都可）→ 本機索引的 entry
export function fromItem(d, deptNo) {
  const raw = s(d.dicComment);
  const p = parse(raw);
  const dicType = s(d.dicType);
  return {
    id: s(d.id), dicType, dicName: s(d.dicName), dicComment: raw, createUser: s(d.createUser), createDate: s(d.createDate),
    desc: d.desc !== undefined && d.desc !== null ? s(d.desc) : p.desc,
    memo: isObj(d.memo) ? pickMemo(d.memo) : p.memo,
    fhir: Array.isArray(d.fhir) ? d.fhir.filter(isObj).map(pickFhir) : p.fhir,
    sys: d.sys !== undefined ? pickSys(d.sys) : p.sys,
    promote: isObj(d.promote) && d.promote.status ? d.promote : p.promote,
    alias_of: d.aliasOf !== undefined && d.aliasOf !== null ? s(d.aliasOf) : p.alias_of,
    etag: s(d.etag) || etag(raw),
    level: s(d.level) || level(dicType, deptNo, (d.sys !== undefined ? pickSys(d.sys) : p.sys || {})?.code || '')
  };
}

// 本機索引的舊 entry（只有 dicComment）→ 補上 desc／memo／level（讀取相容）
export function enrich(e, deptNo) {
  if (!e) return e;
  if (e.desc !== undefined && e.level !== undefined) return e;
  return fromItem({ ...e, aliasOf: e.alias_of }, deptNo);
}

// 給 plan／計畫表看的摘要
export function summary(parsed) {
  const p = parsed && parsed.desc !== undefined ? parsed : parse(parsed);
  return {
    desc: p.desc, sys: p.sys || null, memo: p.memo || null, fhir: p.fhir || [],
    memo_by: p.memo_by || '', memo_at: p.memo_at || '', promote: p.promote || null, alias_of: p.alias_of || '', is_json: !!p.isJson
  };
}

// memo 的補充合併：保留既有內容，只覆寫有給的鍵；值為 "" 或 null 表示清除該鍵
export function mergeMemo(current, patch) {
  const base = { ...(isObj(current) ? current : {}) };
  for (const [k, v] of Object.entries(isObj(patch) ? patch : {})) {
    if (v === '' || v === null || (Array.isArray(v) && !v.length)) delete base[k];
    else base[k] = v;
  }
  return Object.keys(base).length ? validateMemo(base) : null;
}
