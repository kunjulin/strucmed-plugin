# 表單設計規則（控制項推論、字典、必填、禁止事項）

> 規則依據平台 runtime 實測。由 `create-form`、`edit-form` 與 `form-planner`、`form-reviewer` 載入。

## 控制項推論規則（v0.1）

| 資訊型態 | datatype | 規則 |
|---|---|---|
| 是／否、有／無 | `radiobutton` | row 2；需帶出細項時 `further` 指向該欄位 itemid |
| 單選 ≤ 6 項 | `radiobutton` | |
| 單選 > 6 項 | `selection` | 允許自由輸入改 `combobox` |
| 多選（症狀、病史） | `checkbox` | row 3–4；「其他」選項 `further` → 一個 `textbox` |
| 階層分類 | `submenu` | 選項以 `-`／`--`／`---` 開頭 |
| 數值量測 | `numberbox` | **必設** minval／maxval |
| 日期時間 | `calendar` | format date／time／datetime |
| 短文字 | `textbox` | |
| 自由描述、主訴、計畫 | `textarea` | |
| 顯示另一欄的值 | `label` | format Reference + reference |

`further` 指向的欄位要**先規劃好 itemid**：itemid 由 MCP 依建立順序分配（區塊與控制項共用、從 1 起），`form_add_control` 回傳值會告訴你。先建被引用的欄位，或先規劃順序再建。

**新產生的表單不支援**（告訴使用者，請其匯入後在編輯器手動補，或改用「以既有表單為範本改版」）：圖片、雙欄、群組、彈出片語、子表單綁定（新產生時不支援；改版時原封保留）。計算式、HIS 參照、巨集、LLM 按鈕見 §3b；表格與頁籤見 §3c。

## 必守規則

- **區塊權限**：預設所有人（`doctor`）可顯示、可編輯、回傳文字。只有刻意隱藏（放計算）或表頭不回傳時才宣告 `hidden` / `return_text:false`，並向使用者說明。
- **字典**：
  - 要結構化進倉儲的欄位才綁字典；純說明欄位不綁（`nohis`）。
  - 綁定既有字典時角色可選；**新字典匯入後角色一律 `tohis`**，需要其他角色要請使用者匯入後手動改。
  - 名稱在**同一層級**有多筆同名會被拒絕（`E_DICT_AMBIGUOUS`），請改用 id；不同層級同名時自動綁體系字典（`W_DICT_PREFER_SYSTEM`）。
  - 字典命名依使用者規範；未定案前用 `<表單縮寫>_<欄位語意>` 大寫英數底線，並先搜尋避免重複。
  - 說明、補述、層級與升級見下一節。
- **必填**：只標「沒有它表單就失去意義」的欄位；說明必填只在 HIS 端提醒，編輯器存檔不檢查。
- **禁止**：預設值或選項放任何病人資料；寫表單 JS；嵌入圖片；§3b 列出的禁用函數；任何刪除或覆寫線上範本與字典。線上寫入只限 §6 的病人紀錄存檔。
- 使用者要求超出範圍（例如「直接幫我把範本上傳到編輯器」）時，說明目前線上 tool 不含範本寫入，範本仍由使用者匯入 `.htm`；經 API 建立／更新範本的規劃（Phase 2）。

## 字典說明、補述與層級

字典的說明欄（dicComment）是一個 JSON 容器（MCP 2.4.0 起），由 MCP 與平台用同一份規格組裝，**不要自己拼 JSON**：

| 段落 | 內容 | 誰能改 | 怎麼寫入 |
|---|---|---|---|
| `desc` | 一行語意（≤ 300 字、不可換行） | 原作者；體系字典（2 碼，或帶體系標記）另含該體系的字典管理者 | 新建時 `dictionary.comment`；既有的**不動** |
| `memo` | 補述：`meaning` 語意、`type` 建議 datatype、`unit` 單位、`range` 合理範圍、`asr` 語音別名（陣列）、`calx` 計算式用途白話、`llm` 給 prompt 的欄位描述、`scope` 適用範圍 | 所有登入者與 AI | 新建時 `dictionary.memo`；既有字典用 `online_dictionary_memo_set` |
| `fhir` | FHIR 對應（陣列）：`res`、`path`、`code`（`system\|code`）、`display`、`ucum` | 所有登入者與 AI，寫入前檢查格式 | `online_dictionary_memo_set` |
| `sys` | 體系標記 `{ code, by, at }`：升級為體系字典時寫入，id 與 dicType 都不變 | 只有該體系的字典管理者（字典頁一鍵升級／降回科部） | 不由 AI 寫入，沒有工具 |
| `alias_of` | 已併入另一本字典 | 只有體系管理者（升級時體系內已有同名，在字典頁設定） | 不由 AI 寫入 |

