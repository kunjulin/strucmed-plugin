---
name: create-form
description: >
  依「表單目的、目標科部／作業別、既有字典」設計一張新的 StrucMed 表單：需求訪談 → 表單計畫（閘門 G1）→ 建置 → 審查 → runtime 驗證（閘門 G2）→
  輸出可匯入的 .htm 與 manifest。USE WHEN 使用者要「做一張新的 XX 表單／評估單／紀錄單」。既有表單改版請用 edit-form。
  不處理：病人資料、刪除或覆寫線上表單、在對話中要求密碼。
user-invocable: true
argument-hint: "<表單目的與臨床情境>"
allowed-tools: Read, Glob, Grep, AskUserQuestion, Task, Bash(node *)
---

# create-form

> `${CLAUDE_PLUGIN_ROOT}`＝plugin 根目錄。Codex 等不展開這個變數的工具：改用本 SKILL.md 所在 `skills/` 目錄的上一層（Codex 的 skill roots 表列出 `skills/` 的絕對路徑）。

以本機 MCP `strucmed` 產生定義檔；**使用者本人**在編輯器「匯入表單（及字典）」後檢視並保存。預設不連線、不處理帳密、不接觸病人資料。
規則依據：`references/FormDesignRules.md`（控制項推論、字典、必填、禁止事項）、`references/FormulaMacroRules.md`（計算式、HIS 參照、巨集、LLM 按鈕）、`references/TablesTabsRules.md`（表格與頁籤）。閘門格式：`references/Gates.md`。

## 1. 需求（缺一不可，不要自行假設）

| 輸入 | 必要 | 備註 |
|---|---|---|
| 表單目的 | ✓ | 臨床情境、使用者、要收集什麼、要帶回 HIS 的文字 |
| 目標科部代碼 `dept_no` | ✓ | 線上模式用 `online_me` 的 `dept_no`；離線時請使用者提供登入編輯器時填的 deptno |
| 作業別 | ✓ | 門／住／急／手術／檢查／助手／All；**測試表單不設** |
| 字典來源 | 建議 | 線上：`online_dictionary_search`（`update_index: true`，不帶 `q`）；離線：字典頁選單「Export」匯出的 CSV → `dictionary_load`（「批次匯出所選」沒有 id，不能用） |
| 是否正式上架 | ✓ | 否 → 不設捷徑與作業別 |
| AI／巨集需求 | 有才問 | 觸發（按鈕、輸入後自動、開表單帶入）、輸入來源（欄位、HIS 天數、影像、錄音）、輸出欄位與是否回 HIS；配方見 `references/MacroRecipes.md` §2 |

一次用 `AskUserQuestion` 問完缺的項目，不要分多輪。

## 2. 流程

```
階段 1 需求（本 skill，對話）
階段 2 規劃  → Task(form-planner)  → <workspace>/.strucmed/plans/<slug>/strucmed-form-plan.md
▶ G1「## 表單計畫」（本 skill 呈現；核准後 node scripts/verify-plan.mjs prepare）
階段 3 建置  → Task(form-builder)  → draft（itemid 回填計畫「建置對照表」）
階段 4 審查  → Task(form-reviewer) → review.md；NeedsRevision 回 builder（≤2 輪）
階段 5 runtime 驗證 → 載入 verify-runtime（有計算式／巨集／表格／頁籤時必做）
▶ G2「## 驗證結果」（本 skill 呈現）
階段 6 輸出  → form_export 兩段式（plan 原樣給使用者 → confirm_token）
階段 7 交付
```

### 階段 2：規劃
- 用 `Task` 啟動 `form-planner`（headless，唯讀）。給它：需求摘要、`dept_no`、作業別、是否上架、字典索引是否已載入、工作目錄。
- 它回傳計畫檔路徑與 `Status`。`Blocked` → 把它列的問題問使用者後重跑；`NeedsRevision` → 依它的建議補需求。
- 計畫以穩定 ID（區塊 `A1…`、控制項 `C1…`）描述；此時**沒有 itemid**。

