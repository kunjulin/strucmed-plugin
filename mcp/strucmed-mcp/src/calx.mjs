// jQuery Calx 2.2.8 計算式的離線語法檢查（v0.2）。
// 詞法規則改寫自 jQuery Calx 2.2.8 的 jison lexer（MIT，見 THIRD_PARTY_NOTICES.md），
// 並保留它的行為特性：
//   - 「第一個符合的規則勝出」（lexer 沒有開 flex），不是最長匹配。
//     所以 `A5>3`、`10>A2` 這類 `>` 兩側緊貼英數字的寫法會被切成單一 SHEET token → 語法錯誤。
//   - `evaluate` 固定是 cell 模式（v.fx.obj={type:"cell"}）：`A12` 是儲存格參照。
//   - TRUE／FALSE／NULL／PI／E／NOT 的專用規則排在識別字規則之後，實際上都會被當成變數；
//     getVariable 只認 TRUE／FALSE／NULL（不分大小寫），其他未定義的變數回傳 "#UNDEFINED_VARIABLE!"。
//   - 函數名稱不分大小寫（callFunction 先 toUpperCase），查不到回傳 "#NAME?"（不拋錯）。
//   - 沒有 `&` 運算子（無對應規則 → 詞法錯誤）。
// 文法（productions_）：
//   e := variableSequence | TIME_AMPM | TIME_24 | number | STRING | e = e | e + e | ( e ) | [ expseq ]
//      | e < = e | e > = e | e < > e | e > e | e < e | e - e | e * e | e / e | e ^ e | - e | + e
//      | FUNCTION ( ) | FUNCTION ( expseq ) | cell
//   cell := FIXEDCELL | FIXEDCELL : FIXEDCELL | CELL | CELL : CELL | SHEET ! CELL | SHEET ! CELL : CELL
//   expseq := e | expseq ; e | expseq , e
//   number := NUMBER | NUMBER . NUMBER | number %
//   variableSequence := VARIABLE | variableSequence . VARIABLE

