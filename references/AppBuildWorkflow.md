# 表單 APP 建構流程（B2）

> 由 `build-form-app` 載入。設計；範本 `templates/form-app/`；產生器 `scripts/scaffold-form-app.mjs`；靜態檢查 `scripts/check-app-dist.mjs`。

## 1. 主機位置（先問一次）

| 選項 | 做法 | LLM／語音 | 需平台配合 |
|---|---|---|---|
| **H0 本機 Docker**（預設） | scaffold 產生 app＋`Dockerfile`＋`nginx.conf`＋`compose.yaml`；nginx 提供 app 於 `/`，同源反向代理 `/strucmed`、`/llmgw`、`/FM` 到站台 | 表單頁向 `/llmgw` 呼叫 | 需在 LlmGateway 登記 APP（回呼 `http://localhost:<port>/`）走 PKCE 取得 token |
| H1 既有 struNote | 不產生 app：`online_me_notes_set` 把範本加進登入者的 struNote 清單，在平板開 `/strucmed/note/` | 同源 | 無 |
| H2 站台 `/strucmed/apps/<name>/` | scaffold（`hosting: H2`，不含 Docker 檔）→ `dist/` 交平台放到 `web/apps/<name>/` | 同源 | P7 靜態路由 |
| H3 外部 Origin | 不提供 | — | — |

## 2. 前提

- 範本已上架：`online_template_get(template_id)` 成功（H1 另需登入者就是要用 app 的人）。
- `online_features`：`runtime.save` 與 `runtime.query` 代表 **登入者** 在 HIS 端存檔／查詢白名單；app 的表單頁存檔走 `records/save`；`save:false` 時存檔可能失敗，要告知使用者。
- `fmapi_status`（有 `FMAPI_BASE_URL` 時）：站台健康，錯誤回報是否可用。
- 沒有線上登入時只能產生 app（H0／H2）但不能驗證範本，交付時標示「未驗證範本 ID」。
- H0：`docker version` 可用，且計畫的埠未被佔用（`docker ps`／`netstat -ano | findstr :<埠>`）；被佔用就改埠，計畫升 Revision 重新核准。

## 3. 應用程式計畫（G4）

1. 問：主機位置、app 名稱（≤60 字）、slug（小寫英數與 -）、要包含的範本（id＋顯示名）、是否允許使用者自訂清單、是否啟用錯誤回報、H0 的站台根網址（https）與埠。
2. `Task(app-builder)` 不需要規劃者；由本 skill 直接寫 `<workspace>/.strucmed/plans/<slug>/app-plan.md`：

```markdown
# <app 名稱> 應用程式計畫

## 應用程式計畫
<!-- gate: build-form-app:plan | category=plan | cancel-leaves=nothing -->
Status: Ready
Revision: 1

| 項目 | 值 |
|---|---|
| 主機位置 | H0 本機 Docker（埠 8080）／H1 既有 struNote／H2 站台 /strucmed/apps/<slug>/ |
| app 名稱／slug／版本 | … |
| 範本 | <id> <名稱>（已上架 ✓／未驗證） … |
| 使用者自訂清單 | 是／否 |
| 錯誤回報（FMapi） | 是／否 |
| 站台根網址（H0 代理目標） | https://<站台> |
| 輸出目錄 | <workspace>/output/apps/<slug>/ |
| 會產生的檔案 | package.json、src/…、Dockerfile、nginx.conf、compose.yaml、app.config.json |
| LLM／語音路徑 | 同源 → 站台 api/llm-config（H0 需登記 LlmGateway APP 走 PKCE） |
| 存檔路徑 | 表單頁 → api/v2/records/save（登入者需在存檔白名單） |

## 核准
Status: Pending
Approved-Revision:
Approved-At:
Approved-By:
```

3. 對話中呈現同一份，`AskUserQuestion`：核准（建議）／要求修改／取消。核准後：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <app-plan.md> --by <user_id 或 local>
   ```
   H1 不產生檔案：改走 `online_me_notes_set` 的兩段式 plan（它自己就是閘門），不需要 app-plan.md。

## 4. 建置（G4 之後）

1. 把計畫寫成 `config.json`（`scripts/scaffold-form-app.mjs` 檔頭格式）到計畫目錄。
2. `Task(app-builder)`：它先 `verify-plan.mjs verify`，再執行 scaffold，回報 `files`、`unresolved_placeholders`；不執行 npm。
3. 本 skill 在輸出目錄執行（告知使用者需要 Node 20 與網路取套件）：
   ```bash
   npm install --no-audit --no-fund
   npm run build
   node "${CLAUDE_PLUGIN_ROOT}/scripts/check-app-dist.mjs" dist
   ```
   `check-app-dist` 不通過（金鑰、token、身分證樣式、殘留佔位符、sourcemap）→ 不交付，回報 findings。
   H0 的 `Dockerfile` 只把這份 `dist/` 裝進 nginx 映像（容器內不跑 npm），所以 `docker compose build` 一定在 build 與檢查之後。
4. 選用：`npm run preview` 後以內建瀏覽器開登入頁，只確認頁面載入與版本字樣；**不輸入真帳密**。

## 5. 交付

- 輸出目錄、`app.config.json` 摘要、`dist/` 檢查結果。
- H0：`docker compose build && docker compose up -d` → `http://localhost:<port>/`；首次登入後實測「開啟表單 → 提交」。存檔走 `records/save`；LLM／語音需先在 LlmGateway 登記 APP（PKCE）。
- H2：`dist/` 交平台放到 `web/apps/<slug>/`。
- 待辦清單：存檔白名單、LlmGateway APP 登記（PKCE）、範本未驗證者。
- 不交付任何含帳密或 token 的檔案；`config.json` 與 `app.config.json` 不含機敏資料（scaffold 會拒絕）。