### G1：表單計畫
- 把計畫檔的「## 表單計畫」原樣呈現（表格、計算式與巨集摘要、AI 資料流、待新建字典）。
- 選項固定：核准（建議）／要求修改／取消。要求修改 → 改需求、`Revision` +1、重跑 planner。
- 核准後：
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <plan.md> --by <online_me.user_id 或 local>
  ```
  並在計畫檔補「## 核准」段（格式見 `Gates.md`）。**沒有這一步不得建置。**

### 階段 3：建置
- `Task(form-builder)`，給它計畫檔路徑。它會先 `verify-plan.mjs verify`，不符就拒絕並回報。
- 單一 builder、依計畫順序建：`form_create` → 逐區塊 `form_add_area` → 逐欄 `form_add_control`（說明文字＋控制項＋換行）→ 計算式與巨集 `form_update_control` → 表格／頁籤的格子最後。
- itemid 由 MCP 依建立順序分配（區塊與控制項共用、從 1 起），`further`／`A<itemid>`／`action_id` 都依賴順序，所以**不平行**。builder 把每個 `C*` 對應的 itemid 回填計畫「建置對照表」。

### 階段 4：審查
- `Task(form-reviewer)`，給它計畫檔與 `draft_id`。它跑 `form_validate`、`formula_check`、`form_preview(tree)`，比對計畫 ↔ draft，檢查模型名稱、AI 資料流、疑似個資，寫 `review.md` 並回 `Status`。
- `NeedsRevision`：把它列的項目交回 builder 修正；兩輪仍未過就改變假設（例如換控制項型別）並告訴使用者。
- error 必須修；warning 逐條向使用者說明。prompt 的 `W_PROMPT_*` 要附 `references/PromptPatterns.md` 的改法；使用者想反覆調整某一顆按鈕的 prompt 或試跑模型時，建議之後用 `/strucmed:tune-prompt`。

### 階段 5：runtime 驗證
- 有計算式、HIS 參照、巨集、表格或頁籤時載入 `verify-runtime`。它會把「輸入 → 結果」對照表、LLM prompt 摘要、被封鎖的請求與截圖交給使用者。
- `runtime_available: false` 時跳過，並明確告知使用者。

### G2：驗證結果
- 呈現對照表與截圖；使用者要調整 → 修改 draft（`form_update_control`）後重跑階段 4、5；若改動計畫結構 → 回 G1（核准失效，`Revision` +1）。

### 階段 6：輸出或上架
- 線上模式且使用者要上架 → 載入 `publish-form`（閘門 G3，經 API 新建範本）。
- 否則 `form_export` 第一次（不帶 token）→ 把 `plan` 原樣呈現 → 使用者同意後帶 `confirm_token` 第二次呼叫。
- 已存在同名輸出時 `E_OUTPUT_EXISTS`：問使用者是否覆寫（`overwrite: true`）。

## 3. 交付格式

1. 結構預覽（tree）。
2. 字典：綁定既有（名稱／id 前 8 碼／角色）與待新建清單。
3. 驗證警告與處理建議；`W_AI_DATAFLOW`（哪些欄位會送到 LLM／語音服務）必列。
4. 輸出檔（`.htm` 內含範本套件 v2、`.package.json`）與 `*.manifest.md`（含匯入步驟與保存前確認清單）的路徑。支援 v2 的編輯器匯入時會預填名稱、捷徑、作業別、Info，**有捷徑＋作業別＝保存後上架**，務必提醒使用者確認。
5. 提醒：先按「新增表單」並確認 sheetID 空白再匯入；有新字典時**必須**「匯入表單及字典」；匯入後不要按「重新編號」；保存前逐一檢查區塊人形圖示。

## 4. 新產生的表單不支援

圖片、雙欄、群組、彈出片語、子表單綁定（改版時原封保留）。告訴使用者請其匯入後在編輯器手動補，或改用 `edit-form`。
