# strucmed-mcp（v2.5.0）

MCP server：產生 StrucMed 2.0 可匯入的表單定義檔（`.htm` / `.package.json`〔範本套件 v2〕 / `.manifest.md`），由使用者本人在編輯器「匯入表單（及字典）」後檢視保存。離線 tool 不連線；另自動判斷院內（LVAIW）或院外（使用者設定的網址）站台，多出呼叫 strucmed V2 API 的線上 tool，以瀏覽器登入（見下方〈線上 tool〉）。

## 安全特性
- **零相依**：只用 Node.js 內建模組，不安裝任何 npm 套件（無供應鏈風險）。
- **不經手 HIS 密碼**：`online_login` 以系統瀏覽器開啟站台登入頁（OAuth 2.0 授權碼 + PKCE，回呼到本機 127.0.0.1），密碼只在站台頁面輸入；MCP 只拿到一次性授權碼與只限範本、字典、自己 struNote 清單的短效 token。
- **站台偵測只看 `api/health`**：啟動時探測站台（只 GET、不帶憑證）；`STRUCMED_SITE=offline` 時完全不連線，`tools/list` 不列出線上 tool，呼叫一律回 `E_ONLINE_DISABLED`。
- 只寫入 `<workspace>/.strucmed/`（draft、字典索引）與 `<workspace>/output/`（產出），兩者皆 gitignore。
- 輸出與刪除 draft 採**兩段式確認**（`confirm_token`：HMAC、綁定內容雜湊、10 分鐘有效、金鑰只存在本次行程）。
- 線上寫入（範本新建／更新、字典、struNote 清單）的第二次呼叫另有**瀏覽器寫入確認頁**（2.3.0，`src/approve.mjs`）：在 127.0.0.1 開一頁列出 plan，使用者按「確認寫入」才寫入；還沒按時回 `pending` 與 `approve_url`，再呼叫一次接著等；按取消回 `E_REJECTED`。每次確認只能用一次，無法關閉；網址含一次性 nonce，POST 檢查 Host／Origin，頁面內容一律跳脫並帶嚴格 CSP。`STRUCMED_APPROVE_WAIT_MS` 調整單次等待（預設 120 秒）。
- stdout 只輸出 JSON-RPC；診斷訊息寫 stderr。
- 表單 JS 區塊只寫入產生器標記註解，不產生可執行程式碼。

## 使用
本 repo 是 Claude Code plugin（`.claude-plugin/plugin.json` 的 `mcpServers` 以 `${CLAUDE_PLUGIN_ROOT}` 指到本 server；工作目錄＝Claude Code 的目前目錄）。安裝：`claude plugin marketplace add <本 repo 路徑>` → `claude plugin install strucmed@strucmed-marketplace`；在本 repo 內開發也用已安裝的 plugin（本機市集直接讀原始檔），tool 名稱為 `mcp__plugin_strucmed_strucmed__<tool>`。**改了 MCP 原始碼或更新 plugin 後，已開啟的工作階段裡 MCP 子行程仍是舊版**（`form_export` 的 `marker` 會顯示舊版號）：執行 `/reload-plugins` 或重開 Claude Code 才會換新。根目錄不再放 `.mcp.json`（它會被當成專案層級設定重複載入，且 `${CLAUDE_PLUGIN_ROOT:-.}` 這種預設語法不會展開）。手動執行：
```bash
node mcp/strucmed-mcp/src/server.mjs
```
環境變數 `STRUCMED_WORKSPACE` 指定工作目錄（預設為執行時的目錄；Copilot CLI、Codex 以 plugin 根目錄啟動時改用 `PWD`，即啟動 CLI 的目錄；沒有可用的 `PWD`（Codex app、Windows）時用 `~/Documents/StrucMed`，不寫進 plugin 目錄）；未展開的 `${…}` 字面值一律視為未設定；`STRUCMED_FLAGS` 指定 feature-flags.json（預設 plugin 根目錄）；`STRUCMED_RUNTIME_WEB` 指定平台 `web/` 本機副本（HTML 預覽用）。搭配 skill：`skills/strucmed-form/SKILL.md`（入口）。

