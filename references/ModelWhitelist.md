# LLM 模型白名單（LlmGateway）

> 由 `form-planner`、`form-reviewer`、`create-form`、`build-form-app` 載入。原則：**模型名稱不得憑記憶**；以 `llmgateway_models` 現場取得的清單為準，取不到時才退回下方靜態表，並告知使用者 `W_LLM_WHITELIST_STALE`。

## 1. 三層名稱

| 層 | 例子 | 誰看 |
|---|---|---|
| 表單巨集寫的**別名** | `tw`、`gemma3`、`gemma3_12b`、`medgemma`、`ph4`、`qwen332b`、`tqwen332b`、`qwen3627b`、`tqwen3627b(-low/-medium/-high)`、`nemotron35`、`tnemotron35(-low/-medium/-high)`（只經 Gateway）、空字串＝預設 | 使用者寫在 `LLMQUERY(id, prompt, "別名")`、`LLMvision(...)` |
| HIS 端 runtime 送出的模型名 | `gemma2:latest`、`gemma3`、`gemma3:12b`、`medgemma`、`phi4`、`qwen3:32b`、`Qwen3.6:27B`、`Nemotron-3.5-Super-VL`（只經 Gateway）、`llama3.1:8b-instruct-q8_0` | `TempHtml.js` LLMquery 路由 |
| LlmGateway 的模型 id | 同上，但 Ollama 名稱加標籤：`gemma3` → `gemma3:latest`、`medgemma` → `medgemma:latest`、`phi4` → `phi4:latest`（`TempHtml.js` `LLM_GATEWAY_MODEL_NAMES`） | `GET /v1/models` 的 `id` |

對應程式：`mcp/strucmed-mcp/src/policy.mjs`（`gatewayModelFor(alias, fn)`）。LLMvision 只有 `gemma3`、`gemma3_12b`、`medgemma`（→ `medgemma:4b_vision`）、`nemotron35`（→ `Nemotron-3.5-Super-VL`，不思考，只經 Gateway）與預設 `gemma3:12b`。

**只經 Gateway 的模型**（`nemotron35` 系列，平台 20261124）：醫科管控端點要金鑰、不回 CORS，金鑰只放 LlmGateway 伺服器，前端沒有直連端點。站台沒有啟用 Gateway 時 `LLMQUERY` 顯示「這個模型只能經院內 LLM Gateway 使用」、不送出（不會改用別的模型），`LLMvision`／`LLMATTACH` 改用預設 `gemma3:12b`；舊站 `/go/` 沒有這些代號。`formula_check`／`form_validate` 回 `W_LLM_MODEL_GATEWAY_ONLY` 提醒。`tnemotron35` 的 temperature：`-low` 0.1、`-medium` 0.3、`tnemotron35`／`-high` 0.5，`max_tokens` 16000；上下文 262,144 token；一次請求上限 8 MiB。

`LLMATTACH`（附件容器，flag `attachBox`）的內建代號是 LLMvision 的代號再加 `tnemotron35`（思考）；用 `nemotron35`／`tnemotron35` 時平台送出前以 8 MiB 檢查（影像與 PDF 頁面影像都算），超過就擋下；**不在代號表的名稱不會被改成預設**，經 LlmGateway 時原樣當模型 id 送出（`W_LLM_MODEL_PASSTHROUGH`）。所以還沒有代號的新模型，直接寫 `llmgateway_models` 回傳的 id，大小寫要完全相同；有白名單快取時會檢查存在、狀態與視覺能力。直連（沒有 Gateway）時未知名稱改用預設；院外站台用使用者在設定畫面選的模型。

## 2. 白名單快取

- `llmgateway_models` → `GET /v1/models`（只列這把金鑰可用的模型，不計配額）→ 寫 `<workspace>/.strucmed/llm-models.json`：`{ fetched_at, base_url, models:[{ id, owned_by, context_length, vision, thinking, status, description }] }`。
- `store.loadPolicy()` 自動合併快取為 `policy.gateway_models`，所以 `form_validate`、`formula_check`、`form_add_control`／`form_update_control` 的巨集檢查都會對照：

| 情況 | 結果 |
|---|---|
| 別名對應的閘道模型不在清單 | `E_LLM_MODEL_NOT_ON_GATEWAY`（金鑰沒有該模型權限，或模型已下架） |
| `status: deprecated` | `E_LLM_MODEL_DEPRECATED`，請換模型 |
| `status: maintenance` | `W_LLM_MODEL_MAINTENANCE`，上線前確認 |
| LLMvision 用無 `vision` 的模型 | `E_LLM_MODEL_NO_VISION`（閘道會回 400） |
| LLMATTACH 用無 `vision` 的模型 | 容器會送影像（收 image 或 pdf）→ `E_LLM_MODEL_NO_VISION`；只收文字類附件 → `W_LLM_MODEL_NO_VISION` |
| 沒有快取但表單有 AI 步驟 | `W_LLM_WHITELIST_STALE`（只以靜態表檢查） |
| 快取超過 7 天 | `W_LLM_WHITELIST_STALE`，建議重新取得 |

- 本院另外限制時仍可用 `.strucmed/policy.json` 的 `llm_models`（別名清單）→ `E_LLM_MODEL_POLICY`。

## 3. 建議對應（2026-10 實測，以快取為準）

| 用途 | 別名 | 閘道模型 |
|---|---|---|
| 病歷摘要、長文件、一般問答 | `qwen3627b`（思考 `tqwen3627b`） | `Qwen3.6:27B` |
| 結構化擷取、推理 | `qwen332b`（思考 `tqwen332b`） | `qwen3:32b` |
| 影像（LLMvision） | `gemma3_12b` | `gemma3:12b` |
| 醫療影像（LLMvision） | `medgemma` | `medgemma:4b_vision` |
| 讀影像上的文字、長上下文（只經 Gateway，2026-11-17 實測） | `nemotron35`（思考 `tnemotron35`；LLMvision 只有 `nemotron35`） | `Nemotron-3.5-Super-VL` |
| 低延遲簡短任務 | 空字串（預設） | `llama3.1:8b-instruct-q8_0` |
| 避免 | `tw`／`math`（gemma2，閘道標 deprecated）、`ph4`（視金鑰）、已移除的 `gemma3_27b`、`medgemma:27b`、`gemma4_31b` | — |

## 4. 試跑（選用）

`llmgateway_chat_test`（flag `llmChatTest`，預設關）：只接受白名單內且非 deprecated／maintenance 的模型；prompt 先做個資偵測（身分證字號、「病歷號／姓名：」樣式 → 拒絕；7–10 位數字 → 警告）；`max_tokens ≤ 1024`；不送影像；標頭 `X-Client-Feature: strucmed-skill`。**會計入金鑰配額**，只在使用者要求比較模型回覆時用；真正的表單 LLM 回覆仍以編輯器預覽為準。
