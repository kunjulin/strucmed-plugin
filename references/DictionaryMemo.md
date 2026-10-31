# 字典補述（memo）怎麼寫

> 由 `dictionary-assist`、`form-planner`、`dictionary-annotator`、`tune-prompt` 載入。字典說明的 JSON 容器、誰能改哪一段、綁定順序見 `FormDesignRules.md`〈字典說明、補述與層級〉。

補述是給**下一個編表單的人與 AI** 看的：存檔要綁哪本字典、計算式與巨集怎麼引用、LLM prompt 怎麼描述這個欄位、別的表單能不能共用。寫的時候以欄位事實為底（`form_fields` 的說明文字、datatype、選項、範圍、參照關係、`derived`），寫成一句一句給人看的話。

## 1. 11 個鍵

正規順序（MCP 與平台相同）：meaning → type → unit → range → **func → usecase → interop** → asr → calx → llm → scope。每格 ≤ 300 字，整段說明 ≤ 1800 字，所以**每格寫精簡的一兩句**。

| 鍵 | 名稱 | 寫什麼 | 例（體重） |
|---|---|---|---|
| `meaning` | 語意 | 一句臨床語意，不是重複名稱 | 病人當次量測的體重 |
| `type` | 控制項 | 建議的 datatype，與表單一致 | numberbox |
| `unit` | 單位 | 值的單位 | kg |
| `range` | 範圍 | 合理範圍（numberbox 的 min-max）或選項（用「／」分隔） | 0-300 |
| `func` | **表單功能** | 在表單中的角色：使用者輸入、計算結果、計算式輸入、巨集寫入目標、LLM 輸入或回覆、HIS 帶入、存檔回寫、選項連動 | 使用者輸入；BMI 計算式的輸入 |
| `usecase` | **使用情境** | 哪種表單、什麼時間點、誰填、臨床目的 | 門診初診與追蹤，護理師量測後填寫，供營養評估與藥物劑量 |
| `interop` | **交換引用** | 別的表單引用時要知道的：值的格式與精度、編碼、與哪些字典同義或互斥、單位換算、不要混用的情況 | 數字到 1 位小數；與「體重(lb)」不同單位不可混用；FHIR Observation 29463-7 |
| `asr` | 語音別名 | 醫師口語的叫法（陣列，≤ 20 個）；欄位說明與別名完全相同時，`dictionary_suggest` 視同名稱相同 | 體重、BW、weight |
| `calx` | 計算式說明 | 參與的計算式白話，不寫 Calx 原文 | BMI＝體重 ÷（身高 m）^2 |
| `llm` | LLM 提示 | 寫 prompt 時描述這個欄位的那句話 | 體重（kg，數字） |
| `scope` | 適用範圍 | 適用科別或情境；跨科共用時寫出來（升級理由） | 全院門診、住院 |

`fhir`（另一段，不在 memo 內）：見 `FormDesignRules.md`。interop 可以提到 FHIR 對應，但代碼本身寫在 `fhir`。

## 2. 三個角度怎麼寫

- **表單功能（func）**：從 `form_fields` 的 `derived.func`、`refs_in`、`ai` 改寫。寫「角色」，不寫 itemid（itemid 每張表單不同）。同一本字典用在多張表單、角色不同時，寫共通的角色，再用「例如」帶一個。
- **使用情境（usecase）**：寫臨床脈絡，不寫某位病人。可以從表單名稱、區塊標題、作業別（門／住／急…）、`online_dictionary_usage` 列出的表單推得。
- **交換引用（interop）**：站在「別張表單要引用這本字典」的角度：值長什麼樣、怎麼比對、跟誰不能混。從 `dictionary_suggest` 找到的相似字典（同義、不同單位、不同選項集）寫進來。

## 3. 規則

- **保留既有內容再補充**：既有字典只補缺的鍵；覺得別人寫的有誤時，在計畫中標「建議修改」並寫理由，由使用者決定，不要直接覆寫。
- **不放病人資料**：不寫姓名、病歷號、身分證字號、具體病人的數值。`dictionary_memo_check` 會擋疑似個資。
- **只用 Big5 字**：上標「²」寫成「^2」或「平方」；不用 emoji、圈號數字、項目符號「•」。
- **多張表單共用時寫共通內容**：整段說明上限 1800 字，不要為每張表單各加一句；`func`、`usecase` 寫共通角色，表單特有的細節不寫。
- 寫完一定跑 `dictionary_memo_check`（既有字典帶 `dic_id`，有 draft 時帶 `draft_id`＋`itemid`），error 修到沒有，warning 逐條確認。
- 站台還不支援 func／usecase／interop 時（`W_SERVER_OLD_MEMO_KEYS`），這三格不會寫入；計畫中照樣列出，等平台升級後再補。

## 4. 寫入方式

| 情況 | 工具 |
|---|---|
| 新建字典（表單計畫的待新建字典） | 建置時 `form_add_control`／`form_update_control` 的 `dictionary.memo`，上架時 `online_dictionary_batch`／`create` 一起寫 |
| 一本既有字典 | `online_dictionary_memo_set`（兩段式＋瀏覽器確認頁） |
| 一張表單的多本既有字典 | `online_dictionary_memo_batch`（一次 ≤ 100 本，逐本 If-Match，計畫檔 `memo-plan.md`） |

補述不需要上架表單，所有登入者都能寫，不限字典建立者。`desc` 仍只有原作者或體系管理者能改。