## HTTP 模式（伺服器端 agent 平台）
預設是 stdio（上方 `node src/server.mjs`，由 Claude Code 等本機工具以子行程啟動）。設定 `STRUCMED_HTTP_PORT` 後改以 **Streamable HTTP** 提供同一組 tool：`POST <path>` 收一則 JSON-RPC 請求（或批次）、回一則 JSON；只有通知時回 202；無 session、無 GET 串流（GET／DELETE 回 405）。給跑在伺服器上、只能連 HTTP MCP 的 agent 平台（例如 MaiAgent 的 MCP 工具）使用。

```bash
STRUCMED_HTTP_PORT=8765 STRUCMED_HTTP_TOKEN="$(openssl rand -hex 24)" STRUCMED_WORKSPACE=/srv/strucmed node src/server.mjs
# [strucmed-mcp] v2.5.3 ready (...); http: http://127.0.0.1:8765/mcp (bearer)
```

| 變數 | 說明 |
|---|---|
| `STRUCMED_HTTP_PORT` | 設了就是 HTTP 模式（0＝隨機 port，實際 port 印在 stderr）；未設＝stdio |
| `STRUCMED_HTTP_HOST` | 綁定位址，預設 `127.0.0.1`。要綁 `0.0.0.0`（容器、其他主機連入）必須同時設 `STRUCMED_HTTP_TOKEN`，否則拒絕啟動 |
| `STRUCMED_HTTP_TOKEN` | 設了就要求每個請求帶 `Authorization: Bearer <token>`（定長比較）；不印、不寫檔 |
| `STRUCMED_HTTP_PATH` | 端點路徑，預設 `/mcp` |

行為與限制：
- **預設離線**：HTTP 模式下 `STRUCMED_SITE` 未設時視為 `offline`，只列離線 tool。原因是 `online_login` 的瀏覽器回呼與寫入確認頁都開在**執行 MCP 那台機器**的 127.0.0.1，遠端使用者的瀏覽器到不了；要用線上 tool 需明確設定 `STRUCMED_SITE`，並自行處理回呼（目前不支援）。
- **工作目錄只有一份**：`.strucmed/`、`output/` 是整個行程共用，多位使用者同時透過平台操作會看到彼此的 draft。單人測試或一個 agent 一個行程時沒有問題；多租戶隔離是後續工作。
- **平台會平行呼叫、也可能把同參數的呼叫去重**：要控制欄位順序請依序呼叫 `form_add_control` 並帶 `after_itemid`；重新驗證時帶上一次 `form_validate` 回傳的 `updated_at`，讓參數不同。
- 帶 `Origin` 標頭的請求一律 403（這個端點不給瀏覽器頁面直接呼叫，也避免 DNS rebinding）；本文上限 1 MiB；`Content-Type` 必須是 `application/json`。
- **檔案路徑限制在工作目錄內**：`dictionary_load` 的 `csv_path`、`form_import` 的 `source_path`、`form_export` 的 `out_dir` 都會解開 symlink 後檢查。stdio 模式的 `csv_path` 仍可用工作目錄外的路徑。部署時請以低權限帳號或容器執行。
- **檔案要直接傳內容**：呼叫端讀不到伺服器的檔案系統，`dictionary_load` 用 `csv_text`、`form_import` 用 `source_text`，不要傳路徑。內容由模型寫進 tool 參數，受模型輸出長度與本文上限限制，大型字典 CSV 請先篩到本科部需要的列。
- 對外曝露請放在 TLS 反向代理之後；token 只放環境變數。
- stdout 在 HTTP 模式下不輸出任何東西，診斷仍在 stderr。

## MCP App 卡片（form_preview／form_export）
支援 MCP Apps（SEP-1865）的 host（例如 MaiAgent 的 Web Chat 與後台對話）會把 `form_preview` 與 `form_export` 的結果畫成互動卡片；不支援的 host（Claude Code、Codex、LINE 等文字通道）看到的 JSON 文字結果完全不變。

