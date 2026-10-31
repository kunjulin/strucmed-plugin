---
name: dictionary-assist
description: >
  StrucMed 欄位字典助手：(1) 為存檔欄位、計算式、巨集、LLM prompt 找合適的字典並給引用方式；(2) 為新建字典寫完整的 AI 補述
  （表單功能、使用情境、交換引用等 11 個欄位＋FHIR）；(3) 解析既有表單，為它用到的字典補上補述，讓之後的表單可以引用。
  USE WHEN 使用者說「這個欄位要綁哪個字典」「有沒有現成的字典」「別科有沒有」「幫字典寫補述／說明」「整理這張表單的字典」
  「讓別的表單可以引用」，或 create-form／edit-form／tune-prompt 需要選字典、寫補述時。不處理：刪除或改名字典、升級為體系字典
  （由體系字典管理者在字典頁操作）、改別人寫的字典說明 desc、病人資料。
user-invocable: true
argument-hint: "find <draft_id> <itemid> | new <draft_id> | annotate <template_id|.htm|draft_id>"
allowed-tools: Read, Write, AskUserQuestion, Task, Bash(node *), mcp__strucmed__form_fields, mcp__strucmed__dictionary_suggest, mcp__strucmed__dictionary_memo_check, mcp__strucmed__dictionary_search, mcp__strucmed__dictionary_create, mcp__strucmed__form_update_control, mcp__strucmed__form_import, mcp__strucmed__form_preview, mcp__strucmed__online_dictionary_search, mcp__strucmed__online_dictionary_usage, mcp__strucmed__online_dictionary_memo_set, mcp__strucmed__online_dictionary_memo_batch, mcp__strucmed__online_template_get, mcp__strucmed__online_folder_list, mcp__strucmed__online_me, mcp__plugin_strucmed_strucmed__form_fields, mcp__plugin_strucmed_strucmed__dictionary_suggest, mcp__plugin_strucmed_strucmed__dictionary_memo_check, mcp__plugin_strucmed_strucmed__dictionary_search, mcp__plugin_strucmed_strucmed__dictionary_create, mcp__plugin_strucmed_strucmed__form_update_control, mcp__plugin_strucmed_strucmed__form_import, mcp__plugin_strucmed_strucmed__form_preview, mcp__plugin_strucmed_strucmed__online_dictionary_search, mcp__plugin_strucmed_strucmed__online_dictionary_usage, mcp__plugin_strucmed_strucmed__online_dictionary_memo_set, mcp__plugin_strucmed_strucmed__online_dictionary_memo_batch, mcp__plugin_strucmed_strucmed__online_template_get, mcp__plugin_strucmed_strucmed__online_folder_list, mcp__plugin_strucmed_strucmed__online_me
---

# dictionary-assist

欄位字典是表單存檔、計算式、巨集、LLM prompt 的共同語言。這個 skill 讓 AI 能**找到並引用**合適的字典，並把字典的**補述**寫完整，讓下一張表單也能引用。

規則：`references/DictionaryMemo.md`（11 個補述欄位怎麼寫、三個角度、合併規則）、`references/FormDesignRules.md`〈字典說明、補述與層級〉（誰能改哪一段、綁定順序）、`references/SecurityInvariants.md`（不碰病人資料；字典使用索引只有範本名稱與欄位 id）。

## 0. 準備

1. 線上模式：`online_me`（未登入 → 載入 `connect-strucmed`）。`online_dictionary_search`（`update_index: true`，不帶 `q`）建本機索引，記下回應的 `memo_keys`：沒有 `func`／`usecase`／`interop` 表示站台還是舊版，這三格不會寫入（告知使用者）。
2. `online_dictionary_usage`（不帶 `dic_id`）把各字典的使用表單數寫進索引，供排序。回 `W_USAGE_NOT_SCANNED` 時告知「平台還沒開使用索引，推薦不會考慮多少表單在用」，繼續。
3. 離線：只能用 `dictionary_load` 的 CSV 索引做模式 1、2 的離線部分，寫入改由使用者在字典頁操作。

依使用者意圖選一種模式（不明確時用 `AskUserQuestion` 問一次）。

## 模式 1：找字典引用

1. 有 draft 時 `form_fields`（`draft_id`、`itemids`）取欄位事實；沒有 draft 時請使用者描述欄位（說明文字、datatype、單位、選項、用途）。
2. `dictionary_suggest`（`draft_id`＋`itemid`，或 `field`）。沒有候選或分數都很低時：`online_dictionary_search`（`scope: "all"`、`q`: 關鍵字、`update_index: true`）把別科的字典併進索引，再 `dictionary_suggest`（`include_other: true`）。
3. 呈現前 3–5 名：名稱、層級（體系優先）、說明、補述摘要（type／unit／range／func）、幾張表單在用（需要時 `online_dictionary_usage(dic_id)` 列出表單名稱）、`reasons`。標出：沒有補述的、單位或型別不符的、他體系的（level=other：可以以 id 綁定，但不在本科部的名稱比對範圍）。
4. 使用者選定後：
   - 綁定：`form_update_control`（`changes.dictionary: { id }`，用 `cite.bind`）；已在 G1 計畫中的修改照 create-form／edit-form 的流程走。
   - 寫計算式、巨集：用 `cite.ref`（`A<itemid>`）引用欄位，計算式說明參考 `cite.calx`。
   - 寫 LLM prompt：欄位描述用 `cite.prompt`（即 `memo.llm`），交給 `tune-prompt`。
   - 沒有合適的：規劃新建字典（模式 2）。
