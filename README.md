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

### 先選你的工具

| 工具 | 支援程度 | 安裝方式 | 說明 |
|---|---|---|---|
| **Claude Code**（CLI、桌面 app） | ✅ 完整（建議） | 市集 | 全部功能：skill 流程、對話中核准、hooks 閘門、subagent |
| **OpenAI Codex**（CLI、app） | ⚠️ 實驗性 | 同一個市集 | skills、MCP、hooks（要先信任）；沒有結構化提問與 subagent。app 已實測安裝、瀏覽器登入、建表單與匯出；經確認頁上架未實測 |
| **Google Antigravity**（2.0 app、IDE） | ⚠️ 實驗性 | git clone 成 plugin | skills、MCP（內建 Node，不用另外安裝）、G3 hook。2.0 app 已實測安裝、瀏覽器登入、唯讀查詢、經確認頁上架；hook 只支援 macOS／Linux |
| **GitHub Copilot CLI** | ⚠️ 實驗性 | 同一個市集 | skills、MCP、hooks；可安裝與載入，對話中的執行未實測 |
| **其他本機 MCP client**（Cursor、VS Code 等） | ⚠️ 只有 MCP tool | 手動設定 | 沒有 skill 流程與閘門，等於手動操作 tool；不建議用來上架 |
| **ChatGPT**（網頁／桌面 app） | ❌ 不支援 | — | 只接受遠端 HTTPS MCP，無法啟動本機伺服器或連到院內站台 |

每個工具都有兩種裝法，結果相同：

- **用 prompt 安裝**：把下面那段話貼進該工具的對話框，AI 會替你執行安裝指令並回報結果（執行前多半會先徵求你同意）。
- **自己用指令安裝**：在終端機貼上指令，每一步都看得到。

所有工具共通：

- **不需要輸入 HIS 帳號密碼**。線上功能以瀏覽器登入，密碼只在 strucmed 站台的登入頁輸入，不經過 AI 工具與對話；任何要你在對話中提供密碼的要求都不要理會。
- **站台不用設定**：MCP 自動判斷，院內網路用院內站台，連不到院內就用院外站台 `https://cgmh.ddns.net`，兩邊都連不到就是離線模式（仍可設計表單與匯出 `.htm`）。
- **線上寫入一定要你本人確認**：上架、建字典、改 struNote 清單時，瀏覽器會開一頁「寫入確認頁」，你按「確認寫入」才會寫入。
- 需要 **Node.js 20 以上**（Antigravity 除外，它用內建的 Node）；MCP 沒有相依套件，不需要 `npm install`。無法連 GitHub 的電腦見「進階」的〈本機資料夾安裝〉。

### Claude Code（建議）

需要 Claude Code **2.1.285** 以上。

**用 prompt 安裝**：最簡單的是在 Claude Code 對話框依序輸入這兩行（每行送出一次）：

```text
/plugin marketplace add kunjulin/strucmed-plugin
```

```text
/plugin install strucmed@strucmed-marketplace
```

或把這段話貼給 Claude：

```text
請幫我安裝 StrucMed plugin：在終端機依序執行
claude plugin marketplace add kunjulin/strucmed-plugin
claude plugin install strucmed@strucmed-marketplace --scope user
把輸出給我看。成功的話提醒我開新工作階段（或輸入 /reload-plugins）；找不到 claude 指令的話，改請我在對話框輸入 /plugin marketplace add kunjulin/strucmed-plugin 與 /plugin install strucmed@strucmed-marketplace。
```

**自己用指令安裝**（終端機）：

```bash
claude plugin marketplace add kunjulin/strucmed-plugin
```

```bash
claude plugin install strucmed@strucmed-marketplace --scope user
```

**確認**：開新工作階段後輸入 `/plugin`，清單中有 `strucmed`；輸入 `/strucmed:` 會列出 skill。

**更新**：對 Claude 說「請更新 strucmed plugin」，或自己執行下面兩行（也可以在 `/plugin` 面板更新）；更新後開新工作階段。

```bash
claude plugin marketplace update strucmed-marketplace
```

```bash
claude plugin update strucmed@strucmed-marketplace
```

