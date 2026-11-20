---
name: verify-runtime
description: >
  以 HIS 端 runtime（平台 TempHtml.html 的本機離線副本）開 draft 的預覽頁：預設只給可點的連結與 HIS 文字輸出，使用者在頁面上填值、看計算結果、留意見；
  有巨集時實跑一次，截圖只在使用者要求或開不了預覽頁時才做。USE WHEN create-form／edit-form 要開預覽頁，或使用者說「預覽看看」「幫我測一下公式」「看 HIS 文字輸出」。不呼叫真正的 LLM；不連外。
user-invocable: true
argument-hint: "<draft_id>"
allowed-tools: Read, Bash(node *), mcp__Claude_Browser__*, SendUserFile
---

# verify-runtime

> `${CLAUDE_PLUGIN_ROOT}`＝plugin 根目錄。Codex 等不展開這個變數的工具：改用本 SKILL.md 所在 `skills/` 目錄的上一層（Codex 的 skill roots 表列出 `skills/` 的絕對路徑）。
> **不要 `cd`**：工作區＝工作目錄，`.strucmed/`、hooks、`preview.mjs` 都靠它找檔案。Bash 一律寫絕對路徑（`<workspace>/.strucmed/…`），`cd` 之後 hook 會找不到定稿檔。

目的：讓使用者看著表單決定，不必反覆匯入編輯器。使用者最後仍以編輯器的「預覽」確認（包括**實際的 LLM 回覆**，這裡不呼叫 LLM）。計算式的「輸入 → 結果」對照由 reviewer 的 `formula_check` 產生，**不在瀏覽器逐格設值**。
詳細操作：`references/RuntimeVerification.md`。

## 步驟

0. **先 `runtime_status`**（唯讀）：確認 runtime 副本能用、而且與站台同版。版本漂移在預覽畫面上看不出來，但計算式與巨集的行為可能和 HIS 端不同。
   - `W_RUNTIME_STALE`（站台比較新）→ 一句話告知使用者「本機 runtime 是 ver A、站台是 ver B」，問要不要更新；要更新就走 `runtime_fetch`（`refetch: true`，兩段式）。**不自動覆蓋**。使用者的副本是自己管理的（`source: "env"`）時只告知，不要動它。
   - `E_RUNTIME_HASH`（抓來的快取被改過）→ 不能用，請使用者同意後 `runtime_fetch(refetch: true)` 重抓。
   - `runtime_available: false` 且沒有副本 → 用 `runtime_fetch` 從站台抓一份：**第一次呼叫只回 plan**（站台、網址、版本戳記、幾個檔案、存到哪裡），把它給使用者確認（這是對外連線），同意後才帶 `confirm_token`。站台連不到或 flag `runtimeFetch` 關閉時，告知設定 `STRUCMED_RUNTIME_WEB` 的方法（`form_preview` 的 `notes` 已經寫出該平台的指令），審閱迴圈退回對話（`RuntimeVerification.md` §6）。
1. `form_preview`（`format: "html"`；有 review.md 帶 `formulas_from_review: true`，已套用意見帶 `applied_seq`）產生預覽資料，並由常駐的 MCP 行程自動啟動（或沿用）本機預覽伺服器，直接回傳 `url` 與 `link`。回 `runtime_available: false` → 照第 0 步處理。編輯器匯出的 `.htm` 不能代替副本：引擎與函式庫都向站台載入，預覽會封鎖。回傳的 `runtime_version`、`runtime_source` 就是預覽頁橫幅會顯示的那一版。
2. 只有在 `form_preview` 回傳的 `url` 是 `null` 時才需要跑一次取回 `link`（埠號它會處理，不要自己換埠，也不要叫使用者自己啟動）：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preview.mjs" <draft_id> --workspace <workspace>
   ```
3. 給使用者 `link`，一句話說明可以做什麼：填值看結果、按「文字輸出」看 HIS 收到的文字、點欄位右上角改說明文字與補述、留意見，按「送出意見」或「定稿」後回到對話。
4. 文字輸出：頁面上有值時，用內建瀏覽器開 `url`，讀 `GetJsonText()`（**不用 `GetText()`**，它在捷徑模式會 `scut_cancel()`），對照 `his_text_keys` 用一兩行回報；沒有值或沒有內建瀏覽器就略過，使用者自己按「文字輸出」。
5. 只在需要時操作瀏覽器（`RuntimeVerification.md` §4）：有片段（`form_script_preview` 的 `snippets`）時**必跑**：`guard` 輸入一組會觸發的值、再改回正常值，確認提示出現一次、`.sm-guard` 標示加上又移除；`derive`／`lookup` 輸入來源值看目標欄位（lookup 的 customfunc 要按對應的巨集按鈕）；`required` 空白失焦看提示、填上再失焦看標示移除；`autorun` 看開文件後目標欄位的「將送出 N 字」與面板「已封鎖的請求」；`table-rows` 看列數與預填（預覽頁沒有病人，開文件類片段在 1 秒後執行）；有巨集按鈕要實跑一次（`performActionByID` → 讀 `window.__simulated`、`window.__blocked`）、`formula_check` 回 `reason` 的計算式、使用者要求測某組值。動態表格按「+」加列、頁籤要切換。結果進定稿檔的「### 驗證結果」，對話中只講一句。
6. 截圖**預設不做**：只在使用者要求、使用者開不了預覽頁、或 draft 有 `style` 片段時（樣式只能用看的；`RuntimeVerification.md` §5）。先 `resize_window`（1000×900），再 `await __snapshot('<名稱>', '<CSS 選擇器>')` → `tools/v0-harness/out/snapshots/<名稱>.png` → 改回 `desktop` → `Read` 看過 → `SendUserFile`。

使用者要調整時，修改 draft 後重新 `form_preview(html)`，請使用者重新整理；連結不變（預覽伺服器重啟過時 nonce 會換，這時要重新給連結）。

## 限制

- CSP 封鎖所有對外連線；LLM／HIS 查詢只顯示將送出的內容。
- 不要在 HIS 終端機上跑；runtime 必須是本機副本（`STRUCMED_RUNTIME_WEB`、本機快取，或 `runtime_fetch` 從站台抓來的那一份）。
- 預覽伺服器只聽 `127.0.0.1`，網址帶一次性 nonce（重啟就失效），閒置超過 `STRUCMED_PREVIEW_IDLE_MS`（預設 120 分鐘）自動關。
- 預覽頁送出的意見會先擋掉疑似病歷號與身分證字號（頁面與伺服器端同一組規則）；被擋掉的值不寫進 review JSON，`form_review_read` 也看不到，頁面會告訴使用者擋了哪幾個。
- `runtime_fetch` 是唯一會在這個流程裡對外連線的 tool，而且兩段式：第一次只回 plan，使用者同意才抓。只抓與站台同源的網址，不碰第三方 CDN。
- 舊版 html2canvas 不畫單選與核取的圓圈，這是截圖限制，不是表單問題。
