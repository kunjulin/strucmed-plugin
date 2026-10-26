// 計算式的「人看得懂」檢查（3.3.0）：formula_check 只檢查語法時，抓不到參照放反（例如 BMI 的身高、體重對調）。
//   - captions：每個控制項前面最近的說明文字（同一串流或前一格），當作欄位名稱
//   - labelFormula：把 A<itemid> 換成 [欄位名稱]，讓人和 agent 一眼看出參照對不對
//   - evaluate：以試算值實際計算（只支援常用運算與函數；不支援的一律回報「無法試算」，不猜）
// 運算子優先順序依 Calx 2.2.8 的 jison 文法：= < (<= >= <>) < (> <) < (+ -) < (* /) < ^ < % < 單元負號。
import { tokenize, check } from './calx.mjs';
import { walk, isControl } from './formtree.mjs';

const lastPiece = s => {
  const parts = String(s).replace(/[：:＝=]\s*$/, '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].replace(/[：:]$/, '') : '';
};

// itemid → 欄位名稱。依文件順序走訪：文字與表格標題（datatitle）更新「最近的說明」，遇到控制項就取用並清空。
export function captions(draft) {
  const out = new Map();
  let last = '';
  walk(draft, n => {
    if (n.itemtype === 'td' && n.datatitle) last = String(n.datatitle);
    if (n.datatype === 'text' && String(n.datavalue || '').trim()) last = String(n.datavalue);
    // 固定表格常用「純文字 label」當說明格：不算欄位，不取用說明
    else if (n.datatype === 'label' && !n.formula && !n.hisquery) { if (typeof n.datavalue === 'string' && n.datavalue.trim()) last = n.datavalue; }
    else if (isControl(n)) {
      const label = lastPiece(last) || (n.dictionary ? String(n.dictionary) : '');
      if (label) out.set(String(n.itemid), label);
      last = '';
    }
  });
  return out;
}

export function labelFormula(src, names) {
  const toks = tokenize(src).filter(t => t.type === 'CELL' || t.type === 'FIXEDCELL');
  let s = String(src);
  for (const t of toks.reverse()) {
    const id = t.text.replace(/\$/g, '').replace(/^[A-Za-z]+/, '');
    const name = names.get(String(Number(id)));
    if (name) s = s.slice(0, t.pos) + `[${name}]` + s.slice(t.pos + t.text.length);
  }
  return s;
}

class Unsupported extends Error {}

const num = v => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  throw new Unsupported(`「${v}」不是數字`);
};
const truthy = v => typeof v === 'string' ? (/^true$/i.test(v) ? true : /^false$/i.test(v) ? false : num(v) !== 0) : !!num(v);
const flat = args => args.flat();
// 進位函數與 MOD 逐字照 Calx 2.2.8 的實作（不補浮點誤差）：試算要和 HIS runtime 顯示的值一樣，
// 例如 ROUND(80/(1.6^2), 1) 在 runtime 是 31.2（1.6^2＝2.5600000000000005），不是數學上的 31.3。
const pow10 = n => Math.pow(10, n);
const sign = x => (0 < x ? 1 : -1);
// Calx 的 ROUND／ROUNDUP／ROUNDDOWN 沒有預設位數，少了第二個參數會算出 NaN（只有 TRUNC 預設 0）
const digits = (name, n) => {
  if (n === undefined) throw new Unsupported(`${name} 少了小數位數參數，HIS runtime 會算出 NaN；請寫成 ${name}(x, 0)`);
  return num(n);
};

