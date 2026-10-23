// 範本套件 v2（strucmed.template/v2）— schemas/strucmed-template-v2.schema.json
// 同一份 .htm 同時含：
//   <script>var tempdata =<form></script>                 → 舊版匯入器（平台 web/js/shortcut.js getFormData）
//   <script type="application/json" id="strucmed-package"> → 新版匯入器（預填所有選項）
import crypto from 'node:crypto';

export const FORMAT = 'strucmed.template/v2';
export const INTEGRITY_ALG = 'sha256(JSON.stringify({form,presets}))';
export const GROUPS = ['門', '住', '急', '手術', '檢查', '助手'];
export const FOLDER_TYPES = ['usr', 'sub', 'dpt', 'sys', ''];

// 與編輯器 JS 相同的序列化（JSON.stringify，無空白），瀏覽器端以 crypto.subtle 重算即可比對
export function packageHash(form, presets) {
  return crypto.createHash('sha256').update(JSON.stringify({ form, presets }), 'utf8').digest('hex');
}

// 由 deptNo 推算資料夾代號；usr 需要使用者代號，未知時留空
export function folderCode(type, deptNo, userID = '') {
  const d = String(deptNo || '');
  return { usr: userID, sub: d.substr(0, 4), dpt: d.substr(0, 3), sys: d.substr(1, 2), '': '' }[type] ?? '';
}

export function buildPackage({ form, meta, presets = [], dictionaries = [], generator, exportedBy = '', templateID = '', rev = 0, derivedFrom = null }) {
  const groups = (meta.groups || []).includes('All') ? GROUPS.slice() : (meta.groups || []).filter(g => GROUPS.includes(g));
  const iot = form.find(x => x && x.itemtype === 'iot') || {};
  const folderType = meta.folder_type || '';
  const pkg = {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    exportedBy,
    generator,
    template: {
      templateID,
      name: meta.name,
      shortcut: String(meta.shortcut || '').toLowerCase(),
      groups,
      description: meta.description || '',
      folder: { type: folderType, code: folderCode(folderType, meta.dept_no) },
      rev,
      editorver: iot.editorver || '1.6',
      ...(derivedFrom && { derivedFrom })
    },
    form,
    presets,
    dictionaries,
    integrity: { alg: INTEGRITY_ALG, sha256: packageHash(form, presets) }
  };
  const errs = validatePackage(pkg);
  if (errs.length) throw new Error('套件不符合 schema：' + errs.join('；'));
  return pkg;
}

// 零相依的結構驗證（對照 schema 的必要規則）；回傳錯誤訊息陣列
export function validatePackage(p) {
  const e = [];
  const isStr = v => typeof v === 'string';
  if (!p || typeof p !== 'object') return ['不是物件'];
  const allowed = ['format', 'exportedAt', 'exportedBy', 'generator', 'template', 'form', 'presets', 'dictionaries', 'integrity'];
  for (const k of Object.keys(p)) if (!allowed.includes(k)) e.push(`不允許的欄位 ${k}`);
  if (p.format !== FORMAT) e.push(`format 必須是 ${FORMAT}`);
  if (!isStr(p.exportedAt) || isNaN(Date.parse(p.exportedAt))) e.push('exportedAt 不是日期時間');
  if (!isStr(p.generator)) e.push('generator 必填');
  const t = p.template || {};
  if (!isStr(t.name) || !t.name.trim() || t.name.length > 36) e.push('template.name 必填且 ≤ 36 字');
  if (!isStr(t.shortcut)) e.push('template.shortcut 必須是字串');
  if (!Array.isArray(t.groups) || t.groups.some(g => !GROUPS.includes(g)) || new Set(t.groups).size !== t.groups.length) e.push('template.groups 只能是 門/住/急/手術/檢查/助手 且不可重複');
  if (!isStr(t.description)) e.push('template.description 必須是字串');
  if (!t.folder || !FOLDER_TYPES.includes(t.folder.type) || !isStr(t.folder.code)) e.push('template.folder 格式錯誤');
  if (!isStr(t.editorver)) e.push('template.editorver 必填');
  if (t.derivedFrom !== undefined) {
    const d = t.derivedFrom;
    if (!d || !isStr(d.templateID) || !isStr(d.name) || !/^[0-9a-f]{64}$/.test(d.sha256 || '')) e.push('template.derivedFrom 格式錯誤');
  }
  if (!Array.isArray(p.form) || p.form.length < 2 || p.form.some(x => !x || !isStr(x.itemtype))) e.push('form 必須是 GetData() 陣列');
  else {
    if (p.form[p.form.length - 1].itemtype !== 'iot') e.push('form 最後一項必須是 iot');
    if (!p.form.some(x => x.itemtype === 'javascript')) e.push('form 缺少 javascript 項');
  }
  if (!Array.isArray(p.presets) || p.presets.some(x => !x || !isStr(x.name) || !isStr(x.user))) e.push('presets 格式錯誤');
  if (!Array.isArray(p.dictionaries) || p.dictionaries.some(x => !x || !isStr(x.id) || !isStr(x.dicName) || !x.dicName || !isStr(x.dicType))) e.push('dictionaries 格式錯誤');
  const i = p.integrity || {};
  if (i.alg !== INTEGRITY_ALG || !/^[0-9a-f]{64}$/.test(i.sha256 || '')) e.push('integrity 格式錯誤');
  else if (Array.isArray(p.form) && Array.isArray(p.presets) && packageHash(p.form, p.presets) !== i.sha256) e.push('integrity.sha256 與內容不符');
  return e;
}

// <script> 內嵌 JSON 的安全序列化：避免 </script、<!-- 與 U+2028/2029 破壞 HTML 解析
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const scriptSafe = s => s.replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');

export function renderHtm(pkg, title) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 舊版匯入器以字串搜尋 "<script>var tempdata =" 並擷取到下一個 "</script>"，所以 tempdata 必須放在最前面且格式不變
  const legacy = JSON.stringify(pkg.form).replace(/<\/(script)/gi, '<\\/$1');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>` +
    `<script>var tempdata =${legacy}</script>` +
    `<script type="application/json" id="strucmed-package">${scriptSafe(JSON.stringify(pkg))}</script>` +
    `</body></html>`;
}

// 從 .htm 擷取套件（與平台編輯器 getPackageData 相同的規則）
export function extractPackage(htm) {
  const m = /<script type="application\/json" id="strucmed-package">([\s\S]*?)<\/script>/.exec(htm);
  return m ? JSON.parse(m[1]) : null;
}
