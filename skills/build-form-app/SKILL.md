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

規則：`references/ModelWhitelist.md`、`references/SecurityInvariants.md`；B2 流程：`references/AppBuildWorkflow.md`；閘門：`references/Gates.md`（G4）。

## B1：HIS 內執行、AI 走 LlmGateway（執行清單，不產生程式碼）

前提：範本已上架（有 `template_id`）；線上已登入。

1. `online_template_get(template_id, save:true)` → `form_import` 成新 draft（只為檢查，不輸出）→ `form_validate`。
2. 模型：`llmgateway_models`（有金鑰時）→ `form_validate` 的 `E_LLM_MODEL_*`／`W_LLM_*` 就是白名單比對結果；沒有金鑰時只以靜態表檢查並標 `W_LLM_WHITELIST_STALE`。
3. 站台：`online_features`
   - `llm_gateway.enabled: false` → 表單內的 LLM／語音仍走舊的院內端點，不經閘道（由平台管理者啟用）。
   - `runtime.save`／`query` → 登入者是否在 HIS 端存檔／查詢白名單（影響 HIS 端體驗，不影響表單設計）。
4. 範本：捷徑＋作業別都有才會出現在 HIS 清單；`online_template_versions` 確認 `current` rev。
5. 交付《B1 執行清單》（寫到 `<workspace>/output/<範本名>.b1-checklist.md` 並在對話摘要）：

```markdown
# <表單名稱> B1 執行清單（<日期>）
| 項目 | 狀態 | 說明 |
|---|---|---|
| 範本已上架 | ✓／✗ | templateID、資料夾、rev |
| 捷徑＋作業別 | ✓／✗ | 缺少則 HIS 清單看不到 |
| HIS 端元件版本支援新站台 | 請 HIS 端確認 | 版本請洽資訊室 |
| LlmGateway 啟用（api/llm-config） | ✓／✗ | 由平台管理者啟用 |
| 巨集模型在白名單 | ✓／✗ | 列出每個 LLMQUERY／LLMvision 的別名 → 閘道模型 → 狀態 |
| AI 資料流（W_AI_DATAFLOW） | 已告知 | 哪些欄位會送到 LLM／語音 |
| 身分（R3） | 說明 | HIS 端身分由 HIS 傳入 |
| 匯入後勿按「重新編號」 | 提醒 | |
```

## B2：獨立表單 APP（struNote 型 PWA）

依 `references/AppBuildWorkflow.md`：
1. **主機位置**先問一次：H0 本機 Docker（預設）、H1 既有 struNote（只把範本加進清單）、H2 站台 `/strucmed/apps/<slug>/`。
2. **前提**：範本已上架（`online_template_get`）；`online_features` 看登入者是否在 HIS 端存檔白名單；有 `FMAPI_BASE_URL` 時 `fmapi_status` 看站台健康。
3. **H1**：`online_me_notes_get` → `online_me_notes_set`（`add`，兩段式，plan 就是閘門；第二次呼叫要使用者在瀏覽器確認頁按「確認寫入」）→ 告知在平板開 `/strucmed/note/`。
4. **H0／H2**：寫 `<workspace>/.strucmed/plans/<slug>/app-plan.md`「## 應用程式計畫」→ ▶ **G4**（`AskUserQuestion` 核准／要求修改／取消）→ 核准後 `verify-plan.mjs prepare` → 寫 `config.json` → `Task(app-builder)` 執行 scaffold → 本 skill 在輸出目錄 `npm install`、`npm run build`、`check-app-dist.mjs dist`（不通過不交付）；H0 再 `docker compose build && docker compose up -d`（映像只裝入這份 dist，容器內不跑 npm）。
5. **交付**：輸出目錄、`docker compose` 指令（H0）或 `dist/` 交平台（H2）、待辦（存檔白名單、LlmGateway APP 登記（PKCE））。

不做：不在 app 內放任何帳密或 token；不產生 H3（外部 Origin）；`check-app-dist` 有 findings 時不交付。
