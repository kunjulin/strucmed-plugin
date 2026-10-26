# strucmed-plugin

長庚結構化病歷 2.0（StrucMed）表單製作的 **Claude Code plugin**：在對話中設計表單、離線驗證與 runtime 預覽、經 strucmed API v2 上架、對照院內 LlmGateway 模型白名單，並產生可在院內獨立運作的表單 APP。

本 repo 同時是 plugin 本體（`.claude-plugin/plugin.json`）與它自己的市集（`.claude-plugin/marketplace.json`），附帶零相依的 MCP 伺服器 `mcp/strucmed-mcp/`。

## 概觀

| 你想做的事 | 結果 |
|---|---|
| 「幫我做一張跌倒風險評估單」 | 需求訪談 → 表單計畫（核准）→ 建置 → 審查 → runtime 驗證（核准）→ 可匯入的 `.htm`，或直接上架 |
| 「以這張表單為範本加兩個欄位」 | 載入 `.htm`／線上範本 → 原結構原封保留 → 輸出新版 |
| 「上架到編輯器」 | 經 API v2 新建或更新範本（If-Match 防衝突），唯一會寫入線上的步驟，兩段式確認 |
| 「做成 app、平板用」 | B1：HIS 內執行、AI 走院內 LlmGateway 的檢核清單；B2：行動紀錄型 PWA（本機 Docker 預設） |

全程**不經對話收密碼**、**不直連倉儲**、**不接觸病人資料**、**不刪除或覆寫**線上範本與字典（詳見 [references/SecurityInvariants.md](references/SecurityInvariants.md)）。

## 安裝

### 支援的工具

本 plugin 依 Claude Code plugin 規格打包（`userConfig` 選填設定、hooks 閘門、`${CLAUDE_PLUGIN_ROOT}`、AskUserQuestion／Task subagent）。GitHub Copilot CLI 直接讀 `.claude-plugin/` 的 manifest 與 Claude 格式的 hooks；Codex（CLI 與 app）讀同一個市集與 `.codex-plugin/plugin.json`（MCP 的路徑寫法不同，所以另備一份）。其他工具只能用其中的 `skills/*/SKILL.md`（開放的 Agent Skills 格式）與 stdio MCP，安全機制不完整。

| 工具 | 支援程度 | 可用 | 缺少 |
|---|---|---|---|
| **Claude Code**（CLI、桌面 app） | ✅ 完整（建議） | 全部 | — |
| **GitHub Copilot CLI** | ⚠️ 實驗性 | skills、MCP（含瀏覽器登入）、hooks（同一個市集安裝） | `userConfig`（院外站台網址等改用環境變數）、subagent；對話中的執行與線上登入未經實測 |
| **OpenAI Codex**（CLI、app） | ⚠️ 實驗性，上架建議回 Claude Code | skills、MCP（含瀏覽器登入）、hooks（同一個市集安裝；hooks 需信任）；app 已實測安裝、瀏覽器登入、建表單與匯出 | `userConfig`（改用環境變數）、subagent 與結構化提問、runtime 預覽（需 `STRUCMED_RUNTIME_WEB`）；G3 阻擋未經實測 |
| **Google Antigravity**（IDE；2.0 app 未測） | ⚠️ 實驗性，只有 MCP tool | `form_*`、`dictionary_*`、`formula_check` 等 tool（全域 `mcp_config.json`）；IDE 2.5.5 已實測離線呼叫 | skill 流程與其他 hooks（plugin 格式不同，尚未移植）；G3 要另外裝 Antigravity 版 hook（已實測阻擋）；線上登入未經實測；上架建議回 Claude Code |
| **其他本機 MCP client**（Cursor、VS Code 等） | ⚠️ 只有 MCP tool | `form_*`、`dictionary_*`、`formula_check` 等 tool | 所有 skill 流程、閘門與 hooks |
| **ChatGPT**（網頁／桌面 app） | ❌ 不支援 | — | 只接受遠端 HTTPS MCP，無法啟動本機 stdio 伺服器、執行 `node` 腳本或連到院內站台 |

