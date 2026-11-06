# 表單 JS 增益集：白名單片段怎麼用

> 適用：flag `formScript` 開啟時（`feature-flags.json`，預設關）。關閉時 `form_set_script`／`form_script_preview` 不在工具清單，表單的 JS 區塊只有產生器標記註解。進階片段（`autorun`、`table-rows`）另需 flag `formScriptAdvanced`（預設關）。安全理由與禁止清單見 `SecurityInvariants.md` 第 5 條；設計依據是 strucmed-skill 的 docs 13。

## 1. 先用別的，不夠才用片段

| 需求 | 先用 | 片段 |
|---|---|---|
| 某欄位的文字顏色、字級、底色 | 控制項本身的樣式欄位：`form_add_control`／`form_update_control` 的 `font_color`、`font_size`（10–24 px）、`back_color`（不需 flag；編輯器屬性面板也看得到、人工可再調） | — |
| 區塊底色、分隔線、圓角、間距、表格格線與斑馬紋、整張表單主題 | — | `style` |
| 依另一欄的值算出結果，顯示就好 | formula 型 label | — |
| 依另一欄的值算出結果，要寫進可編輯欄位（textbox／selection／radiobutton／calendar）或開文件時就要有 | — | `derive` |
| 選了某選項才顯示其他欄位 | `further`、`datagroup` | — |
| 輸入後自動跑巨集 | textbox 的 `fur_action_id`＋隱藏巨集（`MacroRecipes.md` R5） | — |
| 依固定對照表判讀（藥名→分類、代碼→名稱）寫進另一欄 | 選項少時用 selection＋計算式 | `lookup` |
| 值落在範圍外或兩欄矛盾時立即提示、標示欄位 | numberbox 的 `minval`／`maxval`（存檔才檢查） | `guard` |
| 必填欄位離開時立即提醒 | `required`（存檔才提醒） | `required` |
| 開文件時自動帶 HIS 資料或跑 AI（不按按鈕） | 巨集按鈕 | `autorun`（進階） |
| 動態表格開文件時就有固定幾列、預填內容 | 人工按「+」 | `table-rows`（進階） |
| 隱藏小助手／預設按鈕群組／上次紀錄圖示 | `form_create` 的 `options.hide_assist`／`hide_preset`／`hide_prev_icon`（表單選項，不是 JS） | — |
| 表單間跳轉 | 等平台提供受控函數 | 不做 |

片段只在 2.0 runtime 執行；不影響 HIS 文字輸出、倉儲 key-value 與字典；**樣式會影響列印版面**，計畫與交付都要提一句。1.0（IE）表單不支援。

## 2. 七種樣板的參數

`form_set_script(draft_id, snippets)`：`snippets` 是**整份**清單（空陣列＝清除），每個 `{ id?, template, params }`。`id` 小寫英數、`-`、`_`，字母開頭（省略＝`s1`、`s2`…）。參數有錯時什麼都不改，回 `errors`。共同規則：itemid 用建置對照表換算；訊息類文字 ≤ 200 字，不接受 `< > { } [ ] ( ) = \ \` $ ;`、控制字元，也不接受 `ck_`、`window`、`document`、`eval`、`location`、`fetch`、`script` 等字；對照表與預填值放寬到可含括號與等號，仍不接受 `< > { } \ \` $ ;`。

