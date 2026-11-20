# 安全不變量

> 所有 skill 與 agent 都必須遵守；與使用者的要求衝突時，說明理由並指向本文。

## 可驗證的範圍（資安審查看這一段）

**`strucmed-mcp` 的 token 只能使用範本、字典與登入者自己的 struNote；平台對病人資料 API 一律回 403。**
plugin 裡沒有任何查詢或存檔病人紀錄的 tool，不是「不呼叫」，是**平台端拒絕**（2026-10-25 起對 `strucmed-mcp` 的 token 生效）。要查或存病人紀錄請在編輯器或 HIS 操作。

對外連線只有四處，每一處都要使用者動作，預設都不會自己連：

| 連去哪 | 什麼時候 | 怎麼把關 |
|---|---|---|
| strucmed 站台 API v2（院內 LVAIW／院外站台） | 字典索引、上架、取回範本 | 瀏覽器登入（HIS 密碼不經 MCP）；寫入兩段式＋G2＋確認頁 |
| LlmGateway、FMapi（只有院內） | 取模型白名單、查 FMapi 狀態 | 需要使用者自己填的金鑰；沒填就不連 |
| 站台的靜態檔（`runtime_fetch`） | HTML 預覽缺平台前端副本時 | 兩段式（第一次只回 plan）；只抓與站台同源的 https，**不碰第三方 CDN**；每檔 SHA-256 寫進 manifest，開預覽前重算比對 |
| 預覽伺服器（`127.0.0.1`） | runtime 驗證 | 只聽本機、CSP 封鎖對外、網址帶一次性 nonce、閒置自動關 |

SBOM：`scripts/sbom.mjs` 產三份（plugin 本身／表單 APP 範本的產出物相依／runtime 快取的 provenance），見 README〈SBOM〉。plugin **執行期零第三方相依**。

1. **帳密與金鑰不經對話**：HIS 帳密只在 strucmed 站台的登入頁輸入（`online_login` 以瀏覽器登入：授權碼 + PKCE、本機 127.0.0.1 回呼），MCP 與 AI 工具都拿不到密碼，`online_login` 也沒有帳密參數；登入取得的 token 只存在 MCP 記憶體。選用的金鑰（LlmGateway token、FMapi 金鑰）由使用者在 `/plugin configure strucmed@strucmed-marketplace` 填寫（`sensitive`，存 Claude Code 的安全儲存區，以 `${user_config.*}` 注入 MCP 的環境變數 `LLMGW_API_KEY`、`FMAPI_API_KEY`），或進階者在啟動 shell 設環境變數。不要求使用者在對話中提供密碼或 token；登入頁顯示密碼錯誤或鎖定時由使用者在瀏覽器處理；不寫進 `.mcp.json`、`settings.json`、`.env`、腳本、計畫檔、manifest 或任何輸出。`check-env.mjs` 只回報「是否設定」。
2. **寫入一律兩段式**：`form_export`、`form_remove_control`、`form_delete`，以及範本、字典與 struNote 清單的線上寫入，第一次呼叫取得 `plan`，**原樣**呈現給使用者，同意後才帶 `confirm_token`。內容改動後 token 失效。線上寫入的第二次呼叫另由 MCP 開啟瀏覽器確認頁，使用者本人按「確認寫入」才寫入。同一個 draft 已取得計畫的多項寫入列在同一頁、按一次涵蓋頁上全部（MCP 2.14.0），頁上沒有列出的寫入不在確認範圍內；agent 不得替使用者確認或操作確認頁。
   **瀏覽器確認頁可以關掉（flag `browserApprove`，預設 `true`）**：遠端或用手機操作這個工具時碰不到 127.0.0.1 的那一頁，所以提供 `browserApprove: false`，第二段呼叫直接寫入、不開頁。兩段式 `confirm_token` 與 G2 定稿核准都不變。取捨要誠實講出來，不要只寫「可關閉」：
   - **`browserApprove: false` 再加上 AI 工具處於自動核准模式時，就沒有任何在 AI 之外的人看過 plan。** 這是關掉它真正失去的東西，不是「少一個步驟」。
   - 關閉時每次線上寫入的 plan 都會多一條 `W_NO_BROWSER_APPROVE`，定稿檔的「### 警告」一定看得到；skill 不得省略或改寫它。
   - 可攜的第二道把關是**AI 工具自己的「要不要允許這次 tool 呼叫」提示**（Claude Code、Codex、Antigravity 都有）。`AskUserQuestion` **不能**當成唯一閘門：Codex 與 Antigravity 沒有這個 tool。
   - `STRUCMED_NO_BROWSER=1` 的語意不變，它只是不自動開瀏覽器，那一頁還是要有人去開。
