# 閘門與計畫檔格式

> 比照 microsoft/power-platform-skills 的核准關卡：固定標題、核准寫入計畫檔、上游變更即失效、子代理不問使用者。
> 3.9.0 起流程是「先建再看」：draft 是本機檔，建錯可以重建，不動線上（實測 10 欄內約 4 分，60 欄約 20 分），所以建置前不核准；使用者看著預覽頁改，只在線上寫入或輸出前核准一次。

## 1. 閘門

| 閘門 | 標題 | 時機 | 強制方式 | 取消後留下什麼 |
|---|---|---|---|---|
| （非閘門）需求確認 | — | 階段 1 | `AskUserQuestion` 一次 | 無 |
| （非閘門）審閱迴圈 | — | 階段 3 | 預覽頁；意見檔在 `.strucmed/review/` | 本機 draft |
| **G2** | `## 定稿` | 審閱迴圈後、任何線上寫入或輸出前 | skill 呈現＋`verify-plan.mjs prepare`；線上寫入另由 hooks（`publish-plan.md` sidecar）與瀏覽器確認頁強制 | 本機 draft、字典 CSV、review 檔；線上沒有任何寫入 |
| G4 | `## 應用程式計畫` | B2 app 產生前（H0／H2；H1 以 `online_me_notes_set` 的 plan 代替） | skill 呈現＋`verify-plan.mjs prepare` | 沒有產生任何檔案 |

G1、G3 編號停用，不重新編號：舊文件、CHANGELOG 與案例文件裡的 G1～G3 指 3.8.0 以前的流程。

閘門在對話中呈現的固定格式（對話中**不輸出** `<!-- gate: … -->` 註解：Codex 等工具會把它顯示成文字；閘門 id 已在 🚦 那一行。註解只寫在計畫檔；從計畫檔呈現內容時略去該行）：

```markdown
## 定稿
> 🚦 **閘門（publish-form:publish）**：核准後才會寫入線上（或輸出 .htm）。
> **為什麼問**：這是唯一的核准點：驗證結果、HIS 文字輸出、字典與上架設定一次看完。
> **取消會留下**：本機 draft、字典 CSV、review 檔；線上沒有任何寫入。

（定稿檔內容）

| 選項 | 說明 |
|---|---|
| 核准（建議） | 依此定稿寫入線上或輸出。有疑問請先在對話問，不要在這裡選 |
| 要求修改 | 說明要改什麼；改 draft 或 CSV 後 Revision +1 重新呈現 |
| 取消 | 停止，線上沒有任何寫入 |
```

選項一律用 `AskUserQuestion`（三個選項，核准放第一個）。**子代理（`form-planner`、`form-builder`、`form-reviewer`）是 headless 的，`AskUserQuestion` 在它們裡面不會到達使用者**；閘門只能由 skill 本身呈現。

## 2. 草案檔

位置：`<workspace>/.strucmed/plans/<slug>/strucmed-form-plan.md`（slug＝表單名稱的英數底線化，最多 40 字）。檔名沿用，builder、reviewer 都讀它。草案**沒有「## 核准」段**、不跑 `verify-plan.mjs prepare`、builder 不跑 `verify`，產出後直接建。