- `tools/list` 在這兩個 tool 的 `_meta.ui.resourceUri` 指到 `ui://strucmed/form-card.html`；`resources/read` 回傳卡片 HTML（`ui/form-card.html`，單檔、不載入外部資源，符合 host 的封閉 CSP）。
- tool 結果多一個 `structuredContent`：表單資訊、各區塊的列與控制項、驗證結果、待新建字典，以及狀態 `kind`（`preview`／`export_plan`／`exported`）。`ui_hints.modelContext` 讓 host 把目前狀態塞給模型。
- 卡片動作：「產生匯出計畫」→ 呼叫 `form_export` 拿 plan；「確認匯出」→ 帶 `confirm_token` 再呼叫一次；完成後列出檔案與「下載」按鈕（`ui/open-link` 開啟簽章下載連結）。「請 AI 修改」把修改指示以 `ui/message` 送回對話。兩段式確認因此不再需要本機瀏覽器確認頁。
- **下載連結**（HTTP 模式）：`GET <path>/files/<draft_id>/<kind>?t=<token>`，`kind` 為 `htm`／`json`／`manifest`。token 是本行程金鑰簽的 HMAC、綁定 draft 與 kind、24 小時有效，是這條路徑唯一的憑證（瀏覽器下載不帶 bearer）。連結的主機名取自 `STRUCMED_PUBLIC_URL`，未設時用請求的 `X-Forwarded-Proto`／`X-Forwarded-Host`／`Host`。檔案以 `form_export` 記在 draft 裡的實際路徑取用（`draft.exported`），表單改名或自訂 `out_dir` 都不影響，也不會拿到同名另一張表單的檔案；連結永遠指向該 draft 最新一次匯出。
- **資源**：輸出檔也可用 `resources/read` 讀 `strucmed://export/<draft_id>/<kind>`（`form_export` 回應的 `resources` 欄位；`resources/templates/list` 列有樣板），host 可自行取檔、不經模型。`include_content:true` 時 `.htm` 改以內嵌資源（`content` 的 `resource` 區塊）回傳，不放在文字結果；整份 .htm 仍會進對話，只在平台既沒有下載入口也不能讀資源時使用。

## 線上 tool（strucmed V2 API）
呼叫 strucmed 的 token 保護 API。

### 設定
**不需要設定 HIS 帳密**（v2.0.0 起），**院外站台也不需要設定**（v2.1.0 起內建 `https://cgmh.ddns.net`）。`/plugin configure strucmed@strucmed-marketplace` 只有選填項目：LlmGateway token、FMapi 金鑰、院外站台網址（覆寫用）、平台 `web/` 副本；token 存安全儲存區，plugin.json 的 `mcpServers.env` 以 `${user_config.*}` 注入環境變數。填完 `/reload-plugins`。未填的選項展開為空字串，MCP 視為未設定。

### 站台自動判斷（`src/site.mjs`）
MCP 在回應 `initialize`／`tools/list` 前並行探測兩個站台的 `api/health`（只 GET、不帶憑證、逾時 3 秒；`STRUCMED_SITE` 不是 `auto` 或指定了 `STRUCMED_ONLINE_BASE_URL` 時不探測）：

| 結果 | 站台 | LlmGateway／FMapi |
|---|---|---|
| 院內可連（不論院外） | 院內 `https://lvaiw.cgmf.org.tw/strucmed` | 院內預設 `/llmgw`、`/FM` |
| 只有院外可連 | 院外站台 `https://cgmh.ddns.net`（內建；`STRUCMED_EXTERNAL_URL` 可覆寫，`none` 停用） | 不提供（院外連不到）；模型白名單用內建靜態表 |
| 都連不到 | 離線（線上 tool 不列出；30 秒後再探測，例如接上 VPN） | — |

`online_template_get`、`online_dictionary_search`、上架與 `If-Match` 更新在兩邊行為相同（ETag 是倉儲 head 的 sha256，rev 取倉儲最大值＋1）。`online_login`／`online_features` 回應的 `site` 標明目前站台；院外時 `online_features` 回 `W_SITE_EXTERNAL`。

### 瀏覽器登入（`online_login`）
平台契約見 `kunjulin/strucmed` 的 `docs/API-V2.md`「瀏覽器登入」（docs/13 第 2 期）。

1. 產生 `code_verifier`（32 bytes 隨機）與 `state`，在 `127.0.0.1` 隨機 port 等待 `/callback`。
2. 以系統瀏覽器開啟 `<站台>/api/v2/auth/authorize?client_id=strucmed-mcp&redirect_uri=http://127.0.0.1:<port>/callback&code_challenge=<S256>&state=…`（Windows `rundll32 url.dll,FileProtocolHandler`、macOS `open`、Linux `xdg-open`，不經 shell）；`STRUCMED_NO_BROWSER=1` 不開啟，回應中的 `authorize_url` 由使用者自行開啟。
3. 使用者在站台登入頁輸入 HIS 帳密（帳號連續 5 次錯誤，站台鎖 15 分鐘），按「登入並同意」，瀏覽器導回本機回呼；`state` 不符的請求一律 400 並繼續等待。
4. 以 `POST api/v2/auth/token`（`grantType: authorization_code`、`code`、`codeVerifier`、`redirectUri`）換 token。