const FUNCS = {
  ROUND: ([x, n]) => { const d = digits('ROUND', n); return Math.round(num(x) * pow10(d)) / pow10(d); },
  ROUNDUP: ([x, n]) => { const a = num(x), d = digits('ROUNDUP', n); return sign(a) * Math.ceil(Math.abs(a) * pow10(d)) / pow10(d); },
  ROUNDDOWN: ([x, n]) => { const a = num(x), d = digits('ROUNDDOWN', n); return sign(a) * Math.floor(Math.abs(a) * pow10(d)) / pow10(d); },
  TRUNC: ([x, n = 0]) => { const a = num(x), d = num(n); return sign(a) * Math.floor(Math.abs(a) * pow10(d)) / pow10(d); },
  INT: ([x]) => Math.floor(num(x)),
  ABS: ([x]) => Math.abs(num(x)),
  SQRT: ([x]) => Math.sqrt(num(x)),
  POWER: ([x, y]) => Math.pow(num(x), num(y)),
  MOD: ([x, y]) => { const a = num(x), b = num(y), c = Math.abs(a % b); return 0 < b ? c : -c; },
  SUM: a => flat(a).reduce((s, v) => s + num(v), 0),
  AVERAGE: a => { const v = flat(a); return v.reduce((s, x) => s + num(x), 0) / v.length; },
  MIN: a => Math.min(...flat(a).map(num)),
  MAX: a => Math.max(...flat(a).map(num)),
  AND: a => flat(a).every(truthy),
  OR: a => flat(a).some(truthy),
  NOT: ([x]) => !truthy(x),
  CONCATENATE: a => flat(a).map(v => typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v)).join('')
};

const cmp = (a, b) => {
  const na = typeof a === 'number' || (typeof a === 'string' && a.trim() !== '' && !isNaN(Number(a)));
  const nb = typeof b === 'number' || (typeof b === 'string' && b.trim() !== '' && !isNaN(Number(b)));
  if (na && nb) return num(a) - num(b);
  const sa = String(a), sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
};

