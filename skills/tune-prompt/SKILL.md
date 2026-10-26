---
name: tune-prompt
description: >
  調校 StrucMed draft 中單一 LLM 按鈕（action 的 LLMQUERY／LLMvision 步驟，或 action2 的 prompt）的提示詞：依 PromptPatterns 改寫、formula_check、
  （選用）以去識別化樣本用 llmgateway_chat_test 試跑比較模型，再寫回 draft。USE WHEN 使用者說「prompt 怎麼寫」「AI 回覆不好」「幫我改提示詞」
  「試跑看看」「換個模型比較」。不處理：整張表單的設計（用 create-form／edit-form）、真實病人資料、上架。
user-invocable: true
argument-hint: "<draft_id> <itemid> [模型別名]"
allowed-tools: Read, AskUserQuestion, Bash(node *), mcp__strucmed__form_preview, mcp__strucmed__formula_check, mcp__strucmed__form_update_control, mcp__strucmed__form_validate, mcp__strucmed__llmgateway_models, mcp__strucmed__llmgateway_chat_test, mcp__plugin_strucmed_strucmed__form_preview, mcp__plugin_strucmed_strucmed__formula_check, mcp__plugin_strucmed_strucmed__form_update_control, mcp__plugin_strucmed_strucmed__form_validate, mcp__plugin_strucmed_strucmed__llmgateway_models, mcp__plugin_strucmed_strucmed__llmgateway_chat_test
---

# tune-prompt

只動**一個控制項的 prompt**，不改表單結構。規則：`references/PromptPatterns.md`（樣板與原則）、`references/MacroRecipes.md`（多步驟時的前後步驟）、`references/ModelWhitelist.md`（模型）、`references/FormulaMacroRules.md`（Calx 字串陷阱）。安全不變量照 `references/SecurityInvariants.md`：**不用真實病人資料**，試跑只用去識別化樣本。

## 1. 取得現況

1. `form_preview(draft_id, format: "tree")`，找到 `itemid`：必須是 `action`（看 `action_script` 裡的 `LLMQUERY`／`LLMvision` 步驟）或 `action2`（整段 `action_script` 就是 prompt）。不是 → 告訴使用者這個控制項沒有 LLM，結束。
2. `formula_check`（`kind: macro` 或 `prompt`，帶 `draft_id`、`self_itemid`）取得目前的 findings 與 `ai`（每步的模型、送出的欄位）。
3. 把「目前 prompt、模型、寫入欄位、送出的欄位、警告（`W_PROMPT_*`、`W_AI_IDENTIFIER`、`E_LLM_MODEL_*`）」用一張小表呈現給使用者。

## 2. 改寫

- 對照 `PromptPatterns.md` §1 的 P1～P10 逐條檢查，選 §4 最接近的樣板（摘要／擷取／接力／影像／建議／口述）。
- 欄位描述以字典 memo 為依據：被引用的 `A<n>` 有綁字典時，用 `dictionary_search`（exact，名稱取自 `form_preview`）讀它的 `memo.llm`（沒有就用 `meaning`＋`unit`）寫進 prompt 的欄位說明；memo 沒有這兩項時，把你寫的描述列為「建議補進 memo.llm」，上架時由 publish-form 以 `online_dictionary_memo_set` 寫入。
- 問使用者（一次問完）：任務目標、輸出格式與字數、要中文還是英文、是否接受思考模式（較慢）。模型只能從 `llmgateway_models` 快取或 `ModelWhitelist.md` 選；`action2` 不能選模型，需要時建議改成 `action`＋`LLMQUERY`（那是結構變更，交回 `edit-form`）。
- 寫出新的 Calx 運算式（`IF(LEN(...) < 10, "not available", CONCATENATE(...))` 骨架），`formula_check` 到沒有 error、`W_PROMPT_*` 都消失或使用者明確接受。
- 以「改寫前 → 改寫後 → 每一處改動的理由（對應 P 編號）」呈現。

## 3. 試跑（選用，使用者要求時）

前提：`llmgateway_chat_test` 需要 flag `llmChatTest=true`（plugin 的 `feature-flags.json`，或 `STRUCMED_FLAGS` 指到自己的檔；改完要開新工作階段）與已取得白名單（`llmgateway_models`）。flag 關閉時 tool 回 `E_FEATURE_DISABLED`，照這段說明告訴使用者怎麼開，不要自行改檔。

1. 請使用者提供**去識別化樣本**（每個被引用的 `A<n>` 一段文字；可用你擬的假資料，不要真實病歷號、姓名、身分證）。
2. 由你把樣本代入運算式、手動求值成純文字 prompt（`IF`、`CONCATENATE`、`CHAR(40)` 等都自己算），把送出的全文先給使用者看。
3. `llmgateway_chat_test(model, prompt, max_tokens ≤ 512, thinking 依需求)`；要比較模型就最多再跑一個。回覆、`usage`、`finish_reason` 原樣呈現。tool 的個資偵測擋下就改樣本，不要繞過。
4. 提醒：試跑走的是閘道的一般對話，**沒有** HIS 端 runtime 的 system prompt 與別名路由，回覆只供調整措辭；最終效果以編輯器預覽與 HIS 端為準。每次試跑計入金鑰配額。

## 4. 寫回

- `form_update_control(draft_id, itemid, action_script: <新運算式>)`（`action` 整段巨集一起給，只換該步驟）；`action_id`、`fur_action_id` 不動。
- `form_validate(draft_id)` 確認沒有新 error；列出更新後的 `ai` 資料流。
- 之後要做的事（告訴使用者）：有計算式或多步驟時用 `verify-runtime` 看 `__simulated` 的 prompt；draft 已上架過的話走 `publish-form`（更新為新 rev）；匯入後不要按「重新編號」。

## 回覆格式（結束時）

```
Draft: <draft_id>  Control: #<itemid>（action|action2）
Model: <別名 → 閘道模型>  Writes: #<target>  Inputs: A<n>…
Prompt: <改寫後的運算式>
Checks: formula_check <errors>/<warnings>（剩餘警告逐條）
Trial: <未試跑 | 模型 × 次數、usage 摘要>
Next: verify-runtime | publish-form | 無
```