`online_login` 最多等 `STRUCMED_LOGIN_WAIT_MS`（預設 120000，上限 300000）；還沒完成時回 `pending: true` 與 `authorize_url`，再呼叫一次會接著等同一個登入（10 分鐘內）。已登入時直接回目前狀態（`already: true`）。access token 30 分鐘，過期時自動以 refresh token 換新（站台每次輪替 refresh token）；同一次登入最長 8 小時。`online_logout` 與 MCP 結束（stdin 關閉）時呼叫 `POST api/v2/auth/revoke` 作廢登入。使用者在登入頁按「拒絕」時回 `E_AUTH`。

**進階**：在啟動 Claude Code（或 MCP）的環境直接設定下列變數；MCP 子行程會繼承：

| 變數 | 說明 |
|---|---|
| `STRUCMED_EXTERNAL_URL` | 覆寫院外站台網址（等同 `/plugin configure` 的「院外站台網址」）。留空＝內建 `https://cgmh.ddns.net`；`none`／`off`＝不探測院外；只接受 https |
| `STRUCMED_SITE` | `auto`（預設）／`internal`／`external`／`offline`：強制院內、院外或離線，不探測 |
| `STRUCMED_ONLINE_BASE_URL` | 直接指定站台根網址（不探測），例如本機測試站。只接受 `https`；`http` 只限 `localhost`／`127.0.0.1`／`[::1]`；不可含帳密、查詢字串或 `#`；院外站台不可加 `/strucmed`（會 301，MCP 不跟隨轉址） |
| `LLMGW_BASE_URL`、`FMAPI_BASE_URL` | 覆寫 LlmGateway／FMapi 網址（預設只有院內才有） |
| `STRUCMED_NO_BROWSER` | `1`＝不自動開啟瀏覽器（遠端主機、測試） |
| `STRUCMED_LOGIN_WAIT_MS` | `online_login` 每次最多等待的毫秒數（預設 120000） |

**不要**把 token 寫進 `.mcp.json`、`.env`、腳本或任何檔案，也不要在對話中貼出密碼。

