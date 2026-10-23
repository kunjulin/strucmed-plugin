# 巨集工作流配方（批次多函數、生成式 AI、語音、倉儲帶入）

> 由 `form-planner`、`form-reviewer`、`create-form`、`edit-form`、`tune-prompt` 載入。依據：GitBook「巨集按鈕控制項」「函數(巨集專用)」「倉儲巨集函數」「語音轉錄函數」與平台 runtime 實測。語法陷阱在 `FormulaMacroRules.md`，prompt 寫法在 `PromptPatterns.md`。
> GitBook 原「批次多函數指令執行」頁已搬走，規則以「巨集按鈕控制項」頁與 `TempHtml.js` 實測為準。

## 1. 執行模型（設計前先記住）

| 規則 | 內容 |
|---|---|
| 步驟 | `action_script` 以**最外層逗號**分隔，依序執行；runtime 只算括號深度不理引號，字串內的括號或逗號會打亂切分（`E_MACRO_SPLIT`） |
| 等待 | `LLMQUERY`、`LLMvision`、`VOICETOTEXT` 是非同步步驟，**大小寫完全相同且在步驟開頭**時 runtime 才會等它完成再做下一步 |
| 中止 | 任一步驟出錯就中止整個序列並顯示錯誤；之前已寫入的欄位不會回復 |
| 結果 | 最後一個一般運算式的結果寫入 `action_id`（0 或空白＝不回傳）；要寫多個欄位用 `MACRO(id, 運算式)` 或 `SETVALUEBYID(id, 值)` |
| 觸發 | 點按鈕；`textbox` 的 `fur_action_id`（輸入後觸發）；`action_name` 留空＝隱藏按鈕，只能被前者觸發 |
| 條件 | 外層 `IF` 擋不住 LLMQUERY（每次都執行、不等待）；條件寫進 prompt |
| 讀取 | 步驟內用 `A<itemid>` 讀欄位，被讀的欄位要勾「參與計算」；`MACRO` 會把換行與連續空白壓成一個空白 |
| 不能寫入 | 動態表格（`table1`／`table2`）內的欄位：每列共用 itemid，會一次改到所有列（`E_MACRO_TARGET_TABLE`）；頁籤內欄位不上傳 HIS |
| 禁用 | `CUSTOMFUNC`、`OPENURL`、`SAVEDOC`、`SETIOTHEADER`、`S_USERID`、`S_DEPTNO`（`E_FORBIDDEN_FUNCTION`）；需要時匯入後由人工在編輯器加並審查 |

## 2. 規劃時要問使用者的三件事

1. **觸發**：按鈕點一下？輸入某欄位後自動？開表單時就帶入（那是 HIS 參照 label，不是巨集）？
2. **輸入來源**：哪些欄位、HIS 哪些資料（天數）、要不要影像或錄音。
3. **輸出**：寫到哪個欄位、一個還是多個、是否要帶回 HIS 文字（textarea 綁字典 `tohis`）。

答案決定配方，再把每一步寫進計畫的「### 計算式與巨集」表（`Gates.md` §2）：一列一個步驟，`類型` 寫 `action 步驟 n：LLMQUERY`，`寫入` 寫目標 `C*`。

## 3. 配方

每個配方：觸發 → 步驟 → 需要的控制項 → 注意。`<id>` 一律以計畫的 `C*` 表示，建置後由 builder 換成 itemid。

### R1 一鍵病歷摘要（HIS 資料 → LLM）
- 觸發：按鈕「整理病歷」。
- 控制項：`C_src` label `format=hisquery`（例 `OPDDATA.InDays(180).GetLatestString()`，開表單時帶入，勾參與計算）；`C_out` textarea。
- 步驟：
  ```
  LLMQUERY(<C_out>, IF(LEN(A<C_src>) < 10, "not available", CONCATENATE("…摘要 prompt…", A<C_src>)), "qwen3627b")
  ```
- 注意：HIS 參照用 label 在開表單時帶入最穩；`HISQUERY("id,查詢")` 當巨集步驟後接 LLMQUERY 是否等待**未經實測**，不要依賴。`W_PATIENT_DATA_READ` 與 `W_AI_DATAFLOW` 必列。

### R2 摘要 → 臨床問題（兩段 LLM 接力）
- 觸發：同一顆按鈕。
- 控制項：`C_src`（同 R1）、`C_sum` textarea、`C_q` textarea。
- 步驟：
  ```
  LLMQUERY(<C_sum>, IF(LEN(A<C_src>) < 10, "not available", CONCATENATE("…摘要…", A<C_src>)), "qwen3627b"),
  LLMQUERY(<C_q>, IF(LEN(A<C_sum>) < 10, "not available", CONCATENATE("…依摘要列問題與鑑別…", A<C_sum>)), "tqwen3627b")
  ```
- 注意：第二步讀第一步的欄位，所以 `C_sum` 要勾參與計算；兩步都要防呆。