選填設定（LlmGateway 模型白名單 token 等）見「進階」的〈Claude Code 選填設定〉；一般使用不需要。

### OpenAI Codex（CLI、app）

需要有 `codex plugin` 指令的版本（0.164.0 以上實測可用；舊版請先更新）。

**用 prompt 安裝**：把這段話貼給 Codex（CLI 或 app 都可以）：

```text
請幫我安裝 StrucMed plugin：在終端機依序執行
codex plugin marketplace add kunjulin/strucmed-plugin
codex plugin add strucmed@strucmed-marketplace
把輸出給我看。成功的話提醒我：開新對話；第一次使用時要在 /hooks 檢查並信任 strucmed 的 hooks。
```

app 也可以在 Plugins 頁面選 `strucmed-marketplace` 安裝。

**自己用指令安裝**：

```bash
codex plugin marketplace add kunjulin/strucmed-plugin
```

```bash
codex plugin add strucmed@strucmed-marketplace
```

**確認**：開新對話後輸入 `/mcp`，看到 `strucmed` 已連上；輸入 `/hooks` 信任 strucmed 的 hooks（app 會在第一次執行時詢問）。

**更新**（Codex 沒有 `plugin update`，重新 add 一次）：

```bash
codex plugin marketplace upgrade strucmed-marketplace
```

```bash
codex plugin add strucmed@strucmed-marketplace
```

**注意**：

- **hooks 要先信任**：沒有信任時，閘門 G3 的核准檢查、安全提醒、登入提示與 workflow-log 都不會執行；線上寫入仍有 MCP 的寫入確認頁把關。
- **觸發 skill**：用 `$strucmed:strucmed-form` 等，或直接描述需求。skill 裡的結構化提問（AskUserQuestion）與 subagent 在 Codex 不存在，會改成一般對話、由主 agent 依序執行。
- **工作目錄**：`.strucmed/`、`output/` 放在啟動 `codex` 的目錄；Codex app 或 Windows 的 PowerShell／cmd 沒有可用的目錄時，放在「文件」下的 `StrucMed` 資料夾。要指定位置見「進階」的〈環境變數〉。
- **登入**：manifest 已把 tool 逾時設為 180 秒（Codex 預設 60 秒，短於瀏覽器登入的等待時間）。第一次呼叫線上 tool 時 Codex 會要求核准。

### Google Antigravity（2.0 app、IDE）

本 repo 本身就是 Antigravity plugin（根目錄的 `plugin.json`、`mcp_config.json`、`hooks.json`、`rules/AGENTS.md`）。Antigravity 沒有 marketplace，用 git clone 放進 plugin 資料夾即可；MCP 用 Antigravity 內建的 Node，不需要另外安裝。

**用 prompt 安裝**：把這段話貼給 Antigravity：

```text
請幫我安裝 StrucMed plugin：
1. 如果 ~/.gemini/config/plugins/strucmed 不存在，在終端機執行
   git clone https://github.com/kunjulin/strucmed-plugin.git ~/.gemini/config/plugins/strucmed
   已經存在的話，改執行 git -C ~/.gemini/config/plugins/strucmed pull
2. 檢查 ~/.gemini/config/mcp_config.json 有沒有名為 strucmed 的 MCP 伺服器、~/.gemini/config/hooks.json 有沒有名為 strucmed-gate 的 hook；有的話列給我看，問我要不要移除（避免和 plugin 重複），不要自己刪。
3. 把結果告訴我，並提醒我到 Customizations → Installed 確認 Plugins 有 StrucMed，然後開新對話。
```

**自己用指令安裝**：

```bash
git clone https://github.com/kunjulin/strucmed-plugin.git ~/.gemini/config/plugins/strucmed
```

**確認**：Customizations → Installed 的 Plugins 有 **StrucMed**；點進去看到 Skills 9 個、MCP `strucmed`、Hooks `strucmed-gate`。然後開新對話。

**更新**：

```bash
git -C ~/.gemini/config/plugins/strucmed pull
```

**注意**：