### Tools
| tool | API | 說明 |
|---|---|---|
| `online_login` | `GET api/v2/auth/authorize`（瀏覽器）、`POST api/v2/auth/token` | 參數只有 `dept_no`、`hospital`（預設 CGMH），沒有帳密；見上方「瀏覽器登入」。`client_id` 固定 `strucmed-mcp`，平台只放行範本、字典與登入者自己的 struNote 清單（`me/notes`）的 API，病人紀錄回 403。完成時回 `site`、`user_id`、`name`、`dept_no`、`expires_at`，不回傳 token；未完成回 `pending`、`authorize_url` |
| `online_logout` | `POST api/v2/auth/revoke` | 作廢登入並清除記憶體中的 token |
| `online_folder_list` | `GET api/v2/folders/{type}/templates` | 唯讀；`type`：usr／sub／dpt／sys／trash／ALL，`q`、`page`、`page_size` |
| `online_template_get` | `GET api/v2/templates/{id}` | 唯讀；回傳範本套件 v2（`strucmed.template/v2`）。`save:true` 另存 `.strucmed/online/<id>.package.json`，可再用 `form_import` 載入為新 draft |
| `online_me` | `GET api/v2/me` | 唯讀；登入者、科部、可用資料夾代碼、是否管理者、token 到期 |
| `online_features` | `GET api/health`、`api/v2/runtime/features`、`api/llm-config` | 唯讀；站台健康、登入者的 HIS 端存檔／查詢開關、LLM 閘道是否啟用（**不回傳任何 token**）；任一端點失敗只回 warnings |
| `online_dictionary_search` | `GET api/v2/dictionaries?scope=match\|exact\|all&q=&page=&pageSize=` | 唯讀；每筆回 `level`（sys／own／sub／dpt／system）、`desc`、`sys`（體系標記）、`memo`、`fhir`、`alias_of`、`etag`，體系優先排序；同體系他科帶標記的字典也在比對範圍內；`update_index:true` 把結果寫成本機字典索引（取代 CSV），之後 `dictionary_search` 與字典綁定都依此。站台尚未升級時回 `W_SERVER_OLD`，desc／memo 由本機解析 |
| `online_template_create` | `POST api/v2/folders/{usr\|sub\|dpt}/templates` | **寫入範本**，兩段式（plan＝閘門 G3）；前置驗證無 error、無待新建字典；不寫 sys；寫入不重試 |
| `online_template_update` | `PUT api/v2/templates/{id}`＋`If-Match` | **寫入範本**（flag `templateUpdate`）；只允許以該範本 import 改版的 draft；第一次呼叫取線上 ETag 與差異；409→`E_CONFLICT` |
| `online_template_versions` | `GET api/v2/templates/{id}/versions` | 唯讀；版本清單 |
| `online_dictionary_create`／`online_dictionary_batch` | `POST api/v2/dictionaries`、`/batch` | **寫入字典**（flag `dictionaryWrite`，預設開）；dicComment 以字典 JSON 一次寫好 desc＋memo；同名沿用；已刪除同名回 `E_DELETED_EXISTS` 不自動 force；成功後綁回 draft 與本機索引 |
| `online_dictionary_memo_set` | `PUT api/v2/dictionaries/{id}/memo`＋`If-Match: etag` | **寫入字典補述**（flag `dictionaryWrite`）；任何登入者可寫、不動 desc；memo 補充合併、fhir 整組取代；送出前本機檢查 FHIR（`E_INVALID_FHIR`、`W_FHIR_TYPE_MISMATCH`）；plan 有改前／改後；線上已被修改 → `E_CONFLICT`（`details.current`）。選填 `draft_id`：hooks 檢查該 draft 的 G3 |
| `online_dictionary_memo_batch` | `PUT api/v2/dictionaries/memo/batch`（舊站台退回逐本 `PUT {id}/memo`，≤ 15 本） | **寫入字典補述**（flag `dictionaryWrite`）；一次 ≤ 100 本、逐本 If-Match（第二次呼叫帶 plan 的 `etags`）；取得計畫後被改的字典 → `E_CONFLICT`（`details.stale`，不開確認頁）；逐本回報，部分衝突 `W_PARTIAL_CONFLICT`。選填 `draft_id`：hooks 檢查 `memo-plan.md`（或上架計畫）的核准 |
| `online_dictionary_usage` | `GET api/v2/dictionaries/usage`、`/{id}/usage` | 唯讀；字典使用索引（平台每日掃描範本，只有範本名稱、資料夾、欄位 id）；不帶 id 時把各字典使用表單數寫進本機索引供 `dictionary_suggest` 排序；沒掃描過 `W_USAGE_NOT_SCANNED` |
| `online_me_notes_get`／`online_me_notes_set` | `GET/PUT api/v2/me/notes` | struNote 表單清單；set 整份取代（`add`／`remove` 增量），兩段式 plan 顯示新增／移除／改名 |

token 過期（401）時自動以 refresh token（`POST api/v2/auth/refresh`）換新並重試一次；refresh 也失敗時清除 session，回 `E_AUTH` 要求重新 `online_login`。錯誤碼：`E_ONLINE_DISABLED`（`STRUCMED_SITE=offline`、兩個站台都連不到或網址不合規定）、`E_AUTH`（未登入、登入頁按了拒絕、token 失效或登入超過 8 小時）、`E_UPSTREAM`（伺服器或倉儲錯誤、連不到、轉址；`details.status` 為 HTTP 狀態）。

### 資安限制
- **帳密不經過 LLM**：`online_login` 沒有帳號密碼參數；密碼只在登入時送到 `api/v2/auth/token` 一次。
- **不留痕跡**：密碼與 access／refresh token 只存在本次 MCP 行程的記憶體（重新啟動即失效），**不回傳、不寫檔、不寫 log**；錯誤訊息不含請求本文。測試以假伺服器檢查整個 stdout、stderr 與工作目錄都不含密碼或 token。
- **只連判斷出的站台**：站台探測只 GET `api/health`、不帶憑證；只接受 https（本機例外）；**不跟隨轉址**（避免 bearer token 被帶到其他主機）；逾時 30 秒、不自動重試（401 換 token 的那一次除外）。
- **身分與權限由 token 決定**：伺服器以 token 的使用者決定可寫的資料夾與 struNote 清單，並記錄每次寫入；`clientId: "strucmed-mcp"` 的 token 只能呼叫範本、字典與 `me/notes`。
- **不碰病人資料**：沒有查詢或存檔病人紀錄的 tool；平台對 `strucmed-mcp` 的 token 呼叫病人紀錄、匯出與管理 API 一律回 403。使用者要查或存病人紀錄，請其在編輯器或 HIS 操作。

