# 閘門與計畫檔格式

> 比照 microsoft/power-platform-skills 的核准關卡：固定標題、核准寫入計畫檔、上游變更即失效、子代理不問使用者。

## 1. 四個閘門

| 閘門 | 標題 | 時機 | cancel-leaves | 取消後留下什麼 |
|---|---|---|---|---|
| G1 | `## 表單計畫` | planner 產出計畫後、建置前 | draft | 沒有 draft（或改版時只有 import 後未修改的 draft） |
| G2 | `## 驗證結果` | runtime 驗證後、輸出前 | draft | 本機 draft，可繼續修改 |
| G3 | `## 上架計畫` | `online_template_create`／`update` 第一次呼叫取得 plan 後 | nothing | 線上沒有任何寫入 |
| G4 | `## 應用程式計畫` | B2 app 產生前（H0／H2；H1 以 `online_me_notes_set` 的 plan 代替） | nothing | 沒有產生任何檔案 |

每個閘門在對話中呈現的固定格式（對話中**不輸出** `<!-- gate: … -->` 註解：Codex 等工具會把它顯示成文字；閘門 id 已在 🚦 那一行。註解只寫在計畫檔；從計畫檔呈現內容時略去該行）：

```markdown
## 表單計畫
> 🚦 **閘門（create-form:plan）**：核准後才會建立 draft。
> **為什麼問**：itemid 與參照依建立順序分配，建置後改結構成本高。
> **取消會留下**：沒有 draft。

（計畫內容）

| 選項 | 說明 |
|---|---|
| 核准（建議） | 依此計畫建置 |
| 要求修改 | 說明要改什麼，計畫 Revision +1 後重新呈現 |
| 取消 | 停止，不建立任何東西 |
```

選項一律用 `AskUserQuestion`（三個選項，核准放第一個）。**子代理（`form-planner`、`form-builder`、`form-reviewer`）是 headless 的，`AskUserQuestion` 在它們裡面不會到達使用者**；閘門只能由 skill 本身呈現。

## 2. 計畫檔

位置：`<workspace>/.strucmed/plans/<slug>/strucmed-form-plan.md`（slug＝表單名稱的英數底線化，最多 40 字）。