ChatGPT 若要支援，需把 MCP 改成對外 HTTPS 服務並加 OAuth，等於把 HIS 帳號登入與上架能力暴露到院外的雲端連線；與本 repo 的安全約定衝突，目前不規劃。

以下「步驟 1～3」是 Claude Code 的安裝方式；Copilot CLI、Codex、Antigravity 與其他 MCP client 見後面各節。

### 前提

- Claude Code **2.1.285** 以上（桌面 app 或 CLI）。
- Node.js **20** 以上（MCP 零相依，不需要 `npm install`）。
- 無法連 GitHub 的電腦見下方「本機資料夾市集」。
- 網路：院內網路（整合站台 `/strucmed`、LlmGateway `/llmgw`），或院外連到內建的院外站台 `https://cgmh.ddns.net`（3.1.0 起不需設定；見下方「院內與院外」）；都連不到時只能離線作業。

### 步驟 1：從 GitHub 安裝（終端機，只做一次）

```bash
claude plugin marketplace add kunjulin/strucmed-plugin
```

```bash
claude plugin install strucmed@strucmed-marketplace --scope user
```

也可以在 Claude Code 工作階段內用 `/plugin marketplace add kunjulin/strucmed-plugin` 與 `/plugin install strucmed@strucmed-marketplace`。

### 步驟 2：選填設定（在 Claude Code 內）

**不需要填 HIS 帳號密碼**（3.0.0 起）：線上功能改用瀏覽器登入，見步驟 3。**院外也不需要設定**（3.1.0 起內建 `https://cgmh.ddns.net`）。只有要用 LlmGateway 模型白名單時才需要：

```
/plugin configure strucmed@strucmed-marketplace
```

| 欄位 | 填什麼 |
|---|---|
| LlmGateway token | 選用。在 `/llmgw` 的「我的帳號」自助核發一把**伺服器型** token，標籤建議 `strucmed-plugin`；只在院內用來取模型白名單 |
| 院外站台網址 | 通常留空（預設 `https://cgmh.ddns.net`）。只有資訊室公告新網址時才填（必須是 https）；填 `none` 則不探測院外 |
| FMapi 金鑰、平台 `web/` 副本 | 選用，可留空 |

站台**不用填**：MCP 啟動時自動判斷，院內網路用院內 LVAIW（`/strucmed`、`/llmgw`、`/FM`），院內連不到就用院外站台 `https://cgmh.ddns.net`（登入仍要 HIS 帳密），兩邊都連不到就是離線模式。token 存在 Claude Code 的安全儲存區，不寫進設定檔或對話。設定後執行 `/reload-plugins`（或開新工作階段）。

從 2.x 升級：`/plugin configure` 裡舊的「院內 HIS 帳號／密碼」欄位已移除，不需處理；平台需部署到支援瀏覽器登入的版本（strucmed 2026-10-25 之後的 main，含 `api/v2/auth/authorize`）。

### 步驟 3：開始用

```
/strucmed:connect-strucmed
```

登入、確認站台功能、取模型白名單。**登入**會用系統瀏覽器開啟 strucmed 站台的登入頁：確認網址是 strucmed 站台後輸入 HIS 帳號密碼，按「登入並同意」，回到 Claude Code 即可（瀏覽器沒有自動開啟時，對話中會顯示網址）。

- 密碼只在站台的登入頁輸入，不經過 AI 工具與對話；HIS 密碼變更後直接在登入頁輸入新密碼即可。
- 登入後的 token 只存在 MCP 的記憶體，只能使用範本、字典與自己的 struNote 清單；30 分鐘自動更新，同一次登入最長 8 小時。開新工作階段或 `/reload-plugins` 後要重新登入。
- 同一帳號連續 5 次密碼錯誤，站台會鎖定 15 分鐘。

