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

### 小改動快速路徑（門檻照下表判斷，不要臨場評估）

本次改動同時符合**全部**六項時，**不啟動 `form-planner`**：本 skill 直接呼叫（新增區塊與欄位用一次 `form_build(draft_id)`，只改既有欄位用 `form_update_control`），`form-reviewer` 只跑一輪（§5 的最後一輪，或由 `publish-form` 的驗證段代替）。

| 門檻 | 值 |
|---|---|
| 本次新增的區塊數 | ≤ 1 |
| 本次新增或修改的控制項數 | ≤ 6 |
| 新增巨集／LLM 按鈕 | 無 |
| 新增表單 JS 片段（`form_set_script`） | 無 |
| 新增嵌入頁面（embed／`OPENPANEL`） | 無 |
| 待新建字典 | 無（新增的存檔欄位都綁得到既有字典） |

- 快速路徑仍然要做的：第 2 節的「字典先找再建」、改到的計算式先 `formula_check`、改完 `form_validate`（本次改到的面向有問題就是 error）、照常開預覽頁審閱、照常走 G2。省掉的只有草案檔與 reviewer 的中間輪次。
- 沒有草案檔時，審查由本 skill 自己跑 `form_validate` 與 `formula_check`（做法同 `publish-form` 的驗證段），「### 審閱修改紀錄」改記在 `<workspace>/.strucmed/plans/<draft_id>/changes.md`。
- **任何一項超過門檻就走下面的三代理流程**，不要折中。

### 門檻以上

- `Task(form-planner)` 產草案（只描述**新增與修改**的部分，標註對應的原 itemid），摘要 ≤ 15 行告知後直接 `Task(form-builder)`（沿用 `draft_id`，它以一次 `form_build(draft_id)` 建完新增的部分）、`Task(form-reviewer)`。

修改工具：

