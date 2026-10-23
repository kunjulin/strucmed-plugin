---
name: report-issue
description: >
  回報 strucmed plugin 的問題：收集 plugin／MCP 版本、feature flags、環境變數有無、最近的 workflow-log 與使用者描述的錯誤，產生遮蔽後的 issue 草稿到工作目錄。
  USE WHEN 使用者說「回報問題」「開 issue」「這個 tool 壞了」「回報 bug」。不處理：自動送出 issue、收集病人資料或憑證。
user-invocable: true
argument-hint: "[一句話描述問題]"
allowed-tools: Read, AskUserQuestion, Bash(node *)
---

# report-issue

1. 用 `AskUserQuestion` 或對話確認三件事：一句話標題、做了什麼與預期／實際結果、錯誤訊息（可貼 tool 回傳的 JSON）。不要請使用者提供帳密、token 或病歷號；若貼上的內容含這些，腳本會遮蔽，但仍提醒使用者。
2. 把描述與錯誤各存成暫存檔（工作目錄 `.strucmed/` 下），執行：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/report-issue.mjs" --title "<標題>" --notes <描述檔> --error <錯誤檔>
   ```
3. 把回傳的 `file` 用 `Read` 檢查一次：確認沒有病人資料、帳密、token（腳本已遮蔽 Bearer、`cgllm_`、JWT、身分證字號、7–10 位數字；**姓名、病歷內容與臨床描述不會自動遮蔽**，看到就請使用者刪掉）。
4. 交給使用者：草稿路徑，並請使用者自己再檢查一次後，經院內管道（例如公務信箱）交給維護者。**本 skill 不送出、不呼叫 gh、不開公開 issue。**
