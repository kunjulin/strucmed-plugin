# __APP_NAME__（StrucMed 表單 APP）

由 strucmed-plugin 的 `scripts/scaffold-form-app.mjs` 自 `templates/form-app/` 產生。設計重點：

- token 只存 **sessionStorage**（關閉分頁即消失）。
- 「提交表單」直接呼叫同源 iframe 的 `SaveDoc()`。
- 固定範本清單來自 `app.config.json`（`templates`），使用者自訂清單（`me/notes`）由 `allowUserList` 控制。
- 錯誤回報到 FMapi（`errorlog`），只送錯誤訊息與 app／範本 ID，不送病歷號或表單內容。
- H0 本機 Docker：`nginx` 提供 app 並同源反向代理 `/strucmed`、`/llmgw`、`/FM`。

## 設定（`app.config.json`）

| 欄位 | 說明 |
|---|---|
| `appName`／`shortName`／`version` | 顯示名稱與版本（manifest、登入頁） |
| `hosting` | `H0`（本機 Docker，預設）或 `H2`（站台 `/strucmed/apps/<name>/`） |
| `siteBase` | strucmed 站台前綴（H0 為 `/strucmed`；H2 由網址推算） |
| `templates` | 固定範本 `[{ id, name }]`，永遠排在清單最前面 |
| `allowUserList` | 是否允許使用者自訂清單（`me/notes`） |
| `errorlog` | `{ enabled, base }`，FMapi 前綴（H0 為 `/FM`） |
| `idleTimeoutMs` | 閒置多久自動登出（預設 30 分鐘） |

## 執行

```bash
npm ci
npm run build          # 輸出 dist/
```

H0：先在主機 `npm run build` 並通過 `check-app-dist.mjs dist`，再 `docker compose build && docker compose up -d` → `http://localhost:__PORT__/`（映像只裝入主機建好的 `dist/`，容器內不跑 npm）。`compose.yaml` 的 `UPSTREAM` 是院內站台 https 根網址。

H2：把 `dist/` 複製到站台 `web/apps/__APP_SLUG__/`（需平台提供 `/strucmed/apps/{name}/*` 靜態路由）。

## 不放進這個目錄的東西

帳號密碼、LlmGateway token、病人資料。登入用院內 HIS 帳號；表單頁內的 LLM／語音由站台處理，app 不經手 token。
