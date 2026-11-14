---
name: edit-form
description: >
  以既有 StrucMed 表單為範本改版：載入使用者提供的 .htm／.json 或線上範本（online_template_get），修改名稱、欄位、計算式、巨集，
  原表單所有結構原封保留，在預覽頁審閱後經定稿閘門 G2 輸出為新表單或更新線上範本。USE WHEN 使用者說「以這張表單為範本」「修改這張表單」「在原表單加欄位」「把 XX 表單改成…」。
  不處理：覆寫線上原範本、刪除範本、病人資料。
user-invocable: true
argument-hint: "<來源 .htm／.json 路徑或範本 ID> <要改什麼>"
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Task, Bash(node *), mcp__strucmed__form_import, mcp__strucmed__form_preview, mcp__strucmed__form_validate, mcp__strucmed__formula_check, mcp__strucmed__form_add_area, mcp__strucmed__form_add_control, mcp__strucmed__form_update_control, mcp__strucmed__form_update_area, mcp__strucmed__form_update_meta, mcp__strucmed__form_move_control, mcp__strucmed__form_remove_control, mcp__strucmed__form_remove_area, mcp__strucmed__form_set_script, mcp__strucmed__form_fields, mcp__strucmed__form_review_read, mcp__strucmed__dictionary_search, mcp__strucmed__dictionary_suggest, mcp__strucmed__dictionary_plan_import, mcp__strucmed__online_template_get, mcp__strucmed__online_folder_list, mcp__strucmed__online_dictionary_search, mcp__plugin_strucmed_strucmed__form_import, mcp__plugin_strucmed_strucmed__form_preview, mcp__plugin_strucmed_strucmed__form_validate, mcp__plugin_strucmed_strucmed__formula_check, mcp__plugin_strucmed_strucmed__form_add_area, mcp__plugin_strucmed_strucmed__form_add_control, mcp__plugin_strucmed_strucmed__form_update_control, mcp__plugin_strucmed_strucmed__form_update_area, mcp__plugin_strucmed_strucmed__form_update_meta, mcp__plugin_strucmed_strucmed__form_move_control, mcp__plugin_strucmed_strucmed__form_remove_control, mcp__plugin_strucmed_strucmed__form_remove_area, mcp__plugin_strucmed_strucmed__form_set_script, mcp__plugin_strucmed_strucmed__form_fields, mcp__plugin_strucmed_strucmed__form_review_read, mcp__plugin_strucmed_strucmed__dictionary_search, mcp__plugin_strucmed_strucmed__dictionary_suggest, mcp__plugin_strucmed_strucmed__dictionary_plan_import, mcp__plugin_strucmed_strucmed__online_template_get, mcp__plugin_strucmed_strucmed__online_folder_list, mcp__plugin_strucmed_strucmed__online_dictionary_search
---

# edit-form

> **不要 `cd`**：工作區＝工作目錄，`.strucmed/`、hooks、`preview.mjs` 都靠它找檔案。Bash 一律寫絕對路徑（`<workspace>/.strucmed/…`），`cd` 之後 hook 會找不到定稿檔。

細節規則：`references/RevisionWorkflow.md`。流程、閘門、子代理分工與對話長度規範都與 `create-form` 相同（需求 → 草案建 draft → 審閱迴圈 → G2 定稿 → 交付；`create-form` §1 的表照用），差別只在起點是 `form_import`。

## 1. 取得來源

| 來源 | 做法 |
|---|---|
| 使用者提供的檔案（放在工作目錄內） | 編輯器「匯出範本套件 (v2)」的 `.htm`（最完整）、「匯出 JSON 文件」的 `.json`、舊版 `.htm` 都可以 |
| 線上範本（已登入） | `online_folder_list` 找到範本 → `online_template_get`（`template_id`、`save: true`）→ 得到 `.strucmed/online/<id>.package.json` |

## 2. 階段 1：需求與匯入

