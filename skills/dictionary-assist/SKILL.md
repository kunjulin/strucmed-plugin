---
name: dictionary-assist
description: >
  StrucMed 欄位字典助手：(1) 為存檔欄位、計算式、巨集、LLM prompt 找合適的字典並給引用方式；(2) 定稿 G2 前以 CSV 補述：字典一覽輸出成 CSV，AI 先起草新字典的補述
  （表單功能、使用情境、交換引用等 11 個欄位＋FHIR），使用者編輯後匯回；(3) 解析既有表單，為它用到的字典補上補述，讓之後的表單可以引用。
  USE WHEN 使用者說「這個欄位要綁哪個字典」「有沒有現成的字典」「別科有沒有」「幫字典寫補述／說明」「整理這張表單的字典」
  「讓別的表單可以引用」，或 create-form／edit-form 的審閱迴圈、G2 前、tune-prompt 需要選字典、寫補述時（建 draft 前的字典綁定由 form-planner 負責，不另外載入本 skill）。不處理：刪除或改名字典、升級為體系字典
  （由體系字典管理者在字典頁操作）、改別人寫的字典說明 desc、病人資料。
user-invocable: true
argument-hint: "find <draft_id> <itemid> | csv <draft_id> | annotate <template_id|.htm|draft_id>"
allowed-tools: Read, Write, AskUserQuestion, Task, Bash(node *), mcp__strucmed__form_fields, mcp__strucmed__dictionary_suggest, mcp__strucmed__dictionary_memo_check, mcp__strucmed__dictionary_search, mcp__strucmed__dictionary_create, mcp__strucmed__dictionary_plan_export, mcp__strucmed__dictionary_plan_import, mcp__strucmed__form_update_control, mcp__strucmed__form_import, mcp__strucmed__form_preview, mcp__strucmed__online_dictionary_search, mcp__strucmed__online_dictionary_usage, mcp__strucmed__online_dictionary_memo_set, mcp__strucmed__online_dictionary_memo_batch, mcp__strucmed__online_template_get, mcp__strucmed__online_folder_list, mcp__strucmed__online_me, mcp__plugin_strucmed_strucmed__form_fields, mcp__plugin_strucmed_strucmed__dictionary_suggest, mcp__plugin_strucmed_strucmed__dictionary_memo_check, mcp__plugin_strucmed_strucmed__dictionary_search, mcp__plugin_strucmed_strucmed__dictionary_create, mcp__plugin_strucmed_strucmed__dictionary_plan_export, mcp__plugin_strucmed_strucmed__dictionary_plan_import, mcp__plugin_strucmed_strucmed__form_update_control, mcp__plugin_strucmed_strucmed__form_import, mcp__plugin_strucmed_strucmed__form_preview, mcp__plugin_strucmed_strucmed__online_dictionary_search, mcp__plugin_strucmed_strucmed__online_dictionary_usage, mcp__plugin_strucmed_strucmed__online_dictionary_memo_set, mcp__plugin_strucmed_strucmed__online_dictionary_memo_batch, mcp__plugin_strucmed_strucmed__online_template_get, mcp__plugin_strucmed_strucmed__online_folder_list, mcp__plugin_strucmed_strucmed__online_me
---

# dictionary-assist

> **不要 `cd`**：工作區＝工作目錄，`.strucmed/`、hooks、`preview.mjs` 都靠它找檔案。Bash 一律寫絕對路徑（`<workspace>/.strucmed/…`），`cd` 之後 hook 會找不到定稿檔。

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
   - 綁定：`form_update_control`（`changes.dictionary: { id }`，用 `cite.bind`）；create-form／edit-form 的審閱迴圈中照它們的流程走。
   - 寫計算式、巨集：用 `cite.ref`（`A<itemid>`）引用欄位，計算式說明參考 `cite.calx`。
   - 寫 LLM prompt：欄位描述用 `cite.prompt`（即 `memo.llm`），交給 `tune-prompt`。
   - 沒有合適的：規劃新建字典（`dictionary.name`＋`dictionary.comment`），補述由模式 2 起草。
5. 選定的字典沒有補述或缺三個角度時，提議順手補（模式 3 的單本版：`online_dictionary_memo_set`）。仍是兩段式：第一次呼叫的 plan 原樣給使用者看、`AskUserQuestion` 核准後才帶 `confirm_token`；不帶 `draft_id` 時 hooks 不檢查計畫檔，核准只靠這一步與瀏覽器確認頁，不要省略。在 create-form／edit-form 流程中不單本寫入：改在 G2 前的 CSV 補述（模式 2，該列 `action` 改 `memo`）處理，到 G2 一起寫入。

## 模式 2：G2 前以 CSV 補述

create-form 階段 2（builder 建完、reviewer 之前）跑第 1、2 步，讓預覽卡片有內容；階段 4（定稿前）跑第 1、3、4 步；使用者要整理一個 draft 的字典時全跑。字典補述與 FHIR 不在草案裡：一張表單的字典集中成一份 CSV（欄位見 `references/DictionaryMemo.md` §5），用 Excel 看過一次就好；預覽頁卡片改的補述也會進來。

