# 計算式、HIS 參照、巨集與 LLM 按鈕

> 規則依據平台 runtime 實測。寫之前先用 `formula_check` 試。模型名稱以 `llmgateway_models` 取得的白名單快取為準（`references/ModelWhitelist.md`；`formula_check`／`form_validate` 會自動對照，回 `E_LLM_MODEL_NOT_ON_GATEWAY`／`E_LLM_MODEL_DEPRECATED`／`W_LLM_MODEL_MAINTENANCE`／`E_LLM_MODEL_NO_VISION`）；沒有快取時才以本文清單為準並標 `W_LLM_WHITELIST_STALE`。

> **prompt 怎麼寫**（防呆、限定來源、格式、模型選擇、影像與口述樣板）：`references/PromptPatterns.md`。**多步驟工作流**（摘要接力、影像→文字、錄音→紀錄、輸入後自動觸發、回填多欄位、倉儲帶入）：`references/MacroRecipes.md`。本檔只管語法與陷阱。

## 計算式、HIS 參照、巨集、LLM 按鈕（v0.2）

規則依平台 runtime 實際行為，**不是一般 Excel**。寫之前先用 `formula_check` 試，錯誤會附修正提示。

| 需求 | 控制項 | 寫法 |
|---|---|---|
| 由其他欄位算出（BMI、分數加總） | `label` format=formula | `formula`，以 `A<itemid>` 參照；被參照的欄位要勾「參與計算」（預設 true） |
| 開表單時從 HIS 帶入 | `label` format=hisquery | `hisquery`，例：`Procedure.InName(pkg.proc).GetValueByName(X)`、`LABDATA.InDays(30).InName(HbA1c).GetLatestString` |
| 按鈕執行多個步驟 | `action` | `action_script`：最外層逗號分隔的步驟；`action_id`：最後結果寫入的欄位 |
| 按鈕問 LLM | `action2`（預設模型）或 `action` 內 `LLMQUERY(id, prompt, "模型")` | `action_id` 必填（回覆寫入的 textarea／textbox） |
| 輸入後自動執行巨集 | `textbox` | `fur_action_id` = 巨集按鈕 itemid |

**引用欄位先看字典補述**：寫計算式、巨集、LLM prompt 前，用 `dictionary_suggest` 的 `cite` 或 `formula_check`（帶 `draft_id`）的 `ref_dictionary` 讀被引用欄位的 `unit`、`range`、`type`、`calx`、`llm`。單位換算、試算例範圍、計算式白話、prompt 欄位描述都以補述為準，與需求衝突時列入「待決」，不要默默改。`formula_check` 會以補述提醒 `W_REF_NO_MEMO`、`W_REF_UNIT_MISMATCH`（可換算時附倍率）、`W_REF_UNIT_UNKNOWN`、`W_REF_TYPE_MISMATCH`、`W_SAMPLE_OUT_OF_RANGE`。

**一定要避開的陷阱**：
- 比較運算子兩側**加空白**：`A5 > 3`，不要寫 `A5>3`（會語法錯誤）。
- 不能用 `&`，改用 `CONCATENATE`；小數寫 `0.5`；文字一律加引號。
- 巨集步驟的字串裡**不要放半形括號**（會打亂步驟切分），需要時用 `CHAR(40)`／`CHAR(41)`。
- 步驟指令大小寫固定：`LLMQUERY`、`LLMvision`、`MACRO`、`VOICETOTEXT`，而且要放在步驟開頭；不要把 LLMQUERY 放進 IF。
- 模型名稱要加引號並在清單內（`tw`、`gemma3`、`qwen332b`、`tqwen332b`、`qwen3627b`…）。拼錯時平台會靜默改用預設模型。
- 計算式不能用巨集專用函數（HISQUERY、SETVALUEBYID、LLMQUERY…）。
- **禁止產生**：CUSTOMFUNC、OPENURL、SAVEDOC、SETIOTHEADER、S_USERID、S_DEPTNO。使用者需要時，請其匯入後在編輯器由人工加入並審查。

**交付時必須告知**：
- `W_AI_DATAFLOW`：哪些欄位會送到 LLM／語音服務（manifest「AI 資料流」）。模型白名單與上架審查待院方決議。
- `W_RENUMBER_MACRO`：匯入後**不要按「重新編號」**。
- `W_FORMULA_FN_NEEDS_DEPLOY`：TEXT、VALUE、MEDIAN 等函數要等平台 #25 部署後才可用。
- `W_PATIENT_DATA_READ`：HIS 參照與 lookup 函數會在 HIS 端讀取病人資料。