1. `form_import`（`source_path`、**新名稱**、`dept_no`）。輸出是**新表單**，不沿用原 templateID；捷徑與作業別預設不沿用（沿用會與原表單在 HIS 清單重複），只有使用者明確要求時才以 `form_update_meta` 設定。
   **要更新同一張線上範本**（之後走 `publish-form` 的 `online_template_update`）：改帶 `for_update: true`，不必改名；名稱、捷徑、作業別、Info 上架時沿用線上值，只有用 `form_update_meta` 明確改的欄位才覆寫。
2. 改動還沒說清楚時，`form_preview`（tree）看原表單結構與 itemid（不貼回對話，用文字說要改的那幾處），需要問的一次問完。HIS 接收端要固定鍵時用 `form_update_meta` 的 `his_text_keys`：這個設定存在 draft，不寫進表單，從線上取回的範本不會帶，有需要才問。
3. **字典先找再建**（小改動也要做）：新增存檔欄位、改字典，或原表單有未綁字典的存檔欄位時，先 `online_dictionary_search(update_index:true)`，再對這些欄位跑 `dictionary_suggest`（`draft_id`＋`itemid`）。`confidence: high` 的候選寫進草案建議綁定，範圍內沒有候選才找他科或新建，規則同 `agents/form-planner.md`。原欄位改綁字典會影響資料延續，一律先問使用者。

## 3. 階段 2：草案與修改（不停下來核准）

- **小改**（只改文字、預設值、選項）：本 skill 直接呼叫，不需 planner；用「草案摘要」的格式講一句改了什麼。沒有草案檔時，審查由本 skill 自己跑 `form_validate` 與 `formula_check`（做法同 `publish-form` 的驗證段）。
- **要新增區塊、控制項、計算式或巨集**：`Task(form-planner)` 產草案（只描述**新增與修改**的部分，標註對應的原 itemid），摘要 ≤ 15 行告知後直接 `Task(form-builder)`（沿用 `draft_id`）、`Task(form-reviewer)`。

修改工具：

- `form_update_meta`：名稱、捷徑、作業別、Info
- `form_update_control`：說明文字（頂層 `label_text`，`changes` 內沒有 caption）、單位（`changes.unit`）、預設值、必填、選項、字典（改版時先 `online_dictionary_search(update_index:true)`；原表單綁的是科部字典而體系有同名時，**建議改綁體系字典**，使用者同意才改；改了 datatype、單位、選項或計算式的欄位，該字典的 memo 列入 G2 前的補述；要換字典時用 `dictionary-assist` 模式 1 找候選；只想把原表單的字典補述補齊而不改表單時，改用 `dictionary-assist` 模式 3）；計算式、HIS 參照、巨集腳本（`references/FormulaMacroRules.md`；多步驟配方 `MacroRecipes.md`；prompt 寫法 `PromptPatterns.md`，只調 prompt 可改用 `tune-prompt`）
- `form_add_control`：只能加在文字區塊與表格／頁籤的格子；itemid 自動接續原表單最大值；`after_itemid` 指定位置
- `form_add_area`：新增文字、表格、頁籤區塊（`references/TablesTabsRules.md`）；`after_itemid` 插在指定區塊之後
- 嵌入頁面（flag `embedArea`；工具清單的 `form_add_area` type 有 `embed` 才可用）：`form_add_area`（`type: "embed"`）新增、`form_update_area` 改 `url`／`params`／`height`／`inputs`／`outputs`、`form_remove_area` 刪；按鈕開頁面用巨集 `OPENPANEL`（`MacroRecipes.md` R10）。**原表單的 embed 與 OPENPANEL 不論 flag 一律原封保留**並檢查（原表單既有的 `E_EMBED_*` 是 warning）；flag 關閉時不能改它們的設定。被 embed 的 `inputs`／`outputs` 參照的欄位不能刪。G2 必列 `W_EMBED_DATAFLOW`（主機、參數、寫回欄位）。規則見 `references/FormDesignRules.md`〈嵌入頁面〉
- `form_move_control`：搬欄位到別的區塊或位置（itemid 不變，參照不受影響）
- `form_update_area`：改區塊標題、可見標題、隱藏；`titles` 改頁籤名稱（HIS 文字鍵）、增減頁籤；`form_remove_area`：刪空區塊
- `form_update_control` 的 `font_color`／`font_size`／`back_color`：欄位顏色、字級、底色（不需 flag）；`form_set_script`（flag `formScript`）：區塊以上的樣式、即時提示、連動寫值、對照表、必填提醒片段（進階的開文件自動跑巨集與表格加列另需 `formScriptAdvanced`），整份取代，規則見 `references/ScriptAddonRules.md`。原表單既有的 JS 原封保留（`W_CUSTOM_JS`；flag 開啟時另掃禁用 token 列 `W_CUSTOM_JS_FINDINGS`，只告知），片段接在它後面；使用者要「換成片段」時必須明確選擇捨棄原 JS，本工具不自動改
- `form_remove_control`：兩段式確認；仍被參照的控制項會被拒絕，須先改參照方

