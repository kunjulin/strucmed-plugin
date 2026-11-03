---
name: publish-form
description: >
  定稿閘門 G2 的執行段：把驗證結果、HIS 文字輸出、字典與上架 plan 寫成定稿檔一次核准，再經 strucmed API v2 依序寫入：待新建字典（flag dictionaryWrite）→ 補述 → 新建範本（POST folders/{type}/templates）或更新以該範本改版的 draft（PUT templates/{id}，If-Match，flag templateUpdate）；離線時換成 form_export。
  唯一會寫入線上的流程，全部兩段式並經閘門 G2。create-form、edit-form 在階段 4 內嵌，也可單獨對既有 draft 使用。USE WHEN 使用者說「上架」「發佈」「定稿」「存到編輯器／範本庫」「更新線上範本」。
  不處理：刪除範本、刪除字典、sys 資料夾、病人紀錄。
user-invocable: true
argument-hint: "<draft_id> [--folder usr|sub|dpt] [--update <templateID>]"
allowed-tools: Read, Write, Edit, AskUserQuestion, Bash(node *)
---

# publish-form

> `${CLAUDE_PLUGIN_ROOT}`＝plugin 根目錄。Codex 等不展開這個變數的工具：改用本 SKILL.md 所在 `skills/` 目錄的上一層（Codex 的 skill roots 表列出 `skills/` 的絕對路徑）。
> **不要 `cd`**：工作區＝工作目錄，`.strucmed/`、hooks、`preview.mjs` 都靠它找檔案。Bash 一律寫絕對路徑（`<workspace>/.strucmed/…`），`cd` 之後 hook 會找不到定稿檔。

流程細節與錯誤對照：`references/PublishWorkflow.md`；閘門與定稿檔格式：`references/Gates.md`；不變量：`references/SecurityInvariants.md`。

## 單獨使用時：驗證段

create-form、edit-form 內嵌時已跑過 reviewer 與字典補述，跳到「準備定稿」。使用者直接對既有 draft 使用，或改版小改沒有草案檔時，先做：

1. `form_validate`：有 error 就停，請使用者回 `create-form`／`edit-form` 修。
2. `form_preview`（tree）找出 draft 的計算式，逐條 `formula_check`（`kind`、`text`、`draft_id`、`self_itemid`，formula 帶自己出的 `samples`：典型值、每個 IF 分支一例，`expect` 依欄位定義手算，不抄工具結果）。結果進「### 驗證結果」，回 `reason` 的註明需以 runtime 驗證。
3. `dictionary_plan_export`（`draft_id`）出 CSV，把路徑告訴使用者：要改就先改，改完 `dictionary_plan_import`（`draft_id`、`csv_path`；HTTP 模式 `csv_text`），回傳的 `memo_items` 寫進 `<workspace>/.strucmed/plans/<draft_id>/memo-items.json`。使用者不改就往下走，不等。

## 準備定稿

開始取 plan 前（第 2 步之前）對使用者說一句：「接下來的呼叫只產生計畫，不寫入；若被權限擋下請允許。」auto mode 可能擋下這些呼叫（`PublishWorkflow.md` §4）。

1. **前提**：`online_me`（未登入且要上架 → 載入 `connect-strucmed`；離線或不上架 → 第 3 步用 `form_export` 的 plan）。決定資料夾（草案「### 上架設定」，預設 `usr`；使用者要給科部用才 `dpt`／`sub`）與「新建或更新」（更新只在 draft 的來源就是該範本：`online_template_get(save:true)` 的套件或 iot templateID＝線上 ID 的 `.htm` → `form_import(for_update:true)`，且 flag `templateUpdate` 開）。
2. **字典**：依 `PublishWorkflow.md` §2。`dictionary_plan_export` 更新 CSV；待新建字典（JSON 說明一次寫好，但不含 FHIR）先把 FHIR 記到 `pending-fhir.json`（§2），再做 `online_dictionary_batch` 第一次呼叫；`memo-items.json` 有內容時做 `online_dictionary_memo_batch` 第一次呼叫（`items`、`draft_id`）。review.md 的「## 體系升級建議」沒有寫入工具，原樣帶到定稿檔與交付清單。flag `dictionaryWrite` 關閉時告知並改走 `form_export`。
3. **取得 plan**：`online_template_create`／`online_template_update` 第一次呼叫（不帶 `confirm_token`）。回 `E_DICT_PENDING` 時字典建好才拿得到：「### 上架」先列已知值（`PublishWorkflow.md` §3 第 3 步）。離線時 `form_export` 第一次呼叫。

## G2 定稿