接著：

```
/strucmed:strucmed-form 幫我做一張 XX 評估單
```

### 更新

```bash
claude plugin marketplace update strucmed-marketplace
```

```bash
claude plugin update strucmed@strucmed-marketplace
```

或在 `/plugin` 面板更新；更新後開新工作階段。

### 本機資料夾市集（無法連 GitHub，或開發者）

把本 repo 複製到本機或院內共用資料夾後：

```bash
claude plugin marketplace add <資料夾路徑>
```

其餘步驟相同。開發者改 skill／references 後 `/reload-plugins` 即生效；MCP 程式與憑證的變更要開新工作階段。

### GitHub Copilot CLI（實驗性）

Copilot CLI 與 Claude Code 共用 plugin 格式（microsoft/power-platform-skills 也是同一份給兩邊用）。2026-10-23 以 Copilot CLI 1.0.103 實測：可從本市集安裝，9 個 skill 都會載入，MCP 設定也能正確解析；**對話中的實際執行尚未實測**。

```bash
copilot plugin marketplace add kunjulin/strucmed-plugin
```

```bash
copilot plugin install strucmed@strucmed-marketplace
```

私有 repo 會用 Copilot 登入的 GitHub 帳號取用（`/login` 的帳號要有 repo 權限）。更新用 `copilot plugin marketplace update strucmed-marketplace` 與 `copilot plugin update strucmed@strucmed-marketplace`；開發時可用 `copilot --plugin-dir <repo>` 直接載入。安裝後可用 `/skills` 與 `/mcp show strucmed` 確認，再直接描述需求（例如「幫我做一張 XX 評估單」）。

和 Claude Code 的差異：

- **線上登入**：3.0.0 起改用瀏覽器登入，不需要 `userConfig`，Copilot 也能使用線上 tool（未實測）。Copilot 沒有 `/plugin configure`：院外站台已內建，不需設定；LlmGateway 的 token 以啟動 `copilot` 的 shell 環境變數 `LLMGW_API_KEY` 提供，不要寫進 `~/.copilot/mcp-config.json`。
- **hooks**：Copilot 支援 Claude 格式的 `hooks/hooks.json`；hook 以 `PLUGIN_ROOT`／`CLAUDE_PLUGIN_ROOT` 環境變數定位腳本，matcher 同時涵蓋兩邊的 MCP tool 命名，所以 G3 核准檢查、安全提醒與 workflow-log 在 Copilot 也會執行。
- **工作目錄**：Copilot 以 plugin 目錄當 MCP 的 cwd，MCP 會改用啟動 `copilot` 時的目錄（`PWD`）。請在要放 `.strucmed/`、`output/` 的目錄啟動 Copilot。Windows 的 PowerShell／cmd 沒有 `PWD`，改放「文件」下的 `StrucMed` 資料夾（3.2.1 起，不再寫進 plugin 安裝目錄）；要放別處請設 `STRUCMED_WORKSPACE`。
- **subagent**：`agents/*.md` 不是 Copilot 的 `.agent.md` 格式，form-planner 等可能不會載入，skill 會由主 agent 依序執行。

### OpenAI Codex CLI 與 Codex app（實驗性）

Codex 讀得懂本 repo 的市集（`.claude-plugin/marketplace.json`）與 Codex 版 manifest（`.codex-plugin/plugin.json`：skills、MCP、hooks），可以直接安裝（Codex CLI 0.164.0 實測可安裝；沒有 `codex plugin` 指令的舊版請先更新）：

```bash
codex plugin marketplace add kunjulin/strucmed-plugin
codex plugin add strucmed@strucmed-marketplace
```

本機資料夾（無法連 GitHub 或開發用）：`codex plugin marketplace add <資料夾路徑>`。更新：`codex plugin marketplace upgrade strucmed-marketplace`，再執行一次 `codex plugin add strucmed@strucmed-marketplace`（Codex 沒有 plugin update）。安裝或更新後開新工作階段。