舊字典的說明是純文字，讀取時整段視為 `desc`。早期版本留下的 `promote`（升級申請）段落讀取時保留，已不再使用。整段長度上限 1800 字（正式倉儲實測中文 1800 字完整保留），所以 memo 每格寫精簡的一句。**只用 Big5 字集裡的字**：倉儲是 Oracle 的 Big5（CP950）字集，字集外的字會被換掉，上標「²」還會弄壞整段說明（實測）。MCP 與平台都會拒絕（`E_INVALID_INPUT`，訊息指出是哪個字）。可以用：中文（含常見簡體字）、英數、全形標點、「÷ ＝ ± ℃ ㎏」等常見符號；要改寫的：上標下標（「²」寫成「^2」或「平方」）、圈號數字「①」、項目符號「•」、emoji。

### 綁定順序

`online_dictionary_search(update_index:true)` 後，依序找：**體系（sys：第 2–3 碼的字典，或帶體系標記、`sys.code` 等於登入者體系代碼的他科字典）→ 本科（own）→ 次專（sub，前 4 碼）→ 科部（dpt，前 3 碼）→ 新建科部字典**。
- 同名多層時 MCP 自動綁體系字典（`W_DICT_PREFER_SYSTEM`），計畫裡寫出綁的是哪一本。
- 字典有 `alias_of` 時 MCP 會改綁目標（`W_DICT_ALIAS`）。
- 綁既有字典前先讀它的 `memo`：datatype、單位、範圍、選項、計算式白話與 prompt 的欄位描述以 memo 為依據；memo 與需求衝突時列入「待決」，不要默默改用別的字典。
- 已有 `fhir` 的直接沿用，並用它反推 datatype 與單位（`valueQuantity`→numberbox＋ucum 單位、`valueCodeableConcept`→radiobutton／selection、`valueBoolean`→checkbox、`valueDateTime`→calendar、`valueString`→textbox／textarea）。

### memo 怎麼寫

- **保留既有內容再補充**：`online_dictionary_memo_set` 的 memo 只覆寫給的鍵，其他鍵保留；要清除某鍵才給 `""`。不要因為「寫得不好」就整段改寫別人的 memo。
- `meaning`：一句臨床語意（「病人自述過去一年內跌倒次數」），不是重複名稱。
- `type`／`unit`／`range`：與表單實際控制項相同（numberbox 的 minval／maxval 就是 range）。
- `asr`：語音輸入時醫師會說的叫法（中文、英文縮寫、口語），給語音巨集對欄位用。
- `calx`：這個欄位參與的計算式白話（「BMI＝體重 ÷（身高 m）²」）；不寫 Calx 原文。
- `llm`：寫 prompt 時描述這個欄位的那句話（tune-prompt 與 LLM 按鈕直接引用），不放病人資料。
- `scope`：適用科別或情境；跨科共用時寫出來，作為升級理由。
- `fhir`：`path` 必須以 `res` 開頭；`code` 的 system 只能是 LOINC（`http://loinc.org`）、SNOMED CT（`http://snomed.info/sct`）、ICD-10-CM（`http://hl7.org/fhir/sid/icd-10-cm`）、UCUM 或院內 CodeSystem。ICD-10-CM 以已連線的 ICD-10 MCP（`lookup_code`、`validate_code`）驗證；LOINC、SNOMED 沒有查詢工具，由 planner 提建議並在 G1 標「待人工確認」。datatype 與 FHIR 型別不一致只警告（`W_FHIR_TYPE_MISMATCH`）。

### 何時建議升級為體系字典

- 同體系不同科部會用到同一個量測或評估（體重、身高、疼痛分數、跌倒史），且目前只有科部層級字典。
- 計畫中綁的既有字典是 own／sub／dpt 層級、而表單要給其他科共用。
- 體系內已有同名字典時不要建議，直接綁體系那本。

**AI 不升級，也沒有升級工具**：建議列入 G1「### 體系升級建議」（字典、id 前 8 碼、理由），交付時請使用者轉給體系字典管理者，由管理者在字典頁按「升級為體系 XX」。
- 倉儲不允許同一個 id 改類型（正式倉儲實測 HTTP 500），所以升級**不改 id、也不改 dicType**，只在說明寫入體系標記 `sys`。
- 升級後同體系其他科部的比對範圍會納入這本字典，層級是 sys；已綁這本字典的表單不必改。
- 管理者也可以降回科部（移除標記）。
- 體系內已有同名字典時無法升級；管理者可以把這本設為那本的別名（`alias_of`），之後 MCP 會改綁體系那本（`W_DICT_ALIAS`）。
