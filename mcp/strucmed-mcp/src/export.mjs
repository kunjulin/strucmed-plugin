// form_export — writes <name>.htm (importable), <name>.package.json (範本套件 v2), <name>.manifest.md
// The .htm keeps `<script>var tempdata =` first, which is exactly what the old
// editor importer extracts (平台 web/js/shortcut.js:2081-2107), and adds the v2
// package in <script type="application/json" id="strucmed-package"> for the new
// importer . The editor takes the form name from the file name.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toFormJson } from './model.mjs';
import { preview } from './preview.mjs';
import { buildPackage, renderHtm } from './package.mjs';
import { walk, isControl } from './formtree.mjs';
import * as dc from './dictcomment.mjs';

export const VERSION = '2.4.1';

export function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'form';
}

// 表單中參照到的字典：綁定既有（含 id）＋待新建（id 為空字串）
function referencedDictionaries(draft, dictIndex) {
  const out = new Map();
  const known = new Map();
  for (const e of (dictIndex ? dictIndex.entries : [])) known.set(e.id, e);
  for (const d of (draft.source ? draft.source.dictionaries : []) || []) if (d.id && !known.has(d.id)) known.set(d.id, d);
  walk(draft, n => {
    if (!isControl(n) || !n.dictionary) return;
    if (n.dicid) {
      const e = known.get(n.dicid) || {};
      out.set('id:' + n.dicid, { id: n.dicid, dicName: n.dictionary, dicType: e.dicType || '', dicComment: e.dicComment || '' });
    } else {
      const p = (draft.pendingDictionaries || []).find(x => x.name === n.dictionary) || {};
      out.set('new:' + n.dictionary, { id: '', dicName: n.dictionary, dicType: draft.meta.dept_no, dicComment: dc.build({ desc: p.comment || '', memo: p.memo || null }) });
    }
  });
  return [...out.values()];
}

export function buildArtifacts(draft, dictIndex) {
  const tag = `strucmed-skill v${VERSION} ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} draft=${draft.draft_id}`;
  const form = toFormJson(draft, tag);
  const pkg = buildPackage({
    form, meta: draft.meta,
    presets: draft.source ? structuredClone(draft.source.presets || []) : [],
    dictionaries: referencedDictionaries(draft, dictIndex),
    generator: `strucmed-skill ${VERSION}`,
    derivedFrom: draft.source ? draft.source.derivedFrom : null
  });
  const htm = renderHtm(pkg, safeFileName(draft.meta.name));
  return { form, pkg, htm, tag };
}

function derivedLines(draft) {
  if (!draft.source) return '';
  const d = draft.source.derivedFrom;
  return `\n- **改版自**：${d.name || '（未命名）'}（來源 sha256 \`${d.sha256.slice(0, 12)}…\`）；**新表單不沿用原 ID**` +
    `\n- 保留原表單 JS ${(draft.source.javascript || '').length} 字元（本工具未審查）、表單預設 ${(draft.source.presets || []).length} 筆（P0 匯入時只顯示、不寫入）` +
    `\n- 本次新增或修改的控制項：${(draft.touched || []).length ? (draft.touched || []).map(id => '#' + id).join('、') : '無'}`;
}

// v0.2：計算式、巨集與 AI 資料流
function scriptSection(draft, validation) {
  const st = validation.stats || {};
  const ai = validation.ai || [];
  if (!st.formulas && !st.macros) return '';
  const cell = v => String(v === undefined || v === null || v === '' ? '—' : v).replace(/\|/g, '／');
  const rows = ai.map(x => `| #${x.itemid}${x.name ? ` ${cell(x.name)}` : ''} | ${x.step} | ${cell(x.kind)} | ${cell(x.model !== undefined ? x.model || '（預設）' : x.provider)} | ${cell([...(x.inputs || []).map(i => 'A' + i), ...(x.sources || [])].join('、'))} | ${x.target ? '#' + x.target : '—'} |`);
  return `
## 計算式與巨集
- 計算式 ${st.formulas || 0} 個、巨集／LLM 按鈕 ${st.macros || 0} 個（語法依真實 Calx 2.2.8 檢查，）
- **匯入後不要按「重新編號」**：它不會更新巨集內容裡的 A<n> 與目標 id，字串裡像 A1c 的文字也會被改掉
${ai.length ? `
### AI 資料流（${ai.length} 個步驟）
下列欄位的內容會在使用者按下按鈕時，從 HIS 端瀏覽器送到院內 LLM／語音服務。模型白名單與上架審查待院方決議。

| 按鈕 | 步驟 | 類型 | 模型／服務 | 送出的欄位 | 回覆寫入 |
|---|---|---|---|---|---|
${rows.join('\n')}
` : ''}`;
}

