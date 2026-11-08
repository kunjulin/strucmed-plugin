// 嵌入頁面（embed 區塊、OPENPANEL 巨集）的網址組合與檢查規則。
// 來源：平台 web/js/embed-block.js（commit 26984f3，PLAN-STRUCFORM-1.10.9 §1.1～§1.3；契約 docs/EMBED-APP-GUIDE.md §4），
// 由 ES5 UMD 逐行移植成 ESM：規則、錯誤碼、訊息、檢查順序都與平台相同（編輯器存檔前、runtime 載入前用的是同一份）。
// 平台改了規則時這裡要一起改，並同步 test/embed.test.mjs 由平台 tests/web-js/embed-block.test.mjs 搬來的案例。
//   - 網址只接受 https，主機在院內範圍：*.cgmh.org.tw、*.cgmf.org.tw、*.cgmh.me、10/8、172.16/12、192.168/16、localhost
//     （只看網址的主機字串，不做 DNS 解析；IP 網段以解析後的數字判斷）
//   - params 的值只能是占位符 {chtno}、{deptNo}、{user}、{opdno} 或常數；不能帶身分證號、姓名
// 移植時沒有改的行為：coerceResultValue（runtime 收 strucmed.result 用）一併保留，plugin 不用但測試比對。

export const PLACEHOLDERS = { '{chtno}': 'chtno', '{deptNo}': 'deptNo', '{user}': 'user', '{opdno}': 'opdno' };
// 占位符的中文說明（預覽、審查、揭露用；平台編輯器的勾選項名稱）
export const PLACEHOLDER_LABELS = { '{chtno}': '病歷號', '{deptNo}': '科別', '{user}': '使用者', '{opdno}': '門診序號' };
const DOMAIN_SUFFIXES = ['cgmh.org.tw', 'cgmf.org.tw', 'cgmh.me'];
const LOCAL_HOSTS = { localhost: true, '127.0.0.1': true, '::1': true };
// 參數名稱看起來是身分證號或姓名就拒絕（小寫比對，去掉 _ - 空白）
const PII_KEYS_EXACT = ['pid', 'name', 'nm', 'ptname', 'ptnm'];
const PII_KEYS_CONTAIN = ['idno', 'personid', 'nationalid', 'idcard', 'identity', 'patname', 'patientname', 'chtname', 'usernm', 'username', 'fullname', '身分證', '身份證', '姓名'];
const TW_ID = /[A-Za-z][1289]\d{8}/;   // 身分證號／居留證號樣式
export const FILL_MIN = 300;
const PX_MIN = 100;
const PX_MAX = 4000;
export const DEFAULT_HEIGHT = 600;

export const MESSAGES = {
  E_EMBED_URL: '網址格式錯誤',
  E_EMBED_SCHEME: '嵌入頁面只接受 https 網址',
  E_EMBED_HOST: '主機不在院內範圍（*.cgmh.org.tw、*.cgmf.org.tw、*.cgmh.me、10.x、172.16～31.x、192.168.x、localhost）',
  E_EMBED_PII: '參數不可帶身分證號、姓名或未開放的占位符（只允許 {chtno}、{deptNo}、{user}、{opdno}）',
  E_EMBED_HEIGHT: '高度只能是 "fill" 或像素數字（' + PX_MIN + '～' + PX_MAX + '）',
  E_EMBED_FILL: '一張表單最多一個 height: "fill" 的嵌入頁面',
  E_EMBED_INPUT: 'inputs 的欄位必須存在且勾選「參與計算」',
  E_EMBED_OUTPUT_MISSING: 'outputs 的欄位不存在',
  E_EMBED_OUTPUT_EMBED: 'outputs 不能指向嵌入頁面區塊',
  E_EMBED_OUTPUT_GROUP: 'outputs 不能指向彈出片語（form）或群組控制項（subgroup）裡的欄位',
  E_EMBED_OUTPUT_DUP: '多個嵌入頁面的 outputs 不能寫同一個欄位',
  E_EMBED_MAP: 'inputs／outputs 的 key 只能是英數字、底線、減號，值是欄位 ID'
};
export const CODES = Object.keys(MESSAGES);

