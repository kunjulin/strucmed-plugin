// form_export — writes <name>.htm (importable), <name>.package.json (範本套件 v2), <name>.manifest.md
// The .htm keeps `<script>var tempdata =` first, which is exactly what the old
// editor importer extracts (平台 web/js/shortcut.js:2081-2107), and adds the v2
// package in <script type="application/json" id="strucmed-package"> for the new
// importer . The editor takes the form name from the file name.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toFormJson, isNoPatient, iotOptionFields, NOPATIENT_CODE, NOPATIENT_SUBJECT } from './model.mjs';
import { preview } from './preview.mjs';
import { buildPackage, renderHtm } from './package.mjs';
import { walk, isControl } from './formtree.mjs';
import * as dc from './dictcomment.mjs';
import { renderSnippets } from './script-snippets.mjs';
import { bridgeText } from './embed.mjs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

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
      out.set('new:' + n.dictionary, { id: '', dicName: n.dictionary, dicType: draft.meta.dept_no, dicComment: dc.build({ desc: p.comment || '', memo: p.memo || null, fhir: p.fhir }) });
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
下列欄位的內容會在使用者按下按鈕時，從 HIS 端瀏覽器送到院內 LLM／語音服務；在院外站台（cgmh.ddns.net、struNote）開啟時改送站台允許的院外 LLM 服務（目前 OpenAI）與院外語音服務（OpenAI、Groq），使用者自備 API 金鑰、第一次使用會出現注意事項，巨集指定的院內模型代號會被忽略。模型白名單與上架審查待院方決議。

| 按鈕 | 步驟 | 類型 | 模型／服務 | 送出的欄位 | 回覆寫入 |
|---|---|---|---|---|---|
${rows.join('\n')}
` : ''}`;
}

// 非病人表單（iot f_nopatient）：manifest 與交付說明要列出（站台支援與否、紀錄表頭、只有本人查得到、HIS 內不能存檔）
const draftAutoLoad = draft => (draft.source && draft.source.iot ? draft.source.iot.f_autoLoadOnOpen === true : iotOptionFields((draft.meta || {}).options).f_autoLoadOnOpen === true);
export function noPatientSection(draft) {
  if (!isNoPatient(draft)) return '';
  return `
## 非病人表單
- **非病人表單：struNote 不需病歷號，平台以保留代碼（預設 ${NOPATIENT_CODE}）開啟**（iot \`f_nopatient: true\`）；「上次紀錄」只看自己的。
- **站台支援**：院內、院外站台都已支援（2026-11-22）。其他站台以 \`online_features\` 的 \`runtime.no_patient\` 為準（站台 \`GET api/v2/runtime/features\` 回 \`noPatientChtno\`）；不支援的站台會把它當一般表單、要求病歷號，這時不要在該站台使用（不輸入真實病歷號，也不自行輸入保留代碼）。
- **紀錄表頭**（院方 2026-11-22 核定）：\`chtno\`＝${NOPATIENT_CODE}、\`deptNo\`＝APP、\`opdno\`＝${NOPATIENT_SUBJECT}（紀錄主體，現行固定）、\`recNo\`＝紀錄鍵。一筆紀錄由 \`user\`＋\`sheetid\`＋\`opdno\`＋\`recNo\` 定位；struNote 不帶 \`recNo\`（寫入 \`none\`），每人每張表單只有一筆。要多筆紀錄須由 APP 以表單頁的 \`recNo\` 參數開啟（英數字與 \`_\`、\`.\`、\`-\`，最多 64 字；取值規則須先登錄，不得自行填未登錄的值）。
- **只有填寫者本人查得到、下載得到**：查詢（\`api/v2/records/query/*\`）必須帶 \`sheetid\`、只回呼叫者自己建立的紀錄；資料下載只含下載者本人的紀錄，原作者與管理者也一樣，目前無法彙整他人的紀錄。
- **HIS 內不能存檔**：HIS 內開啟時 HIS 仍帶真實病歷號，存檔會被平台拒絕；目前只在 struNote／表單頁使用，不要設作業別上架到 HIS 清單。
- **開啟時自動取出**${draftAutoLoad(draft) ? '已開啟：struNote 開啟時載入自己上次存的那一筆。' : '**沒有開啟**：struNote 開啟時是空白表單，存檔會覆寫上次存的那一筆（form_validate 的 W_NOPATIENT_AUTOLOAD）。'}
- **不要用倉儲以病歷號查詢這類紀錄**：所有人的紀錄都在同一個保留代碼下，不代表任何病人。\`chtno\` 為 \`Shortcut\` 或以 \`APP\` 開頭的都不是病人紀錄，\`500\` 是測試用病歷號；統計與分析請一併排除。
- 表單不得有 HIS 參照、HISQUERY、LOOKUPDW／LOOKUPDEFAULTSETTING、讀取型字典角色（fromhis／puthis）、G_CHTNO()、嵌入頁 {chtno}／{opdno} 參數（form_validate 的 E_NOPATIENT_*）。
- 舊版編輯器（尚未更新的站台）不認得這個選項：在那裡另存，選項可能遺失，請在支援的站台確認 Option 面板的「非病人表單（不需病歷號）」。
`;
}

