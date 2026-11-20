// 疑似個資（PHI）的樣式：原本散在 validate.mjs（E_PHI_SUSPECT）與 embed.mjs（E_EMBED_PII）兩處，
// 這裡集中成一份，讓預覽頁的審閱意見（tools/v0-harness/review-mode.js 與 serve.mjs）用同一組規則，不另寫一套。
//   - embed.mjs 不改：它是平台 web/js/embed-block.js 的逐行移植，訊息與檢查順序要與平台一致（embed.test.mjs 直接比對平台檔）。
//     這裡的 TW_ID 比它寬一點（含居留證的 8／9），validate.mjs 的行為維持原樣（只收 [A-Z][12]）。
export const TW_ID_STRICT = /[A-Z][12]\d{8}/;              // validate.mjs 既有的身分證字號樣式（行為不變）
export const TW_ID = /[A-Za-z][1289]\d{8}/;                // embed.mjs 的樣式：含居留證／統一證號
export const PHI_WORDS = /(病歷號|身分證|身份證|姓名)\s*[:：]\s*\S/;
export const LONG_DIGITS = /\b\d{7,10}\b/;                 // 病歷號長度；只當 warning 用

// 預覽頁審閱意見用：看起來像病歷號或身分證字號就不要寫進 review JSON。→ '' 或原因代號
export function phiReason(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (TW_ID.test(s)) return 'id_number';
  if (PHI_WORDS.test(s)) return 'labelled_phi';
  if (LONG_DIGITS.test(s)) return 'chart_number';
  return '';
}
export const looksLikePhi = value => !!phiReason(value);

export const REASON_LABEL = { id_number: '疑似身分證字號', labelled_phi: '疑似個資（病歷號／身分證／姓名）', chart_number: '疑似病歷號（7–10 位數字）' };

// review-mode.js（瀏覽器腳本）用同一組樣式：serve.mjs 以 /__harness/phi.js 提供，不在瀏覽器端另寫規則
export function clientScript() {
  return '// 由 mcp/strucmed-mcp/src/phi.mjs 產生，請不要手改：預覽頁的審閱意見用同一組疑似個資樣式\n' +
    '(function () {\n' +
    `  var TW_ID = ${TW_ID.toString()}, PHI_WORDS = ${PHI_WORDS.toString()}, LONG_DIGITS = ${LONG_DIGITS.toString()};\n` +
    `  var LABEL = ${JSON.stringify(REASON_LABEL)};\n` +
    '  function reason(v) {\n' +
    '    var s = v === null || v === undefined ? "" : String(v);\n' +
    '    if (!s) return "";\n' +
    '    if (TW_ID.test(s)) return "id_number";\n' +
    '    if (PHI_WORDS.test(s)) return "labelled_phi";\n' +
    '    if (LONG_DIGITS.test(s)) return "chart_number";\n' +
    '    return "";\n' +
    '  }\n' +
    '  window.__strucmedPhi = { reason: reason, looksLikePhi: function (v) { return !!reason(v); }, label: LABEL };\n' +
    '}());\n';
}