function err(code, detail) {
  return { code, message: MESSAGES[code] + (detail ? '：' + detail : '') };
}

function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [];
  for (let i = 1; i <= 4; i++) {
    if (m[i].length > 1 && m[i].charAt(0) === '0') return null;   // 不接受 010 這種八進位寫法
    const n = parseInt(m[i], 10);
    if (n > 255) return null;
    parts.push(n);
  }
  return parts;
}

// host：URL.hostname（小寫、IPv6 含中括號）
export function isInternalHost(host) {
  let h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (h.charAt(0) === '[' && h.charAt(h.length - 1) === ']') h = h.slice(1, -1);
  if (!h) return false;
  if (LOCAL_HOSTS[h]) return true;
  const ip = parseIPv4(h);
  if (ip) {
    if (ip[0] === 10) return true;
    if (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) return true;
    if (ip[0] === 192 && ip[1] === 168) return true;
    return false;
  }
  if (/^[\d.]+$/.test(h) || h.indexOf(':') > -1) return false;   // 不完整的 IP、其他 IPv6
  for (const s of DOMAIN_SUFFIXES) {
    if (h === s || (h.length > s.length && h.slice(-(s.length + 1)) === '.' + s)) return true;
  }
  return false;
}

function parseUrl(url) {
  try { return new URL(String(url)); } catch (e) { return null; }
}

const normKey = k => String(k).toLowerCase().replace(/[\s_\-]/g, '');

function looksLikePii(key, value) {
  const k = normKey(key);
  for (const x of PII_KEYS_EXACT) if (k === x) return true;
  for (const x of PII_KEYS_CONTAIN) if (k.indexOf(x) > -1) return true;
  return TW_ID.test(String(value == null ? '' : value));
}

// 只檢查網址（OPENPANEL 與 embed 共用）：{ ok, errors, url, origin, host }
export function checkUrl(url) {
  const errors = [];
  const raw = String(url == null ? '' : url).trim();
  const u = raw && /^[a-z][a-z0-9+.\-]*:/i.test(raw) ? parseUrl(raw) : null;
  if (!u) return { ok: false, errors: [err('E_EMBED_URL', raw)] };
  if (u.protocol !== 'https:') errors.push(err('E_EMBED_SCHEME', u.protocol.replace(':', '')));
  if (u.username || u.password) errors.push(err('E_EMBED_URL', '網址不可含帳號密碼'));
  if (!isInternalHost(u.hostname)) errors.push(err('E_EMBED_HOST', u.hostname));
  if (raw.indexOf('{') > -1 || raw.indexOf('%7B') > -1 || raw.indexOf('%7b') > -1) errors.push(err('E_EMBED_PII', '占位符只能放在 params'));
  u.searchParams.forEach((v, k) => { if (looksLikePii(k, v)) errors.push(err('E_EMBED_PII', k)); });
  return { ok: errors.length === 0, errors, url: u.href, origin: u.origin, host: u.hostname };
}

export function checkParams(params) {
  const errors = [];
  if (params == null || params === '') return errors;
  if (typeof params !== 'object' || Array.isArray(params)) return [err('E_EMBED_PII', 'params 必須是 { key: value } 物件')];
  for (const k of Object.keys(params)) {
    const v = params[k] == null ? '' : String(params[k]);
    if (!/^[A-Za-z0-9_.\-]+$/.test(k)) { errors.push(err('E_EMBED_PII', '參數名稱 ' + k)); continue; }
    const isPlaceholder = Object.prototype.hasOwnProperty.call(PLACEHOLDERS, v);
    if (!isPlaceholder && (v.indexOf('{') > -1 || v.indexOf('}') > -1)) errors.push(err('E_EMBED_PII', k + '=' + v));
    else if (looksLikePii(k, isPlaceholder ? '' : v)) errors.push(err('E_EMBED_PII', k));
  }
  return errors;
}

