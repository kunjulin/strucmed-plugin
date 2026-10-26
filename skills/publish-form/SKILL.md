---
name: publish-form
description: >
  把已驗證的 StrucMed draft 經 strucmed API v2 上架到範本庫：先建立待新建字典（flag dictionaryWrite），再新建範本（POST folders/{type}/templates）或更新以該範本改版的 draft（PUT templates/{id}，If-Match，flag templateUpdate）。
  唯一會寫入線上的流程，全部兩段式並經閘門 G3。USE WHEN 使用者說「上架」「發佈」「存到編輯器／範本庫」「更新線上範本」。
  不處理：刪除範本、刪除字典、sys 資料夾、病人紀錄；線上未設定時改走 form_export 由使用者匯入。
user-invocable: true
argument-hint: "<draft_id> [--folder usr|sub|dpt] [--update <templateID>]"
allowed-tools: Read, Write, Edit, AskUserQuestion, Bash(node *)
---

# publish-form

> `${CLAUDE_PLUGIN_ROOT}`＝plugin 根目錄。Codex 等不展開這個變數的工具：改用本 SKILL.md 所在 `skills/` 目錄的上一層（Codex 的 skill roots 表列出 `skills/` 的絕對路徑）。

流程細節與錯誤對照：`references/PublishWorkflow.md`；閘門格式：`references/Gates.md`；不變量：`references/SecurityInvariants.md`。

## 步驟

1. **前提**：`online_me`（未登入 → 載入 `connect-strucmed`；離線 → 說明只能 `form_export` 由使用者匯入，結束）。`form_validate` 無 error。決定資料夾（預設 `usr`；使用者要給科部用才 `dpt`／`sub`）與「新建或更新」（更新只在 draft 的來源就是該範本：`online_template_get(save:true)` 的套件或 iot templateID＝線上 ID 的 `.htm` → `form_import(for_update:true)`，且 flag `templateUpdate` 開）。
2. **字典**：依 `PublishWorkflow.md` §2：待新建字典（JSON 說明一次寫好）、G1「### 字典補述」中要補充的既有字典（`online_dictionary_memo_set`）。兩者都先做第一次呼叫取得 plan；補述帶 `draft_id`。G1「### 體系升級建議」沒有寫入工具，原樣帶到 G3 與交付清單。flag `dictionaryWrite` 關閉時告知並改走 `form_export`。
3. **取得計畫**：`online_template_create`／`online_template_update` 第一次呼叫（不帶 `confirm_token`）。回 `E_DICT_PENDING` → 回第 2 步。
4. **寫計畫檔並呈現 G3**：`<workspace>/.strucmed/plans/<draft_id>/publish-plan.md`（格式見 `PublishWorkflow.md` §3），把字典新建與補述（改前／改後）的 plan 一併列入，另附體系升級建議（給管理者）；對話中用 `AskUserQuestion`：核准（建議）／要求修改／取消。
   - **保存後即上架**（有捷徑＋作業別）要用粗體提醒；測試表單不應有捷徑。
   - 更新範本：把 `plan.meta`（名稱／捷徑／作業別／Info 的線上值與寫入值）與 `plan.diff`（`summary`、`changed_itemids`、`changed_areas`、`js_changed`、`iot_changed`、`online_since_source`）並列給使用者。`W_UNPUBLISH`（會從 HIS 清單消失）、`W_META_RENAME`、`W_ONLINE_CHANGED_SINCE_SOURCE`（會蓋掉線上別人的修改）用粗體提醒，使用者明確同意才繼續；`W_NO_CHANGE` 時問使用者是否真的要更新。
   - 有 LLM／語音巨集：W_AI_DATAFLOW 必列（不需另行審查，但不可省略）。
5. **核准**：改「## 核准」為 Approved → `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <publish-plan.md> --by <user_id>`。沒有這一步，hooks 會阻擋第二次呼叫。
6. **執行**：依序 字典新建（`online_dictionary_batch`／`create`）→ 補述（`online_dictionary_memo_set`，帶 plan 的 `etag`）→ 範本（更新帶 `if_match`），各做第二次呼叫。補述回 `E_CONFLICT` 時以 `details.current` 合併後重取 plan 並重新給使用者確認（不影響已完成的步驟）。第二次呼叫會在瀏覽器開啟「寫入確認頁」（MCP 2.3.0 起）：回 `pending`（附 `approve_url`）時，請使用者在頁面核對站台、登入者、資料夾與名稱後按「確認寫入」，再帶同一個 `confirm_token` 呼叫一次。**不要替使用者確認、不要自己開啟或操作確認頁**；回 `E_REJECTED`（使用者按取消）就停止，需要時重新取得計畫。錯誤依 `PublishWorkflow.md` §4 處理；`E_UPSTREAM` 帶 `pending` 時**不要重試**。
7. **收尾**：`online_template_get`（`save: true`，只回摘要）取回確認名稱、捷徑、作業別與控制項數；更新另跑 `online_template_versions`。最後交付（§5）：有體系升級建議時註明「請轉給體系字典管理者在字典頁升級；升級不改 id，這次上架的表單不用改」。

## 不做

- 不呼叫 trash、字典刪除、硬刪除；不寫 `sys`；不升級或降級字典（沒有這個工具，由體系字典管理者在字典頁操作）；不改既有字典的 desc。
- 不在核准前呼叫任何帶 `confirm_token` 的 tool。
- 不把 plan 摘要改寫後呈現：計畫檔與對話中的內容必須與 tool 回傳的 `plan` 一致。
