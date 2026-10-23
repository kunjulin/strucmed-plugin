# LLM 提示詞樣板（LLMQUERY／LLMvision／LLM 控制項）

> 由 `form-planner`、`form-reviewer`、`create-form`、`edit-form`、`tune-prompt` 載入。依據：GitBook「LLM 控制項 › Prompt 文字指令」「函數(巨集專用) › 生成式 AI 巨集函數」與平台 runtime 實測。模型名稱以 `references/ModelWhitelist.md`（`llmgateway_models` 快取）為準。
> 工作流（多步驟巨集、語音、HIS 帶入）見 `references/MacroRecipes.md`；語法陷阱見 `references/FormulaMacroRules.md`。

## 1. 原則（每一條 prompt 都要過一遍）

| # | 原則 | 寫法 | 沒做會怎樣 |
|---|---|---|---|
| P1 | **防呆**：資料太少就不要讓模型硬生 | 最外層 `IF(LEN(A16) < 10, "not available", CONCATENATE(...))` | 模型憑空編出病史；lint `W_PROMPT_NO_GUARD` |
| P2 | **限定來源**：只依本次給的內容 | 「只根據下列紀錄」「Only based on the records below」 | 混入訓練知識或上一位病人；lint `W_PROMPT_NO_SCOPE` |
| P3 | **無資料的回覆**：指定固定字串 | 「若無相關資料，回答 not available」 | 回覆一段道歉或猜測 |
| P4 | **只給答案** | 「只提供答案，不要開場白與額外說明」 | 回覆帶「好的，以下是…」，寫進病歷欄位 |
| P5 | **限制輸出**：字數、段落、格式 | 「50 字以內」「分三段：所見、印象、鑑別診斷」 | 太長、格式每次不同 |
| P6 | **說明資料格式** | 「檢驗資料每列為 YYYYMMDD 日期＋項目＋數值，多次檢驗取最近一次」 | 模型讀錯日期或單位 |
| P7 | **條件寫在 prompt 內** | `LLMQUERY(id, IF(A3 = "是", "…", "do not respond"), "模型")` | 外層 `IF` 不會擋 LLMQUERY，每次都執行（`W_LLM_NOT_AWAITED`） |
| P8 | **語言** | 要中文就寫「以繁體中文回答」並用中文能力好的模型（`qwen3627b`、`qwen332b`） | 預設 Llama 3.1 8B 偏英文 |
| P9 | **不帶識別資料** | prompt 不放 `G_CHTNO()`、`G_USERNM()`、姓名、身分證 | lint `W_AI_IDENTIFIER`；資料流外洩風險 |
| P10 | **臨床建議必附查核句** | 輸出格式最後一行固定「※ AI 產生，需由醫師查核」 | 建議被當成醫囑 |

Calx 字串規則（寫錯會整段失效）：文字一律加雙引號；串接只能 `CONCATENATE`，不能 `&`；巨集步驟的字串裡**不要放半形括號與逗號**，需要時用 `CHAR(40)`／`CHAR(41)`；模型名稱加引號。寫完先 `formula_check`（`kind: macro` 或 `prompt`）。

## 2. 模型怎麼選

以 `ModelWhitelist.md` §3 為準，這裡只補 GitBook 公布的上下文長度，用來估計能塞多少病歷：

| 別名 | 閘道模型 | 上下文 | 適合 |
|---|---|---|---|
| （空）預設 | Llama 3.1 8B | 32K（院內設定） | 簡短英文任務、LLM 控制項（`action2` 固定用它，不能改） |
| `qwen3627b`／`tqwen3627b(-low/-medium/-high)` | Qwen3.6 27B | 256K | 長病歷摘要、中文輸出；思考模式用於推理、鑑別診斷 |
| `qwen332b`／`tqwen332b` | qwen3:32b | 40K | 結構化擷取、指定格式輸出 |
| `gemma3_12b`（建議）／`gemma3`／`medgemma` | gemma3:12b／gemma3/ medgemma:4b | 16K（含影像） | **只有這三個能讀影像**（LLMvision） |
| `tw`、`math` | gemma2 | 8K | 閘道標 deprecated，不要新用 |
| `phi4` | Phi-4 14b | 16K | 視金鑰權限 |

要點：
- 拼錯或停用的名稱**不報錯**，靜默改用預設模型；LLMvision 用非視覺模型也不報錯，而是**編造影像內容**（GitBook 實測把紅藍測試圖說成含「陽光黃」）。`formula_check` 會攔（`E_LLM_MODEL_UNKNOWN`、`E_LLM_MODEL_NO_VISION`）。
- 思考模式回覆慢、token 多；只在鑑別診斷、多步推理用，摘要用非思考。
- 一次送入的資料量要在上下文內：`GETTEXT()` 會送整份報告全文，`LABDATA.InDays(365)` 可能很長；超過就截斷或改天數。

## 3. 骨架

```
IF(LEN(A16) < 10,
   "not available",
   CONCATENATE(
     "你是<科別>醫師的病歷助理。只根據下列紀錄，<任務>。",
     "輸出：<格式與字數>。若紀錄中沒有相關資料，回答 not available。只提供答案，不要開場白。",
     "紀錄：", A16))
```

`A16` 換成實際欄位；多個來源就多個 `CONCATENATE` 參數，每段前加標籤（「主訴：」「檢驗：」）讓模型知道邊界。

## 4. 樣板

