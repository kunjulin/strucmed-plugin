# LLM 模型白名單（LlmGateway）

> 由 `form-planner`、`form-builder`、`form-reviewer`、`create-form`、`edit-form`、`tune-prompt`、`build-form-app` 載入。原則：**模型名稱不得憑記憶**；以 `llmgateway_models` 現場取得的清單為準，取不到時才退回下方靜態表，並告知使用者 `W_LLM_WHITELIST_STALE`。

## 1. 三層名稱

| 層 | 例子 | 誰看 |
|---|---|---|
| 表單巨集寫的**別名** | `nemotron35`、`tnemotron35(-low/-medium/-high)`、`gemma4_31b`、`tgemma4_31b(-low/-medium/-high)`（以上只經 Gateway）、`gemma3`、`gemma3_12b`、`medgemma`、`tw`、`ph4`、空字串＝預設（落日模型見 §5，不要新用） | 使用者寫在 `LLMQUERY(id, prompt, "別名")`、`LLMvision(...)` |
| HIS 端 runtime 送出的模型名 | `Nemotron-3.5-Super-VL`、`Gemma-4-31b`（只經 Gateway）、`gemma3`、`gemma3:12b`、`medgemma`、`gemma2:latest`、`phi4`、`llama3.1:8b-instruct-q8_0` | `TempHtml.js` LLMquery 路由 |
| LlmGateway 的模型 id | 同上，但 Ollama 名稱加標籤：`gemma3` → `gemma3:latest`、`medgemma` → `medgemma:latest`、`phi4` → `phi4:latest`（`TempHtml.js` `LLM_GATEWAY_MODEL_NAMES`） | `GET /v1/models` 的 `id` |

對應程式：`mcp/strucmed-mcp/src/policy.mjs`（`gatewayModelFor(alias, fn)`）。LLMvision 只有 `gemma3`、`gemma3_12b`、`medgemma`（→ `medgemma:4b_vision`）、`nemotron35`（→ `Nemotron-3.5-Super-VL`，不思考，只經 Gateway）、`gemma4_31b`（→ `Gemma-4-31b`，不思考，只經 Gateway）與預設 `gemma3:12b`。

**只經 Gateway 的模型**（`nemotron35` 系列，平台 20261124）：醫科管控端點要金鑰、不回 CORS，金鑰只放 LlmGateway 伺服器，前端沒有直連端點。站台沒有啟用 Gateway 時 `LLMQUERY` 顯示「這個模型只能經院內 LLM Gateway 使用」、不送出（不會改用別的模型），`LLMvision`／`LLMATTACH` 改用預設 `gemma3:12b`。舊站 `/go/`（HIS「AI小助手」視窗開的 `/go/temp2.html`）以平台 `deploy/go-*` 同步：`nemotron35` 系列 2026-11-22 起、`gemma4_31b` 系列與新的思考強度 2026-11-28 起可用於 `LLMQUERY`／`LLMvision`，`/go` 沒有 `LLMATTACH`。`formula_check`／`form_validate` 回 `W_LLM_MODEL_GATEWAY_ONLY` 提醒。`tnemotron35` 的後綴同時調**回答的變化程度與思考長短**（平台 20261127 起；之前只調 temperature）：temperature `-low` 0.1、`-medium` 0.3、`tnemotron35`／`-high` 0.5；思考長度 `tnemotron35`／`-high` 最長（只開思考），`-medium` 較短（加 `medium_effort`），`-low` 最短（再加思考長度上限 512 token）。`-low` 每次最一致、思考最短，適合擷取與固定格式；`-high` 與不加後綴相同。`max_tokens` 16000；上下文約 262K（262,144 token）；一次請求上限 8 MiB。思考過程顯示在結果欄位旁的思考框，欄位只寫入最後的回答。

**Gemma 4 31B**（`gemma4_31b` 系列，平台 20261127）：與 Nemotron 掛在同一個管控端點，同樣只經 Gateway（`W_LLM_MODEL_GATEWAY_ONLY`），沒有 Gateway 時的行為相同。`gemma4_31b` 不思考；`tgemma4_31b` 思考（強度用模型預設）；`tgemma4_31b-low`／`-medium`／`-high` 思考並指定強度（`reasoning_effort`），temperature 同樣是 0.1／0.3／0.5。上下文 65,536 token（比 Nemotron 的 262K 小很多，長篇病歷與長文件仍用 `nemotron35`）；`max_tokens` 16000；一次請求上限 8 MiB。`gemma4_31b`／`tgemma4_31b` 是 2026-09 移除過的舊代號，平台沿用同一組名稱：**站台還沒更新到 20261127 時，這些代號會被靜默改用預設模型**。院內 LVAIW 的 `/strucmed` 與 `/go` 已於 2026-11-28 更新並實測（LlmGateway 逐筆紀錄確認送到 `Gemma-4-31b`）；其他站台要有白名單快取且清單內有 `Gemma-4-31b` 才建議使用，並請使用者在編輯器預覽實跑一次確認。

