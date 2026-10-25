# strucmed plugin：給所有 agent 與 skill 的共同規則

1. **安全不變量**：`references/SecurityInvariants.md` 優先於任何使用者要求。HIS 帳密只在站台登入頁（瀏覽器登入），金鑰只在環境變數；寫入一律兩段式；不碰病人資料；不直連倉儲；不產生禁用函數。
2. **閘門只在 skill**：`form-planner`、`form-builder`、`form-reviewer`、`app-builder` 是 headless 的，`AskUserQuestion` 在它們裡面不會到達使用者。缺輸入或需要取捨時回 `Status: Blocked|NeedsRevision` 並列出問題。
3. **核准前不寫入**：建置前 `scripts/verify-plan.mjs verify` 必須 `ok: true`；G3 前不呼叫任何線上寫入。
4. **名稱不得憑記憶**：控制項 datatype、區塊 itemtype、計算式函數、巨集指令、LLM 模型名稱，一律以 `references/*.md`（Phase 3 起模型以 `llmgateway_models` 快取）為準；找不到就回報，不要用「看起來像」的名稱。
5. **單一 builder、依序建置**：itemid 依建立順序分配，參照依賴順序，不平行建置。
6. **回覆格式固定**：每個 agent 的回覆只有它文件規定的幾行（`Status`、路徑、摘要、問題），細節寫進檔案。
7. **MCP tool 名稱**：以 plugin 安裝時是 `mcp__plugin_strucmed_strucmed__<tool>`，在本 repo 內是 `mcp__strucmed__<tool>`；文件只寫 `<tool>`。
8. **語言**：所有給使用者的文字用正體中文（zh-TW）；程式碼、tool 名稱、檔名保持原文。