## LlmGateway tool（院內＋`LLMGW_API_KEY`）
| tool | API | 說明 |
|---|---|---|
| `llmgateway_models` | `GET /v1/models` | 模型白名單快取 `.strucmed/llm-models.json`；之後巨集模型檢查對照快取（`references/ModelWhitelist.md`） |
| `llmgateway_chat_test` | `POST /v1/chat/completions` | flag `llmChatTest`；只用白名單模型、prompt 個資偵測、`max_tokens ≤ 1024`、會計配額 |

金鑰只從環境變數讀、只進 Authorization 標頭；https only、不跟隨轉址；測試以假閘道檢查整個 stdout、stderr 與工作目錄不含金鑰。

## FMapi tool（院內，`FMAPI_API_KEY` 選用）
| tool | API | 說明 |
|---|---|---|
| `fmapi_status` | `GET api/errorlog/status`、`GET api/uptime/summary` | 唯讀；錯誤紀錄後端與轉送狀態、相關站台可用率與最新探測（`W_SITE_DOWN`）；uptime 被拒時只回 warnings |

## Tools（離線）
| tool | 說明 |
|---|---|
| `dictionary_load` / `dictionary_search` | 載入字典頁 Export 的 CSV（`csv_path` 或 `csv_text` 擇一）、搜尋（編輯器相同的科部比對規則；同範圍內體系 → 本科 → 次專 → 科部；fuzzy 也搜 desc 與 memo）。CSV 中 JSON 說明被逗號斷欄時回 `W_DICT_CSV_JSON_BROKEN` |
| `form_fields` | 字典助手：把 draft 解析成逐欄事實（說明文字、datatype、選項、範圍、單位、字典與目前補述、誰參照誰、AI 資料流），`derived` 是推得的補述草稿（func／type／range／unit） |
| `dictionary_suggest` | 字典助手：依欄位事實從本機索引排出候選字典（名稱、說明與補述命中、型別、單位、選項、層級、使用表單數），附 `reasons` 與引用方式 `cite`（綁定 id、`memo.llm`、`memo.calx`、`A<itemid>`）；`include_other` 列出他科字典 |
| `dictionary_memo_check` | 字典助手：檢查補述草稿（11 個欄位、Big5、FHIR、1800 字、疑似個資），帶 `dic_id` 先與既有補述合併，帶 `draft_id`＋`itemid` 比對控制項型別、單位、範圍、選項，提示缺的角度 |
| `dictionary_create` | 規劃新字典（不寫入）；`comment`＝desc、`memo`＝補述，建立時寫進字典 JSON（`form_add_control`／`form_update_control` 的 `dictionary.comment`／`dictionary.memo` 相同） |
| `form_create` / `form_search` / `form_delete` | 本機 draft 管理（刪除只刪本機 draft）；`form_create` 的名稱、捷徑、作業別、Info、`folder_type` 會寫入套件 v2 |
| `form_import` | **v1**：載入既有表單（套件 v2 `.htm`／`.package.json`、舊版 `.htm`、`.json`；`source_path` 或 `source_text` 擇一）為新 draft；所有區塊、計算式、巨集、JS 原封保留；輸出為新表單（不沿用 templateID，捷徑與作業別預設不沿用） |
| `form_update_meta` / `form_update_control` | **v1**：修改名稱、捷徑、作業別、Info；修改控制項說明文字、預設值、必填、選項、字典 |
| `form_remove_control` | **v1**：兩段式移除控制項（仍被參照時拒絕；子項一併移除） |
| `form_add_area` | `form` 區塊；權限預設所有人（`doctor`）顯示／編輯／回傳文字 |
| `form_add_control` | textbox、numberbox、textarea、calendar、selection、combobox、radiobutton、checkbox、submenu、label（defaultValue/Reference）；`after_itemid` 插在同一區塊或同一格的指定控制項之後 |
| `form_validate` | 遞迴檢查巢狀結構：itemid 重複、參照（further、reference、公式與巨集中的 A<n>）、dicid 存在性、區塊權限、疑似個資；**依修改類別分級**：本次改到的面向為 error，原表單既有問題為 warning |
| `form_preview` | tree / markdown |
| `form_export` | 兩段式輸出 `.htm`（舊版 tempdata＋範本套件 v2）／`.package.json`（範本套件 v2）／`.manifest.md` |