3. **不碰病人資料**：plugin 沒有查詢或存檔病人紀錄的 tool（2026-10-25 起平台對 `strucmed-mcp` 的 token 呼叫病人紀錄、匯出與管理 API 一律回 403）；使用者要查或存病人紀錄，請其在編輯器或 HIS 操作。對話中出現的病人資料不轉存到檔案或計畫檔。預設值、選項、計畫、manifest 不放任何病人資料；`form_validate` 的 `E_PHI_SUSPECT` 必須處理。改版來源的表單預設（片語）是使用者存下的填寫值：`online_template_get` 一律帶 `presets=false`，站台不回傳片語（回應標頭 `X-Strucmed-Presets: omitted`，`site_presets: "omitted"`），舊版站台忽略參數時在本機清成 `[]` 並重算 `integrity`（`site_presets: "unsupported"`＋`W_SITE_PRESETS_UNSUPPORTED`），`save:true` 的存檔一律不含片語；`.htm`／`.json` 來源的片語 `form_import` 預設不帶入；保留時由 `form_validate` 一併掃描，命中以 `form_update_meta(drop_presets: true)` 移除。字典補述同樣不放病人資料（`dictionary_memo_check` 的 `E_PHI_SUSPECT`）；`online_dictionary_usage` 的字典使用索引只有範本名稱、資料夾與欄位 id，不含病歷。
4. **不直連倉儲**：plugin 只呼叫 strucmed API v2（院內 LVAIW 或院外站台，由 MCP 自動判斷；探測只 GET `api/health`、不帶憑證）、LlmGateway、FMapi（兩者只有院內）。`E_ONLINE_DISABLED` 時不嘗試其他連線方式。
5. **禁止產生的函數與表單 JS**：OPENURL、SAVEDOC、SETIOTHEADER、S_USERID、S_DEPTNO；CUSTOMFUNC 只允許呼叫同一 draft 以 `form_set_script` 的 `lookup` 片段定義的 `sm_<name>`（第一個參數必須是字串字面值；flag 關閉時一律禁止）；不嵌入圖片。表單 JS 只由 `form_set_script` 以白名單樣板產生（flag `formScript`，預設關：`style`、`guard`、`derive`、`lookup`、`required`；進階的 `autorun`、`table-rows` 另需 `formScriptAdvanced`，開文件時自動執行既有巨集與動態表格加列，不直接呼叫查詢或 AI 函數），draft 只存樣板參數、JS 在匯出或上架時由 MCP 渲染，不接受自由 JS、CSS 或選擇器字串；渲染後的程式碼必須原樣列在定稿計畫與匯入說明給使用者審閱。flag 關閉時 JS 區塊只有產生器標記註解。片段不得連外、不得讀寫身分與病歷脈絡、不得對 `ck_*` 賦值、不得存檔載入或整份搬運資料（渲染後掃描 `E_SCRIPT_FORBIDDEN_API`）。使用者需要其他 JS 時，請其匯入後在編輯器由人工加入並審查。
6. **模型名稱不得憑記憶**：只用 `references/FormulaMacroRules.md` 的清單（Phase 3 起改用 `llmgateway_models` 的快取）；拼錯平台會靜默改用預設模型。
7. **AI 資料流必須揭露**：有 LLM／語音巨集的表單，計畫與交付都要列 `W_AI_DATAFLOW`（哪些欄位會送出）。2026-10-22 決定：含 AI 巨集的上架不另設審查，但告知不可省略。嵌入頁面（embed 區塊、`OPENPANEL`）同等級：計畫、review.md 與交付都要列 `W_EMBED_DATAFLOW`（目標主機、帶出的參數、送出與寫回的欄位）。
8. **核准前不得寫入**：G2 定稿前不呼叫任何線上寫入；核准 sidecar（`verify-plan.mjs`）不符時拒絕寫入。
9. **不刪除、不覆寫線上範本與字典**：沒有也不會提供 trash、字典刪除、硬刪除紀錄的 tool。`templateUpdate` 開啟時只能更新「以該範本 import 後改版」的 draft，且帶 `If-Match`。
10. **runtime 驗證只在本機**：`STRUCMED_RUNTIME_WEB` 是本機副本，harness 的 CSP 封鎖對外連線、只聽 `127.0.0.1`、預覽網址帶一次性 nonce（伺服器重啟就失效）、閒置超過 `STRUCMED_PREVIEW_IDLE_MS`（預設 120 分鐘）自動關；不在 HIS 終端機上跑。預覽頁送出的審閱意見會先擋掉疑似病歷號與身分證字號（`mcp/strucmed-mcp/src/phi.mjs`，頁面與伺服器端用同一組規則，伺服器端是最後一道），被擋掉的值不寫進 review JSON。
    **副本不內附進 plugin**：平台 `TempHtml.html` 引用約 25 個第三方元件（jQuery、Bootstrap、moment、numeral、jstat、fancytree、html2canvas…），內附會把它們拉進 plugin 的合規與 SBOM 範圍。沒有副本時用 `runtime_fetch` 從**站台**抓一份到 `<HOME>/.strucmed/runtime`（flag `runtimeFetch`，預設開）：
    - 兩段式，第一次只回 plan（站台、網址、版本戳記、要抓幾個檔案、存到哪裡），使用者同意後第二次才連外；之後沿用快取不再問。
    - 只抓 https 且與站台同源、在站台路徑底下的網址（`http` 只放行 `127.0.0.1`／`localhost` 測試）；轉址後的位置也要同源。**絕不從任何第三方 CDN 抓**（bootcdn、staticfile、jsdelivr…）。
    - 必要檔案（`TempHtml.html` 與它直接引用的 js／css）少一個就整批失敗，先寫暫存目錄再換過去，不留半套。
    - manifest（`.strucmed-runtime.json`：來源網址、抓取時間、版本戳記、每檔 SHA-256）是這份快取的 provenance，也是 `sbom-runtime.json` 的來源。**開預覽前重算雜湊比對，不符就拒絕開**，不默默使用。
    - 版本漂移要主動講：`runtime_status` 比對站台的版本戳記，站台比較新時回 `W_RUNTIME_STALE` 並請使用者決定要不要重抓，**不自動覆蓋**；預覽頁橫幅顯示目前跑的是哪一版。
