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

> `${CLAUDE_PLUGIN_ROOT}`＝plugin 根目錄。Codex 等不展開這個變數的工具：改用本 SKILL.md 所在 `skills/` 目錄的上一層（Codex 的 skill roots 表列出 `skills/` 的絕對路徑）。
> **不要 `cd`**：工作區＝工作目錄，`.strucmed/`、hooks、`preview.mjs` 都靠它找檔案。Bash 一律寫絕對路徑（`<workspace>/.strucmed/…`），`cd` 之後 hook 會找不到定稿檔。

這個 skill 只做三件事：確認環境、判定意圖、載入對應的流程。規則細節都在各流程 skill 與 `references/`，**不要**一次全部讀完。

## 1. 先確認環境（每次對話第一次進入時）

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-env.mjs" --workspace <workspace>
```

- `mode: offline`：只做離線流程（產生 `.htm` 由使用者匯入）。使用者要線上功能時，載入 `connect-strucmed`。
- `mode: online` 且尚未登入：先載入 `connect-strucmed` 完成 `online_login` → `online_me`。
- `runtime_web.available` 只是這個 shell 看到的結果（plugin 設定的「平台 web/ 副本」只有 MCP 讀得到），不是結論。預覽頁能不能用以 `form_preview`（`format: "html"`）回的 `runtime_available` 為準：`false` 時才告知「預覽頁不可用，審閱改在對話中進行」，並說明設定 `STRUCMED_RUNTIME_WEB` 的方法。
- 輸出裡的環境變數只有「是否設定」；**絕不**在對話中要求或複誦密碼、金鑰。
- **plugin 更新後 MCP 子行程不會自動換新**：`check-env` 的 `mcp_version` 是檔案上的版本，實際執行中的版本看 `form_export` 回傳的 `marker`（`strucmed-skill vX.Y.Z`）或 MCP 的 `initialize` serverInfo。兩者不同時請使用者執行 `/reload-plugins` 或重開 Claude Code，再繼續。

## 2. 依意圖分流（只載入一個）

| 使用者要做什麼 | 載入 | 備註 |
|---|---|---|
| 設計一張新表單 | `create-form` | 需求一次問完 → 草案直接建 draft → 預覽頁審閱迴圈 → 定稿 G2（驗證＋字典＋上架一次核准）→ 上架或輸出 |
| 以既有表單為範本改版、加欄位 | `edit-form` | 來源可以是使用者提供的 `.htm`／`.json`，或線上範本（`online_template_get`） |
| 預覽表單、看計算式與 HIS 文字輸出 | `verify-runtime` | 需要 draft 已存在；預設只給連結與文字輸出 |
| 這個欄位要綁哪個字典、別科有沒有現成的字典、幫字典寫補述、整理既有表單的字典讓別的表單引用 | `dictionary-assist` | 模式 1 找字典引用、2 G2 前以 CSV 補述、3 既有表單補述；寫入既有字典的補述要線上模式 |
| 改某一顆 LLM 按鈕的提示詞、AI 回覆不好、想試跑或比較模型 | `tune-prompt` | 需要 draft 與 itemid；試跑要 flag `llmChatTest` 與去識別化樣本 |
| 上架到編輯器／範本庫、更新線上範本 | `publish-form` | 定稿 G2 的執行段，可單獨對既有 draft 使用；唯一寫入線上的流程；離線時換成 `form_export` 由使用者匯入 |
| 上線前檢查、AI 走閘道、做成 app／平板用 | `build-form-app` | B1：HIS 內執行的執行清單；B2：獨立 PWA（H0 本機 Docker 預設、H1 既有 struNote、H2 站台） |
| 表單要自動提示、強調欄位、美化版面 | `edit-form`（既有表單）或 `create-form` | 欄位顏色字級底色用 `form_update_control` 的樣式欄位；區塊以上的樣式、即時提示、連動寫值、對照表、必填提醒是 `form_set_script` 的白名單片段，需 flag `formScript`（預設關；開文件自動跑巨集與表格加列另需 `formScriptAdvanced`）；規則 `references/ScriptAddonRules.md` |
| 問某個 LLM 模型能不能用 | `llmgateway_models`（有金鑰時）＋ `references/ModelWhitelist.md` | 沒金鑰時只能依靜態表回答並說明可能過時 |
| 問規則、問某個控制項怎麼寫 | 直接讀 `references/FormDesignRules.md`、`FormulaMacroRules.md`、`TablesTabsRules.md` 回答 | 不建 draft |

意圖不明確時用 `AskUserQuestion` 問一次，選項就是上表的前三列。

## 3. 所有流程共同遵守

- **安全不變量**：`references/SecurityInvariants.md`。重點：HIS 帳密只在站台登入頁（瀏覽器登入），金鑰只在環境變數；寫入一律兩段式；不碰病人資料除非使用者明確要求；不直連倉儲；禁用函數清單。
- **閘門**：`references/Gates.md`。建 draft 不用核准，定稿 G2 核准後才可以寫入線上或輸出。閘門只由本 skill（或它載入的流程 skill）在對話中呈現；子代理（`form-planner`、`form-builder`、`form-reviewer`）是 headless 的，不能問使用者。
- **對話長度**：草案摘要 ≤ 15 行、審閱每輪 ≤ 5 行、`review.md` 不貼回對話（`create-form` §1）。
- **MCP tool 名稱**：以 plugin 安裝時是 `mcp__plugin_strucmed_strucmed__<tool>`；在本 repo 內直接使用時是 `mcp__strucmed__<tool>`。文件一律只寫 `<tool>` 名稱（例如 `form_create`）。
- **交付格式**：流程結束時依 `create-form` §交付格式回報；有 AI 巨集時必列 `W_AI_DATAFLOW`，匯入後不要按「重新編號」。