// 嵌入頁面資料流（embed 區塊與 OPENPANEL）：與 AI 資料流同樣揭露目標主機、帶出的參數、送出與寫回的欄位
export function embedSection(validation) {
  const list = validation.embeds || [];
  if (!list.length) return '';
  const cell = v => String(v === undefined || v === null || v === '' ? '—' : v).replace(/\|/g, '／');
  const io = l => (l.length ? l.map(x => `${cell(x.key)}→#${x.itemid}`).join('、') : '—');
  // 經站台啟動橋接頁的：目標主機欄寫明真正的 APP（主機取自站台目錄；沒有目錄時寫「以站台登錄表為準」）
  const host = x => cell(x.host) + (x.bridge ? `（啟動橋接頁；${cell(bridgeText(x.bridge))}）` : '');
  const rows = list.map(x => x.kind === 'embed'
    ? `| 區塊 #${x.itemid}${x.title ? ` ${cell(x.title)}` : ''}${x.source === 'imported' ? '（原表單）' : ''} | 表單載入時 | ${host(x)} | ${x.params.length ? x.params.map(p => `${cell(p.key)}=${cell(p.placeholder ? `${p.value}（${p.placeholder}）` : p.value)}`).join('、') : '—'} | ${io(x.inputs)} | ${io(x.outputs)} |`
    : `| 巨集 #${x.itemid}${x.name ? ` ${cell(x.name)}` : ''}${x.source === 'imported' ? '（原表單）' : ''} | 按下 OPENPANEL | ${host(x)} | — | — | — |`);
  return `
## 嵌入頁面資料流（${list.length} 個）
下列院內頁面會顯示在表單內。embed 區塊載入後 runtime 另以 strucmed.context 送出病歷號、科別、使用者、門診序號與「送出欄位」的值；
嵌入頁以 strucmed.result 回傳的值會寫進「寫回欄位」，和醫師手填一樣隨表單存檔。網址只接受 https 與院內主機，參數不帶身分證號、姓名。
HIS 端要 StrucForm 導向白名單放行該主機（1.10.9 起預設放行院內範圍）。

| 來源 | 時機 | 目標主機 | 網址參數 | 送出欄位 | 寫回欄位 |
|---|---|---|---|---|---|
${rows.join('\n')}
`;
}

// 白名單片段（docs/13）：清單與渲染後的程式碼原樣列出，供人工審閱
export function scriptSnippetSection(draft) {
  const r = renderSnippets(draft);
  if (!r.js) return '';
  return `
## 表單 JS（白名單片段，${r.snippets.length} 個，sha256 ${r.hash}）
由固定樣板渲染，不接受自由 JS；只在 2.0 runtime 執行，不影響 HIS 文字輸出與倉儲。樣式會影響列印版面。
${r.snippets.map(s => `- ${s.template}#${s.id}${s.advanced ? '（進階，flag formScriptAdvanced）' : ''}：${s.summary}${s.affects.length ? `（影響 #${s.affects.join('、#')}）` : ''}`).join('\n')}

\`\`\`js
${r.js}
\`\`\`
`;
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

${noPatientSection(draft)}${scriptSection(draft, validation)}${embedSection(validation)}${scriptSnippetSection(draft)}
## 套件內的選項（v2）
| 項目 | 值 |
|---|---|
| 表單名稱 | ${t.name} |
| 捷徑 | ${t.shortcut || '（空白＝不上架）'} |
| 作業別 | ${t.groups.join('、') || '（無＝不上架）'} |
| Info | ${t.description || '（無）'} |
| 建議資料夾 | ${t.folder.type || '（未指定）'}${t.folder.code ? `（${t.folder.code}）` : ''} |${isNoPatient(draft) ? '\n| 非病人表單 | 是（f_nopatient；struNote 不需病歷號；紀錄只有填寫者本人查得到） |' : ''}

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
${isNoPatient(draft) ? `- [ ] 非病人表單：Option 面板的「非病人表單（不需病歷號）」已勾選（尚未更新的站台沒有這一項）；從 struNote 開啟，不輸入真實病歷號，不從 HIS 開啟\n` : ''}- [ ] 有計算式或巨集時：在預覽中實際操作一次，確認結果寫入正確的欄位

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