const RULES = [
  [/^(?:\s+)/, null],
  [/^(?:"(\\["]|[^"])*")/, 'STRING'],
  [/^(?:'(\\[']|[^'])*')/, 'STRING'],
  [/^(?:#[A-Za-z0-9_]+)/, 'SHEET'],
  [/^(?:[A-Za-z]{1,}[A-Za-z_0-9]+(?=[(]))/, 'FUNCTION'],
  [/^(?:([0]?[1-9]|1[0-2])[:][0-5][0-9]([:][0-5][0-9])?[ ]?(AM|am|aM|Am|PM|pm|pM|Pm))/, 'TIME'],
  [/^(?:([0]?[0-9]|1[0-9]|2[0-3])[:][0-5][0-9]([:][0-5][0-9])?)/, 'TIME'],
  [/^(?:[A-Za-z0-9_]+>[A-Za-z0-9_]+)/, 'SHEET_GT'],     // cell 模式回傳 SHEET：`A5>3` 陷阱
  [/^(?:\$[A-Za-z]+\$[0-9]+)/, 'FIXEDCELL'],
  [/^(?:[A-Za-z]+[0-9]+)/, 'CELL'],
  [/^(?:[A-Za-z]+(?=[(]))/, 'FUNCTION'],
  [/^(?:[A-Za-z]{1,}[A-Za-z_0-9]+)/, 'VARIABLE'],
  [/^(?:[A-Za-z_]+)/, 'VARIABLE'],
  [/^(?:[0-9]+)/, 'NUMBER'],
  [/^(?:\$)/, null],                                      // 無回傳值 → 略過
  [/^(?: )/, null],
  [/^(?:[.])/, '.'], [/^(?::)/, ':'], [/^(?:;)/, ';'], [/^(?:,)/, ','],
  [/^(?:\*)/, '*'], [/^(?:\/)/, '/'], [/^(?:-)/, '-'], [/^(?:\+)/, '+'], [/^(?:\^)/, '^'],
  [/^(?:\()/, '('], [/^(?:\))/, ')'], [/^(?:\[)/, '['], [/^(?:\])/, ']'],
  [/^(?:>)/, '>'], [/^(?:<)/, '<'],
  // NOT／PI／E／TRUE／FALSE／NULL 的規則在此之後，永遠不會先符合（已被識別字規則吃掉）
  [/^(?:")/, 'QUOTE'], [/^(?:')/, 'QUOTE'], [/^(?:!)/, '!'], [/^(?:=)/, '='], [/^(?:%)/, '%'], [/^(?:[#])/, '#']
];

export class CalxError extends Error {
  constructor(code, message, pos) { super(message); this.code = code; this.pos = pos; }
}

export function tokenize(src) {
  const toks = [];
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    const rest = s.slice(i);
    let hit = null;
    for (const [re, type] of RULES) {
      const m = rest.match(re);
      if (m) { hit = { type, text: m[0] }; break; }
    }
    if (!hit) {
      const ch = rest[0];
      const hint = ch === '&' ? '（Calx 沒有 & 運算子，請改用 CONCATENATE）' : '';
      throw new CalxError('E_FORMULA_LEX', `第 ${i + 1} 個字元「${ch}」無法辨識${hint}`, i);
    }
    if (hit.type) toks.push({ ...hit, pos: i });
    i += hit.text.length;
  }
  toks.push({ type: 'EOF', text: '', pos: s.length });
  return toks;
}

// 遞迴下降。接受集合與 jison LALR 文法相同（運算子優先順序不影響「是否接受」）。
export function parse(src) {
  const toks = tokenize(src);
  let k = 0;
  const info = { functions: [], cells: [], ranges: [], variables: [], strings: [], sheets: [] };
  const peek = (o = 0) => toks[k + o];
  const eat = type => {
    const t = toks[k];
    if (t.type !== type) {
      const got = t.type === 'EOF' ? '結尾' : `「${t.text}」`;
      let hint = '';
      if (t.type === 'SHEET_GT' || (t.type === 'SHEET' && />/.test(t.text))) hint = '（`>` 兩側請加空白，例如 A5 > 3）';
      throw new CalxError('E_FORMULA_SYNTAX', `第 ${t.pos + 1} 個字元：預期「${type}」，卻是 ${got}${hint}`, t.pos);
    }
    k++;
    return t;
  };
  const unexpected = t => {
    let hint = '';
    if (t.type === 'SHEET_GT') hint = '（`>` 兩側緊貼英數字會被 Calx 切成錯誤的 token，請加空白，例如 A5 > 3）';
    else if (t.type === 'QUOTE') hint = '（字串沒有結束的引號）';
    else if (t.type === '.' ) hint = '（小數請寫成 0.5，不能以小數點開頭）';
    throw new CalxError('E_FORMULA_SYNTAX', `第 ${t.pos + 1} 個字元：不預期的 ${t.type === 'EOF' ? '結尾' : `「${t.text}」`}${hint}`, t.pos);
  };

  function cellRef(t) {
    const addr = t.type === 'FIXEDCELL' ? t.text.replace(/\$/g, '') : t.text;
    return { addr: addr.toUpperCase(), pos: t.pos, ...(t.type === 'FIXEDCELL' && { fixed: true }) };
  }
  function cellTail(first) {
    if (peek().type === ':') {
      k++;
      const t2 = peek();
      if (t2.type !== first.type) unexpected(t2);
      k++;
      info.ranges.push({ from: cellRef(first).addr, to: cellRef(t2).addr, pos: first.pos });
    } else info.cells.push(cellRef(first));
  }
  function primary() {
    const t = peek();
    switch (t.type) {
      case 'NUMBER': {
        k++;
        if (peek().type === '.' ) { k++; eat('NUMBER'); }
        while (peek().type === '%') k++;
        return;
      }
      case 'STRING': k++; info.strings.push({ text: t.text.slice(1, -1), pos: t.pos }); return;
      case 'TIME': k++; return;
      case 'VARIABLE': {
        k++;
        let name = t.text;
        while (peek().type === '.' && peek(1).type === 'VARIABLE') { k += 2; name += '.' + toks[k - 1].text; }
        info.variables.push({ name, pos: t.pos });
        return;
      }
      case '(': k++; expr(); eat(')'); return;
      case '[': k++; expseq(); eat(']'); return;
      case '-': case '+': k++; primary(); return;
      case 'FUNCTION': {
        k++;
        eat('(');
        let argc = 0;
        const args = [];
        if (peek().type !== ')') { const r = expseq(); argc = r.count; args.push(...r.spans); }
        const close = eat(')');
        info.functions.push({ name: t.text.toUpperCase(), raw: t.text, pos: t.pos, end: close.pos + 1, argc, args });
        return;
      }
      case 'CELL': case 'FIXEDCELL': k++; cellTail(t); return;
      case 'SHEET': {
        k++;
        eat('!');
        const c = peek();
        if (c.type !== 'CELL') unexpected(c);
        k++;
        info.sheets.push({ sheet: t.text, pos: t.pos });
        if (peek().type === ':') { k++; eat('CELL'); }
        return;
      }
      default: unexpected(t);
    }
  }
  function binaryOp() {
    const t = peek();
    if (['+', '-', '*', '/', '^', '='].includes(t.type)) { k++; return true; }
    if (t.type === '<') { k++; if (peek().type === '=' || peek().type === '>') k++; return true; }
    if (t.type === '>') { k++; if (peek().type === '=') k++; return true; }
    return false;
  }
  function expr() {
    primary();
    while (binaryOp()) primary();
  }
  function expseq() {
    const spans = [];
    let start = peek().pos;
    expr();
    let count = 1;
    while (peek().type === ',' || peek().type === ';') {
      spans.push([start, peek().pos]);
      k++;
      start = peek().pos;
      expr();
      count++;
    }
    spans.push([start, peek().pos]);
    return { count, spans };
  }

  expr();
  if (peek().type !== 'EOF') unexpected(peek());
  return info;
}

// 不拋錯的版本
export function check(src) {
  try {
    return { ok: true, ...parse(src) };
  } catch (e) {
    if (e instanceof CalxError) return { ok: false, code: e.code, message: e.message, pos: e.pos };
    throw e;
  }
}