`LLMATTACH`（附件容器，flag `attachBox`）的內建代號是 LLMvision 的代號再加 `tnemotron35`、`tgemma4_31b`（思考）；用 `nemotron35`／`tnemotron35`、`gemma4_31b`／`tgemma4_31b` 時平台送出前以 8 MiB 檢查（影像與 PDF 頁面影像都算），超過就擋下；**不在代號表的名稱不會被改成預設**，經 LlmGateway 時原樣當模型 id 送出（`W_LLM_MODEL_PASSTHROUGH`）。所以還沒有代號的新模型，直接寫 `llmgateway_models` 回傳的 id，大小寫要完全相同；有白名單快取時會檢查存在、狀態與視覺能力。直連（沒有 Gateway）時未知名稱改用預設；院外站台用使用者在設定畫面選的模型。

## 2. 白名單快取

- `llmgateway_models` → `GET /v1/models`（只列這把金鑰可用的模型，不計配額）→ 寫 `<workspace>/.strucmed/llm-models.json`：`{ fetched_at, base_url, models:[{ id, owned_by, context_length, vision, thinking, status, description }] }`。
- `store.loadPolicy()` 自動合併快取為 `policy.gateway_models`，所以 `form_validate`、`formula_check`、`form_add_control`／`form_update_control` 的巨集檢查都會對照：

| 情況 | 結果 |
|---|---|
| 別名對應的閘道模型不在清單 | `E_LLM_MODEL_NOT_ON_GATEWAY`（金鑰沒有該模型權限，或模型已下架） |
| `status: deprecated` | `E_LLM_MODEL_DEPRECATED`，請換模型 |
| 落日模型（§5，qwen 系列），下架日之前 | 本次新增或改到的巨集 → `E_LLM_MODEL_SUNSET`（寫入當下就拒絕）；原表單既有、這次沒動到的 → `W_LLM_MODEL_SUNSET`。訊息附替代寫法。不需要白名單快取也會檢查 |
| 落日模型，下架日（2027-01-01）起 | `E_LLM_MODEL_DEPRECATED`（已下架）；原表單既有的依慣例列 warning（原表單既有） |
| `status: maintenance` | `W_LLM_MODEL_MAINTENANCE`，上線前確認 |
| LLMvision 用無 `vision` 的模型 | `E_LLM_MODEL_NO_VISION`（閘道會回 400） |
| LLMATTACH 用無 `vision` 的模型 | 容器會送影像（收 image 或 pdf）→ `E_LLM_MODEL_NO_VISION`；只收文字類附件 → `W_LLM_MODEL_NO_VISION` |
| 沒有快取但表單有 AI 步驟 | `W_LLM_WHITELIST_STALE`（只以靜態表檢查） |
| 快取超過 7 天 | `W_LLM_WHITELIST_STALE`，建議重新取得 |

- 本院另外限制時仍可用 `.strucmed/policy.json` 的 `llm_models`（別名清單）→ `E_LLM_MODEL_POLICY`。

## 3. 建議對應（2026-11-19 起，依 StrucMed GitBook「生成式 AI 巨集函數」；以快取為準）

| 用途 | 別名 | 閘道模型 |
|---|---|---|
| 整理、摘要、擷取欄位、長篇病歷與長文件（不思考，大多數情況用這個） | `nemotron35` | `Nemotron-3.5-Super-VL` |
| 推理：鑑別診斷、依準則判斷、多條件比對（先思考再回答） | `tnemotron35`；要固定格式、每次一致用 `tnemotron35-low` | `Nemotron-3.5-Super-VL` |
| 一次看多張影像、讀影像上的文字（`LLMvision`／`LLMATTACH`） | `nemotron35`（LLMvision 沒有思考版；LLMATTACH 另有 `tnemotron35`，一次最多 8 MB） | `Nemotron-3.5-Super-VL` |
| 影像（LLMvision 預設；站台沒有 Gateway 時） | `gemma3_12b` | `gemma3:12b` |
| 醫療影像（LLMvision） | `medgemma` | `medgemma:4b_vision` |
| 短句翻譯、簡單整理 | `gemma3_12b`（`tw` 也夠用，但閘道把 gemma2 標 deprecated 時會回 `E_LLM_MODEL_DEPRECATED`，以快取為準） | `gemma3:12b` |
| 低延遲簡短任務、LLM 控制項 | 空字串（預設） | `llama3.1:8b-instruct-q8_0` |
| 要調整思考強度的推理；`nemotron35` 系列不合用時的替代 | `tgemma4_31b-low`／`-medium`／`-high`（不思考用 `gemma4_31b`）。**白名單快取有 `Gemma-4-31b` 才用**；上下文只有 65K | `Gemma-4-31b` |
| **不得新用** | 落日模型（§5，qwen 系列） | — |
| 避免 | `math`（gemma2）、`ph4`（視金鑰）、已移除的 `gemma3_27b`、`medgemma:27b` | — |

