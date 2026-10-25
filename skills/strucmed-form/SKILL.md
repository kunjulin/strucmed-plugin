---
name: strucmed-form
description: >
  長庚結構化病歷 2.0（StrucMed）表單製作的入口：依使用者意圖分流到設計新表單、改版既有表單、runtime 驗證、上架與表單 APP。
  USE WHEN 使用者提到 StrucMed、結構化病歷 2.0、結構化表單、表單編輯器，或「幫我做一張 XX 表單／評估單／紀錄單」且涉及長庚 HIS 作業
  （門診／住院／急診／手術／檢查／AI 小助手）；「以既有表單為範本改版／在原表單加欄位」；「加計算式／BMI／巨集按鈕／LLM 按鈕」；
  「上架／發佈到編輯器」；「做成 app／平板用」。不處理：病人資料下載、刪除或覆寫線上表單與字典、直接寫入倉儲、在對話中要求密碼。
user-invocable: true
argument-hint: "<表單需求，或：改版 <檔案或範本ID> | 預覽 <draft_id> | 調校 <draft_id> <itemid> | 上架 <draft_id> | app <範本ID>>"
allowed-tools: Read, Glob, Grep, AskUserQuestion, Task, Bash(node *)
---

# strucmed-form（入口）

這個 skill 只做三件事：確認環境、判定意圖、載入對應的流程。規則細節都在各流程 skill 與 `references/`，**不要**一次全部讀完。

## 1. 先確認環境（每次對話第一次進入時）

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-env.mjs"
```

- `mode: offline`：只做離線流程（產生 `.htm` 由使用者匯入）。使用者要線上功能時，載入 `connect-strucmed`。
- `mode: online` 且尚未登入：先載入 `connect-strucmed` 完成 `online_login` → `online_me`。
- `runtime_web.available: false`：有計算式、巨集、表格或頁籤時要告知使用者「runtime 驗證不可用」，並說明設定 `STRUCMED_RUNTIME_WEB` 的方法。
- 輸出裡的環境變數只有「是否設定」；**絕不**在對話中要求或複誦密碼、金鑰。
- **plugin 更新後 MCP 子行程不會自動換新**：`check-env` 的 `mcp_version` 是檔案上的版本，實際執行中的版本看 `form_export` 回傳的 `marker`（`strucmed-skill vX.Y.Z`）或 MCP 的 `initialize` serverInfo。兩者不同時請使用者執行 `/reload-plugins` 或重開 Claude Code，再繼續。

## 2. 依意圖分流（只載入一個）

| 使用者要做什麼 | 載入 | 備註 |
|---|---|---|
| 設計一張新表單 | `create-form` | 需求訪談 → 計畫（G1）→ 建置 → 審查 → runtime 驗證（G2）→ 輸出 |
| 以既有表單為範本改版、加欄位 | `edit-form` | 來源可以是使用者提供的 `.htm`／`.json`，或線上範本（`online_template_get`） |
| 只要看計算式／巨集算得對不對 | `verify-runtime` | 需要 draft 已存在 |
| 改某一顆 LLM 按鈕的提示詞、AI 回覆不好、想試跑或比較模型 | `tune-prompt` | 需要 draft 與 itemid；試跑要 flag `llmChatTest` 與去識別化樣本 |
| 上架到編輯器／範本庫、更新線上範本 | `publish-form` | 需線上模式；唯一寫入線上的流程，閘門 G3；離線時改走 `create-form`／`edit-form` 的輸出由使用者匯入 |
| 上線前檢查、AI 走閘道、做成 app／平板用 | `build-form-app` | B1：HIS 內執行的執行清單；B2：獨立 PWA（H0 本機 Docker 預設、H1 既有 struNote、H2 站台） |
| 問某個 LLM 模型能不能用 | `llmgateway_models`（有金鑰時）＋ `references/ModelWhitelist.md` | 沒金鑰時只能依靜態表回答並說明可能過時 |
| 問規則、問某個控制項怎麼寫 | 直接讀 `references/FormDesignRules.md`、`FormulaMacroRules.md`、`TablesTabsRules.md` 回答 | 不建 draft |

意圖不明確時用 `AskUserQuestion` 問一次，選項就是上表的前三列。

## 3. 所有流程共同遵守

- **安全不變量**：`references/SecurityInvariants.md`。重點：HIS 帳密只在站台登入頁（瀏覽器登入），金鑰只在環境變數；寫入一律兩段式；不碰病人資料除非使用者明確要求；不直連倉儲；禁用函數清單。
- **閘門**：`references/Gates.md`。閘門只由本 skill（或它載入的流程 skill）在對話中呈現；子代理（`form-planner`、`form-builder`、`form-reviewer`）是 headless 的，不能問使用者。核准後才可以建置或輸出。
- **MCP tool 名稱**：以 plugin 安裝時是 `mcp__plugin_strucmed_strucmed__<tool>`；在本 repo 內直接使用時是 `mcp__strucmed__<tool>`。文件一律只寫 `<tool>` 名稱（例如 `form_create`）。
- **交付格式**：流程結束時依 `create-form` §交付格式回報；有 AI 巨集時必列 `W_AI_DATAFLOW`，匯入後不要按「重新編號」。