// "fill" | 像素 → { fill: true } | { px: n }；不合回 null。未設定視為預設高度
export function parseHeight(height) {
  if (height === undefined || height === null || height === '') return { px: DEFAULT_HEIGHT };
  if (String(height).toLowerCase() === 'fill') return { fill: true };
  const s = String(height).replace(/px$/i, '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (n < PX_MIN || n > PX_MAX) return null;
  return { px: n };
}

function checkMap(map, name) {
  const errors = [];
  if (map == null || map === '') return errors;
  if (typeof map !== 'object' || Array.isArray(map)) return [err('E_EMBED_MAP', name)];
  for (const k of Object.keys(map)) {
    if (!/^[A-Za-z0-9_\-]+$/.test(k) || !/^\d+$/.test(String(map[k]).trim())) errors.push(err('E_EMBED_MAP', name + '.' + k));
  }
  return errors;
}

// 單一 embed 區塊的欄位檢查（不含與其他區塊的關係）
export function checkBlock(block) {
  const b = block || {};
  let errors = checkUrl(b.url).errors.concat(checkParams(b.params));
  if (!parseHeight(b.height)) errors.push(err('E_EMBED_HEIGHT', String(b.height)));
  errors = errors.concat(checkMap(b.inputs, 'inputs'), checkMap(b.outputs, 'outputs'));
  return errors;
}

// 組出實際網址：params 依序附加到 query（占位符換成 ctx 的值，空值也送空字串）
// ctx：{ chtno, deptNo, user, opdno }；回傳 { ok, url, origin, host, errors }
export function buildUrl(block, ctx) {
  const b = block || {};
  const errors = checkBlock({ url: b.url, params: b.params, height: b.height });
  if (errors.length) return { ok: false, errors };
  const u = parseUrl(String(b.url).trim());
  const c = ctx || {};
  const params = b.params || {};
  for (const k of Object.keys(params)) {
    let v = params[k] == null ? '' : String(params[k]);
    if (Object.prototype.hasOwnProperty.call(PLACEHOLDERS, v)) {
      const cv = c[PLACEHOLDERS[v]];
      v = cv == null ? '' : String(cv);
    }
    u.searchParams.append(k, v);
  }
  return { ok: true, url: u.href, origin: u.origin, host: u.hostname, errors: [] };
}

// 走訪範本 JSON，收集控制項：{ itemid: { datatype, tocalc, grouped } }，以及區塊 itemid
export function collect(form) {
  const controls = {};
  const areas = {};
  function walkControl(c, grouped) {
    if (!c || typeof c !== 'object') return;
    if (c.itemid !== undefined && c.itemid !== null && c.itemid !== '' && c.datatype) {
      controls[String(c.itemid)] = { datatype: c.datatype, tocalc: c.tocalc === true || c.tocalc === 'true', grouped };
    }
    const inGroup = grouped || c.datatype === 'form' || c.datatype === 'subgroup';
    if (Array.isArray(c.datavalue)) for (const x of c.datavalue) walkControl(x, inGroup);
    walkChildren(c, inGroup);
  }
  function walkChildren(o, grouped) {
    for (const list of [o.item, o.itemtemp]) {
      if (!Array.isArray(list)) continue;
      for (const x of list) walkControl(x, grouped);
    }
  }
  for (const a of Array.isArray(form) ? form : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.itemid !== undefined && a.itemtype && a.itemtype !== 'iot' && a.itemtype !== 'javascript') areas[String(a.itemid)] = a.itemtype;
    walkChildren(a, false);
  }
  return { controls, areas };
}