Codex app：可在對話中請 Codex 執行上面的 `codex plugin marketplace add`，或在 Plugins 頁面選 `strucmed-marketplace` 安裝；安裝後開新對話。2026-10-26 實測可安裝、瀏覽器登入（院外站台）、建立並匯出測試表單；過程中需核准 hooks。

- **hooks 要先信任**：Codex 不會自動執行 plugin 的 hooks。安裝或更新後在 Codex 輸入 `/hooks`（app 會在第一次執行時詢問），檢查並信任 strucmed 的 hooks（安全提醒、G3 核准檢查、登入提示、workflow-log）。沒有信任時 G3 不會執行，線上寫入只剩 MCP 本身的兩段式 `confirm_token`。
- **上架**：G3 在 Codex 的阻擋行為尚未實測；實測通過前，上架請回 Claude Code 或用編輯器匯入。
- **工作目錄**：Codex 以 plugin 目錄當 MCP 的 cwd，MCP 改用啟動 `codex` 時的目錄（`PWD`）放 `.strucmed/`、`output/`。沒有可用的 `PWD` 時（Codex app、Windows 的 PowerShell／cmd），改放「文件」下的 `StrucMed` 資料夾；3.2.1 起不再寫進 plugin 快取（更新 plugin 時會被清掉）。匯出結果會回傳完整路徑。要放在專案資料夾，CLI 可先指定：

  ```powershell
  $env:STRUCMED_WORKSPACE = (Get-Location).Path; codex
  ```
- **設定**：沒有 `/plugin configure`。LlmGateway token 等改用環境變數（`LLMGW_API_KEY`、`FMAPI_API_KEY`、`STRUCMED_EXTERNAL_URL`、`STRUCMED_RUNTIME_WEB`），在啟動 `codex` 的 shell 設定；**不要**寫進 `config.toml`。HIS 帳密不需要，線上以瀏覽器登入。
- **登入**：manifest 已把 tool 逾時設為 180 秒（Codex 預設 60 秒，短於瀏覽器登入的等待時間）。第一次呼叫線上 tool 時 Codex 會要求核准。
- skill 以 `$strucmed:strucmed-form` 等觸發，或直接描述需求；`/mcp` 可確認 `strucmed` 已連上。tool 名稱是 `strucmed` 伺服器下的 `form_validate` 等，不是 `mcp__plugin_strucmed_strucmed__*`。
- skill 裡的 AskUserQuestion、Task（subagent）在 Codex 不存在，會退化成一般對話與單一 agent 依序執行。

### Google Antigravity（實驗性，只用 MCP tool）

Antigravity 有自己的 plugin、hooks 格式，也沒有 marketplace，目前只能把 MCP 伺服器註冊進全域設定；skill 流程不會載入，閘門 G3 要另外裝 Antigravity 版 hook（步驟 4）。2026-10-26 以 Antigravity IDE 2.5.5 實測：離線模式可載入 16 個 tool、呼叫 `form_create` 建立 draft；G3 hook 對沒有核准計畫的上架呼叫回 deny、對已核准的回 ask；Antigravity 2.0 app 與真正的線上登入未測。

1. 把發佈 repo 複製到本機（例如 `git clone https://github.com/kunjulin/strucmed-plugin.git`），記下資料夾的絕對路徑。
2. 編輯 `~/.gemini/config/mcp_config.json`（IDE 的 Agent 面板 → `…` → MCP Servers → Manage MCP Servers → View raw config 會開同一個檔）：

   ```json
   {
     "mcpServers": {
       "strucmed": {
         "command": "/opt/homebrew/bin/node",
         "args": ["<plugin 資料夾>/mcp/strucmed-mcp/src/server.mjs"],
         "env": {
           "STRUCMED_SITE": "offline",
           "STRUCMED_FLAGS": "<plugin 資料夾>/feature-flags.json",
           "STRUCMED_WORKSPACE": "<你的家目錄>/Documents/StrucMed"
         }
       }
     }
   }
   ```

