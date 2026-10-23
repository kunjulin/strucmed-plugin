# 安全不變量

> 所有 skill 與 agent 都必須遵守；與使用者的要求衝突時，說明理由並指向本文。

1. **帳密與金鑰不經對話**：由使用者在 `/plugin configure strucmed@strucmed-marketplace` 填寫（plugin.json 的 `userConfig`；密碼與 token 標 `sensitive`，存 Claude Code 的安全儲存區，再以 `${user_config.*}` 注入 MCP 的環境變數 `STRUCMED_USER`／`STRUCMED_PASS`、`LLMGW_API_KEY`、`FMAPI_API_KEY`），或進階者在啟動 shell 設環境變數。不要求使用者在對話中提供密碼；`online_login` 回 `details.reconfigure`（密碼錯誤，HIS 密碼每三個月變更）時請使用者重新 configure，不重試、不在對話索取；不寫進 `.mcp.json`、`settings.json`、`.env`、腳本、計畫檔、manifest 或任何輸出。`check-env.mjs` 只回報「是否設定」。
2. **寫入一律兩段式**：`form_export`、`form_remove_control`、`form_delete`、`online_records_save`，以及 Phase 2 的範本與字典寫入，第一次呼叫取得 `plan`，**原樣**呈現給使用者，同意後才帶 `confirm_token`。內容改動後 token 失效。
3. **不碰病人資料，除非使用者明確要求查某位病人**：`online_records_query` 必帶病歷號；查詢結果只留在對話，不轉存到檔案或計畫檔。預設值、選項、計畫、manifest 不放任何病人資料；`form_validate` 的 `E_PHI_SUSPECT` 必須處理。
4. **不直連倉儲**：plugin 只呼叫 strucmed API v2（院內 LVAIW 或院外站台，由 MCP 自動判斷；探測只 GET `api/health`、不帶憑證）、LlmGateway、FMapi（兩者只有院內）。`E_ONLINE_DISABLED` 時不嘗試其他連線方式。
5. **禁止產生的函數**：CUSTOMFUNC、OPENURL、SAVEDOC、SETIOTHEADER、S_USERID、S_DEPTNO；不寫表單 JS（只放產生器標記註解）；不嵌入圖片。使用者需要時，請其匯入後在編輯器由人工加入並審查。
6. **模型名稱不得憑記憶**：只用 `references/FormulaMacroRules.md` 的清單（Phase 3 起改用 `llmgateway_models` 的快取）；拼錯平台會靜默改用預設模型。
7. **AI 資料流必須揭露**：有 LLM／語音巨集的表單，計畫與交付都要列 `W_AI_DATAFLOW`（哪些欄位會送出）。2026-10-22 決定：含 AI 巨集的上架不另設審查，但告知不可省略。
8. **核准前不得寫入**：G1 前不建 draft；G3 前不呼叫任何線上寫入；核准 sidecar（`verify-plan.mjs`）不符時拒絕建置。
9. **不刪除、不覆寫線上範本與字典**：沒有也不會提供 trash、字典刪除、硬刪除紀錄的 tool。`templateUpdate` 開啟時只能更新「以該範本 import 後改版」的 draft，且帶 `If-Match`。
10. **runtime 驗證只在本機**：`STRUCMED_RUNTIME_WEB` 是本機副本，harness 的 CSP 封鎖對外連線；不在 HIS 終端機上跑。