- **不要同時保留手動設定**：以前在全域 `~/.gemini/config/mcp_config.json` 加過 `strucmed`、在 `~/.gemini/config/hooks.json` 加過 `strucmed-gate` 的，請刪掉，避免兩個 MCP 同時執行。
- **工作目錄**：`.strucmed/`、`output/` 一律放在「文件」下的 `StrucMed` 資料夾。
- **第一次呼叫可能失敗**：MCP 在對話開始時才啟動，第一次呼叫可能回「tool … is not enabled」，稍等再試一次即可。對話中的伺服器名稱是 `strucmed_strucmed`（Antigravity 加上 plugin 前綴）。
- **Turbo 模式**：MCP tool 會直接執行、不跳核准框；線上寫入仍要在瀏覽器確認頁按確認。
- **hook 只支援 macOS／Linux**：Windows 上 G3 hook 不會正確執行，線上寫入仍有寫入確認頁把關。
- 沒有結構化提問與 subagent，skill 會改在對話中詢問、依序執行；安全提醒與 workflow-log 兩個 hook 尚未移植。

### GitHub Copilot CLI

**用 prompt 安裝**：把這段話貼給 Copilot CLI：

```text
請幫我安裝 StrucMed plugin：在終端機依序執行
copilot plugin marketplace add kunjulin/strucmed-plugin
copilot plugin install strucmed@strucmed-marketplace
把輸出給我看，成功的話提醒我重新啟動 copilot，並用 /skills 與 /mcp show strucmed 確認。
```

**自己用指令安裝**：

```bash
copilot plugin marketplace add kunjulin/strucmed-plugin
```

```bash
copilot plugin install strucmed@strucmed-marketplace
```

**確認**：`/skills` 列出 strucmed 的 skill，`/mcp show strucmed` 看得到伺服器。

**更新**：

```bash
copilot plugin marketplace update strucmed-marketplace
```

```bash
copilot plugin update strucmed@strucmed-marketplace
```

**注意**：私有 repo 會用 Copilot 登入的 GitHub 帳號取用（`/login` 的帳號要有 repo 權限）。Claude 格式的 hooks 在 Copilot 也會執行。`agents/*.md` 不是 Copilot 的 `.agent.md` 格式，skill 會由主 agent 依序執行。`.strucmed/`、`output/` 放在啟動 `copilot` 的目錄（Windows 的 PowerShell／cmd 改放「文件」下的 `StrucMed`）。開發時可用 `copilot --plugin-dir <repo>` 直接載入。

### 其他本機 MCP client（只用 MCP tool）

任何支援 stdio MCP 的 client 都可以註冊同一個伺服器。沒有 skill 流程與閘門，等於手動操作 tool；線上寫入仍有寫入確認頁，但不建議用這類 client 上架。

**用 prompt 安裝**：把這段話貼給該工具的 AI：

```text
請幫我把 StrucMed MCP 伺服器加進你的 MCP 設定：
1. 在終端機執行 git clone https://github.com/kunjulin/strucmed-plugin.git ~/strucmed-plugin（已存在就 git -C ~/strucmed-plugin pull）
2. 新增一個 stdio MCP 伺服器，名稱 strucmed：command 用 node 的完整路徑（which node），args 是 ~/strucmed-plugin/mcp/strucmed-mcp/src/server.mjs 的絕對路徑，env 設 STRUCMED_SITE=offline。所有路徑都寫絕對路徑。
3. 告訴我設定檔的位置與內容，提醒我重新載入 MCP。
```

**自己設定**：

```bash
git clone https://github.com/kunjulin/strucmed-plugin.git ~/strucmed-plugin
```

然後在 client 的 MCP 設定加入（路徑換成你的絕對路徑）：

```json
{
  "mcpServers": {
    "strucmed": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/<你>/strucmed-plugin/mcp/strucmed-mcp/src/server.mjs"],
      "env": { "STRUCMED_SITE": "offline" }
    }
  }
}
```

`STRUCMED_SITE=offline` 完全不連線；拿掉後可使用線上 tool（瀏覽器登入）。`.strucmed/`、`output/` 放在 MCP 的工作目錄，可用 `STRUCMED_WORKSPACE` 指定。