3. 回到 Manage MCP Servers 按 **Refresh**；`strucmed` 顯示 Enabled、16 個 tool 即完成（改設定後都要再按一次）。
4. **拿掉 `STRUCMED_SITE=offline`（啟用線上 tool）時必裝**：閘門 G3 的 Antigravity 版 hook。建立 `~/.gemini/config/hooks.json`（已有這個檔就把 `strucmed-gate` 加進去）：

   ```json
   {
     "strucmed-gate": {
       "PreToolUse": [
         { "matcher": "call_mcp_tool", "hooks": [ { "type": "command", "command": "/opt/homebrew/bin/node \"<plugin 資料夾>/hooks/antigravity/validate-gate.js\"", "timeout": 20 } ] }
       ]
     }
   }
   ```

   上架類 tool（`online_template_create`／`update`、`online_dictionary_create`／`batch`）帶 `confirm_token` 的第二段呼叫，只有在 `<STRUCMED_WORKSPACE>/.strucmed/plans/<draft_id>/` 有核准過的上架計畫時才會放行，其餘一律擋下；工作目錄從同一個 `mcp_config.json` 的 `STRUCMED_WORKSPACE` 讀取。放行時仍會跳 Antigravity 的核准框（hook 不替使用者核准）。

注意：

- **一律絕對路徑**：沒有 `${CLAUDE_PLUGIN_ROOT}`、沒有 `cwd` 欄位。`command` 寫 `node` 的完整路徑（`which node`）：從 Dock 開的 app 不一定吃得到 shell 的 PATH。`STRUCMED_WORKSPACE` 要明寫，`.strucmed/`、`output/` 放在這裡。
- **只建議離線**：上例的 `STRUCMED_SITE=offline` 完全不連線，產出 `.htm` 由使用者在編輯器匯入。拿掉它可試線上唯讀 tool（`online_template_get`、`online_dictionary_search`；瀏覽器登入最長等 120 秒，Antigravity 的 tool 逾時未實測，可用 `STRUCMED_LOGIN_WAIT_MS` 縮短）。
- **上架建議回 Claude Code**：Antigravity 沒有 publish-form skill，不會替你產生並核准上架計畫，所以裝了步驟 4 的 hook 後，線上寫入實際上都會被擋下。上架請回 Claude Code 或用編輯器匯入。`hooks/hooks.json`（Claude 格式）在 Antigravity 不能用：輸入格式不同，照搬會被當成第一段呼叫放行。
- **金鑰不要寫進 `mcp_config.json`**：`env` 是明文存檔。GUI app 也拿不到 shell 的環境變數，所以 LlmGateway 白名單在 Antigravity 改用內建靜態表。
- 第一次呼叫每個 tool，Antigravity 會跳出「Allow using this MCP tool?」核准框。
- 給維護者：Antigravity 的 hook 裡 MCP tool 一律是 `call_mcp_tool`，伺服器與 tool 名稱在 `toolCall.args.ServerName`／`ToolName`、參數在 `toolCall.args.Arguments`；stdout 回 `{"decision":"deny","reason":…}` 擋下、回 `ask` 照原本的核准流程，回 `allow` 也不會略過核准框。hook 的 cwd 是 `hooks.json` 所在目錄，IDE 未開資料夾時 `workspacePaths` 是空陣列；被擋下的呼叫仍會觸發 `PostToolUse`，且 `error` 是空字串（所以 workflow-log 還沒移植）。G3 的檢查本身在 `hooks/gate-check.js`，Claude 版與 Antigravity 版共用。

### 其他本機 MCP client（只用 MCP tool）

任何支援 stdio MCP 的 client 都可註冊同一個伺服器，用法同上：`command = node`、`args = <repo>/mcp/strucmed-mcp/src/server.mjs`、`STRUCMED_FLAGS` 指向 `feature-flags.json`；線上 tool 以瀏覽器登入，`STRUCMED_SITE=offline` 可完全不連線。這種用法沒有任何 skill 流程與閘門，等於手動操作 tool；寫入線上的 tool 不建議在這類 client 使用。

