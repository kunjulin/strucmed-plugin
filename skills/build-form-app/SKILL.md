---
name: build-form-app
description: >
  讓已上架的 StrucMed 表單成為可在院內獨立運作的「表單 APP」：B1＝在 HIS 內執行、AI 全走院內 LlmGateway 的執行條件檢核與交付清單；
  B2＝struNote 型獨立 PWA（本機 Docker 預設；或加進既有 struNote、站台 /apps/）。USE WHEN 使用者說「做成 app」「平板用」「獨立運作」「AI 走閘道」「上線前檢查」。
  不處理：修改平台設定、核發金鑰、部署到伺服器（只產出清單與檔案）。
user-invocable: true
argument-hint: "<範本 ID> [b1|b2]"
allowed-tools: Read, Write, Edit, AskUserQuestion, Task, Bash(node *), Bash(npm *), Bash(docker *)
---

# build-form-app

> **不要 `cd`**：工作區＝工作目錄，`.strucmed/`、hooks、`preview.mjs` 都靠它找檔案。Bash 一律寫絕對路徑（`<workspace>/.strucmed/…`），`cd` 之後 hook 會找不到定稿檔。

規則：`references/ModelWhitelist.md`、`references/SecurityInvariants.md`；B2 流程：`references/AppBuildWorkflow.md`；閘門：`references/Gates.md`（G4）。

## B1：HIS 內執行、AI 走 LlmGateway（執行清單，不產生程式碼）

前提：範本已上架（有 `template_id`）；線上已登入。

1. `online_template_get(template_id, save:true)` → `form_import` 成新 draft（只為檢查，不輸出）→ `form_validate`。
2. 模型：`llmgateway_models`（有金鑰時）→ `form_validate` 的 `E_LLM_MODEL_*`／`W_LLM_*` 就是白名單比對結果；沒有金鑰時只以靜態表檢查並標 `W_LLM_WHITELIST_STALE`。`W_LLM_MODEL_SUNSET`／`E_LLM_MODEL_SUNSET`（qwen 系列：院方建議不採用，2027-01-01 自 LlmGateway 下架）→ 清單標 ✗「落日模型，上線前改用 nemotron35／tnemotron35」，交回 `edit-form` 改版；下架日後是 `E_LLM_MODEL_DEPRECATED`。
3. 站台：`online_features`
   - `llm_gateway.enabled: false` → 表單內的 LLM／語音仍走舊的院內端點，不經閘道（由平台管理者啟用）。
   - 巨集用了只經 Gateway 的模型（`form_validate` 回 `W_LLM_MODEL_GATEWAY_ONLY`，目前是 `nemotron35`、`gemma4_31b` 系列）→ 站台**必須**啟用 Gateway：沒有時 `LLMQUERY` 不送出、`LLMvision`／`LLMATTACH` 改用預設 `gemma3:12b`。舊站 `/go/`（HIS 的「AI小助手」視窗開的就是 `/go/temp2.html`）2026-11-28 起也有這兩個系列的 `LLMQUERY`／`LLMvision` 代號，但沒有 `LLMATTACH`。`online_features` 讀不到 `api/llm-config`（403）時，清單寫「請平台管理者確認」。
   - `runtime.save`／`query` → 登入者是否在 HIS 端存檔／查詢白名單（影響 HIS 端體驗，不影響表單設計）。院外站台這兩項是 false；非病人表單看 `runtime.app_records`（true＝本人的非病人表單紀錄可存、應用紀錄清單可用）。