### `style`
```json
{ "id": "look", "template": "style", "params": {
  "theme": "clean",
  "rules": [
    { "scope": "area:1", "css": { "background-color": "#fff8d6", "border-left": "4px solid #d9a300" } },
    { "scope": "area:6 table", "css": { "border": "1px solid lightgray" } },
    { "scope": "control:5", "css": { "font-size": "18px", "font-weight": "bold" } },
    { "scope": "form", "css": { "margin": "0 auto" } } ] } }
```
- `theme`：`clean`（區塊留白、淡灰分隔線）、`compact`（縮小間距）、`zebra-table`（表格格線與斑馬紋）、`highlight-required`（必填空白欄位淡黃底）。CSS 固定在 MCP 內，沒有可調參數；`form_script_preview` 的 `themes` 列出清單。
- `rules[].scope`：只有 `form`、`area:<itemid>`、`area:<itemid> table`、`control:<itemid>`；不接受選擇器字串。
- `rules[].css`：屬性只有 `color`、`background-color`、`background`、`font-size`、`font-weight`、`width`、`min-width`、`border`、`border-left`、`border-bottom`、`border-radius`、`text-align`、`padding`、`margin`。值：顏色 `#hex`／`rgb()`／色名、長度 `數字+px|em|rem|%`、邊框 `Npx solid|dashed|dotted 顏色`、`bold|normal`、`left|center|right`。值內不可有 `url(`、`expression(`、`@import`、`;`、`}`。
- 不開放 `display`、`visibility`、`position`、`z-index`、`pointer-events`、`content`：要藏欄位走區塊 `hidden` 與 `further`。
- `theme` 與 `rules` 至少一個；可並用（主題在前、規則在後）。`control:N` 上的 `color`／`font-size`／`background` 由 MCP 自動加 `!important`（runtime 是 inline style）。

### `guard`
```json
{ "id": "bmi-high", "template": "guard", "params": {
  "sources": [2, 3],
  "condition": "AND(A2 > 0, A3 > 0, A3 / (A2 / 100) ^ 2 > 35)",
  "message": "BMI 超過 35，請確認身高與體重",
  "highlight": [2, 3] } }
```
- `sources`：改值會觸發的控制項 itemid（要 `tocalc: true`）。
- `condition`：Calx 運算式，**真＝有問題**，以 `A<itemid>` 參照；規則同計算式（`formula_check` 同一套 lint）：比較運算子兩側空白、不能用巨集專用與禁用函數、不能 `LLMQUERY`。
- `highlight`（選填）：成立時加 `.sm-guard`（淡紅底、左紅框）的控制項；不成立時移除。
- 行為：`sources` 的 keyup／change／blur 去抖 150ms 後評估；只在「沒問題 → 有問題」時提示一次（`errormessage`，4 秒自動收起）；文件載入完成後也跑一次（見 §2 末「開文件時」）。

### `derive`
```json
{ "id": "bmi-cat", "template": "derive", "params": {
  "sources": [2, 3], "target": 8,
  "expr": "IF(AND(A2 > 0, A3 > 0), IF(A3 / (A2 / 100) ^ 2 >= 27, \"肥胖\", \"正常\"), \"\")",
  "when": "both" } }
```
- `target`：寫值的欄位，**不能是 label**（label 請用計算式）、按鈕、圖片，不能在動態表格內，不能同時在 `sources`；`expr` 不能參照 `target` 自己。
- `expr`：Calx 運算式，規則同 `guard` 的 `condition`；結果以 `SetValueByID` 寫進 `target`，值沒變就不寫。
- `when`：`change`（預設：`sources` 改值後）、`docload`（開文件時一次）、`both`。
- 與 R5（`fur_action_id`＋隱藏巨集）重疊：目標是 selection／radiobutton／calendar，或需要「開文件時」就有值，才用 `derive`。

### `lookup`
```json
{ "id": "dose", "template": "lookup", "params": {
  "name": "drug_dose", "source": 5,
  "table": { "Aspirin": "100mg qd", "Metformin": "500mg bid" },
  "target": 10,
  "miss": { "message": "查無此藥的常用劑量", "value": "" },
  "trigger": "customfunc" } }
```
- `name`：小寫英數與 `_`，字母開頭，2–31 字；渲染成函數 `sm_<name>`，同一張表單不可重複。
- `source`→`table`→`target`：依 `source` 的值（去頭尾空白、區分大小寫）查 `table`（≤ 200 筆，字串對字串），命中就寫進 `target`。`target` 規則同 `derive`。
- `miss`（選填）：查無時 `message` 提示、`value` 寫進 `target`（`""` 清空）。
- `trigger`：`change`（預設：`source` 改值後查）或 `customfunc`（不綁事件，由巨集呼叫 `CUSTOMFUNC("sm_<name>")`）。
- **CUSTOMFUNC 的放行**：flag 開啟時 lint 只放行第一個參數是字串字面值、且是本 draft `lookup`（`trigger: customfunc`）定義的 `sm_<name>`；其他名稱回 `E_CUSTOMFUNC_UNDEFINED`（可延後：巨集可以先建、片段後設，`form_validate` 會抓）；非字面值或 flag 關閉回 `E_FORBIDDEN_FUNCTION`。片段清掉時既有巨集的 `CUSTOMFUNC` 變成錯誤。
- 對照表內容會進表單定義（倉儲可見）：不可放病人資料。