### A. 病歷摘要（summarize）
- 模型：`qwen3627b`；寫入：textarea。
- prompt：「只根據下列紀錄，以醫療專業語氣整理現在病史、過去病史、目前問題三項，各 50 字以內，沒有資料的項目省略。若全無相關資料回答 not available。只提供答案。紀錄：」＋欄位。
- 來源欄位常用：HIS 參照 label（`OPDDATA.InDays(180).GetLatestString()`）、使用者填的主訴 textarea。

### B. 結構化擷取（指定欄位）
- 模型：`qwen332b`；每個目標欄位一個 `LLMQUERY`，或一次輸出「鍵: 值」多行再由使用者核對。
- prompt：「從下列紀錄擷取：<欄位 1>、<欄位 2>、<欄位 3>。每項一行，格式『欄位名: 值』，找不到寫『欄位名: not available』。不要加入紀錄以外的推論。只提供答案。紀錄：」＋欄位。
- 數值要帶單位時明寫「數值後加單位，單位沿用原文」。

### C. 臨床問題與鑑別診斷（接力）
- 兩步：步驟 1 用 A 樣板產生摘要寫入 `A<摘要>`；步驟 2 以摘要為輸入。
- 步驟 2 模型：`tqwen3627b`（思考）；prompt：「只根據以下摘要，列出最多三個主要臨床問題，每個附一到二個鑑別診斷與建議的下一步檢查，各 30 字以內。無法判斷時寫 not available。最後一行固定『※ AI 產生，需由醫師查核』。只提供答案。摘要：」＋`A<摘要>`。
- 步驟 2 一樣要 `IF(LEN(A<摘要>) < 10, …)` 防呆，因為步驟 1 可能回 not available。

### D. 影像與圖表 OCR（LLMvision → LLMQUERY）
- 步驟 1 `LLMvision(A<描述>, prompt, "gemma3_12b")`：prompt 只要求**描述所見、逐字轉錄**：「只描述影像中看到的內容。若是表格或報表，逐列轉錄文字與數值，保留原順序與單位，看不清的字用 ? 代替，不要推測或補足。不要下診斷。」醫療影像改 `medgemma`。
- 步驟 2 `LLMQUERY(A<整理>, …, "qwen332b")`：把步驟 1 的文字整理成需要的格式（B 樣板），或給出印象（C 樣板）。
- 不要在一個 prompt 同時要求「看圖＋推論」，視覺模型推理弱、文字模型看不到圖。
- 影像由使用者在 HIS 端選取並以 base64 送出；目標欄位必須是 textarea（`E_MACRO_TARGET_TYPE`）。

### E. 臨床建議（衛教、處置提醒）
- 模型：`qwen3627b`；prompt 除 P1～P5 外加：「依據請標示來自紀錄的哪一句」「不要開立藥物劑量」「最後一行固定『※ AI 產生，需由醫師查核』」。
- 上架計畫的 AI 資料流要寫明這是「建議」而非判讀；表單的說明文字也放同一句查核提醒。

### F. 口述整理（VOICETOTEXT → LLMQUERY）
- 步驟 1 `VOICETOTEXT(A<逐字稿>, 'ASUS')`；步驟 2 LLMQUERY：「下列是口述逐字稿，整理成<紀錄格式：主訴／處置／衛教>，去掉口語贅字，不新增逐字稿沒有的內容，無法歸類的放『其他』。只提供答案。逐字稿：」＋`A<逐字稿>`。
- 完整步驟與觸發方式見 `MacroRecipes.md` R4。

### G. LLM 控制項（`action2`）
- 整段 `action_script` 經 Calx 求值後就是 prompt，模型固定預設（Llama 3.1 8B，英文佳、中文弱），不能指定。
- 只用在簡短英文任務；要中文或要選模型一律改用 `action` ＋ `LLMQUERY`。

## 5. lint 對照

| 代碼 | 觸發 | 處理 |
|---|---|---|
| `W_PROMPT_NO_GUARD` | prompt 引用欄位或 `GETTEXT()`／`GETVALUE()`，但沒有 `IF(LEN(...)` 防呆 | 套 §3 骨架 |
| `W_PROMPT_NO_SCOPE` | prompt 字串裡沒有「只根據／only based on」「not available／無資料」「只提供答案／answer only」任一句 | 補 P2～P4 |
| `W_VISION_NO_FOLLOWUP` | 巨集有 LLMvision 但之後沒有 LLMQUERY | 依 D 樣板接力，或確認只要描述 |
| `W_AI_IDENTIFIER` | prompt 帶入 `G_CHTNO()`、`G_USERNM()` 等 | 移除 |
| `W_LLM_NOT_AWAITED` | LLMQUERY 寫在 IF 內或大小寫不對 | 條件改寫進 prompt（P7） |
| `E_LLM_MODEL_*` | 模型不在白名單、deprecated、無視覺 | 改用 §2 的模型 |

三個 `W_PROMPT_*` 都是警告：reviewer 要在 `review.md` 列出，由使用者決定；沒有欄位參照的 prompt（純問答）不會觸發。

## 6. 試跑與調校

`/strucmed:tune-prompt <draft_id> <itemid>`：針對單一按鈕反覆改寫並用 `llmgateway_chat_test` 試跑（flag `llmChatTest`，預設關；只用去識別化樣本；計入金鑰配額）。真正的表單回覆仍以編輯器預覽與 HIS 端為準，因為 runtime 另有 system prompt 與路由。