4. 範本：捷徑＋作業別都有才會出現在 HIS 清單；`online_template_versions` 確認 `current` rev。
4c. **非病人表單不走 B1**（`form_validate` 回 `no_patient: true`；`references/FormDesignRules.md`〈非病人表單〉）：HIS 內開啟時 HIS 仍帶真實病歷號，平台的存檔雙向檢查會拒絕（站台關閉 API 存檔或退回直連倉儲時伺服器擋不到，紀錄會存在該病歷號下），所以**非病人表單目前不能在 HIS 內存檔**。清單的「非病人表單」一列一律標 ✗「不能在 HIS 內使用，請改走 B2（H1 struNote 為主）」，在對話第一行講明並問使用者要不要改做 B2；範本有捷徑＋作業別（`W_NOPATIENT_HIS_LIST`）時另列「請以 `edit-form` 拿掉作業別，避免同仁從 HIS 清單開啟」。仍照常列出 `E_NOPATIENT_*`（HIS 參照、`HISQUERY`、`LOOKUPDW`、讀取型字典角色、`G_CHTNO()`、嵌入頁 `{chtno}`／`{opdno}`；有任何一條就列出控制項，請使用者以 `edit-form` 改版）與 `W_NOPATIENT_AUTOLOAD`、`W_NOPATIENT_OPTION`、`W_NOPATIENT_DICT_WRITE`，供 B2 使用。
4b. 嵌入頁面（範本有 embed 區塊或 `OPENPANEL` 時）：以 `form_validate` 的 `embeds` 列出每個目標主機；有 `W_EMBED_LOCALHOST` 時清單直接標 ✗（本機網址不能上線，要先部署到院內主機並改 `url`）。嵌入頁的訊息格式、高度與版面、上架後實測步驟見 `references/EmbedPageContract.md`，清單加一列「嵌入頁在站台實測（載入、病人情境、寫回、高度）」。HIS 端 StrucForm 要放行它們：1.10.9 DLL 起預設放行院內範圍，iframe 與 OPENPANEL 的子面板走同一份白名單；1.10.7／1.10.8 只認設定主機，會擋掉院內頁面。DLL 版本請 HIS 端確認。被擋下時畫面空白並送 errorlog `NAV-DENIED`，平台管理者可在管理頁「導向白名單擋下的主機」依主機彙總查看（plugin 沒有管理權限，只寫進清單提醒）。嵌入頁本身的條件（`frame-ancestors` 允許 `http://localhost` 與站台、https 憑證、Chromium 104）由嵌入頁開發者負責，列在平台的 B1 嵌入頁 APP 開發說明。
5. 交付《B1 執行清單》（寫到 `<workspace>/output/<範本名>.b1-checklist.md` 並在對話摘要）：

```markdown
# <表單名稱> B1 執行清單（<日期>）
| 項目 | 狀態 | 說明 |
|---|---|---|
| 範本已上架 | ✓／✗ | templateID、資料夾、rev |
| 捷徑＋作業別 | ✓／✗ | 缺少則 HIS 清單看不到 |
| HIS 端元件版本支援新站台 | 請 HIS 端確認 | 版本請洽資訊室 |
| LlmGateway 啟用（api/llm-config） | ✓／✗ | 由平台管理者啟用 |
| 巨集模型在白名單 | ✓／✗ | 列出每個 LLMQUERY／LLMvision／LLMATTACH 的別名 → 閘道模型 → 狀態；只經 Gateway 的模型（`W_LLM_MODEL_GATEWAY_ONLY`）標「需啟用 Gateway」 |
| AI 資料流（W_AI_DATAFLOW） | 已告知 | 哪些欄位會送到 LLM／語音 |
| 嵌入頁主機在 StrucForm 導向白名單（有 embed／OPENPANEL 時） | 請 HIS 端確認 | 列出主機；1.10.9 DLL 起預設放行院內範圍（1.10.7／1.10.8 會擋）；上線一週內請平台管理者看「導向白名單擋下的主機」 |
| 嵌入頁面資料流（W_EMBED_DATAFLOW） | 已告知 | 每個嵌入頁的主機、帶出的參數（病歷號、科別、使用者、門診序號）、寫回欄位 |
| 非病人表單（f_nopatient；是才列） | ✗ | **不能在 HIS 內使用**：HIS 內開啟時存檔會被平台拒絕；請改走 B2（H1 struNote）。有作業別時請拿掉（`W_NOPATIENT_HIS_LIST`）；`E_NOPATIENT_*` 逐條列出 |
| 身分（R3） | 說明 | HIS 端身分由 HIS 傳入 |
| 匯入後勿按「重新編號」 | 提醒 | |
```