## 院內與院外

| | 院內（LVAIW） | 院外（內建 `https://cgmh.ddns.net`，可用「院外站台網址」覆寫） |
|---|---|---|
| 設計、改版、驗證、runtime 預覽、輸出 `.htm` | ✅ | ✅ |
| `online_template_get`、`online_dictionary_search` | ✅ | ✅ |
| 上架（`publish-form`）、`If-Match` 更新原範本 | ✅ | ✅ |
| LlmGateway 模型白名單、`llmgateway_chat_test` | ✅ | ❌（白名單用內建靜態表） |
| FMapi 站台狀態 | ✅ | ❌ |

院外上架的範本院內立即看得到，版本號（rev）與 `If-Match` 衝突偵測跨站有效。

## Skills

| Skill | 用途 | 參數 |
|---|---|---|
| `/strucmed:strucmed-form` | **入口**：確認環境、判定意圖、分流到下列流程 | `<表單需求>`，或 `改版 <檔案或範本ID>`、`預覽 <draft_id>`、`上架 <draft_id>`、`app <範本ID>` |
| `/strucmed:connect-strucmed` | 檢查並建立與 strucmed API v2、LlmGateway、FMapi 的連線 | — |
| `/strucmed:create-form` | 設計新表單：訪談 → 計畫（G1）→ 建置 → 審查 → runtime 驗證（G2）→ 輸出 | `<表單目的與臨床情境>` |
| `/strucmed:edit-form` | 以既有 `.htm`／`.json`／線上範本為範本改版，原結構原封保留 | `<來源> <要改什麼>` |
| `/strucmed:verify-runtime` | 以 HIS 端 runtime 的本機離線副本實跑計算式、巨集、表格頁籤，交出「輸入 → 結果」對照表 | `<draft_id>` |
| `/strucmed:tune-prompt` | 調校單一 LLM 按鈕的提示詞：依 PromptPatterns 改寫、formula_check、選用去識別化樣本試跑比較模型，再寫回 draft | `<draft_id> <itemid> [模型別名]` |
| `/strucmed:publish-form` | 經 API v2 上架（新建或 If-Match 更新；G3），字典先建後綁；線上未設定時改走 `.htm` 匯入 | `<draft_id> [--folder usr\|sub\|dpt] [--update <templateID>]` |
| `/strucmed:build-form-app` | B1 執行條件檢核清單；B2 表單 APP 產生（G4；H0 本機 Docker／H1 既有 struNote／H2 站台 `/apps/`） | `<範本 ID> [b1\|b2]` |
| `/strucmed:report-issue` | 收集 workflow-log、版本與遮蔽後的錯誤，產生 issue 草稿（由你自己送出） | `[一句話描述問題]` |

Agents（headless，由 skill 以 Task 啟動，不直接給使用者用）：`form-planner`（唯讀，產表單計畫）、`form-builder`（單一、依序建置 draft）、`form-reviewer`（計畫 ↔ draft 對照、白名單、AI 資料流、疑似個資）、`app-builder`（執行 scaffold 與靜態檢查）。共同規則在 [AGENTS.md](AGENTS.md)。

## 流程與核准閘門

寫入前一律先給你看計畫，核准狀態落地成檔案，可中斷續跑：

| 閘門 | 計畫檔標題 | 核准後才會 |
|---|---|---|
| G1 | `## 表單計畫` | 建置 draft |
| G2 | `## 驗證結果` | 輸出 `.htm` 或進入上架 |
| G3 | `## 上架計畫` | 呼叫 `online_template_create`／`update` 第二段（唯一寫線上的點；hook 會檢查核准 sidecar） |
| G4 | `## 應用程式計畫` | 產生 B2 app 目錄 |