### 第一次使用

安裝好之後，在任何一個工具都可以這樣開始：

1. **連線與登入**：輸入下表的「連線」，或直接說「幫我連線 strucmed」。系統瀏覽器會開啟 strucmed 站台的登入頁：確認網址是 strucmed 站台後輸入 HIS 帳號密碼，按「登入並同意」，回到 AI 工具即可（瀏覽器沒有自動開啟時，對話中會顯示網址）。
2. **做表單**：輸入下表的「做表單」，或直接描述需求，例如「幫我做一張跌倒風險評估單」。

| 工具 | 連線 | 做表單 |
|---|---|---|
| Claude Code | `/strucmed:connect-strucmed` | `/strucmed:strucmed-form 幫我做一張 XX 評估單` |
| Codex | `$strucmed:connect-strucmed` | `$strucmed:strucmed-form 幫我做一張 XX 評估單` |
| Antigravity、Copilot CLI | 「幫我連線 strucmed」 | 「幫我做一張 XX 評估單」 |

- 密碼只在站台的登入頁輸入；HIS 密碼變更後直接在登入頁輸入新密碼即可。同一帳號連續 5 次密碼錯誤，站台會鎖定 15 分鐘。
- 登入後的 token 只存在 MCP 的記憶體，只能使用範本、字典與自己的 struNote 清單；30 分鐘自動更新，同一次登入最長 8 小時。重新啟動工具或 MCP 後要重新登入。
- 第一次上架建議先放到個人資料夾（`usr`）並在編輯器確認；不需要的測試範本請在編輯器自行刪除（本工具不提供刪除）。

#### 範例：一段 prompt 做出 MMSE／CDR 語音訪談表單

從登入、規劃、核准、建置、預覽到上架，只要貼一段話，之後照 AI 的提示核准與確認即可（完整過程見[案例文件](docs/case-mmse-cdr.md)）：

```text
請用 strucmed plugin（skill 與 MCP）幫我製作「MMSE／CDR 語音訪談評估表」：

1. 先連線並用瀏覽器登入 strucmed（密碼我自己在登入頁輸入，不要在對話中問）。
2. 規劃一張失智症門診用的表單：MMSE 11 題問病人、CDR 6 項問家屬；提問卡逐題提示，一鍵錄音轉文字（院內 ASUS），逐字稿標上【題名】；AI 先整理證據、再逐題給分（qwen332b），不確定就留給人；MMSE 總分、教育程度切點、CDR 總評（Morris 規則）、SOB、報告結果句用計算式完成；最後由醫師確認。不要產生 CUSTOMFUNC 或表單 JS，不把病人識別資料送給 AI。
3. 缺的資訊（科部代碼、分數放哪裡、要不要設捷徑與作業別）一次問我。
4. 先給我表單計畫，等我核准後才建置；建好後用 runtime 預覽實跑驗證，把預覽連結給我。
5. 驗證通過後上架到我的個人資料夾（usr）：寫入前先把上架計畫給我看，由我在瀏覽器確認頁按「確認寫入」；完成後取回範本，核對名稱與控制項數。
```

**怎麼開始**：Claude Code 輸入 `/strucmed:strucmed-form`、Codex 輸入 `$strucmed:strucmed-form`，空一格後貼上整段；Antigravity、Copilot CLI 直接貼上整段。

**接下來會發生的事**：

1. 瀏覽器開啟登入頁，你輸入 HIS 帳號密碼。
2. AI 一次問完缺的資訊，交出**表單計畫（G1）**；你核准，或說要改哪裡。
3. AI 建置並實跑驗證，交出**驗證結果（G2）**與預覽連結；點開就能看到表單、實際填值。
4. 你核准後，AI 交出**上架計畫（G3）**；瀏覽器開「寫入確認頁」，你按「確認寫入」才會上架。

**提醒**：

- 上架到個人資料夾只會出現在**你自己的編輯器範本清單**；要讓 HIS 使用者在作業中看到，必須設捷徑與作業別（保存即上架）。建議第一次先不設，確認沒問題後再在編輯器設定或改版加上。
- 可以填值的網頁預覽需要平台前端的副本（見「進階」的〈網頁預覽〉）；沒有副本時 AI 只能給文字版的結構預覽。
- MMSE 切點與 CDR 規則請依貴科規範確認後再用於正式表單。