## B2：獨立表單 APP（struNote 型 PWA）

依 `references/AppBuildWorkflow.md`：
1. **主機位置**先問一次：H0 本機 Docker（預設）、H1 既有 struNote（只把範本加進清單）、H2 站台 `/strucmed/apps/<slug>/`。
2. **前提**：範本已上架（`online_template_get`）；`online_features` 看登入者是否在 HIS 端存檔白名單；有 `FMAPI_BASE_URL` 時 `fmapi_status` 看站台健康。
3. **H1**：`online_me_notes_get` → `online_me_notes_set`（`add`，兩段式，plan 就是閘門；第二次呼叫要使用者在瀏覽器確認頁按「確認寫入」）→ 告知在平板開 `/strucmed/note/`。
3b. **非病人表單**（前提檢查時 `form_validate` 回 `no_patient: true`；`references/AppBuildWorkflow.md` §2b）：
   - 先看 `online_features` 的 `runtime.no_patient`：`supported: false` → 這個站台目前不能用非病人表單（列出 `reason`），不要加進清單或產生 APP，請使用者等站台更新；沒有登入時寫「站台是否支援尚未確認」。
   - **建議 H1（既有 struNote）**：struNote 會依清單的 `noPatient` 標示、不要求病歷號。H0／H2 產生的 APP 目前沿用同一個病歷號欄位（範本 `templates/form-app/` 尚未依 `noPatient` 免填），開表單前仍要在欄位填值；平台會忽略這個值，但**不要輸入真實病歷號**。使用者仍要 H0／H2 時把這一點寫進計畫與交付。
   - 計畫與交付都要寫明：struNote 不需病歷號、平台以保留代碼開啟；紀錄只有填寫者本人查得到、下載得到（查詢須帶 `sheetid`，資料下載只含本人的紀錄），目前無法彙整他人的紀錄；不要用倉儲以病歷號查詢這類紀錄；不能從 HIS 開啟存檔。
   - **多筆紀錄（`recNo`）**：struNote 的表單清單與產生的 APP 都不帶 `recNo`，每人每張表單只有一筆（重開會載入並覆寫同一筆；`W_NOPATIENT_AUTOLOAD` 沒開時是空白並覆寫）。使用者要同一張表單存多筆時，**先建議 struNote 的應用紀錄清單**（`references/AppBuildWorkflow.md` §2b）：表單設 `options.app_list`（`edit-form` 改版或 `form_update_meta`），上架後給 `<站台>/note/?app=<範本ID>`，不必產生 APP。一定要自製 APP 時，由 APP 以 `GET api/v2/forms/{id}/page?recNo=<鍵>` 開啟（英數字與 `_`、`.`、`-`，最多 64 字；帶 `recNo` 一律載入既有紀錄，只認完全相同的鍵）；scaffold 不產生這段，列為待辦，不要自行編一個未登錄的取值規則寫進程式。
4. **H0／H2**：寫 `<workspace>/.strucmed/plans/<slug>/app-plan.md`「## 應用程式計畫」→ ▶ **G4**（`AskUserQuestion` 核准／要求修改／取消）→ 核准後 `verify-plan.mjs prepare` → 寫 `config.json` → `Task(app-builder)` 執行 scaffold → 本 skill 在輸出目錄 `npm install`、`npm run build`、`check-app-dist.mjs dist`（不通過不交付）；H0 再 `docker compose build && docker compose up -d`（映像只裝入這份 dist，容器內不跑 npm）。
5. **交付**：輸出目錄、`docker compose` 指令（H0）或 `dist/` 交平台（H2）、待辦（存檔白名單、LlmGateway APP 登記（PKCE））。

不做：不在 app 內放任何帳密或 token；不產生 H3（外部 Origin）；`check-app-dist` 有 findings 時不交付。
