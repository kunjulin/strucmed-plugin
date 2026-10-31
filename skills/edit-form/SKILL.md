---
name: edit-form
description: >
  以既有 StrucMed 表單為範本改版：載入使用者提供的 .htm／.json 或線上範本（online_template_get），修改名稱、欄位、計算式、巨集，
  原表單所有結構原封保留，輸出為新表單。USE WHEN 使用者說「以這張表單為範本」「修改這張表單」「在原表單加欄位」「把 XX 表單改成…」。
  不處理：覆寫線上原範本、刪除範本、病人資料。
user-invocable: true
argument-hint: "<來源 .htm／.json 路徑或範本 ID> <要改什麼>"
allowed-tools: Read, Glob, Grep, AskUserQuestion, Task, Bash(node *)
---

# edit-form

細節規則：`references/RevisionWorkflow.md`。閘門與子代理分工與 `create-form` 相同（G1 表單計畫 → 建置 → 審查 → runtime 驗證 G2 → 輸出），差別只在起點是 `form_import`。

## 1. 取得來源

| 來源 | 做法 |
|---|---|
| 使用者提供的檔案（放在工作目錄內） | 編輯器「匯出範本套件 (v2)」的 `.htm`（最完整）、「匯出 JSON 文件」的 `.json`、舊版 `.htm` 都可以 |
| 線上範本（已登入） | `online_folder_list` 找到範本 → `online_template_get`（`template_id`、`save: true`）→ 得到 `.strucmed/online/<id>.package.json` |

## 2. 流程

1. `form_import`（`source_path`、**新名稱**、`dept_no`）。輸出是**新表單**，不沿用原 templateID；捷徑與作業別預設不沿用（沿用會與原表單在 HIS 清單重複），只有使用者明確要求時才以 `form_update_meta` 設定。
   **要更新同一張線上範本**（之後走 `publish-form` 的 `online_template_update`）：改帶 `for_update: true`，不必改名；名稱、捷徑、作業別、Info 上架時沿用線上值，只有用 `form_update_meta` 明確改的欄位才覆寫。
2. `form_preview`（tree）給使用者看原表單結構與 itemid，確認要改哪些地方。改動範圍小（只改文字、預設值、選項）時可以直接做，不需 planner；要新增區塊、控制項、計算式或巨集時走 `create-form` 的階段 2～G1（planner 的計畫只描述**新增與修改**的部分，並標註對應的原 itemid）。
3. **字典先找再建**（小改動也要做）：新增存檔欄位、改字典，或原表單有未綁字典的存檔欄位時，先 `online_dictionary_search(update_index:true)`，再對這些欄位跑 `dictionary_suggest`（`draft_id`＋`itemid`）。`confidence: high` 的候選寫進計畫建議綁定，範圍內沒有候選才找他科或新建，規則同 `agents/form-planner.md`。原欄位改綁字典會影響資料延續，一律先問使用者。
4. 依核准的計畫修改（由 `form-builder` 或本 skill 直接呼叫）：
   - `form_update_meta`：名稱、捷徑、作業別、Info
   - `form_update_control`：說明文字、預設值、必填、選項、字典（改版時先 `online_dictionary_search(update_index:true)`；原表單綁的是科部字典而體系有同名時，在計畫中**建議改綁體系字典**，使用者同意才改；改了 datatype、單位、選項或計算式的欄位，在計畫「### 字典補述」同步修改該字典的 memo；要換字典時用 `dictionary-assist` 模式 1 找候選；只想把原表單的字典補述補齊而不改表單時，改用 `dictionary-assist` 模式 3）；計算式、HIS 參照、巨集腳本（`references/FormulaMacroRules.md`；多步驟配方 `MacroRecipes.md`；prompt 寫法 `PromptPatterns.md`，只調 prompt 可改用 `tune-prompt`）
   - `form_add_control`：只能加在文字區塊與表格／頁籤的格子；itemid 自動接續原表單最大值
   - `form_add_area`：新增文字、表格、頁籤區塊（`references/TablesTabsRules.md`）
   - `form_remove_control`：兩段式確認；仍被參照的控制項會被拒絕，須先改參照方
5. `form_validate`：**本次改到的面向**有問題 → error，必須修正；原表單既有的問題 → warning（標示「原表單既有」），逐條告知但不擋輸出；`W_CUSTOM_JS`：原表單有自訂 JS，本工具未審查，要明確告知。
6. 有計算式、巨集、表格或頁籤變動時載入 `verify-runtime`（G2）。計算式帶 `draft_id` 跑 `formula_check`，依 `ref_dictionary` 與 `W_REF_*`、`W_SAMPLE_OUT_OF_RANGE` 確認。
7. `form_export` 兩段式。manifest 會列出「改版自」與本次改動的控制項（✎）。
8. **補述**：`form_fields`（`only: "dictionary"`）看本次改到的欄位用的字典，`missing_angles` 有缺且已登入時，提議走 `dictionary-assist` 模式 3。不用上架，非建立者也能補，寫入仍要核准與瀏覽器確認。

## 3. 限制（告訴使用者，請其匯入後在編輯器調整）

- 圖形、雙欄區塊內**不能新增**控制項（可以修改既有控制項的屬性）。
- 表單預設在匯入時只顯示筆數，不寫入。
- 要「更新線上原範本」：載入 `publish-form`，它會以 `online_template_update`（If-Match，flag `templateUpdate`）更新；draft 的來源必須就是該範本：`online_template_get(save:true)` 的套件，或 iot 的 `templateID`／`sheetid` 等於線上 ID 的 `.htm`（例如外部工具產生的舊版 `.htm`），以 `form_import(for_update:true)` 載入。否則輸出新表單由使用者匯入。