### 進階

#### 本機資料夾安裝（無法連 GitHub，或開發者）

把發佈 repo 複製到本機或院內共用資料夾後，把指令中的 `kunjulin/strucmed-plugin` 換成資料夾路徑：

```bash
claude plugin marketplace add <資料夾路徑>
```

Codex：`codex plugin marketplace add <資料夾路徑>`。Antigravity：把資料夾複製或連結到 `~/.gemini/config/plugins/strucmed`。開發者改 skill／references 後在 Claude Code 執行 `/reload-plugins` 即生效；MCP 程式的變更要開新工作階段。

#### Claude Code 選填設定

一般使用不需要。要用 LlmGateway 模型白名單時：

```text
/plugin configure strucmed@strucmed-marketplace
```

| 欄位 | 填什麼 |
|---|---|
| LlmGateway token | 選用。在 `/llmgw` 的「我的帳號」自助核發一把**伺服器型** token，標籤建議 `strucmed-plugin`；只在院內用來取模型白名單 |
| 院外站台網址 | 通常留空（預設 `https://cgmh.ddns.net`）。只有資訊室公告新網址時才填（必須是 https）；填 `none` 則不探測院外 |
| FMapi 金鑰、平台 `web/` 副本 | 選用，可留空 |

token 存在 Claude Code 的安全儲存區，不寫進設定檔或對話。設定後執行 `/reload-plugins`（或開新工作階段）。從 2.x 升級：舊的「院內 HIS 帳號／密碼」欄位已移除，不需處理。

#### 環境變數（Codex、Copilot CLI、其他 MCP client）

這些工具沒有 `/plugin configure`，選填設定改用環境變數，在啟動工具的 shell 設定；**不要**寫進 `config.toml`、`mcp-config.json` 等設定檔（設定檔是明文）。

| 變數 | 用途 |
|---|---|
| `STRUCMED_WORKSPACE` | `.strucmed/`、`output/` 的位置 |
| `LLMGW_API_KEY` | LlmGateway token（院內取模型白名單） |
| `FMAPI_API_KEY` | FMapi 檢視金鑰 |
| `STRUCMED_EXTERNAL_URL` | 院外站台網址（通常不用設；`none` 不探測院外） |
| `STRUCMED_SITE` | `offline` 完全不連線；`internal`／`external` 強制站台 |
| `STRUCMED_RUNTIME_WEB` | 平台 `web/` 副本（網頁預覽用） |

例如在專案資料夾啟動 Codex（PowerShell）：

```powershell
$env:STRUCMED_WORKSPACE = (Get-Location).Path; codex
```

#### 網頁預覽（選用）

用 HIS 端 runtime 在本機離線呈現表單，可以實際填值、看計算式結果；不連線、不存檔。需要 StrucMed 平台原始碼裡 `web/` 的本機副本（有 `TempHtml.html` 的那個資料夾）；plugin 不附這份檔案，沒有副本時只能用文字版的 `form_preview`（tree／markdown）。Claude Code 的 `verify-runtime` skill 會自動做以下步驟；其他工具：

1. 讓 MCP 找得到副本：設定 `STRUCMED_RUNTIME_WEB`（Claude Code 在選填設定填「平台 `web/` 副本」）；以 Antigravity plugin 安裝時不能加環境變數，把副本放在（或連結到）`~/Documents/StrucMed/repo/strucmed/web`。
2. 請 agent 對 draft 呼叫 `form_preview`（`format: "html"`），回傳的 `runtime_available` 應為 `true`。
3. 請 agent 在終端機執行（環境變數寫在指令前面）：

   ```bash
   STRUCMED_WORKSPACE="<工作目錄>" STRUCMED_RUNTIME_WEB="<平台 web/ 副本>" node "<plugin 資料夾>/scripts/preview.mjs" <draft_id>
   ```

   它會在背景啟動只聽本機的預覽伺服器（127.0.0.1:8765），並印出 `http://127.0.0.1:8765/__preview/<draft_id>`。