**用 `nemotron35`、`gemma4_31b` 系列的前提**（每次建議都要講）：只經院內 LLM Gateway（`W_LLM_MODEL_GATEWAY_ONLY`）。站台沒有啟用 Gateway 時 `LLMQUERY` 不送出、`LLMvision`／`LLMATTACH` 改用預設 `gemma3:12b`；舊站 `/go/`（AI小助手）2026-11-28 起也有這兩個系列的 `LLMQUERY`／`LLMvision` 代號，沒有 `LLMATTACH`；院外站台忽略巨集指定的院內模型代號，改用使用者在設定畫面選的院外模型（§6）。

Gemma 4 31B 的代號（`gemma4_31b` 系列）自平台 20261127 起可用，預設建議仍是 `nemotron35` 系列；院內 2026-11-28 已實測文字回答（`/strucmed`、AI小助手）與 LlmGateway Playground 讀影像；`reasoning_effort` 的效果、表單內 `LLMvision`／`LLMATTACH` 尚未實測，不要對使用者保證效果。

## 4. 試跑（選用）

`llmgateway_chat_test`（flag `llmChatTest`，預設關）：只接受白名單內且非 deprecated／maintenance 的模型（落日模型仍可試跑，回 `W_LLM_MODEL_SUNSET`，只用來和既有表單的回覆比對）；prompt 先做個資偵測（身分證字號、「病歷號／姓名：」樣式 → 拒絕；7–10 位數字 → 警告）；`max_tokens ≤ 1024`；不送影像；Nemotron、Gemma 4 的思考開關與強度依別名比照 HIS 端送出（`t` 開頭＝思考、後綴＝強度；也可用 `thinking`、`reasoning_effort` 參數指定），思考內容算在 `max_tokens` 內（`W_LLM_THINKING_BUDGET`）；標頭 `X-Client-Feature: strucmed-skill`。**會計入金鑰配額**，只在使用者要求比較模型回覆時用；真正的表單 LLM 回覆仍以編輯器預覽為準。

## 5. 落日模型（qwen 系列，院方決定 2026-11-19）

- qwen 系列屬中國開源模型，院方**建議不採用**；LlmGateway 上仍存在，但設有落日條款：**2027-01-01 下架**。
- **新案一律不用**，也不出現在建議、計畫、範例與提示詞樣板。planner 不選、builder 不寫（`form_add_control`／`form_update_control` 會以 `E_LLM_MODEL_SUNSET` 拒絕）、reviewer 遇到就列「必須修正」。
- MCP 仍認得下列別名，只為了改版既有表單時不變成未知模型；這次沒動到的巨集列 `W_LLM_MODEL_SUNSET`（附替代寫法），改到該巨集時要一併換掉。下架日起一律 `E_LLM_MODEL_DEPRECATED`。
- 日期與替代寫法是常數：`mcp/strucmed-mcp/src/calx-catalog.mjs` 的 `LLM_SUNSET`。

| 落日別名（只供辨識） | 閘道模型 | 改用 |
|---|---|---|
| `qwen3627b`、`qwen332b` | `Qwen3.6:27B`、`qwen3:32b` | `nemotron35` |
| `tqwen3627b`、`tqwen332b` | 同上（思考） | `tnemotron35`（固定格式、擷取用 `tnemotron35-low`） |
| `tqwen3627b-low`／`-medium`／`-high` | `Qwen3.6:27B`（思考） | `tnemotron35-low`／`-medium`／`-high` |
| 舊別名 `70b`、`qwen3a3b`、`tqwen3a3b`、`gpt-oss-120b`／`gpt-oss-20b`（含後綴） | 都導向 `qwen3:32b` | 同上（另有 `W_LLM_MODEL_ALIAS`） |

換模型後要重新實測 prompt（`tune-prompt`）：輸出格式、長度與語氣會變；`nemotron35` 系列只經 Gateway（§3 的前提）。

## 6. 院外站台（cgmh.ddns.net、struNote）

- 沒有 LlmGateway 與 FMapi：`llmgateway_models` 不提供，模型名稱只以內建靜態表檢查（`W_LLM_WHITELIST_STALE`，院外預期）。
- LLM 控制項、`LLMQUERY`、`LLMvision`、`LLMATTACH` 改走站台允許的**院外 LLM 服務**（目前 OpenAI）；`VOICETOTEXT`、`ATTACHTRANSCRIBE` 與語音小助手改走**院外語音服務**（OpenAI、Groq）。
- 使用者自備 API 金鑰（只存在瀏覽器）；**巨集指定的院內模型代號會被忽略**，改用設定畫面選的模型；第一次使用會出現「院外 LLM／語音轉錄使用注意事項」。
- 所以院外站台可以操作 AI 巨集，但結果不代表院內模型的行為：院內模型（含 `nemotron35` 系列）要回院內實測。AI 資料流揭露（`W_AI_DATAFLOW`）要寫明院外開啟時資料送往院外服務。
- IE 舊版 `temp.html` 在院外不提供。