4. **寫定稿檔並呈現**：`<workspace>/.strucmed/plans/<draft_id>/publish-plan.md`（格式見 `Gates.md` §3）：
   - 「### 驗證結果」：review.md「## 試算」的 labeled 與 samples、error／warning 數、warning 逐條、`W_AI_DATAFLOW`、巨集實跑結果。
   - 「### HIS 文字輸出」：`.strucmed/preview/<draft_id>.meta.json` 的 `histext`、`areas`（`gettext`）、`his_text_keys`（沒有這個檔就先 `form_preview`，`format: "html"`），`form_review_read`（`draft_id`）的 `text_output`（沒有 review 就寫「未在預覽頁產生」）。看起來像真實病人資料就不放範例。
   - 「### 字典」：CSV 路徑與各動作本數（以 `dictionary_plan_export` 的 `rows` 與 CSV 為準，不抄 review.md 的數字）；表列新建的 desc、補述修改的改前／改後（plan 原樣）、改綁、CSV 的 `note`、體系升級建議；`pending-fhir.json` 的字典逐本列出 FHIR，註明「字典建好後補寫」；FHIR 標「待人工確認」的特別提醒。
   - 「### 上架」：`PublishWorkflow.md` §3 的表（「資料夾」寫 個人（usr／OL5）這種格式），或 `form_export` 的 plan。
   - **保存後即上架**（有捷徑＋作業別）要用粗體提醒；測試表單不應有捷徑。
   - 更新範本：把 `plan.meta`（名稱／捷徑／作業別／Info 的線上值與寫入值）與 `plan.diff`（`summary`、`changed_itemids`、`changed_areas`、`js_changed`、`iot_changed`、`online_since_source`）並列給使用者。`W_UNPUBLISH`（會從 HIS 清單消失）、`W_META_RENAME`、`W_ONLINE_CHANGED_SINCE_SOURCE`（會蓋掉線上別人的修改）用粗體提醒，使用者明確同意才繼續；`W_NO_CHANGE` 時問使用者是否真的要更新。
   - 有 LLM／語音巨集：W_AI_DATAFLOW 必列（不需另行審查，但不可省略）。

   對話中呈現同一份內容（略去 `<!-- gate: … -->` 註解），一次 `AskUserQuestion`：核准（建議）／要求修改／取消，選項描述加「有疑問請先在對話問，不要在這裡選」。使用者在對話提問時回答後再問一次，定稿內容不重貼。
5. **核准**：使用者核准後執行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <workspace>/.strucmed/plans/<draft_id>/publish-plan.md --by <user_id>`（離線 `--by local`）。prepare 會自己把「## 核准」段填成 Approved、寫入核准時間與核准者，**不要手填** `Approved-At`／`Approved-By`。沒有這一步，hooks 會阻擋第二次呼叫。使用者沒有核准就不要執行 prepare；核准後不再改定稿檔。

## 執行

6. 依序（`PublishWorkflow.md` §4）：字典新建（`online_dictionary_batch`／`create`）→ 補述（`online_dictionary_memo_batch`：同一份 `items`、`draft_id`、plan 的 `etags`）→ 範本（更新帶 `if_match`），各做第二次呼叫。離線只有 `form_export` 第二次呼叫。
   - 有 `pending-fhir.json` 時：字典完成後，把新字典的 `{ dic_id, fhir }` 併進 `memo-items.json`，重新做補述的第一次呼叫，plan 與定稿檔比對後才做第二次呼叫（`PublishWorkflow.md` §4 第 2 步）；`reused` 的字典不併入，列給使用者決定。
   - 有建字典時：字典完成後才做範本的第一次呼叫，plan 與「### 上架」比對。這是 G2 核准後的第一次呼叫，一樣只取計畫：先再說一次「這次只產生計畫，不寫入；若被權限擋下請允許」。相同就原樣列給使用者、接著第二次呼叫；不同就停下來，`Revision` +1 重新呈現。
   - 第二次呼叫會在瀏覽器開啟「寫入確認頁」（MCP 2.3.0 起）：回 `pending`（附 `approve_url`）時，請使用者在頁面核對站台、登入者、資料夾與名稱後按「確認寫入」，再帶同一個 `confirm_token` 呼叫一次。**不要替使用者確認、不要自己開啟或操作確認頁**；回 `E_REJECTED`（使用者按取消）就停止，需要時重新取得計畫。確認頁被關掉時把 `approve_url` 給使用者重開（`PublishWorkflow.md` §4）。
   - 補述回 `E_CONFLICT` 時以 `details.stale` 合併後重取 plan 並重新給使用者確認（不影響已完成的步驟）。token 過期就重新第一次呼叫，plan 相同時定稿檔不用改。錯誤依 `PublishWorkflow.md` §4 處理；`E_UPSTREAM` 帶 `pending` 時**不要重試**。
7. **收尾**：`online_template_get`（`save: true`，只回摘要）取回確認名稱、捷徑、作業別與控制項數；更新另跑 `online_template_versions`。最後交付（`PublishWorkflow.md` §5，≤ 15 行）：有體系升級建議時註明「請轉給體系字典管理者在字典頁升級；升級不改 id，這次上架的表單不用改」。

## 不做

- 不呼叫 trash、字典刪除、硬刪除；不寫 `sys`；不升級或降級字典（沒有這個工具，由體系字典管理者在字典頁操作）；不改既有字典的 desc。
- 不在核准前呼叫任何帶 `confirm_token` 的 tool。
- 不把 plan 摘要改寫後呈現：定稿檔與對話中的內容必須與 tool 回傳的 `plan` 一致。