`form_validate`：**本次改到的面向**有問題 → error，必須修正；原表單既有的問題 → warning（標示「原表單既有」），在 G2 逐條列出但不擋輸出；`W_CUSTOM_JS`：原表單有自訂 JS，本工具未審查，G2 要明確告知。計算式帶 `draft_id` 跑 `formula_check`，依 `ref_dictionary` 與 `W_REF_*`、`W_SAMPLE_OUT_OF_RANGE` 確認。

## 4. 階段 3：審閱迴圈

同 `create-form` §4：`form_preview(html)` 與 `verify-runtime` 給連結 → 使用者在預覽頁看 → `form_review_read` → 三類處理（`references/ReviewLoop.md` §1）→ 重新 `form_preview(html, applied_seq)` → 每輪 ≤ 5 行。沒有預覽頁時退回對話。

大改結構走 `references/ReviewLoop.md` §2〈重建流程〉，差別只有第 3 步：**重新 `form_import`**（同來源、同 `for_update`）得到新 `draft_id`，builder 在新 draft 上重做，舊 draft 保留不刪。`form_import` 沒有 `from_draft_id`，補述一律走第 4 步的 CSV。

## 5. 階段 4、5：定稿 G2 與交付

同 `create-form` §5、§6，閘門是 G2；輸出時 manifest 會列出「改版自」與本次改動的控制項（✎）。

- 小改沒有草案檔時，最後一輪由 `publish-form` 的驗證段代替 reviewer。
- 字典 CSV 匯回（`dictionary_plan_import`）也算改 draft：最後一輪 reviewer 排在匯回之後，同 `create-form` §5 第 1 步。
- 有片段時同 `create-form` §5 第 2 步（guard／derive／lookup／required 必跑、autorun 看送出了什麼、style 截圖），定稿檔「### 表單 JS」放 plan 的 `script.rendered` 原樣。
- 更新線上範本：`plan.meta`、`plan.diff` 與 `W_UNPUBLISH`、`W_META_RENAME`、`W_ONLINE_CHANGED_SINCE_SOURCE` 都進定稿檔，規則見 `publish-form`。
- **補述**：`form_fields`（`only: "dictionary"`）看本次改到的欄位用的字典，`missing_angles` 有缺且已登入時，列進 G2 前的 CSV（`dictionary-assist` 模式 2）。使用者不想這次處理就留給 `dictionary-assist` 模式 3：不用上架，非建立者也能補，寫入仍要核准與瀏覽器確認。

## 6. 限制（告訴使用者，請其匯入後在編輯器調整）

- 圖形、雙欄區塊內**不能新增**控制項（可以修改既有控制項的屬性）。
- 表單預設在匯入時只顯示筆數，不寫入。
- 要「更新線上原範本」：draft 的來源必須就是該範本：`online_template_get(save:true)` 的套件，或 iot 的 `templateID`／`sheetid` 等於線上 ID 的 `.htm`（例如外部工具產生的舊版 `.htm`），以 `form_import(for_update:true)` 載入，`publish-form` 以 `online_template_update`（If-Match，flag `templateUpdate`）更新。否則輸出新表單由使用者匯入。
