---
name: connect-strucmed
description: >
  檢查並建立與院內服務的連線：strucmed API v2（登入、身分、站台功能）、LlmGateway 金鑰、FMapi。USE WHEN 使用者說「連線」「登入」「設定站台」
  「線上模式」「為什麼沒有 online tool」，或其他流程需要線上功能而尚未登入。不處理：在對話中輸入密碼或金鑰、修改使用者的環境變數或設定檔。
user-invocable: true
allowed-tools: Read, Bash(node *)
---

# connect-strucmed

> `${CLAUDE_PLUGIN_ROOT}`＝plugin 根目錄。Codex 等不展開這個變數的工具：改用本 SKILL.md 所在 `skills/` 目錄的上一層（Codex 的 skill roots 表列出 `skills/` 的絕對路徑）。

目的：讓後續流程知道「現在能用什麼」。全部只讀；strucmed 以瀏覽器登入（HIS 密碼只在站台登入頁輸入），選用的 token 由使用者自己以 `/plugin configure` 或環境變數提供，本 skill 只檢查有沒有，不設定、不索取。
站台**自動判斷**，不問使用者：院內網路 → 院內 LVAIW（`/strucmed`、`/llmgw`、`/FM`）；院外 → 內建的院外站台 `https://cgmh.ddns.net`（沒有 LlmGateway 與 FMapi；`/plugin configure` 的「院外站台網址」只在資訊室公告新網址時才需要填，填 `none` 則不探測院外）；兩邊都連不到 → 離線。

## 步驟

1. 執行環境檢查，把 `site.label` 與 `checks` 中非 `ok` 的項目逐條用一句話告訴使用者：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/check-env.mjs"
   ```
   `site.profile: null`（兩邊都連不到）→ 告知只能離線作業（`.htm` 由使用者匯入），結束線上步驟；接上院內網路或 VPN 後重新執行本 skill。
2. `mode: online`：呼叫 `online_login`（參數只有 `dept_no`、`hospital`，都選填；**沒有帳密參數**）。
   - MCP 會以系統瀏覽器開啟 strucmed 站台的登入頁。告訴使用者：確認網址是 strucmed 站台後，在頁面輸入 HIS 帳號密碼並按「登入並同意」，完成後回到這裡說一聲。
   - 回 `pending: true`：把 `authorize_url` 給使用者（`browser_opened: false` 時請其自行開啟），等使用者說完成後**再呼叫一次** `online_login`（會接著等同一個登入，不會重開）。
   - 回 `E_AUTH`「拒絕」：使用者在登入頁按了拒絕，問是否要重新登入。
   - 登入頁顯示「帳號或密碼錯誤」或「嘗試次數過多」是在瀏覽器裡處理的事（HIS 密碼每三個月變更；同一帳號連續 5 次錯誤鎖 15 分鐘），不要在對話中索取密碼。
   - 回應的 `site.label` 告訴使用者目前是院內或院外站台。token 只存在 MCP 記憶體，30 分鐘自動更新，同一次登入最長 8 小時；開新工作階段或 `/reload-plugins` 後需重新登入。
3. 選填設定（LlmGateway）：LlmGateway token 未設定時，指引使用者在 Claude Code 內執行 `/plugin configure strucmed@strucmed-marketplace` 填寫後 `/reload-plugins`（Copilot CLI、Codex 改以啟動 shell 的環境變數 `LLMGW_API_KEY` 提供）。院外站台網址不需要設定（內建 `https://cgmh.ddns.net`），只有資訊室公告新網址時才以「院外站台網址」或 `STRUCMED_EXTERNAL_URL` 覆寫。**不要**請使用者把密碼或 token 貼到對話；本 skill 也不代替使用者執行 configure。`STRUCMED_SITE=internal|external|offline` 可強制站台。
4. 登入後：
   - `online_me`：記下 `user_id`、`dept_no`、`folders`（usr／sub／dpt 代碼）；之後建表的預設 `dept_no` 就用它。
   - `online_features`：回報三項狀態；`W_SITE_EXTERNAL`（院外站台）時告知：上架、`If-Match` 更新、字典與範本讀取都和院內相同，但沒有 LlmGateway、LLM 與語音，AI 巨集回院內再實測。`llm_gateway.enabled: false` 時告知「表單內的 LLM 按鈕仍走院內舊端點，不經閘道」；`runtime.save/query: false` 表示登入者不在 HIS 端存檔／查詢白名單（只影響 B1，不影響設計表單）。
   - 字典來源改用 `online_dictionary_search`（`update_index: true`、不帶 `q`）建立本機索引，取代請使用者匯出 CSV。
5. LlmGateway（只有院內）：`llmgateway_models` 有列出時呼叫，回報模型數、別名對應與 deprecated 的模型（`references/ModelWhitelist.md`）；否則提醒「模型白名單使用內建靜態表，表單有 AI 巨集時會標 `W_LLM_WHITELIST_STALE`」，並指引：在 LlmGateway「我的帳號」核發伺服器型 token（標籤 strucmed-skill）→ `/plugin configure strucmed@strucmed-marketplace` 填「LlmGateway token」→ `/reload-plugins`。
6. FMapi（只有院內）：`fmapi_status` 有列出時呼叫，回報錯誤紀錄狀態與相關站台可用率（`W_SITE_DOWN` 要特別點出）；未設定時略過（選用）。
7. 回報一段「連線摘要」：模式與站台（院內／院外）、登入者與科部、可用資料夾、runtime 驗證是否可用、閘道是否啟用。不重複任何環境變數的值。

## 不做

- 不把帳密或金鑰寫進 `.mcp.json`、`settings.json`、`.env`、腳本或對話。
- 不幫使用者設定環境變數、不修改設定檔。
- `E_ONLINE_DISABLED` 時不嘗試其他連線方式（不直連倉儲、不猜網址）。
