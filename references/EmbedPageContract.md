# 嵌入頁（B1 嵌入頁 APP）契約摘要

> 嵌入頁由第三方開發，完整的開發條件在平台的 B1 嵌入頁 APP 開發說明 `docs/EMBED-APP-GUIDE.md`（最小範例 `docs/examples/embed-app-l1.html`），**兩者不一致時以平台說明為準**。
> 這一份是 plugin 內的摘要：在對話中要幫使用者寫、改或檢查嵌入頁，或要判斷「嵌入頁沒反應」是表單還是嵌入頁的問題時先讀它，不要憑記憶猜訊息格式。
> 來源：站台 runtime 實測（2026-11-16，院外站台編輯器的表單預覽頁，TKA 語音護理交班示範；HIS 用戶端內尚未實測）。

表單這一側怎麼宣告（`url`、`params`、`height`、`inputs`、`outputs`）見 `FormDesignRules.md`〈嵌入頁面〉。

## 1. 訊息格式（postMessage）

| 方向 | 訊息 | 說明 |
|---|---|---|
| 表單 → 嵌入頁 | `{ type: 'strucmed.context', version: 1, chtno, deptNo, user, opdno, values }` | iframe 載入後送一次；`values` 是 `inputs` 宣告的 `{ key: 欄位值 }`。病歷號等只走這裡，不放網址 |
| 嵌入頁 → 表單 | `{ type: 'strucmed.ready' }` | 嵌入頁初始化完成後送；表單收到會**重送** `strucmed.context`（嵌入頁的監聽比表單送得晚時靠它補） |
| 嵌入頁 → 表單 | `{ type: 'strucmed.result', data: { key: 值 } }` | 寫回 `outputs` 宣告的欄位。**欄位值放在 `data`**（不是 `values`）；值是字串、數字或布林，數字欄位收到非數字會被拒絕；沒宣告的 key 不寫 |

- 表單只接受 `event.source` 是那個 iframe、且 `event.origin` 等於 `url` 宣告的來源的 `strucmed.result`；嵌入頁轉址到別的來源後寫回會被丟掉。
- 嵌入頁這一側也要檢查：只收 `event.source === window.parent` 的 `strucmed.context`，回傳時把 `targetOrigin` 設成收到 context 的 `event.origin`，不要用 `'*'` 送病人資料（`strucmed.ready` 不含資料，可以用 `'*'`）。
- 寫回只是把值放進表單控制項，**不會存檔**；存檔仍由使用者在表單按。嵌入頁要讓使用者知道「已寫回、尚未存檔」。

## 2. iframe 的限制

- `sandbox="allow-scripts allow-forms allow-same-origin"`、`referrerpolicy="no-referrer"`：不能開新視窗、不能跳出最上層、不能用 `alert`／`confirm`／`prompt`（沒有 `allow-modals`），提示請畫在頁面內。
- 嵌入頁的回應標頭要允許被表單嵌入：`Content-Security-Policy: frame-ancestors` 列出站台來源（HIS 端另含 `http://localhost:*`），不可有 `X-Frame-Options: DENY／SAMEORIGIN`。被擋時 iframe 顯示灰底哭臉，runtime 不提示。
- HIS 內嵌瀏覽器是 Chromium 104：不要用更新的語法與 API。
- 嵌入頁拿到的 `user`、`deptNo` 是 L1（工作站自稱、無簽章），只做顯示與稽核。

## 3. 高度與版面（最常出錯）

- **iframe 不會隨嵌入頁內容長高**，沒有「自動高度」的訊息。高度只有兩種：固定像素（100～4000，預設 600）或 `"fill"`（跟著視窗高度：視窗高度扣掉表單頁首頁尾，有下限；一張表單最多一個）。
- 怎麼選：

| 嵌入頁型態 | `height` | 理由 |
|---|---|---|
| 整頁型 APP（多欄、有自己的工作流程，內容比一個畫面多） | `"fill"` | 吃滿視窗，各欄在嵌入頁內部捲動；表單其他區塊在它下面，往下捲才看得到 |
| 小工具（一個計算器、一段建議、一張圖） | 像素，照內容實際高度給 | 表單其他欄位留在同一個畫面 |

- 嵌入頁的版面**必須跟著 iframe 高度走**，不可假設固定的頁首高度或固定的總高度（頁首在窄寬度會換行；寫成 `height: calc(100% - 55px)` 這類固定扣除值，換行後整頁就比 iframe 高，出現雙層捲軸）。骨架：

```css
html, body { height: 100%; margin: 0; }
body   { display: flex; flex-direction: column; overflow: hidden; }  /* 整頁不捲 */
header { flex: none; }                                              /* 佔實際高度，可換行 */
main   { flex: 1 1 auto; min-height: 0; display: grid; }            /* 吃剩下的高度 */
.pane  { min-height: 0; overflow: auto; }                           /* 各欄自己捲 */
@media (max-width: 980px) { body { display: block; overflow: auto; } }  /* 窄畫面改單欄、整頁捲 */
```