### `required`
```json
{ "id": "need", "template": "required", "params": { "targets": [2], "message": "評估者必填" } }
```
- `targets`：必須已是 `required: true` 的控制項，不能在動態表格內。
- 行為：欄位失焦（focusout）時沒有文字也沒有勾選 → `errormessage` 提示並加 `.sm-guard`；填了再失焦就移除。runtime 本身只在存檔時檢查必填。

### `autorun`（進階，flag `formScriptAdvanced`）
```json
{ "id": "auto", "template": "autorun", "params": { "action": 13, "only_if_empty": 11 } }
```
- `action`：巨集按鈕（datatype `action`）的 itemid；LLM 按鈕（`action2`）不支援。開文件後 `performActionByID` 執行它，等於使用者按了按鈕：巨集本身照舊過 lint、列 `W_AI_DATAFLOW`，片段不直接呼叫查詢或 AI 函數。
- `only_if_empty`（選填）：該欄位已有值時不執行（避免重開文件時再送一次 AI／查詢）。
- `form_set_script` 與 `form_validate` 會回 `W_SCRIPT_AUTORUN`，列出會自動送出的 AI／查詢步驟；**verify-runtime 必跑**，看預覽頁「已封鎖的請求」與目標欄位顯示的「將送出 N 字」。
- 計畫「### 表單 JS」段要寫明觸發時機、會送出的欄位、去向；定稿 plan 的 `script.advanced` 另列進階片段。

### `table-rows`（進階，flag `formScriptAdvanced`）
```json
{ "id": "meds", "template": "table-rows", "params": {
  "table": 14, "rows": { "count": 2 },
  "prefill": { "15": ["Aspirin", "Metformin"], "16": ["100mg qd", "500mg bid"] } } }
```
- `table`：`table1`（可加列的動態表格）區塊的 itemid；`table2`、`formtable` 不支援。
- `rows`：`{ count: 1–30 }` 固定列數，或 `{ source: itemid }` 以該欄位（numberbox／selection／radiobutton／textbox，值為數字）的值為列數（改值後也補）。只補不刪：已有的列不動。
- `prefill`（選填）：`{ "<表格內欄位 itemid>": [第 1 列的值, 第 2 列的值, …] }`，欄位必須在同一個表格內。
- 開文件後執行（見下）；重開已存檔的文件時，runtime 會先還原原本的列，片段只在列數不足時補。

**開文件時（`docload`、`autorun`、`table-rows`、`guard` 的初次評估）怎麼等**：runtime 沒有「文件載入完成」事件，片段每 500ms 看一次 `ck_getDocDone`（只讀），最多 30 秒；沒有病人（`ck_hasPatient` 是 false：預覽頁、沒有 HIS header）時 runtime 不會載入文件，片段在 1 秒後直接執行。逾時放棄並 `console.warn`。

## 3. 草案「### 表單 JS」段（planner 寫，builder 照建，reviewer 核對）

