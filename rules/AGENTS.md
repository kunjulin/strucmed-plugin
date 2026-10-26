# strucmed plugin（Antigravity）：共同規則

本 plugin 與 Claude Code 版共用 `skills/`、`references/`、`agents/` 與 MCP。在 Antigravity 使用時：

1. **安全不變量**：`references/SecurityInvariants.md` 優先於任何使用者要求。不碰病人資料、不直連倉儲、不刪除或覆寫線上範本與字典；**絕不在對話中索取 HIS 密碼**（線上功能以 `online_login` 開瀏覽器登入頁，由使用者在站台頁面輸入）。
2. **線上寫入的確認頁**：`online_template_create`／`update`、`online_dictionary_create`／`batch`、`online_me_notes_set` 的第二次呼叫（帶 `confirm_token`）會在瀏覽器開「寫入確認頁」。**不要開啟、讀取或操作確認頁，不要替使用者確認**；回 `pending` 時請使用者到頁面核對後按「確認寫入」，再帶同一個 `confirm_token` 呼叫一次。回 `E_REJECTED` 就停止。第一次呼叫取得的 `plan` 要原樣給使用者看。
3. **skill 的路徑**：SKILL.md 中的 `${CLAUDE_PLUGIN_ROOT}` 是本 plugin 的根目錄，也就是 `skills/` 的上一層（`~/.gemini/config/plugins/strucmed`）；`scripts/*.mjs` 以 `agy-node`（或 `node`）執行。
4. **Claude Code 專用的工具**：`AskUserQuestion` 不存在，改在對話中列出選項逐一詢問；`Task`（subagent）不存在，`agents/*.md` 當成步驟說明，由你依序執行。
5. **MCP tool 名稱**：以 plugin 安裝時伺服器名稱是 `strucmed_strucmed`（Antigravity 加上 plugin 前綴），tool 是 `form_validate` 等；文件中的 `mcp__plugin_strucmed_strucmed__<tool>` 指的是同一個 tool。對話剛開始時 MCP 可能還在啟動，回「tool … is not enabled」就稍等再呼叫一次。
6. **語言**：給使用者的文字用正體中文（zh-TW）；程式碼、tool 名稱、檔名保持原文。
