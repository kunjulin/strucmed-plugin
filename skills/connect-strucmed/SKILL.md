---
name: connect-strucmed
description: >
  檢查並建立與院內服務的連線：strucmed API v2（登入、身分、站台功能）、LlmGateway 金鑰、FMapi。USE WHEN 使用者說「連線」「登入」「設定站台」
  「線上模式」「為什麼沒有 online tool」，或其他流程需要線上功能而尚未登入。不處理：在對話中輸入密碼或金鑰、修改使用者的環境變數或設定檔。
user-invocable: true
allowed-tools: Read, Bash(node *)
---

# connect-strucmed

目的：讓後續流程知道「現在能用什麼」。全部只讀；需要的憑證由使用者自己放在**啟動 Claude Code 的環境**，本 skill 只檢查有沒有，不設定、不索取。
站台**自動判斷**，不問使用者：院內網路 → 院內 LVAIW（`/strucmed`、`/llmgw`、`/FM`）；院外 → 使用者在 `/plugin configure` 填的「院外站台網址」（沒有 LlmGateway 與 FMapi；未填就是離線）；兩邊都連不到 → 離線。

## 步驟

1. 執行環境檢查，把 `site.label` 與 `checks` 中非 `ok` 的項目逐條用一句話告訴使用者：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/check-env.mjs"
   ```
   `site.profile: null`（兩邊都連不到）→ 告知只能離線作業（`.htm` 由使用者匯入），結束線上步驟；接上院內網路或 VPN 後重新執行本 skill。
2. 缺帳號或密碼時（`online_login` 回 `E_AUTH`「尚未設定」，或線上 tool 未列出且 `site.profile` 不是 null），指引使用者在 Claude Code 內執行：
   ```
   /plugin configure strucmed@strucmed-marketplace
   ```
   對話框只需填「院內 HIS 帳號」「院內 HIS 密碼」（遮罩輸入、存安全儲存區）；「LlmGateway token」、FMapi 與 runtime 副本選用。填完後執行 `/reload-plugins`，MCP 子行程才會拿到新值；然後重新執行本 skill。
   **不要**請使用者把密碼或 token 貼到對話；本 skill 也不代替使用者執行 configure。替代做法（進階）：在啟動 Claude Code 的 shell 設定 `STRUCMED_USER`、`STRUCMED_PASS`；`STRUCMED_SITE=internal|external|offline` 可強制站台。
3. `mode: online`：
   - `online_login`（參數只有 `dept_no`、`hospital`，都選填）。回應的 `site.label` 告訴使用者目前是院內或院外站台。
   - **密碼錯誤**：回 `E_AUTH` 且 `error.details.reconfigure: true` → 明確告訴使用者「HIS 密碼錯誤（密碼每三個月變更一次，可能已更換）」，請其執行 `error.details.action`（`/plugin configure strucmed@strucmed-marketplace`）更新「院內 HIS 密碼」→ `/reload-plugins` → 重新執行本 skill。**不要**再呼叫 `online_login` 重試（同一組帳密本行程也不會再送出，避免帳號鎖定），不要請使用者在對話中提供密碼。
   - 其他 `E_AUTH`：依訊息說明（缺帳密、登入服務閒置後回「暫時無回應」可重試一次）。
   - `online_me`：記下 `user_id`、`dept_no`、`folders`（usr／sub／dpt 代碼）；之後建表的預設 `dept_no` 就用它。
   - `online_features`：回報三項狀態；`W_SITE_EXTERNAL`（院外站台）時告知：上架、`If-Match` 更新、字典與範本讀取都和院內相同，但沒有 LlmGateway、LLM 與語音，AI 巨集回院內再實測。`llm_gateway.enabled: false` 時告知「表單內的 LLM 按鈕仍走院內舊端點，不經閘道」；`runtime.save/query: false` 表示登入者不在 HIS 端存檔／查詢白名單（只影響 B1，不影響設計表單）。
   - 字典來源改用 `online_dictionary_search`（`update_index: true`、不帶 `q`）建立本機索引，取代請使用者匯出 CSV。
4. LlmGateway（只有院內）：`llmgateway_models` 有列出時呼叫，回報模型數、別名對應與 deprecated 的模型（`references/ModelWhitelist.md`）；否則提醒「模型白名單使用內建靜態表，表單有 AI 巨集時會標 `W_LLM_WHITELIST_STALE`」，並指引：在 LlmGateway「我的帳號」核發伺服器型 token（標籤 strucmed-skill）→ `/plugin configure strucmed@strucmed-marketplace` 填「LlmGateway token」→ `/reload-plugins`。
5. FMapi（只有院內）：`fmapi_status` 有列出時呼叫，回報錯誤紀錄狀態與相關站台可用率（`W_SITE_DOWN` 要特別點出）；未設定時略過（選用）。
6. 回報一段「連線摘要」：模式與站台（院內／院外）、登入者與科部、可用資料夾、runtime 驗證是否可用、閘道是否啟用。不重複任何環境變數的值。

## 不做

- 不把帳密或金鑰寫進 `.mcp.json`、`settings.json`、`.env`、腳本或對話。
- 不幫使用者設定環境變數、不修改設定檔。
- `E_ONLINE_DISABLED` 時不嘗試其他連線方式（不直連倉儲、不猜網址）。
