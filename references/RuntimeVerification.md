# runtime 驗證操作細節

> 規則依據平台 runtime 實測。由 `verify-runtime` 載入。原文的 `node tools/v0-harness/preview.mjs` 在 plugin 內改為 `node "${CLAUDE_PLUGIN_ROOT}/scripts/preview.mjs"`（它會補上 `STRUCMED_WORKSPACE` 與 `STRUCMED_RUNTIME_WEB`）。

## runtime 驗證（Claude 內部步驟，有計算式或巨集時必做）

目的：輸出前確認計算式與巨集在 **HIS 端 runtime** 真的算得對、寫進對的欄位，讓使用者用對話繼續調整，不必反覆匯入編輯器。
使用者最後仍以編輯器的「預覽」確認（包括**實際的 LLM 回覆**，這裡不呼叫 LLM）。

1. `form_preview`（`format: "html"`）產生預覽資料（需要平台前端 `web/` 的本機副本：`STRUCMED_RUNTIME_WEB`，未設定時為 `<workspace>/repo/strucmed/web`；`runtime_available: false` 時跳過本節並告知使用者）。
2. 執行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/preview.mjs" <draft_id>`：它會**先檢查**伺服器，**沒開就在背景啟動**，已開就沿用，最後印出 `url` 與可點的 `link`。
   - 不要叫使用者自己啟動伺服器。伺服器啟動後留著，讓使用者可以點連結。
   - 回報「舊版」時，截圖功能不可用：用 `node "${CLAUDE_PLUGIN_ROOT}/scripts/preview.mjs" <draft_id> 8766` 另開一個新版伺服器。
3. 用內建瀏覽器開 `url`，以 JavaScript 操作（不要點擊數字欄位，它只接受逐鍵輸入）：
   - 設值：`SetValueByID(id, '值')`，接著 `$(targetid).calx('refresh'); $(targetid).calx('calculate');`
     **`targetid` 是 TempHtml.js 的全域變數**（calx 容器選擇器，目前是 `#rowArea`），照字面寫 `$(targetid)`；不要用 `$("[itemid='N']")` 當容器重算，會算不出來。數值欄位是 `<span data-cell="A<itemid>">`，`SetValueByID` 會寫進去。
     核取框要帶出下一欄時用 `input.click()`（或 `.trigger('click')`）一次即可；不要先 `prop('checked', true)` 再 click，會反轉回去。
   - 讀計算結果：`$("[itemid='N']").text()`（calx 不顯示整數結果尾端的 `.0`，例如 37.0 顯示 37，這不是公式錯誤）
   - 按巨集：`performActionByID(按鈕 itemid)`，等約 0.5 秒再讀目標欄位
   - 讀模擬紀錄：`window.__simulated`（LLM／語音／HIS 查詢的 prompt 與模型）、`window.__blocked`（被封鎖的請求）
4. 每個計算式至少測：典型值、每個級距或條件的邊界、空白輸入。LLM 巨集確認目標欄位顯示的 prompt、模型、字數。
5. 交給使用者：
   - 輸入 → 結果的對照表（標示是否符合預期）
   - LLM prompt 摘要（模型、字數、包含哪些欄位）
   - 被封鎖的請求類型
   - **可點的預覽連結**（`link`，使用者可以自己開來操作）
   - **畫面截圖**：瀏覽器工具的截圖只有 Claude 看得到，必須存檔再傳。
     1. 先在頁面設好代表性的值、按過巨集。
     2. 用 `await __snapshot('<名稱>', '<CSS 選擇器，省略＝整張表單>')` 存到 `tools/v0-harness/out/snapshots/<名稱>.png`。
     3. 用 Read 看過內容，再以 `SendUserFile` 傳給使用者。舊版 html2canvas 不畫單選與核取的圓圈，這是截圖限制，不是表單問題。
     - **截圖前一律先 `resize_window`（例 1000×900）**，截完改回 `desktop`：瀏覽器面板隱藏或剛開啟時 `innerWidth` 為 0，`__snapshot` 會回報 `not png`。可在同一個 `browser_batch` 裡依序放 resize → javascript（含 `__snapshot`）→ resize desktop。
     - 截圖以區塊為單位（`.area[itemid='N']`），不要搬動 DOM。段落欄位只會截到可見的幾行，長內容改用文字說明。

   使用者要調整時，修改 draft 後**重跑本節**，再交新的結果。
6. 都確認後才進入 `form_export` 兩段式。
