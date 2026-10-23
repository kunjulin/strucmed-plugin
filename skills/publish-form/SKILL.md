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

流程細節與錯誤對照：`references/PublishWorkflow.md`；閘門格式：`references/Gates.md`；不變量：`references/SecurityInvariants.md`。

## 步驟

1. **前提**：`online_me`（未登入 → 載入 `connect-strucmed`；離線 → 說明只能 `form_export` 由使用者匯入，結束）。`form_validate` 無 error。決定資料夾（預設 `usr`；使用者要給科部用才 `dpt`／`sub`）與「新建或更新」（更新只在 draft 是 `online_template_get(save:true)` → `form_import` 改版而來且 flag `templateUpdate` 開）。
2. **字典**：有待新建字典時依 `PublishWorkflow.md` §2 處理；flag 關閉時告知並改走 `form_export`。
3. **取得計畫**：`online_template_create`／`online_template_update` 第一次呼叫（不帶 `confirm_token`）。回 `E_DICT_PENDING` → 回第 2 步。
4. **寫計畫檔並呈現 G3**：`<workspace>/.strucmed/plans/<draft_id>/publish-plan.md`（格式見 `PublishWorkflow.md` §3），把字典的 plan 一併列入；對話中用 `AskUserQuestion`：核准（建議）／要求修改／取消。
   - **保存後即上架**（有捷徑＋作業別）要用粗體提醒；測試表單不應有捷徑。
   - 有 LLM／語音巨集：W_AI_DATAFLOW 必列（不需另行審查，但不可省略）。
5. **核准**：改「## 核准」為 Approved → `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <publish-plan.md> --by <user_id>`。沒有這一步，hooks 會阻擋第二次呼叫。
6. **執行**：先字典（`online_dictionary_batch`／`create` 第二次呼叫），再範本第二次呼叫（更新帶 `if_match`）。錯誤依 `PublishWorkflow.md` §4 處理；`E_UPSTREAM` 帶 `pending` 時**不要重試**。
7. **收尾**：`online_template_get` 取回確認名稱與控制項數；更新另跑 `online_template_versions`。最後交付（§5）。

## 不做

- 不呼叫 trash、字典刪除、硬刪除；不寫 `sys`。
- 不在核准前呼叫任何帶 `confirm_token` 的 tool。
- 不把 plan 摘要改寫後呈現：計畫檔與對話中的內容必須與 tool 回傳的 `plan` 一致。