5. 選定的字典沒有補述或缺三個角度時，提議順手補（模式 3 的單本版：`online_dictionary_memo_set`）。

## 模式 2：新建字典的完整補述

用在 create-form／edit-form 的 G1 之前（form-planner 規劃了待新建字典），或使用者對 draft 的待新建字典要求補述。

1. `form_fields`（`draft_id`、`only: "dictionary"`），找 `dictionary.pending: true` 的欄位。
2. 每本字典依 `DictionaryMemo.md` 寫滿 11 個欄位：`func` 以 `derived.func` 為底改寫、`usecase` 依表單用途與作業別、`interop` 參考 `dictionary_suggest` 找到的相似字典（同義、不同單位、不同選項集要寫出差別）；可對應 FHIR 的寫 `fhir`（驗證規則見 FormDesignRules）。
3. `dictionary_memo_check`（`memo`、`fhir`、`draft_id`、`itemid`）：error 修到沒有，warning 逐條處理或寫理由。
4. 寫進 G1 計畫的「### 待新建字典」與「### 字典補述」（`references/Gates.md` §2）；建置時以 `dictionary.memo` 帶入（form-builder 照抄），上架時 `online_dictionary_batch`／`create` 一起寫入。

## 模式 3：既有表單的字典補述

1. **取得表單**（只解析，不改、不上架）：
   - 線上範本：`online_folder_list` 找到 → `online_template_get`（`save: true`）→ `form_import`（`source_path`＝存檔路徑、`dept_no`、`for_update: true`）。
   - 使用者給的 `.htm`／`.json`：`form_import`（`for_update: true`；沒有 templateID 時改帶一個新名稱、不帶 for_update）。
   - 已有 draft：直接用。
2. `form_fields`（`only: "dictionary"`）。`W_DICT_NOT_IN_INDEX` 的字典（他科字典）用 `online_dictionary_search`（`scope: "all"`、`q`: 名稱、`update_index: true`）補進索引後再呼叫一次。`stats.missing_angles` 是要補的本數。
3. 每本要補的字典：`online_dictionary_usage(dic_id)` 看還有哪些表單在用（usecase 與 func 寫共通的部分）。
4. **起草**：字典超過 5 本時以 `Task` 啟動 `dictionary-annotator`（headless），給它 `draft_id`、要補的字典 id 清單、輸出路徑 `<workspace>/.strucmed/plans/<draft_id>/memo-draft.md`；它回 `Status` 與檔案路徑。5 本以內自己寫。原則：**只補缺的欄位、不覆寫別人寫的內容**；原內容看起來有誤時列「建議修改」與理由。
5. **補述計畫（閘門）**：寫 `<workspace>/.strucmed/plans/<draft_id>/memo-plan.md`：

   ```markdown
   # <表單名稱> 字典補述計畫

   ## 補述計畫
   <!-- gate: dictionary-assist:memo | category=write | cancel-leaves=nothing -->
   Status: Ready
   Revision: 1

   | 字典 | 層級 | 使用表單數 | 目前補述作者（`memo_by`） | 動作（補充／建議修改） | 補上的欄位 | 內容摘要 |
   |---|---|---|---|---|---|---|

   ### 逐本內容
   （每本：改前 memo／改後 memo，FHIR 有改時一併列出；W_ 警告）

   ### 警告
   - …

   ## 核准
   Status: Pending
   Approved-Revision:
   Approved-At:
   Approved-By:
   ```

   先以 `online_dictionary_memo_batch`（`items`、`draft_id`，不帶 `confirm_token`）取得 plan，把 plan 的逐本改前／改後與 `no_change` 對照寫進計畫檔。在對話中呈現同一份內容，`AskUserQuestion`：核准（建議）／要求修改／取消。
6. **核准**：改「## 核准」為 Approved → `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <memo-plan.md> --by <user_id>`。沒有這一步，hooks 會阻擋第二次呼叫。不要自己把計畫標成 Approved。
7. **執行**：`online_dictionary_memo_batch`（同一份 `items`、`draft_id`、plan 的 `etags`、`confirm_token`）。回 `pending`（附 `approve_url`）時，請使用者在瀏覽器確認頁核對後按「確認寫入」，再帶同一個 `confirm_token` 呼叫一次；**不要替使用者確認**。回 `E_CONFLICT`（有字典在取得計畫後被改）：以 `details.stale` 的目前內容合併，Revision 加 1，重新給使用者核准。部分衝突（`W_PARTIAL_CONFLICT`）只對失敗的字典重做。
8. **收尾**：逐本回報成功與失敗；`online_dictionary_search`（`update_index: true`）重建索引；提醒「字典頁與編輯器的補述視窗看得到新內容；之後的表單用 dictionary_suggest 會引用它們」。有跨科共用的字典時，把它列進「體系升級建議」交給體系字典管理者（AI 不升級）。

## 誰能補

所有登入者都能補補述與 FHIR，不限字典建立者，也不用上架表單。別人的字典只補缺的鍵；要改別人寫的內容一律標「建議修改」，由使用者逐項決定。create-form、edit-form 交付前會提議走模式 3。

## 不做

- 刪除、改名字典；改別人寫的 `desc`；升級、降級、設定別名（體系字典管理者在字典頁操作）。
- 在補述中放任何病人資料。
- 未經使用者核准就寫入（補述計畫或上架計畫都要核准，第二次呼叫還要使用者在瀏覽器確認頁按確認）。