- `form_build`（`draft_id`）：一次加完新的區塊與欄位（含計算式與巨集；參照用 `{C3}` 寫穩定 ID，既有欄位直接寫 itemid）。失敗時照 `details.build` 接著修，不要整張重來。加在既有欄位中間、或只改一兩個欄位時用下面的單筆 tool
- `form_update_meta`：名稱、捷徑、作業別、Info、表單選項（`options`）
- 非病人表單（`references/FormDesignRules.md`〈非病人表單〉）：`form_import` 回 `no_patient: true` 表示原表單就是非病人表單，選項原樣保留，新增的內容不得有 HIS 參照、`HISQUERY`、`LOOKUPDW`、讀取型字典角色、`G_CHTNO()`、嵌入頁 `{chtno}`／`{opdno}`（`E_NOPATIENT_*`）。使用者要把與病人無關的既有表單改成非病人表單時，先說明取捨（含：紀錄只有本人查得到、HIS 內不能存檔所以要拿掉作業別、原本以病歷號存的舊紀錄不會出現在資料下載裡）再 `form_update_meta(options: { no_patient: true })`（一併關閉依病歷號查近期紀錄、隱藏「上次紀錄」圖示、開啟「開啟時自動取出」）；之後既有的違規也都是 error，逐項與使用者確認移除或改寫，不要自行刪欄位。需求明顯與病人無關而原表單不是非病人表單時，在階段 1 提出這個選項（同 `create-form` §2）。
- `form_update_control`：說明文字（頂層 `label_text`，`changes` 內沒有 caption）、單位（`changes.unit`）、預設值、必填、選項、字典（改版時先 `online_dictionary_search(update_index:true)`；原表單綁的是科部字典而體系有同名時，**建議改綁體系字典**，使用者同意才改；改了 datatype、單位、選項或計算式的欄位，該字典的 memo 列入 G2 前的補述；要換字典時用 `dictionary-assist` 模式 1 找候選；只想把原表單的字典補述補齊而不改表單時，改用 `dictionary-assist` 模式 3）；計算式、HIS 參照、巨集腳本（`references/FormulaMacroRules.md`；多步驟配方 `MacroRecipes.md`；prompt 寫法 `PromptPatterns.md`，只調 prompt 可改用 `tune-prompt`）
- `form_add_control`：只能加在文字區塊與表格／頁籤的格子；itemid 自動接續原表單最大值；`after_itemid` 指定位置
- `form_add_area`：新增文字、表格、頁籤區塊（`references/TablesTabsRules.md`）；`after_itemid` 插在指定區塊之後
- 嵌入頁面（flag `embedArea`；工具清單的 `form_add_area` type 有 `embed` 才可用；改 `height` 或使用者說嵌入頁有捲軸、沒寫回時先讀 `references/EmbedPageContract.md`）：`form_add_area`（`type: "embed"`）新增、`form_update_area` 改 `url`／`params`／`height`／`inputs`／`outputs`、`form_remove_area` 刪；按鈕開頁面用巨集 `OPENPANEL`（`MacroRecipes.md` R10）。**原表單的 embed 與 OPENPANEL 不論 flag 一律原封保留**並檢查（原表單既有的 `E_EMBED_*` 是 warning）；flag 關閉時不能改它們的設定。被 embed 的 `inputs`／`outputs` 參照的欄位不能刪。G2 必列 `W_EMBED_DATAFLOW`（主機、參數、寫回欄位）。規則見 `references/FormDesignRules.md`〈嵌入頁面〉
- 附件容器（flag `attachBox`；工具清單的 `form_add_control` datatype 有 `attachbox` 才可用）：`form_add_control`（`datatype: "attachbox"`）新增、`form_update_control` 改提示文字（`datavalue`）與 `attach_kinds`／`attach_max`／`attach_pages`；送給 LLM 用巨集 `LLMATTACH`（`MacroRecipes.md` R11）。flag 關閉時原表單的容器與巨集原樣保留
- LLM 模型（`references/ModelWhitelist.md` §3、§5）：原表單的巨集用了 qwen 系列（落日模型：院方建議不採用，2027-01-01 自 LlmGateway 下架）時，`form_validate` 對這次沒動到的巨集回 `W_LLM_MODEL_SUNSET`（附替代寫法）——**主動告訴使用者有哪幾顆、建議這次一併換成 `nemotron35`／`tnemotron35`**（固定格式 `tnemotron35-low`；只經院內 LlmGateway，`W_LLM_MODEL_GATEWAY_ONLY`），換完用 `tune-prompt` 或編輯器預覽重看回覆。只要改到該巨集（腳本、按鈕名稱、寫入目標），`form_update_control` 會以 `E_LLM_MODEL_SUNSET` 拒絕，必須同時換模型；新增的巨集一律不得用 qwen。2027-01-01 起改為 `E_LLM_MODEL_DEPRECATED`。
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
- 非病人表單：plan 的 `no_patient` 進定稿檔「### 上架」，交付時列 `create-form` §6 第 3b 點；這次才設成非病人表單並更新線上範本時，`plan.diff` 會列「表單選項（iot）」變更。
- **補述**：`form_fields`（`only: "dictionary"`）看本次改到的欄位用的字典，`missing_angles` 有缺且已登入時，列進 G2 前的 CSV（`dictionary-assist` 模式 2）。使用者不想這次處理就留給 `dictionary-assist` 模式 3：不用上架，非建立者也能補，寫入仍要核准與瀏覽器確認。

## 6. 限制（告訴使用者，請其匯入後在編輯器調整）

- 圖形、雙欄區塊內**不能新增**控制項（可以修改既有控制項的屬性）。
- 表單預設（片語，F6）是使用者存下的填寫值，可能含病人資料：`online_template_get` 取回的套件**不含片語**（`presets` 固定 `[]`；回 `W_SITE_PRESETS_UNSUPPORTED` 表示站台是舊版、由本工具在本機清除，照常繼續即可），`.htm`／`.json` 來源的片語 `form_import` 預設**不帶入**（回 `presets_dropped`），上架也不寫入。使用者明確要把片語帶進匯出套件時才帶 `keep_presets: true`；`form_validate` 回片語的 `E_PHI_SUSPECT` 時以 `form_update_meta(drop_presets: true)` 移除，不要手改 draft JSON，也不要把片語內容貼進對話或計畫。
- 要「更新線上原範本」：draft 的來源必須就是該範本：`online_template_get(save:true)` 的套件，或 iot 的 `templateID`／`sheetid` 等於線上 ID 的 `.htm`（例如外部工具產生的舊版 `.htm`），以 `form_import(for_update:true)` 載入，`publish-form` 以 `online_template_update`（If-Match，flag `templateUpdate`）更新。否則輸出新表單由使用者匯入。