計畫檔與核准 sidecar 放在工作目錄的 `.strucmed/plans/<id>/`，`scripts/verify-plan.mjs` 以 sha256 比對；計畫一改，核准就失效。格式見 [references/Gates.md](references/Gates.md)。

## 案例：MMSE／CDR 語音訪談表單

![操作步驟表格](docs/images/case-mmse-cdr/10_form_steps_blank.png)

用一段話描述需求，plugin 一路做到上架：提問卡逐題提示 → 一鍵錄音轉文字 → AI 整理證據、逐題給分（不確定就留給人）→ 總分、切點、CDR 總評由計算式完成，醫師最後確認。

| 階段 | 這個案例學到的 |
|---|---|
| 需求訪談 | 一次問完：分數放哪裡（頁籤不回倉儲）、科部、語音服務、測試或上架 |
| G1 計畫 | 前後 4 版；按鈕 `action_id` 不能指向 numberbox |
| G2 runtime 驗證 | 語法全過，實跑仍抓到 4 個平台計算差異（`COUNT` 算空白、`SMALL` 出錯、`LEFT` 數字、`0 = ""`） |
| 提示詞優化 | 兩段式、規則寫進 prompt、輸出鎖死、回覆驗證；M2 因「無法核對」被判 NA 的修正 |
| 院內版 | 只用 `VOICETOTEXT`＋`LLMQUERY`，巨集全部自動產生，資料不出院 |

完整過程與截圖：[案例：與 AI 共編 MMSE／CDR 表單](docs/case-mmse-cdr.md)。

## MCP 伺服器

`plugin.json` 以 `${CLAUDE_PLUGIN_ROOT}/mcp/strucmed-mcp/src/server.mjs` 註冊 `strucmed`（stdio，Node 20，零相依），tool 名稱為 `mcp__plugin_strucmed_strucmed__<tool>`。

- **離線（一律可用）**：`form_create`／`form_import`／`form_add_area`／`form_add_control`／`form_update_control`／`form_validate`／`form_preview`／`form_export`、`dictionary_*`、`formula_check` 等 16 個。
- **線上（判斷出站台才列出；以瀏覽器登入）**：`online_login`／`me`／`features`／`folder_list`／`template_get`／`template_create`／`template_update`／`template_versions`、`online_dictionary_*`、`online_me_notes_*`。沒有查詢或存檔病人紀錄的 tool。
- **LlmGateway（只有院內）**：`llmgateway_models`（白名單快取 `.strucmed/llm-models.json`，巨集模型檢查以此為準）、`llmgateway_chat_test`（flag 預設關）。
- **FMapi（只有院內）**：`fmapi_status`（唯讀）。

所有寫入都是兩段式（第一次回 plan 與 10 分鐘有效的 `confirm_token`，第二次才執行）。功能開關在 [feature-flags.json](feature-flags.json)；tool 細節與錯誤碼見 [mcp/strucmed-mcp/README.md](mcp/strucmed-mcp/README.md)。

## 減少核准提示

流程會多次呼叫 MCP tool 與 `node` 腳本。只在你信任的環境下，可在 `~/.claude/settings.json` 預先允許：

```jsonc
{
  "permissions": {
    "allow": [
      "Bash(node *)",
      "mcp__plugin_strucmed_strucmed__form_validate",
      "mcp__plugin_strucmed_strucmed__form_preview",
      "mcp__plugin_strucmed_strucmed__formula_check",
      "mcp__plugin_strucmed_strucmed__dictionary_search",
      "mcp__plugin_strucmed_strucmed__online_login",
      "mcp__plugin_strucmed_strucmed__online_me",
      "mcp__plugin_strucmed_strucmed__online_features",
      "mcp__plugin_strucmed_strucmed__llmgateway_models"
    ]
  }
}
```

寫入線上的 tool（`online_template_create`／`update`、`online_dictionary_*`、`online_me_notes_set`）建議**不要**預先允許，讓閘門與提示都留著。