### R3 影像／圖表 → 文字（LLMvision → LLMQUERY）
- 觸發：按鈕「讀取報告影像」；影像由使用者在 HIS 端選取。
- 控制項：`C_desc` textarea（LLMvision 目標**必須是 textarea**）、`C_out` textarea。
- 步驟：
  ```
  LLMvision(<C_desc>, "只描述影像內容，表格逐列轉錄，看不清用 ? 代替，不要推測，不要下診斷", "gemma3_12b"),
  LLMQUERY(<C_out>, IF(LEN(A<C_desc>) < 10, "not available", CONCATENATE("…整理成格式…", A<C_desc>)), "qwen332b")
  ```
- 注意：只有 `gemma3`、`gemma3_12b`、`medgemma` 能看圖，其餘會編造；沒有第二步時 lint 出 `W_VISION_NO_FOLLOWUP`（只要描述可忽略）。

### R4 口述 → 紀錄（VOICETOTEXT → LLMQUERY）
- 觸發：按鈕「口述」；按下即錄音，結束後寫入逐字稿欄位再接 LLM。
- 控制項：`C_raw` textarea（逐字稿）、`C_note` textarea（整理後，綁字典 `tohis` 才回 HIS）。
- 步驟：
  ```
  VOICETOTEXT(<C_raw>, 'ASUS'),
  LLMQUERY(<C_note>, IF(LEN(A<C_raw>) < 10, "not available", CONCATENATE("…整理口述…", A<C_raw>)), "qwen3627b")
  ```
- 注意：服務只能 `'ASUS'` 或 `'QWEN'`（`E_ASR_PROVIDER`）；同時只能開一個錄音視窗；音量太小會被判為結束；逐字稿欄位保留給使用者核對。

### R5 輸入後自動判讀（fur_action_id → 隱藏按鈕）
- 觸發：使用者在 `C_in` textbox 輸入完成。
- 控制項：`C_in` textbox，`fur_action_id` 指向 `C_btn`；`C_btn` action，`action_name` 留空（隱藏）、`action_id` = `C_res`；`C_res` label 或 textbox。
- 步驟：
  ```
  IF(VALUE(A<C_in>) >= 4, "高風險", "低風險")
  ```
- 注意：只有一般運算式，結果走 `action_id`；要寫多欄改 R6。不要在這裡放 LLMQUERY，每次輸入都會呼叫一次。

### R6 一鍵回填多欄位（MACRO／SETVALUEBYID）
- 觸發：按鈕「套用判讀」。
- 控制項：來源 `C_a`、`C_b`；目標 `C_x`、`C_y`、`C_z`。
- 步驟：
  ```
  MACRO(<C_x>, IF(A<C_a> > 25, "過重", "正常")),
  MACRO(<C_y>, ROUND(A<C_a> / 2, 1)),
  SETVALUEBYID(<C_z>, "已判讀")
  ```
- 注意：`action_id` 填 0；`MACRO` 第一個參數不能含逗號；目標型別要能接受字串或數字。

### R7 倉儲資料帶入（LOOKUPDW）
- 觸發：按鈕「帶入上次評估」。
- 步驟：
  ```
  LOOKUPDW("FALL_SCORE:<C_prev>; FALL_NOTE:<C_note>", null, 30)
  ```
- 注意：`req` 為「字典名:欄位 id」以分號分隔；`condition` 不用時**明寫 `null`**；`duration` 預設 7 天、上限 30；開表單時就要帶入改用 `LOOKUPDEFAULTSETTING`（同參數，寫在巨集但開表單執行）。屬 lookup 類，`W_PATIENT_DATA_READ`。

### R8 條件式 LLM（條件寫進 prompt）
- 觸發：按鈕。
- 步驟：
  ```
  LLMQUERY(<C_out>, IF(A<C_flag> = "是", CONCATENATE("…", A<C_src>), "do not respond, answer: not applicable"), "qwen3627b")
  ```
- 注意：不要寫 `IF(A<C_flag> = "是", LLMQUERY(...), "")`，那樣 LLMQUERY 仍會執行且不等待。

### R9 套用表單預設（APPLYPRESETBYNAME）
- 步驟：`APPLYPRESETBYNAME("一般門診")`；預設由使用者在 HIS 端「管理表單預設」建立，名稱要一致。

## 4. 建置與驗證

- 每一步先 `formula_check`（`kind: macro`，帶 `draft_id` 檢查參照與目標型別）；LLM 控制項用 `kind: prompt`。
- builder 的順序：先建所有被讀取與被寫入的欄位，最後才 `form_update_control` 寫 `action_script`、`action_id`、`fur_action_id`。
- `verify-runtime`：按鈕按一次後讀 `window.__simulated`，確認步驟數、每步的 prompt 與模型、目標欄位；LLM／語音不會真的呼叫。
- 交付：`W_AI_DATAFLOW` 列出每一步送出的欄位；提醒匯入後不要按「重新編號」（`W_RENUMBER_MACRO`）。
