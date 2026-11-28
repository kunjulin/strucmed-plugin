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
- `online_features`：`runtime.save` 與 `runtime.query` 代表 **登入者** 在 HIS 端存檔／查詢白名單；app 的表單頁存檔走 `records/save`；`save:false` 時一般表單存檔可能失敗，要告知使用者。院外站台不開這兩項（它們也管病人紀錄），非病人表單改看 `runtime.app_records`：true 時本人的非病人表單紀錄經登入後的 `records/*` 存取，`save:false` 不影響（平台 #294）。
- 非病人表單（`form_validate` 回 `no_patient: true`；`FormDesignRules.md`〈非病人表單〉）：見 §2b。計畫的「範本」列標「非病人表單」。
- `fmapi_status`（有 `FMAPI_BASE_URL` 時）：站台健康，錯誤回報是否可用。
- 沒有線上登入時只能產生 app（H0／H2）但不能驗證範本，交付時標示「未驗證範本 ID」。
- H0：`docker version` 可用，且計畫的埠未被佔用（`docker ps`／`netstat -ano | findstr :<埠>`）；被佔用就改埠，計畫升 Revision 重新核准。

## 2b. 非病人表單

平台現況（`kunjulin/strucmed` `docs/API-V2.md`「非病人表單」；院內與院外站台 2026-11-22 部署）：

- **站台是否支援**：`online_features` 的 `runtime.no_patient`。`supported: false`（站台尚未更新或停用）→ 不要把非病人表單加進清單或做成 APP；沒有登入時標「尚未確認」。
- **開啟**：表單頁 `GET api/v2/forms/{id}/page` 對非病人表單不需要 `chtno`，傳入的 `chtno`、`opdno`、`pacsno` 一律忽略，表頭 `Chtno`＝保留代碼（`APP-NP`）、`Deptno`＝`APP`、`Opdno`＝`APP`；回應標頭 `X-Strucmed-No-Patient: 1`。`GET me/notes` 每筆有 `noPatient`。
  - H1 struNote：依 `noPatient` 不要求病歷號，清單與表單上方標示「此表單與病人無關，不需病歷號」。
  - H0／H2 產生的 APP：`templates/form-app/` 的清單頁仍是同一個病歷號欄位，開表單前要填值（平台忽略）；**不要輸入真實病歷號**。非病人表單建議走 H1；這個限制寫進計畫與交付的待辦。
- **不能在 HIS 內存檔**：非病人表單只在 struNote／表單頁使用；B1 不適用。
- **紀錄主體與紀錄鍵**：`opdno`（紀錄主體）現行固定 `APP`；`recNo`（紀錄鍵）區分同一張表單的多筆紀錄，都是 APP 設定欄位，取值規則須先登錄，程式不得自行填入未登錄的值。一筆紀錄由 `user`＋`sheetid`＋`opdno`＋`recNo` 定位。
  - struNote 的表單清單、產生的 APP（`src/services/api.ts` 的 `fetchFormHtml`）都不帶 `recNo`：每人每張表單一筆（`recNo` 寫入 `none`）。表單要開「開啟時自動取出」（`f_autoLoadOnOpen`，非病人表單預設開）才會在開頁時載入這一筆；沒開時是空白表單，存檔會覆寫它。
  - **要多筆紀錄：用 struNote 的應用紀錄清單**（平台 #290、#291；`FormDesignRules.md`〈應用紀錄清單〉）。表單設 `options.app_list`（iot `f_applist*`）並上架後，給使用者 `<站台>/note/?app=<範本ID>`：struNote 列出本人在這張表單的紀錄，新增時依規則產生 `recNo`，可修改、刪除（硬刪除、無法復原）。不必做 APP，也不必放進 struNote 清單——這是 H1 的變形，計畫的主機位置寫「H1（應用紀錄清單）」。
  - 自製 APP 要多筆時：開表單頁加 `recNo=<鍵>`（英數字與 `_`、`.`、`-`，最多 64 字；帶 `recNo` 開啟一律載入既有紀錄，只認完全相同的 `recNo`，`none` 與帶鍵的紀錄互不覆寫；帶 `recNo` 時不帶入近期紀錄）。清單可用平台的 `POST api/v2/records/query/list`（`{ sheetid }`，範本要開 `f_applist`）、刪除用 `POST api/v2/records/delete`（`{ sheetid, recNo }`）。scaffold 不產生這段：列為待辦，由 APP 開發者自行加，不要自行編一個未登錄的取值規則。