11. **嵌入頁面只用宣告、不寫 JS**（flag `embedArea`，3.11.0 起預設開）：embed 區塊與 `OPENPANEL` 的網址只接受 https＋院內主機（`*.cgmh.org.tw`、`*.cgmf.org.tw`、`*.cgmh.me`、10/8、172.16/12、192.168/16、localhost；只看主機字串，不做 DNS）；網址與 `params` 不帶身分證號、姓名，參數值只能是 `{chtno}`、`{deptNo}`、`{user}`、`{opdno}` 或常數；嵌入頁要留在病歷的資料只經由 `outputs` 寫進一般控制項。不為嵌入頁寫自訂 JS，javascript 區塊照舊只放產生器標記（與第 5 條相同）；`OPENURL` 維持禁用。改版既有表單時原表單的 embed 原樣保留並檢查，原表單的自訂 JS 照標 `W_CUSTOM_JS`。 需要 API 金鑰才能啟動的 APP 不把金鑰放進表單、網址、參數或任何輸出：`url` 指向站台的啟動橋接頁 `app-launch.html?app=<代號>`，金鑰只在站台伺服器；揭露時要寫出資料實際送往的 APP（代號，以及站台目錄提供的主機與送出的欄位），沒有目錄就寫「以站台登錄表為準」，不可只列橋接頁的主機。
12. **附件容器的內容不落地**（flag `attachBox`）：附件、抽出的文字、逐字稿只存在使用者當次的表單頁，plugin 不讀取、不保存、不放進範本或預設值；容器不綁字典、不存檔。用到容器的巨集（`LLMATTACH`、`ATTACHTRANSCRIBE`、prompt 裡的 `ATTACHTEXT`）一律列進 `W_AI_DATAFLOW`，寫明哪些容器、可放入的類型、送給哪個模型或語音服務；院外站台送出前的確認由平台負責，plugin 不能關閉。