function run(src, cell) {
  const toks = tokenize(src);
  let k = 0;
  const peek = () => toks[k];
  const take = () => toks[k++];
  const isOp = (...ops) => {
    const t = peek(), n = toks[k + 1];
    for (const op of ops) {
      if (op.length === 1 && t.type === op && !(op === '<' && (n.type === '=' || n.type === '>')) && !(op === '>' && n.type === '=')) return op;
      if (op.length === 2 && t.type === op[0] && n.type === op[1]) return op;
    }
    return null;
  };
  const level = (next, ops, apply) => () => {
    let v = next();
    for (let op; (op = isOp(...ops));) { k += op.length; v = apply(op, v, next()); }
    return v;
  };
  const arith = (op, a, b) => {
    const x = num(a), y = num(b);
    if (op === '/' && y === 0) return '#DIV/0!';
    return op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : Math.pow(x, y);
  };
  const guard = f => (op, a, b) => (typeof a === 'string' && a.startsWith('#')) ? a : (typeof b === 'string' && b.startsWith('#')) ? b : f(op, a, b);
  const unary = () => {
    if (peek().type === '-') { k++; return arith('*', -1, unary()); }
    if (peek().type === '+') { k++; return num(unary()); }
    return primary();
  };
  const pow = level(unary, ['^'], guard(arith));
  const mul = level(pow, ['*', '/'], guard(arith));
  const add = level(mul, ['+', '-'], guard(arith));
  const cmp2 = level(add, ['>', '<'], (op, a, b) => op === '>' ? cmp(a, b) > 0 : cmp(a, b) < 0);
  const cmp1 = level(cmp2, ['<=', '>=', '<>'], (op, a, b) => op === '<=' ? cmp(a, b) <= 0 : op === '>=' ? cmp(a, b) >= 0 : cmp(a, b) !== 0);
  const expr = level(cmp1, ['='], (op, a, b) => cmp(a, b) === 0);
  const args = () => {
    const list = [];
    if (peek().type === ')') return list;
    const start = () => k;
    for (;;) {
      list.push({ at: start() });
      skipArg();
      if (peek().type === ',' || peek().type === ';') { k++; continue; }
      return list;
    }
  };
  // 參數先記位置、需要時才計算（IF 只算走到的分支）
  function skipArg() {
    let depth = 0;
    for (;;) {
      const t = peek();
      if (t.type === 'EOF') return;
      if (t.type === '(' || t.type === '[') depth++;
      if (t.type === ')' || t.type === ']') { if (depth === 0) return; depth--; }
      if ((t.type === ',' || t.type === ';') && depth === 0) return;
      k++;
    }
  }
  const evalAt = at => { const save = k; k = at; const v = rangeOrExpr(); k = save; return v; };
  function rangeOrExpr() {
    const t = peek(), n = toks[k + 1];
    if ((t.type === 'CELL' || t.type === 'FIXEDCELL') && n.type === ':') {
      k += 2;
      const e = take();
      const [, c1, r1] = /^([A-Z]+)(\d+)$/.exec(t.text.replace(/\$/g, '').toUpperCase());
      const [, c2, r2] = /^([A-Z]+)(\d+)$/.exec(e.text.replace(/\$/g, '').toUpperCase());
      if (c1 !== c2) throw new Unsupported(`範圍 ${t.text}:${e.text} 跨欄`);
      const out = [];
      for (let i = Math.min(+r1, +r2); i <= Math.max(+r1, +r2); i++) out.push(cell(c1 + i));
      return out;
    }
    return expr();
  }
  function primary() {
    const t = take();
    switch (t.type) {
      case 'NUMBER': {
        let s = t.text;
        if (peek().type === '.') { k++; s += '.' + take().text; }
        let v = Number(s);
        while (peek().type === '%') { k++; v /= 100; }
        return v;
      }
      case 'STRING': return t.text.slice(1, -1).replace(/\\(["'])/g, '$1');
      case 'CELL': case 'FIXEDCELL':
        if (peek().type === ':') throw new Unsupported('範圍只能放在函數參數內');
        return cell(t.text.replace(/\$/g, '').toUpperCase());
      case 'VARIABLE':
        if (/^true$/i.test(t.text)) return true;
        if (/^false$/i.test(t.text)) return false;
        if (/^null$/i.test(t.text)) return '';
        throw new Unsupported(`變數 ${t.text}`);
      case '(': { const v = expr(); take(); return v; }
      case 'FUNCTION': {
        const name = t.text.toUpperCase();
        take();
        const list = args();
        take();
        if (name === 'IF') {
          if (list.length < 2) throw new Unsupported('IF 參數不足');
          return truthy(evalAt(list[0].at)) ? evalAt(list[1].at) : list[2] ? evalAt(list[2].at) : false;
        }
        const f = FUNCS[name];
        if (!f) throw new Unsupported(`函數 ${t.text}()`);
        return f(list.map(a => evalAt(a.at)));
      }
      default: throw new Unsupported(`「${t.text}」`);
    }
  }
  return expr();
}

const tidy = v => typeof v === 'number' ? Number(v.toPrecision(12)) : v;
const norm = v => typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE')
  : typeof v === 'number' ? v
  : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : String(v).trim();

// values：{ "A3": 65 } 或 { "3": 65 }。回傳 { ok, value } 或 { ok:false, reason }。
export function evaluate(src, values = {}) {
  if (!check(src).ok) return { ok: false, reason: '語法錯誤' };
  const map = new Map(Object.entries(values || {}).map(([key, v]) => [String(Number(String(key).replace(/^[A-Za-z]+/, ''))), v]));
  const missing = new Set();
  const cell = addr => {
    const id = String(Number(addr.replace(/^[A-Z]+/, '')));
    if (!map.has(id)) { missing.add('A' + id); return 0; }
    return map.get(id);
  };
  try {
    const value = tidy(run(src, cell));
    if (missing.size) return { ok: false, reason: `缺少試算值：${[...missing].join('、')}` };
    return { ok: true, value };
  } catch (e) {
    if (missing.size) return { ok: false, reason: `缺少試算值：${[...missing].join('、')}` };
    if (e instanceof Unsupported) return { ok: false, reason: `無法離線試算（${e.message}）；請以 runtime 預覽確認` };
    throw e;
  }
}

export function sameValue(a, b) {
  const x = norm(a), y = norm(b);
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y));
  return x === y;
}