// 整張表單的 embed 檢查：[{ itemid, code, message }]
export function validateForm(form) {
  const info = collect(form);
  const out = [];
  let fills = 0;
  const owner = {};   // 輸出欄位 → 第一個寫入它的 embed
  for (const b of Array.isArray(form) ? form : []) {
    if (!b || b.itemtype !== 'embed') continue;
    const id = String(b.itemid);
    const push = e => { out.push({ itemid: id, code: e.code, message: e.message }); };
    checkBlock(b).forEach(push);
    const h = parseHeight(b.height);
    if (h && h.fill && ++fills > 1) push(err('E_EMBED_FILL', 'A' + id));
    const inputs = b.inputs && typeof b.inputs === 'object' ? b.inputs : {};
    for (const ik of Object.keys(inputs)) {
      const ic = info.controls[String(inputs[ik]).trim()];
      if (!ic || !ic.tocalc) push(err('E_EMBED_INPUT', ik + ' → A' + inputs[ik]));
    }
    const outputs = b.outputs && typeof b.outputs === 'object' ? b.outputs : {};
    for (const ok of Object.keys(outputs)) {
      const target = String(outputs[ok]).trim();
      const oc = info.controls[target];
      if (info.areas[target] === 'embed') push(err('E_EMBED_OUTPUT_EMBED', ok + ' → A' + target));
      else if (!oc) push(err('E_EMBED_OUTPUT_MISSING', ok + ' → A' + target));
      else if (oc.grouped) push(err('E_EMBED_OUTPUT_GROUP', ok + ' → A' + target));
      if (owner[target] !== undefined && owner[target] !== id) push(err('E_EMBED_OUTPUT_DUP', ok + ' → A' + target + '（已由 A' + owner[target] + ' 寫入）'));
      else owner[target] = id;
    }
  }
  return out;
}

// strucmed.result 的單一值：一律當文字；number 欄位非數字拒絕。回傳 { ok, value, reason }
export function coerceResultValue(value, isNumber) {
  if (value === null || value === undefined) value = '';
  const t = typeof value;
  if (t !== 'string' && t !== 'number' && t !== 'boolean') return { ok: false, reason: '值必須是字串或數字' };
  const s = String(value);
  if (isNumber && s.trim() !== '' && !/^[+\-]?(\d+\.?\d*|\.\d+)([eE][+\-]?\d+)?$/.test(s.trim())) return { ok: false, reason: '不是數字：' + s.slice(0, 40) };
  return { ok: true, value: isNumber ? s.trim() : s };
}

// ── 以下為 plugin 專用（平台沒有）───────────────────────────────────────────
// 揭露用摘要：目標主機、帶出的參數（占位符標中文）、讀取／寫回欄位。不組實際網址、不帶任何病人值。
export function summarize(block) {
  const b = block || {};
  const u = checkUrl(b.url);
  const params = b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? b.params : {};
  const h = parseHeight(b.height);
  const ids = m => (m && typeof m === 'object' && !Array.isArray(m) ? Object.entries(m).map(([k, v]) => ({ key: k, itemid: String(v).trim() })) : []);
  return {
    itemid: String(b.itemid),
    title: b.title ? String(b.title) : '',
    host: u.host || '',
    origin: u.origin || '',
    path: u.url ? new URL(u.url).pathname : '',
    params: Object.entries(params).map(([k, v]) => {
      const s = v == null ? '' : String(v);
      return { key: k, value: s, ...(PLACEHOLDER_LABELS[s] && { placeholder: PLACEHOLDER_LABELS[s] }) };
    }),
    height: h ? (h.fill ? 'fill' : h.px) : String(b.height),
    inputs: ids(b.inputs),
    outputs: ids(b.outputs)
  };
}
// 一行文字：主機、參數、讀取、寫回（預覽、W_EMBED_DATAFLOW、review 共用）
export function summaryText(s) {
  const p = s.params.length ? s.params.map(x => `${x.key}=${x.placeholder ? `${x.value}（${x.placeholder}）` : x.value}`).join('、') : '無';
  const io = (list, none) => (list.length ? list.map(x => `${x.key}→#${x.itemid}`).join('、') : none);
  return `主機 ${s.host || '（網址無效）'}；網址參數 ${p}；送出欄位 ${io(s.inputs, '無')}；寫回欄位 ${io(s.outputs, '無')}`;
}