export function manifest(draft, validation, files, sha, pkg) {
  const m = draft.meta;
  const pend = draft.pendingDictionaries || [];
  const bound = [];
  walk(draft, c => { if (isControl(c) && c.dicid) bound.push(`- #${c.itemid} → ${c.dictionary}（${String(c.dicid).slice(0, 8)}…，${c.dicrole}）`); });
  const importMode = pend.length ? '**匯入表單及字典**（有新字典，不可用「匯入表單」，否則綁定會靜默消失）' : '「匯入表單」或「匯入表單及字典」皆可';
  const t = pkg.template;
  return `# 匯入說明：${m.name}

- 產生器：strucmed-skill v${VERSION}（draft ${draft.draft_id}）
- 產生時間：${new Date().toISOString()}
- 檔案：\`${path.basename(files.htm)}\`（匯入用，含範本套件 v2）、\`${path.basename(files.json)}\`（範本套件 v2）
- SHA-256（.htm）：\`${sha.htm}\`；套件 integrity：\`${pkg.integrity.sha256}\`${derivedLines(draft)}

## 結構預覽
\`\`\`
${preview(draft, 'tree')}
\`\`\`

## 字典
- 待新建（${pend.length}）：${pend.length ? pend.map(p => p.name).join('、') : '無'}
- 綁定既有（${bound.length}）：
${bound.join('\n') || '- 無'}

${scriptSection(draft, validation)}
## 套件內的選項（v2）
| 項目 | 值 |
|---|---|
| 表單名稱 | ${t.name} |
| 捷徑 | ${t.shortcut || '（空白＝不上架）'} |
| 作業別 | ${t.groups.join('、') || '（無＝不上架）'} |
| Info | ${t.description || '（無）'} |
| 建議資料夾 | ${t.folder.type || '（未指定）'}${t.folder.code ? `（${t.folder.code}）` : ''} |

## 匯入步驟（請本人操作）
1. 登入編輯器；**deptno 填 ${m.dept_no}**（新字典的類別會等於此代碼），切到建議資料夾。
2. 按「新增表單」，**確認 Option 面板 sheetID 為空白**（避免覆寫既有表單）。
3. 功能選單 → ${importMode} → 選 \`${path.basename(files.htm)}\` → 上傳。
4. **支援 v2 的編輯器**：名稱、捷徑、作業別、Info 會自動預填並顯示提示，請逐項確認。
   **舊版編輯器**：只會帶入表單內容與檔名，請依上表手動填寫捷徑、作業別、Info。
5. **不要**按「重新編號」。

## 保存前確認清單
- [ ] 預覽中實際操作一次，版面與選項正確
- [ ] 每個區塊的人形圖示：所有人「編輯／顯示」與「回傳文字」符合預期
- [ ] 字典顏色：綠＝寫入、藍＝讀取、橘＝讀寫、白＝無
- [ ] 表單名稱、捷徑、作業別正確（**有捷徑＋作業別＝保存後即上架到 HIS 清單**；測試表單請清空）
- [ ] 沒有任何病人資料
- [ ] 有計算式或巨集時：在預覽中實際操作一次，確認結果寫入正確的欄位

## 驗證結果
- errors：${validation.errors.length}
- warnings：${validation.warnings.length}
${validation.warnings.map(w => `  - ${w.code}：${w.message}`).join('\n')}
`;
}

export function writeArtifacts(outDir, draft, validation, overwrite, dictIndex) {
  const base = safeFileName(draft.meta.name);
  const files = {
    htm: path.join(outDir, base + '.htm'),
    json: path.join(outDir, base + '.package.json'),
    manifest: path.join(outDir, base + '.manifest.md')
  };
  const exists = Object.values(files).filter(f => fs.existsSync(f));
  return {
    files, exists,
    write() {
      const a = buildArtifacts(draft, dictIndex);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(files.htm, a.htm);
      fs.writeFileSync(files.json, JSON.stringify(a.pkg, null, 2));
      const sha = { htm: crypto.createHash('sha256').update(a.htm).digest('hex') };
      fs.writeFileSync(files.manifest, manifest(draft, validation, files, sha, a.pkg));
      return { files, sha256: sha, integrity: a.pkg.integrity.sha256, marker: a.tag };
    }
  };
}
