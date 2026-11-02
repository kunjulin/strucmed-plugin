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

1. `form_preview`（`format: "html"`；有 review.md 帶 `formulas_from_review: true`，已套用意見帶 `applied_seq`）產生預覽資料。回 `runtime_available: false` → 告知使用者需設定 `STRUCMED_RUNTIME_WEB`（平台 `web/` 的本機副本），審閱迴圈退回對話（`RuntimeVerification.md` §6）。編輯器匯出的 `.htm` 不能代替副本：引擎與函式庫都向站台載入，預覽會封鎖。
2. 跑一次，取回 `link`。埠號它會處理（沒開就在背景啟動，舊版占用時改下一個埠），不要自己換埠，也不要叫使用者自己啟動：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preview.mjs" <draft_id> --workspace <workspace>
   ```
3. 給使用者 `link`，一句話說明可以做什麼：填值看結果、按「文字輸出」看 HIS 收到的文字、點欄位右上角改說明文字與補述、留意見，按「送出意見」或「定稿」後回到對話。
4. 文字輸出：頁面上有值時，用內建瀏覽器開 `url`，讀 `GetJsonText()`（**不用 `GetText()`**，它在捷徑模式會 `scut_cancel()`），對照 `his_text_keys` 用一兩行回報；沒有值或沒有內建瀏覽器就略過，使用者自己按「文字輸出」。
5. 只在需要時操作瀏覽器（`RuntimeVerification.md` §4）：有巨集按鈕要實跑一次（`performActionByID` → 讀 `window.__simulated`、`window.__blocked`）、`formula_check` 回 `reason` 的計算式、使用者要求測某組值。動態表格按「+」加列、頁籤要切換。結果進定稿檔的「### 驗證結果」，對話中只講一句。
6. 截圖**預設不做**：只在使用者要求、或使用者開不了預覽頁時（`RuntimeVerification.md` §5）。先 `resize_window`（1000×900），再 `await __snapshot('<名稱>', '<CSS 選擇器>')` → `tools/v0-harness/out/snapshots/<名稱>.png` → 改回 `desktop` → `Read` 看過 → `SendUserFile`。

使用者要調整時，修改 draft 後重新 `form_preview(html)`，請使用者重新整理；連結不變。

## 限制

- CSP 封鎖所有對外連線；LLM／HIS 查詢只顯示將送出的內容。
- 不要在 HIS 終端機上跑；`STRUCMED_RUNTIME_WEB` 必須是本機副本。
- 舊版 html2canvas 不畫單選與核取的圓圈，這是截圖限制，不是表單問題。