- **查詢與下載**：產生的 APP 與 scaffold **沒有**查詢紀錄的程式（只開表單頁、讀寫 `me/notes`）。APP 開發者自行加查詢時：經 `api/v2/records/query/*` 查保留代碼必須帶 `sheetid`，否則 400（`status` 為 `DRAWimg`、`XMLtxt` 例外）；只回呼叫者自己建立的紀錄。資料下載對非病人表單只含下載者本人的紀錄，原作者與管理者也一樣——目前無法彙整他人的紀錄。
- **分析排除**：`chtno` 為 `Shortcut` 或以 `APP` 開頭的都不是病人紀錄；`500` 是測試用病歷號。不要用倉儲以病歷號查詢這類紀錄。

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
| 範本 | <id> <名稱>（已上架 ✓／未驗證；非病人表單時加註「非病人表單：不需病歷號；紀錄只有本人查得到；每人一筆（不帶 recNo）」，開了應用紀錄清單時改成「多筆，以 note/?app=<範本ID> 開啟」） … |
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
   node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <workspace>/.strucmed/plans/<slug>/app-plan.md --by <user_id 或 local>
   ```
   H1 不產生檔案：改走 `online_me_notes_set` 的兩段式 plan（它自己就是閘門），不需要 app-plan.md。

## 4. 建置（G4 之後）

1. 把計畫寫成 `config.json`（`scripts/scaffold-form-app.mjs` 檔頭格式）到計畫目錄。
2. `Task(app-builder)`：它先 `verify-plan.mjs verify`，再執行 scaffold，回報 `files`、`unresolved_placeholders`；不執行 npm。
3. 本 skill 對輸出目錄執行（告知使用者需要 Node 20 與網路取套件；不要 `cd`，一律以 `--prefix` 帶絕對路徑）：
   ```bash
   npm --prefix <輸出目錄> install --no-audit --no-fund
   npm --prefix <輸出目錄> run build
   node "${CLAUDE_PLUGIN_ROOT}/scripts/check-app-dist.mjs" <輸出目錄>/dist
   ```
   `check-app-dist` 不通過（金鑰、token、身分證樣式、殘留佔位符、sourcemap）→ 不交付，回報 findings。
   H0 的 `Dockerfile` 只把這份 `dist/` 裝進 nginx 映像（容器內不跑 npm），所以 `docker compose build` 一定在 build 與檢查之後。
4. 選用：`npm run preview` 後以內建瀏覽器開登入頁，只確認頁面載入與版本字樣；**不輸入真帳密**。

## 5. 交付

- 輸出目錄、`app.config.json` 摘要、`dist/` 檢查結果。
- H0：`docker compose build && docker compose up -d` → `http://localhost:<port>/`；首次登入後實測「開啟表單 → 提交」。存檔走 `records/save`；LLM／語音需先在 LlmGateway 登記 APP（PKCE）。
- H2：`dist/` 交平台放到 `web/apps/<slug>/`。
- 待辦清單：存檔白名單、LlmGateway APP 登記（PKCE）、範本未驗證者。
- 清單裡有非病人表單時（§2b）：告知站台是否支援、紀錄只有填寫者本人查得到與下載得到（無法彙整他人的紀錄）、每人每張表單一筆（多筆用應用紀錄清單 `note/?app=<範本ID>`：紀錄鍵不可放病歷號、身分證號、姓名，刪除無法復原）、不能從 HIS 開啟存檔、H0／H2 的病歷號欄位不要輸入真實病歷號、不要用倉儲以病歷號查詢這類紀錄。
- 不交付任何含帳密或 token 的檔案；`config.json` 與 `app.config.json` 不含機敏資料（scaffold 會拒絕）。