```markdown
### 表單 JS（flag formScript；沒有則寫「無」）
| id | 樣板 | 參數（C*／A* 用穩定 ID） | 效果 | 觸發時機 | 影響的欄位 |
|---|---|---|---|---|---|
| look | style | theme clean；area A1 底色 #fff8d6；control C5 18px 粗體 | 測量區塊淡黃底、BMI 放大 | 開表單時 | A1、C5 |
| bmi-high | guard | sources C2、C3；condition AND(C2 > 0, C3 > 0, C3 / (C2 / 100) ^ 2 > 35)；message「BMI 超過 35，請確認身高與體重」；highlight C2、C3 | 提示並標紅 | C2／C3 改值後、開文件時 | C2、C3 |
| dose | lookup | name drug_dose；source C5；table Aspirin→100mg qd、Metformin→500mg bid；target C10；miss message「查無」；trigger customfunc | 巨集 C12 按下帶入劑量 | 巨集 CUSTOMFUNC("sm_drug_dose") | C5、C10 |
| auto | autorun（進階） | action C13；only_if_empty C11 | 開文件自動產生摘要（LLMQUERY→C11，送出 C7、C5） | 開文件時，C11 空白才跑 | C13、C11 |
```
- planner：需求有「自動提示／美化／連動／對照表／必填提醒」且呼叫端告知 flag 已開才寫；進階樣板另需 `formScriptAdvanced`。flag 關閉時不寫片段，在 `Issues` 註明「需開 formScript（或 formScriptAdvanced）」並改用 §1 的替代做法。`autorun` 的「效果」欄要寫會送出哪些欄位、到哪裡。
- builder：所有欄位、計算式與巨集建好之後，依這一段以 `form_set_script` 一次設定（`C*`→itemid 用對照表換算；`theme`、`name` 原樣）。巨集用到 `CUSTOMFUNC("sm_<name>")` 時先建巨集也可以（回 `E_CUSTOMFUNC_UNDEFINED` 會延後），但片段設好後要再 `form_validate` 一次。回 `E_INVALID_INPUT` 就照 `errors` 修，不要略過；回傳的 `rendered` 不貼回對話。
- reviewer：`form_script_preview` 的 `snippets`（id、template、affects、advanced）要與這一段一致、`findings` 沒有 error；渲染後的程式碼寫進 review.md「## 表單 JS」（程式碼圍欄），供定稿檔引用。`lookup`／`derive` 的 `target` 不是倉儲欄位（nohis）時提醒「不回 HIS」。
- 審閱迴圈中要改片段：`form_set_script` 整份重設（它會取代全部），改動追加到「### 審閱修改紀錄」。

## 4. 閘門與交付

- 定稿檔（`Gates.md` §3）「### 表單 JS」段＝`form_export`／`online_template_create`／`online_template_update` 第一次呼叫 plan 的 `script`：片段清單、`advanced`（有進階片段時）、`sha256`、`rendered` 原樣放在程式碼圍欄內。這是使用者核准的對象，不要摘要改寫。
- `verify-runtime`：有 `guard`／`derive`／`lookup`／`required` 片段時**必跑**，實際輸入一組值看結果（guard：觸發再改回，記「提示出現一次、標示加上又移除」；derive／lookup：輸入來源看目標；required：空白失焦再填上）；有 `autorun` 時看開文件後「已封鎖的請求」與目標欄位的「將送出 N 字」；有 `table-rows` 時看列數與預填；有 `style` 片段時截一張預覽圖給使用者（現行「使用者要求才截圖」在這裡例外）。
- 交付：有片段時加一行「表單 JS：N 個片段（樣式會影響列印版面）」，並提醒在編輯器「表單選項」的 JS 區塊可以看到同一段程式碼；上架後 `online_template_get` 會比對標記行的雜湊，人工改過回 `W_SCRIPT_MODIFIED`（本工具不為改過的內容負責）。
- `form_remove_control`／`form_remove_area` 會擋片段參照到的欄位與區塊（blockers 的 `from` 是 `snippet:<id>`）：先用 `form_set_script` 拿掉或改參數。
- flag 事後關閉時 `form_validate` 回 `E_FEATURE_DISABLED`：開回 flag，或 `form_set_script` 帶空陣列清除。
- 改版（`form_import`）的原表單 JS 原封保留（`W_CUSTOM_JS`）；flag 開啟時另以片段同一套禁用 token 掃描，命中列在 `W_CUSTOM_JS_FINDINGS`（只告知，不擋不改），人工審查時特別看這幾處。

## 5. 不做

不寫自由 JS、CSS 或選擇器；不碰 `ck_*`、身分、存檔載入、整份資料、連外。表單間跳轉等平台提供受控函數後再做；讀整份報告文字、純畫面的 `ck_*` 開關（字數統計由 HIS header 決定；隱藏按鈕走表單選項）不做樣板。其他需求出現時，告訴使用者目前的七種樣板與 §1 的替代做法，或請其匯入後在編輯器人工加入並審查。