1. `dictionary_plan_export`（`draft_id`）→ `<workspace>/.strucmed/plans/<draft_id>/dictionaries.csv`，回 `file`、`rows`（HTTP 模式另回 `csv_text`）。一列一本字典，重跑會覆寫，不走兩段式。
2. **AI 先起草新字典**：新字典的補述只有建立時一次機會，所以 `action=new` 且補述是空的列要先寫。
   - `form_fields`（`draft_id`、`only: "dictionary"`）找 `dictionary.pending: true` 的欄位。超過 5 本時以 `Task` 啟動 `dictionary-annotator`，給它字典名稱清單；5 本以內自己寫。
   - 每本依 `DictionaryMemo.md` 寫滿 11 個欄位，只用 Big5 字（§3 的替代字表）：`func` 以 `derived.func` 為底改寫、`usecase` 依表單用途與作業別、`interop` 參考 `dictionary_suggest`（`full_memo: true`）找到的相似字典（同義、不同單位、不同選項集要寫出差別）；可對應 FHIR 的寫 `fhir`（驗證規則見 FormDesignRules）。
   - `dictionary_memo_check`（`memo`、`fhir`、`draft_id`、`itemid`）：error 修到沒有，warning 逐條處理或寫理由。
   - `dictionary_plan_import`（`draft_id`、`csv_text`＝完整表頭＋起草的列）寫進 draft，再 `dictionary_plan_export` 更新 CSV。`asr`（語音別名）多值以 `／` 分隔，表頭照匯出的 `asr（多值以／分隔）` 原樣保留；寫成 `;`、`,`、`|` 也會拆，但回 `W_ASR_DELIMITER`。
   - 既有字典不主動起草：補述缺的列在 G2 的「### 字典」標出，使用者要補才寫（`action` 改 `memo`，只補缺的鍵），這樣 G2 前不會多一大段工作。
3. **使用者編輯**：把 CSV 路徑告訴使用者，一句話說明能改什麼（`action`：`bind`／`new`／`memo`／`rebind:<id>`／`skip`；`desc` 只有新建可改；補述 11 格與 FHIR 可改；`note` 帶進 G2）。使用者不改就往下走，**不等**；Excel 與 Numbers 存回的 CSV 都能匯回。
4. **匯回**：使用者說改好時 `dictionary_plan_import`（`draft_id`、`csv_path`；HTTP 模式 `csv_text`）。只改本機 draft：
   - `applied`：逐本改了什麼。`action=new` 直接進 draft。
   - `memo_items`：既有字典的補述修改，不進 draft，依 `dic_id` 合併寫進 `<workspace>/.strucmed/plans/<draft_id>/memo-items.json`，G2 時以 `online_dictionary_memo_batch` 寫入（已經 G2 呈現過的話 `Revision` +1）。
   - `rebinds`：改綁的欄位，告知使用者。
   - `skipped`：error 的列沒有套用，列給使用者。`checks` 的 warning 進 G2。
   - `E_INVALID_INPUT`（缺必要欄）：請使用者保留表頭。`id` 欄不可改，要換字典用 `rebind:<id>`。

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
6. **核准**：使用者核准後執行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <workspace>/.strucmed/plans/<draft_id>/memo-plan.md --by <user_id>`，它會自己把「## 核准」段填成 Approved 並寫入時間與核准者（不要手填）。沒有這一步，hooks 會阻擋第二次呼叫。使用者沒有核准就不要執行 prepare。
7. **執行**：`online_dictionary_memo_batch`（同一份 `items`、`draft_id`、plan 的 `etags`、`confirm_token`）。回 `pending`（附 `approve_url`）時，請使用者在瀏覽器確認頁核對後按「確認寫入」，再帶同一個 `confirm_token` 呼叫一次；**不要替使用者確認**。回 `E_CONFLICT`（有字典在取得計畫後被改）：以 `details.stale` 的目前內容合併，Revision 加 1，重新給使用者核准。部分衝突（`W_PARTIAL_CONFLICT`）只對失敗的字典重做。
8. **收尾**：逐本回報成功與失敗；`online_dictionary_search`（`update_index: true`）重建索引；提醒「字典頁與編輯器的補述視窗看得到新內容；之後的表單用 dictionary_suggest 會引用它們」。有跨科共用的字典時，把它列進「體系升級建議」交給體系字典管理者（AI 不升級）。

## 誰能補

所有登入者都能補補述與 FHIR，不限字典建立者，也不用上架表單。別人的字典只補缺的鍵；要改別人寫的內容一律標「建議修改」，由使用者逐項決定。create-form、edit-form 交付前會提議走模式 3。

## 不做

- 刪除、改名字典；改別人寫的 `desc`；升級、降級、設定別名（體系字典管理者在字典頁操作）。
- 在補述中放任何病人資料。
- 未經使用者核准就寫入（補述計畫或 G2 定稿都要核准，第二次呼叫還要使用者在瀏覽器確認頁按確認）。