- 驗收：在 600px 與「fill」兩種高度、寬度 1000～1400px 各看一次，整頁（iframe 本身）不可出現捲軸，只有欄內可以捲。

## 4. 本機開發（`https://localhost:<port>/`）

- `url` 接受 `localhost`，但**只有執行那個服務的電腦開得到**；其他工作站開同一張表單時嵌入頁空白。`form_validate` 會列 `W_EMBED_LOCALHOST`。這種表單只用來示範與測試：不要設成科部或次專資料夾的正式表單，部署到院內主機後改 `url` 再更新範本。
- 自簽憑證：先在**同一個瀏覽器**單獨開一次嵌入頁網址並接受憑證，iframe 才載得進來（iframe 內沒有「繼續前往」可按，只會空白）。
- 本機服務一樣要回 `frame-ancestors`（含站台來源）。

## 5. 上架後實測（verify-runtime 的 harness 不載入外部 iframe）

本機預覽頁只驗表單邏輯，嵌入頁要在站台上實測。有 embed 的表單上架後，請使用者在站台編輯器的表單預覽（或 HIS）開一次，依序確認，結果寫進交付：

1. iframe 有載入（不是空白或哭臉）。空白：看主機是否被 StrucForm 導向白名單擋下（`NAV-DENIED`）、憑證是否已接受；哭臉：看 `frame-ancestors`／`X-Frame-Options`。
2. 嵌入頁收到 `strucmed.context`（畫面上應顯示已嵌入、病歷號遮蔽顯示）。沒收到：嵌入頁有沒有送 `strucmed.ready`。
3. 嵌入頁送出 `strucmed.result` 後，`outputs` 的欄位都有值。沒寫入：是不是用了 `values` 而不是 `data`、key 有沒有對上 `outputs`、數字欄位是不是收到文字。
4. 高度：整頁沒有雙層捲軸（§3）。
5. 用測試病人，不要存檔（除非使用者要驗存檔）。

沒做的步驟在定稿與交付寫「未驗證」，不要寫成已通過。

## 6. 需要金鑰的 APP：站台的啟動橋接頁

來源：平台 `docs/PLAN-APP-LAUNCH-BRIDGE.md`（2026-11-16 合併，站台設定 `EmbedApps`，預設關閉；尚未對真正的 APP 與 HIS 實測）。

- 有些 APP 要先由伺服器帶 API 金鑰換啟動網址。金鑰由站台代持，表單的 `embed` 指向站台的橋接頁 `app-launch.html?app=<代號>`；橋接頁收到 `strucmed.context` 後向站台換啟動網址，再把 APP 顯示在內層 iframe。
- 表單這一側：`url` 是橋接頁網址、不帶 `params`、整頁型用 `height: "fill"`。橋接頁與表單同源，§1 的來源檢查照常成立。
- 資料流：站台把登錄表 `Request` 列的欄位（通常是病歷號、使用者）送給 APP；APP 回應的其他內容不會回到瀏覽器。站台每次啟動留稽核（含病歷號）。
- 寫回：APP 對橋接頁送 `strucmed.result`，橋接頁**只轉送登錄表 `Outputs` 列出的 key**，其餘丟棄；所以表單 `outputs` 的 key 要同時出現在登錄表（`W_EMBED_BRIDGE_OUTPUT`）。
- APP 端另外要滿足：`frame-ancestors` 列出每一層祖先（站台來源與 `http://localhost`）、換票後不可再跳互動式登入、內層 iframe 同樣不能開新視窗與下載。
- 症狀對照：

| 橋接頁顯示 | 原因 |
|---|---|
| 網址缺少 APP 代號 | `url` 沒有 `?app=` 或代號格式不合（`W_EMBED_BRIDGE_APP`） |
| 這個頁面要從結構化表單開啟 | 沒有收到 `strucmed.context`：編輯器區塊內的「預覽嵌入頁」、`OPENPANEL` 都不送（`W_EMBED_BRIDGE_PANEL`） |
| 這個 APP 目前沒有開放／站台沒有登錄這個 APP | 站台未啟用啟動橋接、APP 未登錄、未啟用或沒有金鑰：請站台管理者處理 |
| 您不在這個 APP 的可用名單 | 登錄表的使用者／科別白名單 |
| APP 的啟動服務沒有正常回應／APP 沒有回應 | APP 端的問題或 `frame-ancestors` 擋下內層 iframe |

- 上架後實測（§5）多兩項：APP 顯示的是正確的病人；有寫回時確認登錄表允許的 key 都寫得進欄位。