```markdown
# <表單名稱> 表單計畫

## 表單計畫
<!-- gate: create-form:plan | category=plan | cancel-leaves=draft -->
Status: Ready            ← Ready | NeedsRevision | Blocked
Revision: 1              ← 每次修改 +1
Inputs: dept_no=33F00; groups=門,住; publish=false; dictionary_index=online 2026-10-26

### 結構
| ID | 區塊／控制項 | datatype | 說明文字 | 選項／範圍 | 字典（名稱／id 前 8 碼／層級／角色；或「新建」） | 必填 | 備註（further→C2、row/col、index） |
|---|---|---|---|---|---|---|---|
| A1 | 基本評估（form） | — | | | | | |
| C1 | 跌倒史 | radiobutton | 過去一年是否跌倒 | 是／否 | FALL_HX／3f2a9c1d／體系／tohis | ✓ | further→C2 |

- 層級：體系（sys）／本科（own）／次專（sub）／科部（dpt）／全院（system）。綁定順序與理由見 `references/FormDesignRules.md`〈字典說明、補述與層級〉。

### 計算式與巨集
| ID | 類型 | 內容 | 白話（欄位名稱） | 試算例 | 模型 | 寫入 |
|---|---|---|---|---|---|---|
| C9 | formula | `ROUND(C4 / ((C3 / 100) * (C3 / 100)), 1)` | 體重 ÷（身高 m）² | C3=170、C4=65 → 22.5 | — | — |
| C10 | formula | `IF(C9 >= 24, "過重", "正常")` | BMI ≥ 24 為過重 | C9=25 → 過重；C9=20 → 正常 | — | — |
| C12 | action LLMQUERY | prompt 摘要… | | | qwen332b | → C13 |

- 每條 formula 都要有「白話」與至少一個「試算例」（數字用臨床上合理、容易心算的值；有 IF 時每個分支一例）。試算例由 planner 依臨床定義手算，**不能**用 `formula_check` 算出來再抄回來。
- 試算例在建置後由 reviewer 以 `formula_check` 的 `samples` 實際計算（`C*` 依建置對照表換成 `A<itemid>`）；結果不符＝`E_FORMULA_SAMPLE_MISMATCH`，必須修。試算與 HIS runtime（Calx 2.2.8）同一套算法，進位不補浮點誤差：剛好落在 5 的邊界時，runtime 顯示的值可能和手算差最後一位（例如 BMI 160 cm／80 kg 是 31.2，不是 31.3），錯誤訊息會註明「只差最後一位」；這時以試算值為準修正試算例並在 G2 告知使用者，不要改參照。`ROUND`／`ROUNDUP`／`ROUNDDOWN` 一定要寫位數（`ROUND(x, 0)`），少了位數 runtime 會算出 NaN。

### AI 資料流（W_AI_DATAFLOW）
哪些欄位會送到 LLM／語音服務；沒有則寫「無」。

### 版面配置（有固定表格、頁籤或動態表格時才有）
每個表格一段，用文字畫出格線（列寬 → 各格的說明文字與 `C*`；頁籤與動態表格列出 `index` 與標題），格式見 `references/LayoutPatterns.md` §6。builder 照它的順序建格子，reviewer 拿它對 `form_preview`。
```
A2 身體測量（formtable）
| 1,2,1,2 | 身高： | [C3 numberbox] | cm 體重： | [C4 numberbox] |
```

### 待新建字典
| 名稱 | 用於 | 說明（desc，一行） | 補述（memo 摘要） | 備註 |

### 字典補述
每本用到的字典（既有＋新建）一列；既有 memo 已完整的寫「沿用」。FHIR 欄位的驗證狀態：`ICD-10 MCP 已驗證`／`待人工確認`（LOINC、SNOMED 沒有查詢工具）／`沿用既有`。

| 字典 | 動作（新建帶入／補充／沿用） | meaning | type／unit／range | asr | calx／llm | FHIR res | path | code | 單位 | 驗證狀態 |
|---|---|---|---|---|---|---|---|---|---|---|
| FALL_HX | 補充 | 過去一年跌倒史 | radiobutton | 跌倒、fall | — | Observation | Observation.valueCodeableConcept | http://snomed.info/sct\|… | — | 待人工確認 |

### 體系升級建議
沒有就寫「無」。這是交給體系字典管理者的建議清單：AI 不升級（沒有工具），交付時請使用者轉給管理者在字典頁一鍵升級；升級只在說明寫入體系標記，id 與 dicType 不變，已綁定的表單不受影響。

| 字典 | 目前層級／類型 | 升級到 | 理由（哪些科、哪些表單共用） |
|---|---|---|---|

### 建置對照表（builder 回填）
| ID | itemid |
|---|---|

## 核准
Status: Pending          ← Pending | Approved
Approved-Revision:
Approved-At:
Approved-By:
```

- `Status: Ready` 才可核准；`Blocked` 要列出缺的輸入。
- 核准：skill 把「## 核准」改為 `Approved`、填 `Approved-Revision`（＝目前 Revision）、`Approved-At`（ISO 時間）、`Approved-By`（`online_me.user_id` 或 `local`），然後執行
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <plan.md> --by <user>` 產生 sidecar `.approved-strucmed-form-plan.md`（sha256＋revision）。
- 建置前 builder 執行 `verify-plan.mjs verify <plan.md>`；計畫在核准後有任何修改 → 核准失效，必須重新呈現 G1。
  **例外**：`verify-plan.mjs` 與 `hooks/gate-check.js`（G3 hook 的共用檢查）計算雜湊時**排除「### 建置對照表」段**（從該標題到下一個 `##`／`###` 標題），所以 builder 建置後回填 itemid 不會讓核准失效；reviewer 比對時也忽略該段。其他段落（含 G2 後修改的計算式內容）一改就失效，要重新核准。

## 3. 無人值守

`feature-flags.json` 的 `unattended: true` 時：所有閘門一律視為「取消」，並在 `<workspace>/.strucmed/workflow-log.md` 追加一行 `Unattended: <gate> → cancelled`。**不會**自動核准任何寫入。