規格與錯誤碼；v0.1 範圍外（計算式、巨集 → v0.2；表格、頁籤、圖片、子表單、既有表單改版 → v1）會回傳 `E_UNSUPPORTED_DATATYPE` 並註明版本。

## 測試
```bash
cd mcp/strucmed-mcp && npm test
```
- `test/unit.test.mjs`：各控制項欄位集合與真實編輯器匯入後一致（`test/fixtures/editor-g1-keys.json`，取自 v0 harness）、CSV 解析、字典比對、validator。
- `test/formula-explain.test.mjs`：`formula_check` 的標籤化公式（`labeled`、`ref_labels`）與試算（`samples`）：運算子優先順序、百分比、常用函數、缺值與不支援時回報不猜、BMI 身高體重對調回 `E_FORMULA_SAMPLE_MISMATCH`、進位函數與 MOD 和 Calx 2.2.8 一致（BMI 160／80 → 31.2、只差最後一位的提示）、固定表格的說明格。
- `test/e2e.test.mjs`：以真實 stdio 協定走完 create → export 兩段式流程，驗證套件 v2 與 `.htm` 內嵌套件一致，並以編輯器匯入器相同邏輯擷取 `var tempdata`。
- `test/v1.test.mjs`：改版流程（合成的既有表單 fixture）：三種來源格式、未修改時逐位元組保真、新增／修改／移除與參照保護、嚴重度分級、`derivedFrom`。
- `test/online.test.mjs`：線上 tool，以 127.0.0.1 上的假 V2 伺服器（不連真站）：me／health／features／llm-config（gateway token 不外洩）／dictionaries／feature flags；範本新建（兩段式、token 綁資料夾、503／502 pending 對應、取回確認）、`E_DICT_PENDING`、更新（只允許改版 draft、If-Match 來自 ETag、409→`E_CONFLICT`）、版本、字典新增（created／reused／`E_DELETED_EXISTS` 不自動 force／force）、批次；未設定時隱藏與 `E_ONLINE_DISABLED`、網址限制、登入本文、bearer、401→refresh→重試、refresh 失敗、轉址不跟隨、查詢必須帶病歷號與欄位過濾、存檔兩段式確認與 `iot.user`、登出；寫入確認頁（第二段只回 pending、確認一次只能用一次、取消回 `E_REJECTED`、nonce／Host／Origin 檢查）；全程檢查密碼與 token 未出現在 stdout、stderr 與工作目錄。
- `test/llmgw.test.mjs`：LlmGateway tool，以 127.0.0.1 上的假閘道：未設定時隱藏與 `E_LLMGW_DISABLED`、網址限制、bearer、快取寫入與別名對應、401／轉址／空清單、`formula_check` 對照白名單（不在清單、deprecated、視覺）、`form_validate` 的 `W_LLM_WHITELIST_STALE`、chat_test（flag、白名單、個資、標頭、思考模式、429）；金鑰不出現在 stdout、stderr、工作目錄。
- `test/fmapi.test.mjs`：FMapi tool，以假 FMapi：未設定時隱藏、errorlog 狀態、相關站台過濾與 `W_SITE_DOWN`、uptime 被拒／停用只回 warnings；金鑰不外洩。
- `test/package.test.mjs`：套件 v2 與 schema 一致、完整性雜湊、竄改偵測、`.htm` 內嵌 JSON 的跳脫安全。
- `test/trial-feedback.test.mjs`：3.5.0 試用回饋：`form_import(for_update)` 與 `metaSet`、`formdiff`（說明文字、控制項、JS、iot，排除伺服器補回的欄位）、`visible_title` 與 `W_AREA_NO_VISIBLE_HEADING`、空白巨集腳本 `E_ACTION_EMPTY`、`formula_check` 的 `W_KIND_MISMATCH`。
- `test/make-harness-fixture.mjs`：產生 `tools/v0-harness/fixtures/generated-v01.json`，交由真實編輯器程式碼 round-trip（2026-09-27 結果：F→G1 只有 `d_url`、`modifiedUser` 兩個環境欄位不同）。