```markdown
# <表單名稱> 表單草案

## 表單草案
Status: Ready            ← Ready | NeedsRevision | Blocked
Revision: 1              ← 每次修改 +1
Inputs: dept_no=33F00; groups=; publish=false; folder=usr; his_text_keys=Report,Impression; dictionary_index=online 2026-10-26

### 結構
| ID | 區塊／控制項 | datatype | 說明文字 | 選項／範圍 | 字典（名稱／完整 id／層級；或「新建：一行 desc」） | 必填 | 備註（further→C2；cell 從 0 起算：row/col 或 index；radiobutton 每列幾個） |
|---|---|---|---|---|---|---|---|
| A1 | 基本評估（form） | — | | | | | |
| C1 | 跌倒史 | radiobutton | 過去一年是否跌倒 | 是／否 | FALL_HX／3f2a9c1d-7b1e-4c55-9a10-2f6d0e8b4c11／體系 | ✓ | further→C2；row 2 |

- 層級：體系（sys）／本科（own）／次專（sub）／科部（dpt）／全院（system）。綁定順序與理由見 `references/FormDesignRules.md`〈字典說明、補述與層級〉。
- `Inputs` 只記錄呼叫端給的輸入；捷徑與作業別以「### 上架設定」為準，builder 不從 `Inputs` 取。不上架或測試表單時 `groups=` 留空，不要一邊寫 `groups=住` 一邊在上架設定寫「—」。

### 計算式與巨集
| ID | 類型 | 內容 | 白話 | 模型 | 寫入 |
|---|---|---|---|---|---|
| C9 | formula | `ROUND(C4 / ((C3 / 100) * (C3 / 100)), 1)` | 體重 ÷（身高 m）^2 | — | — |
| C12 | action LLMQUERY | prompt 摘要… | | qwen332b | → C13 |

- formula 型 label 在「### 結構」的 datatype 寫 `label`，公式寫在這裡；builder 全部欄位建好後才補。
- 每條 formula 都要有「白話」。**不寫試算例**：reviewer 依白話自己出（見 `agents/form-reviewer.md`），結果進 review.md。

### AI 資料流（W_AI_DATAFLOW）
哪些欄位會送到 LLM／語音服務；沒有則寫「無」。

### 版面配置（有固定表格、頁籤或動態表格時才有）
每個表格一段，用文字畫出格線（列寬 → 各格的說明文字與 `C*`；頁籤與動態表格列出 `index` 與標題），格式見 `references/LayoutPatterns.md` §6。builder 照它的順序建格子，reviewer 拿它對 `form_preview`。
```
A2 身體測量（formtable）
| 1,2,1,2 | 身高： | [C3 numberbox] | cm 體重： | [C4 numberbox] |
```

### 表單 JS（flag formScript 開啟時才有；沒有則寫「無」）
| id | 樣板 | 參數（C*／A* 用穩定 ID） | 效果 | 觸發時機 | 影響的欄位 |
|---|---|---|---|---|---|
| bmi-high | guard | sources C2、C3；condition …；message「…」；highlight C2、C3 | 提示並標紅 | C2／C3 改值後、開文件時 | C2、C3 |

格式與樣板參數見 `references/ScriptAddonRules.md` §3；builder 在所有欄位建好後以 `form_set_script` 一次設定。

### 待新建字典
| 名稱 | 用於 | desc | 已查候選與不採用理由 |

### 上架設定
| 項目 | 值 |
|---|---|
| 資料夾 | 個人（usr／OL5） |
| 捷徑／作業別 | —／— |
| 保存後即上架 | 否 |
| 更新既有範本 | —（或 templateID） |

### 待決（有才寫）
要使用者取捨的地方：planner 依建議值先寫進結構，這裡列出建議值與替代方案，skill 在草案摘要後一起列。

### 建置對照表（builder 回填）
| ID | itemid |
|---|---|

### 審閱修改紀錄（skill 每輪追加）
第 N 次：itemid 3 caption 身高：→身高(cm)：；新增 C20（itemid 31，after 12）；移除 itemid 18
```

- 「資料夾」一律寫成 個人（usr／OL5）、次專（sub／代碼）或科部（dpt／代碼），草案、定稿檔與交付都同一格式；`Inputs` 的 `folder=` 仍寫代碼。
- `Status: Blocked` 要列出缺的輸入或與規則的衝突；`NeedsRevision` 的取捨列在「### 待決」，照建議值先建。
- 字典補述與 FHIR 不在草案：builder 建完後由 skill 起草寫進 draft，使用者在預覽頁卡片與 G2 前的 CSV 改（`dictionary-assist` 模式 2）。體系升級建議由 reviewer 寫在 review.md，帶進定稿檔。
- 草案沒有核准，可以隨時改；審閱迴圈中的修改只追加到「### 審閱修改紀錄」（不抄意見原文、不放 review 的 `values`）。最後一輪 reviewer 以「草案＋紀錄」比對 draft。
- 3.9.0 以前的計畫檔（有「## 核准」段）不再使用。

## 3. 定稿檔