## Repo 結構

```text
strucmed-plugin/
├── .claude-plugin/
│   ├── plugin.json          # plugin 定義：userConfig（憑證欄位）、MCP 註冊
│   └── marketplace.json     # 市集定義（source 指向 repo 本身）
├── AGENTS.md                # 所有 agent 與 skill 的共同規則
├── feature-flags.json       # 功能開關（online／llmgateway／fmapi 自動；templateUpdate 開；dictionaryWrite 關）
├── skills/                  # 9 個 skill（見上表）
├── agents/                  # form-planner、form-builder、form-reviewer、app-builder
├── references/              # 設計規則、計算式與巨集、提示詞樣板、巨集工作流配方、表格頁籤規則與版面樣板、閘門、上架與 APP 流程、模型白名單、安全不變量
├── hooks/                   # UserPromptSubmit 安全提醒、PreToolUse 核准檢查、PostToolUse workflow-log；antigravity/＝Antigravity 版 G3
├── scripts/                 # check-env、verify-plan、preview、scaffold-form-app、check-app-dist、report-issue
├── templates/form-app/      # B2 表單 APP 範本＋ H0 Docker
├── mcp/strucmed-mcp/        # MCP 伺服器（src/、test/、README）
├── schemas/                 # 範本套件 v2 JSON Schema
├── tools/v0-harness/        # runtime 驗證 harness（本機離線預覽）
└── docs/                    # 案例與截圖
```

工作目錄下會產生 `.strucmed/`（draft、計畫、白名單快取、workflow-log）與 `output/`，都已在 `.gitignore`。

## 本機開發

```bash
git clone https://github.com/kunjulin/strucmed-plugin.git
```

```bash
claude plugin marketplace add D:\repos\strucmed-plugin
```

之後 `claude plugin install strucmed@strucmed-marketplace`，改檔後 `/reload-plugins`。驗證與測試：

```bash
claude plugin validate . --strict
```

```bash
cd mcp/strucmed-mcp && npm test
```

## 文件

| 文件 | 內容 |
|---|---|
| [案例：MMSE／CDR 表單](docs/case-mmse-cdr.md) | 從安裝、需求訪談、G1～G3、runtime 驗證到提示詞優化的完整案例與截圖 |
| [references/](references/) | 表單設計、計算式與巨集、提示詞樣板、閘門、上架流程、模型白名單、安全不變量 |
| [mcp/strucmed-mcp/README.md](mcp/strucmed-mcp/README.md) | MCP tool 與錯誤碼 |

平台本身（strucmed 編輯器與 API）不在本 repo；runtime 預覽需要平台前端 `web/` 的本機副本（`/plugin configure` 的「平台前端 web/ 本機副本」）。

## 安全約定

- HIS 帳密只在 strucmed 站台的登入頁輸入（瀏覽器登入），plugin 與 AI 工具都拿不到；選用的 token 由 `/plugin configure` 收，存安全儲存區；都不寫入任何檔案、log、對話或 git。
- 線上寫入只有「上架」、字典與 struNote 清單，全部兩段式並經閘門；不提供病人紀錄的查詢與存檔；永不提供刪除範本、刪除字典、`sys` 資料夾。
- plugin 不直連倉儲；B2 app 的存檔經 `records/save` API。
- `.gitignore` 排除 `.env*`、`*.log`、`*.har`、`repo/`、`scratch/`、`.strucmed/`、`output/`、`node_modules/`。

## 回報問題

- **一般問題**：在工作階段內執行 `/strucmed:report-issue`，它會把 workflow-log、版本與遮蔽後的錯誤整理成本機草稿。請自己檢查（姓名與病歷內容不會自動遮蔽），再經院內管道交給維護者。請不要在本 repo 的 issue 貼工作紀錄或錯誤訊息。
- **資安問題**：見 [SECURITY.md](SECURITY.md)，請私下回報。
