---
name: verify-runtime
description: >
  在輸出前以 HIS 端 runtime（平台 TempHtml.html 的本機離線副本）實際執行 draft 的計算式、HIS 參照、巨集與表格／頁籤，
  把「輸入 → 結果」對照表、LLM prompt 摘要、被封鎖的請求與截圖交給使用者（閘門 G2）。USE WHEN create-form／edit-form 的 draft 含計算式或巨集，
  或使用者說「幫我測一下公式」「預覽看看」。不呼叫真正的 LLM；不連外。
user-invocable: true
argument-hint: "<draft_id>"
allowed-tools: Read, Bash(node *), mcp__Claude_Browser__*, SendUserFile
---

# verify-runtime

> `${CLAUDE_PLUGIN_ROOT}`＝plugin 根目錄。Codex 等不展開這個變數的工具：改用本 SKILL.md 所在 `skills/` 目錄的上一層（Codex 的 skill roots 表列出 `skills/` 的絕對路徑）。

目的：讓使用者用對話繼續調整，不必反覆匯入編輯器。使用者最後仍以編輯器的「預覽」確認（包括**實際的 LLM 回覆**，這裡不呼叫 LLM）。
詳細操作：`references/RuntimeVerification.md`。

## 步驟

1. `form_preview`（`format: "html"`）產生預覽資料。回 `runtime_available: false` → 跳過本 skill，告知使用者需設定 `STRUCMED_RUNTIME_WEB`（平台 `web/` 的本機副本），G2 只剩離線檢查（`form_validate`、`formula_check` 試算）。編輯器匯出的 `.htm` 不能代替副本：引擎與函式庫都向站台載入，預覽會封鎖。
2. 啟動或沿用 harness 伺服器並取得連結（它會先檢查 8765，沒開就在背景啟動；不要叫使用者自己啟動）：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preview.mjs" <draft_id>
   ```
   回報「舊版」時用另一個埠：`node "${CLAUDE_PLUGIN_ROOT}/scripts/preview.mjs" <draft_id> 8766`。
3. 用內建瀏覽器開 `url`，以 JavaScript 操作（`RuntimeVerification.md` §操作）：設值 → 重算（`$(targetid).calx('refresh'); $(targetid).calx('calculate');`，`targetid` 是 TempHtml 的全域變數，照字面寫）→ 讀結果 → 按巨集 → 讀 `window.__simulated`、`window.__blocked`。
4. 每個計算式至少測：典型值、每個級距或條件的邊界、空白輸入。LLM 巨集確認目標欄位顯示的 prompt、模型、字數。動態表格按「+」加列、頁籤要切換。
5. 截圖存檔再傳（瀏覽器工具的截圖只有 Claude 看得到）：**先 `resize_window`（1000×900）**，再 `await __snapshot('<名稱>', '<CSS 選擇器>')` → `tools/v0-harness/out/snapshots/<名稱>.png` → 改回 `desktop` → `Read` 看過 → `SendUserFile`。
6. 交給使用者（G2）：
   - 輸入 → 結果對照表（標示是否符合預期）
   - LLM prompt 摘要（模型、字數、包含哪些欄位）
   - 被封鎖的請求類型
   - 可點的預覽連結與截圖
   使用者要調整時，修改 draft 後**重跑本 skill**。

## 限制

- CSP 封鎖所有對外連線；LLM／HIS 查詢只顯示將送出的內容。
- 不要在 HIS 終端機上跑；`STRUCMED_RUNTIME_WEB` 必須是本機副本。
- 舊版 html2canvas 不畫單選與核取的圓圈，這是截圖限制，不是表單問題。