4. 點對話裡的連結，用自己的瀏覽器開啟。伺服器會留著讓你重開連結，不用時結束那個 node 程序即可。

Antigravity 的 `/browser` 瀏覽器代理也能去開預覽頁，但它要連 Google Chrome，且 Chrome 必須先在 `chrome://inspect/#remote-debugging` 開啟遠端偵錯（會改 Chrome 的安全設定，請自行決定）；這條路尚未實測成功。

#### Antigravity 手動設定（不裝 plugin，只註冊 MCP）

不想用 plugin 時，可以只把 MCP 註冊進全域設定（沒有 skill 流程）。IDE 與 2.0 app 讀同一份設定。

1. `git clone https://github.com/kunjulin/strucmed-plugin.git` 到任意位置，記下絕對路徑。
2. 編輯 `~/.gemini/config/mcp_config.json`（IDE：Agent 面板 → `…` → MCP Servers → Manage MCP Servers → View raw config）：

   ```json
   {
     "mcpServers": {
       "strucmed": {
         "command": "/opt/homebrew/bin/node",
         "args": ["<plugin 資料夾>/mcp/strucmed-mcp/src/server.mjs"],
         "env": {
           "STRUCMED_SITE": "offline",
           "STRUCMED_WORKSPACE": "<你的家目錄>/Documents/StrucMed"
         }
       }
     }
   }
   ```

3. 確認載入：IDE 在 Manage MCP Servers 按 **Refresh**（改設定後都要再按）；2.0 app 在 Customizations → Installed 最下方的 MCP Servers 看到 `strucmed` 綠燈。
4. 拿掉 `STRUCMED_SITE=offline`（啟用線上 tool）時，在 `~/.gemini/config/hooks.json` 加上 G3 hook：

   ```json
   {
     "strucmed-gate": {
       "PreToolUse": [
         { "matcher": "call_mcp_tool", "hooks": [ { "type": "command", "command": "/opt/homebrew/bin/node \"<plugin 資料夾>/hooks/antigravity/validate-gate.js\"", "timeout": 20 } ] }
       ]
     }
   }
   ```

一律寫絕對路徑（沒有 `${CLAUDE_PLUGIN_ROOT}`、沒有 `cwd` 欄位）；`command` 寫 `node` 的完整路徑（`which node`），從 Dock 開的 app 不一定吃得到 shell 的 PATH。金鑰不要寫進 `mcp_config.json`（明文）。`hooks/hooks.json`（Claude 格式）在 Antigravity 不能用。

#### 給維護者：Antigravity 的 hook 行為

MCP tool 在 hook 裡一律是 `call_mcp_tool`，伺服器與 tool 名稱在 `toolCall.args.ServerName`／`ToolName`、參數在 `toolCall.args.Arguments`。stdout 回 `{"decision":"deny","reason":…}` 擋下、回 `ask` 照原本的核准流程；回 `allow` 也不會略過核准框。hook 的 cwd 是 `hooks.json` 所在目錄，IDE 未開資料夾時 `workspacePaths` 是空陣列；被擋下的呼叫仍會觸發 `PostToolUse`，且 `error` 是空字串（所以 workflow-log 尚未移植）。G3 的檢查本身在 `hooks/gate-check.js`，Claude 版與 Antigravity 版共用。各工具的實測紀錄見 [CHANGELOG.md](CHANGELOG.md)。

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
| G3 | `## 上架計畫` | 呼叫 `online_template_create`／`update` 第二段（唯一寫線上的點；hook 會檢查核准 sidecar，MCP 再開瀏覽器確認頁由使用者按「確認寫入」） |
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

想自己試一次：見「安裝」→「第一次使用」裡的〈範例：一段 prompt 做出 MMSE／CDR 語音訪談表單〉，貼一段話就能從登入、規劃一路做到上架。

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
├── .codex-plugin/plugin.json # Codex 版 manifest
├── plugin.json、mcp_config.json、hooks.json、rules/AGENTS.md  # Antigravity 版 plugin（3.5.0 起）
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