位置：`<workspace>/.strucmed/plans/<draft_id>/publish-plan.md`，檔名與位置**不變**（hooks 認它）。`<draft_id>` 是第二次呼叫時傳給 tool 的 draft。

```markdown
# <表單名稱> 定稿

## 定稿
<!-- gate: publish-form:publish | category=write | cancel-leaves=nothing -->
Status: Ready
Revision: 1

### 驗證結果
| 計算式 | 白話 | 試算 | 結果 | 符合 |
|---|---|---|---|---|
（formula_check 的 labeled 與 samples；runtime 不可用時註明「離線試算」；巨集沒有實跑的列出來）

- 審查：error 0、warning n（review.md 路徑）；warning 逐條
- W_AI_DATAFLOW：…

### HIS 文字輸出
- 模式：histextbyblock；回 HIS 的區塊：…
- 鍵：Report、Impression（需求：Report、Impression → 相符）
- 範例：（最後一次 review 的 text_output，≤ 20 行，放在程式碼圍欄內且每行縮排兩格；沒有就寫「未在預覽頁產生」；看起來像真實病人資料就不放，改寫「範例含疑似個資，未寫入」）

### 字典
- CSV：.strucmed/plans/<draft_id>/dictionaries.csv（n 本：綁既有 a、新建 b、補述修改 c、改綁 d）

| 名稱 | 動作 | 層級 | 摘要 | note |
|---|---|---|---|---|
（補述修改列改前／改後的鍵；新建列 desc，有 FHIR 的逐本列出並註明「字典建好後補寫」；體系升級建議放這裡，交給管理者；FHIR「待人工確認」要標出）

### 上架
（`references/PublishWorkflow.md` §3 的表；離線時換成 form_export 的 plan：檔案、覆寫、匯入模式）

### 表單 JS（有片段時才有）
- 片段：style#look（樣式：主題 clean、2 條規則）、guard#bmi-high（條件提示：…）；sha256 <plan.script.sha256>
- 只在 2.0 runtime 執行；不影響 HIS 文字輸出與倉儲；樣式會影響列印版面
```js
<plan.script.rendered 原樣，不摘要>
```

### 警告
- …

## 核准
Status: Pending          ← Pending | Approved
Approved-Revision:
Approved-At:
Approved-By:
```

- 雜湊涵蓋整份，內容都是確定值。**沒有修改不重寫**：核准後改任何一行都會讓核准失效（`hooks/gate-check.js` 與 `verify-plan.mjs` 相同）。
- `Status: Ready` 才可核准；`Blocked` 要列出缺的輸入。
- 核准：使用者核准後，skill 只執行
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <workspace>/.strucmed/plans/<draft_id>/publish-plan.md --by <user>`（`online_me.user_id`，離線 `local`）。prepare 自己把「## 核准」段填成 `Approved`，寫入 `Approved-Revision`（＝目前 Revision）、`Approved-At`（執行當下的 ISO 時間）、`Approved-By`，再產生 sidecar `.approved-publish-plan.md`（sha256＋revision）。**核准段不要手填**：寫定稿檔時保持 `Pending` 與空白欄位。
- 線上寫入的第二次呼叫由 hooks 檢查 sidecar；離線的 `form_export` 沒有 hook，同樣先呈現、先 prepare 再呼叫。
- 要求修改：改 draft 或 CSV，重新取得 plan，`Revision` +1 重寫定稿檔再呈現；已核准的 sidecar 隨之失效。
- 例外：`verify-plan.mjs` 與 `hooks/gate-check.js` 計算雜湊時排除「### 建置對照表」段（G4 的應用程式計畫與舊計畫檔用得到；定稿檔沒有這一段）。
- `dictionary-assist` 模式 3 的 `memo-plan.md` 不變（單獨補述時用，不屬於 G2）。

## 4. 無人值守

`feature-flags.json` 的 `unattended: true` 時：G2、G4 一律視為「取消」，並在 `<workspace>/.strucmed/workflow-log.md` 追加一行 `Unattended: <gate> → cancelled`。審閱迴圈不開，直接跳到 G2（然後被取消），不會卡住；draft 留在本機。**不會**自動核准任何寫入。
