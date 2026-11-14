# strucmed-plugin

長庚結構化病歷 2.0（StrucMed）表單製作的 **Claude Code plugin**：在對話中設計表單、離線驗證與 runtime 預覽、經 strucmed API v2 上架、對照院內 LlmGateway 模型白名單，並產生可在院內獨立運作的表單 APP。

本 repo 同時是 plugin 本體（`.claude-plugin/plugin.json`）與它自己的市集（`.claude-plugin/marketplace.json`），附帶零相依的 MCP 伺服器 `mcp/strucmed-mcp/`。

## 概觀

| 你想做的事 | 結果 |
|---|---|
| 「幫我做一張跌倒風險評估單」 | 需求一次問完 → 草案直接建 draft → 預覽頁審閱 → 定稿（核准）→ 可匯入的 `.htm`，或直接上架 |
| 「以這張表單為範本加兩個欄位」 | 載入 `.htm`／線上範本 → 原結構原封保留 → 輸出新版 |
| 「上架到編輯器」 | 經 API v2 新建或更新範本（If-Match 防衝突），範本只在這一步寫入線上，兩段式確認 |
| 「做成 app、平板用」 | B1：HIS 內執行、AI 走院內 LlmGateway 的檢核清單；B2：行動紀錄型 PWA（本機 Docker 預設） |

全程**不經對話收密碼**、**不直連倉儲**、**不接觸病人資料**、**不刪除或覆寫**線上範本與字典（詳見 [references/SecurityInvariants.md](references/SecurityInvariants.md)）。

## 安裝

### 先選你的工具

| 工具 | 支援程度 | 安裝方式 | 說明 |
|---|---|---|---|
| **Claude Code**（CLI、桌面 app） | ✅ 完整（建議） | 市集 | 全部功能：skill 流程、預覽頁審閱、對話中核准、hooks 閘門、subagent |
| **OpenAI Codex**（CLI、app） | ⚠️ 實驗性 | 同一個市集 | skills、MCP、hooks（要先信任）；沒有結構化提問與 subagent。app 已實測安裝、瀏覽器登入、建表單與匯出；經確認頁上架未實測 |
| **Google Antigravity**（2.0 app、IDE） | ⚠️ 實驗性 | git clone 成 plugin | skills、MCP（內建 Node，不用另外安裝）、G2 定稿 hook。2.0 app 已實測安裝、瀏覽器登入、唯讀查詢、經確認頁上架；hook 只支援 macOS／Linux |
| **GitHub Copilot CLI** | ⚠️ 實驗性 | 同一個市集 | skills、MCP、hooks；可安裝與載入，對話中的執行未實測 |
| **其他本機 MCP client**（Cursor、VS Code 等） | ⚠️ 只有 MCP tool | 手動設定 | 沒有 skill 流程與閘門，等於手動操作 tool；不建議用來上架 |
| **ChatGPT**（網頁／桌面 app） | ❌ 不支援 | — | 只接受遠端 HTTPS MCP，無法啟動本機伺服器或連到院內站台 |
| **伺服器端 agent 平台**（MaiAgent 等，只接 HTTP MCP） | ⚠️ 只有離線 tool | 自行部署 HTTP 模式 | 設 `STRUCMED_HTTP_PORT` 以 Streamable HTTP 提供同一組 tool；沒有 skill 流程與閘門，線上登入與寫入確認頁到不了遠端使用者，見〈伺服器端 agent 平台〉 |

每個工具都有兩種裝法，結果相同：

- **用 prompt 安裝**：把下面那段話貼進該工具的對話框，AI 會替你執行安裝指令並回報結果（執行前多半會先徵求你同意）。
- **自己用指令安裝**：在終端機貼上指令，每一步都看得到。

已經裝過、只要更新的人，直接看下方的〈更新（已經裝過的人）〉。

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

**更新**：見下方〈更新（已經裝過的人）〉。

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

**更新**：見下方〈更新（已經裝過的人）〉。

**注意**：

- **hooks 要先信任**：沒有信任時，閘門 G2 定稿的核准檢查、安全提醒、登入提示與 workflow-log 都不會執行；線上寫入仍有 MCP 的寫入確認頁把關。
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

**更新**：見下方〈更新（已經裝過的人）〉。

**注意**：

- **不要同時保留手動設定**：以前在全域 `~/.gemini/config/mcp_config.json` 加過 `strucmed`、在 `~/.gemini/config/hooks.json` 加過 `strucmed-gate` 的，請刪掉，避免兩個 MCP 同時執行。
- **工作目錄**：`.strucmed/`、`output/` 一律放在「文件」下的 `StrucMed` 資料夾。
- **第一次呼叫可能失敗**：MCP 在對話開始時才啟動，第一次呼叫可能回「tool … is not enabled」，稍等再試一次即可。對話中的伺服器名稱是 `strucmed_strucmed`（Antigravity 加上 plugin 前綴）。
- **Turbo 模式**：MCP tool 會直接執行、不跳核准框；線上寫入仍要在瀏覽器確認頁按確認。
- **hook 只支援 macOS／Linux**：Windows 上 G2 定稿 hook 不會正確執行，線上寫入仍有寫入確認頁把關。
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

**更新**：見下方〈更新（已經裝過的人）〉。

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

### 伺服器端 agent 平台（MaiAgent 等，只接 HTTP MCP）

agent 跑在平台的伺服器上、沒有「使用者的電腦」可以啟動子行程時，把 MCP 以 HTTP 模式部署在平台連得到的主機，再在平台登錄這個網址與 bearer token：

```bash
git clone https://github.com/kunjulin/strucmed-plugin.git /opt/strucmed-plugin
STRUCMED_HTTP_PORT=8765 STRUCMED_HTTP_TOKEN="<隨機長字串>" STRUCMED_WORKSPACE=/srv/strucmed \
  node /opt/strucmed-plugin/mcp/strucmed-mcp/src/server.mjs
```

平台端 MCP 設定：網址 `http://<主機>:8765/mcp`（對外請走 TLS 反向代理），標頭 `Authorization: Bearer <token>`。平台拿到的是離線 tool（設計表單、驗證、預覽、匯出 `.htm`）；字典 CSV 與既有表單用 `dictionary_load` 的 `csv_text`、`form_import` 的 `source_text` 直接傳內容（平台讀不到伺服器的檔案），大型字典先篩到本科部用得到的列。平台若會平行呼叫 tool，要控制欄位順序請依序呼叫 `form_add_control` 並帶 `after_itemid`。HTTP 模式的檔案路徑限制在工作目錄內；請以低權限帳號或容器執行。skill、hooks、subagent 不會跟過來，線上 tool 預設不提供。支援 MCP Apps 的 host（MaiAgent Web Chat／後台）會把預覽與匯出畫成互動卡片：確認匯出、下載 .htm、把修改指示送回對話都在卡片上完成。變數與限制見 [mcp/strucmed-mcp/README.md](mcp/strucmed-mcp/README.md) 的〈HTTP 模式〉與〈MCP App 卡片〉。

### 更新（已經裝過的人）

已經裝過 strucmed，只要更新到新版時看這一節；新版改了什麼見 [CHANGELOG.md](CHANGELOG.md)。和安裝一樣有兩種做法：把那段話貼給 AI，或自己執行指令。

所有工具共通：

- **更新後要開新的工作階段或對話**，新版才會生效；MCP 重新啟動後也要重新登入（瀏覽器登入頁）。
- **不會動到你的資料**：draft、計畫與輸出的 `.htm` 放在工作目錄的 `.strucmed/`、`output/`（或「文件」下的 `StrucMed`），不在 plugin 的安裝資料夾裡，更新時不受影響。

#### Claude Code

**用 prompt 更新**：

```text
請幫我更新 StrucMed plugin：在終端機依序執行
claude plugin marketplace update strucmed-marketplace
claude plugin update strucmed@strucmed-marketplace
把輸出與更新後的版本號給我看，提醒我開新工作階段；找不到 claude 指令的話，改請我在 /plugin 面板更新。
```

**自己用指令更新**（也可以在 `/plugin` 面板更新）：

```bash
claude plugin marketplace update strucmed-marketplace
```

```bash
claude plugin update strucmed@strucmed-marketplace
```

**確認**：開新工作階段後在 `/plugin` 看 `strucmed` 的版本。

#### OpenAI Codex

Codex 沒有 `plugin update`，更新市集後再 add 一次。

**用 prompt 更新**：

```text
請幫我更新 StrucMed plugin：在終端機依序執行
codex plugin marketplace upgrade strucmed-marketplace
codex plugin add strucmed@strucmed-marketplace
把輸出給我看，提醒我開新對話，並在 /hooks 重新檢查與信任 strucmed 的 hooks。
```

**自己用指令更新**：

```bash
codex plugin marketplace upgrade strucmed-marketplace
```

```bash
codex plugin add strucmed@strucmed-marketplace
```

**確認**：開新對話後 `/mcp` 看到 `strucmed`；到 `/hooks` 重新信任 strucmed 的 hooks（更新後可能要再信任一次，沒信任時 G2 定稿檢查不會執行）。

#### Google Antigravity

**用 prompt 更新**：

```text
請幫我更新 StrucMed plugin：
1. 在終端機執行 git -C ~/.gemini/config/plugins/strucmed pull，把輸出給我看。
2. 如果顯示「not a git repository」（以前是用複製的方式安裝），先把資料夾搬出 plugins 資料夾：mv ~/.gemini/config/plugins/strucmed ~/strucmed-plugin.bak，再執行 git clone https://github.com/kunjulin/strucmed-plugin.git ~/.gemini/config/plugins/strucmed。
3. 如果 pull 出現衝突或「本機有修改」，不要自己覆蓋或刪除，把訊息給我看。
4. 完成後提醒我到 Customizations → Installed → StrucMed 看版本，然後開新對話。
```

**自己用指令更新**：

```bash
git -C ~/.gemini/config/plugins/strucmed pull
```

以前是用複製（不是 git clone）安裝的，`git pull` 會回「not a git repository」。先把舊資料夾搬出 plugins 資料夾（留在裡面會被當成另一個 plugin 載入），再重新安裝：

```bash
mv ~/.gemini/config/plugins/strucmed ~/strucmed-plugin.bak
```

```bash
git clone https://github.com/kunjulin/strucmed-plugin.git ~/.gemini/config/plugins/strucmed
```

**確認**：Customizations → Installed → StrucMed，頁面下方的 Version 是新版號；然後開新對話。以前用「手動設定」（全域 `mcp_config.json`）的人，請改照〈Google Antigravity〉安裝 plugin，並刪掉手動設定。

#### GitHub Copilot CLI

**用 prompt 更新**：

```text
請幫我更新 StrucMed plugin：在終端機依序執行
copilot plugin marketplace update strucmed-marketplace
copilot plugin update strucmed@strucmed-marketplace
把輸出給我看，提醒我重新啟動 copilot，並用 /skills 確認。
```

**自己用指令更新**：

```bash
copilot plugin marketplace update strucmed-marketplace
```

```bash
copilot plugin update strucmed@strucmed-marketplace
```

#### 其他本機 MCP client

```bash
git -C ~/strucmed-plugin pull
```

更新後在 client 重新載入 MCP（或重新啟動 client）。MCP 設定裡的路徑不用改。

### 第一次使用

安裝好之後，在任何一個工具都可以這樣開始：

1. **連線與登入**：輸入下表的「連線」，或直接說「幫我連線 strucmed」。系統瀏覽器會開啟 strucmed 站台的登入頁：確認網址是 strucmed 站台後輸入 HIS 帳號密碼、填科部代碼，按「登入並同意」，回到 AI 工具即可（瀏覽器沒有自動開啟時，對話中會顯示網址）。
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
3. 缺的資訊（分數放哪裡、要不要設捷徑與作業別）一次問我。
4. 草案直接建成 draft，把 runtime 預覽連結給我；我在預覽頁填值、看計算結果與 HIS 文字輸出、留意見，你照意見修改。
5. 我按定稿後，把驗證結果、字典與上架設定一次給我核准，上架到我的個人資料夾（usr），由我在瀏覽器確認頁按「確認寫入」；完成後取回範本，核對名稱與控制項數。
```

**怎麼開始**：Claude Code 輸入 `/strucmed:strucmed-form`、Codex 輸入 `$strucmed:strucmed-form`，空一格後貼上整段；Antigravity、Copilot CLI 直接貼上整段。

**接下來會發生的事**：

1. 瀏覽器開啟登入頁，你輸入 HIS 帳號密碼、填科部代碼。
2. AI 一次問完缺的資訊，用幾行告訴你草案，直接建好，給你**預覽連結**；點開就能看到表單、實際填值。
3. 你在預覽頁改說明文字、選項與字典補述（新字典的補述 AI 已先填好，你只改不對的地方），看 HIS 文字輸出，留意見，按「送出意見」；回到對話說一聲，AI 改好後請你重新整理。可以來回幾輪。
4. 你按「定稿」後，AI 一次交出**定稿（G2）**：驗證結果、HIS 文字輸出、字典、上架設定。你核准後瀏覽器開「寫入確認頁」，你按「確認寫入」才會上架。

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

token 存在 Claude Code 的安全儲存區，不寫進設定檔或對話。設定後執行 `/reload-plugins`（或開新工作階段）。四個欄位都是選填：`claude plugin configure` 會把沒填的列在 unconfigured，那不是待辦；留空時預覽依序找工作目錄下的 `strucmed/web`、`repo/strucmed/web`，再找上一層的 `strucmed/web`；線上用內建的院外站台。從 2.x 升級：舊的「院內 HIS 帳號／密碼」欄位已移除，不需處理。

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
| `STRUCMED_FLAGS` | 自己的功能開關 JSON 檔路徑（例如開 `formScript`；不設則用 plugin 內的 `feature-flags.json`） |

例如在專案資料夾啟動 Codex（PowerShell）：

```powershell
$env:STRUCMED_WORKSPACE = (Get-Location).Path; codex
```

#### 網頁預覽（選用）

用 HIS 端 runtime 在本機離線呈現表單，可以實際填值、看計算式結果；不連線、不存檔。需要 StrucMed 平台原始碼裡 `web/` 的本機副本（有 `TempHtml.html` 的那個資料夾）；plugin 不附這份檔案，沒有副本時只能用文字版的 `form_preview`（tree／markdown）。Claude Code 的 `verify-runtime` skill 會自動做以下步驟；其他工具：

1. 讓 MCP 找得到副本：設定 `STRUCMED_RUNTIME_WEB`（Claude Code 在選填設定填「平台 `web/` 副本」）；以 Antigravity plugin 安裝時不能加環境變數，把副本放在（或連結到）`~/Documents/StrucMed/repo/strucmed/web`。

   編輯器「匯出」的 `.htm` 不能當副本：它只是 `TempHtml.html` 的外殼加上 `<base href="站台網址">`，引擎本身（`js/TempHtml.js`）與 jQuery、Bootstrap 等約 30 個檔案都在開啟時向站台載入；預覽伺服器為了不連外會封鎖這些請求，表單不會執行。
2. 請 agent 對 draft 呼叫 `form_preview`（`format: "html"`），回傳的 `runtime_available` 應為 `true`。
3. 請 agent 在終端機執行（環境變數寫在指令前面）：

   ```bash
   STRUCMED_WORKSPACE="<工作目錄>" STRUCMED_RUNTIME_WEB="<平台 web/ 副本>" node "<plugin 資料夾>/scripts/preview.mjs" <draft_id>
   ```

   它會在背景啟動只聽本機的預覽伺服器（預設 127.0.0.1:8765，被舊版占用時自動改下一個埠），並印出實際的預覽連結。
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
4. 拿掉 `STRUCMED_SITE=offline`（啟用線上 tool）時，在 `~/.gemini/config/hooks.json` 加上 G2 定稿 hook：

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

MCP tool 在 hook 裡一律是 `call_mcp_tool`，伺服器與 tool 名稱在 `toolCall.args.ServerName`／`ToolName`、參數在 `toolCall.args.Arguments`。stdout 回 `{"decision":"deny","reason":…}` 擋下、回 `ask` 照原本的核准流程；回 `allow` 也不會略過核准框。hook 的 cwd 是 `hooks.json` 所在目錄，IDE 未開資料夾時 `workspacePaths` 是空陣列；被擋下的呼叫仍會觸發 `PostToolUse`，且 `error` 是空字串（所以 workflow-log 尚未移植）。G2 定稿的檢查本身在 `hooks/gate-check.js`，Claude 版與 Antigravity 版共用。各工具的實測紀錄見 [CHANGELOG.md](CHANGELOG.md)。

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
| `/strucmed:strucmed-form` | **入口**：確認環境、判定意圖、分流到下列流程 | `<表單需求>`，或 `改版 <檔案或範本ID>`、`預覽 <draft_id>`、`調校 <draft_id> <itemid>`、`上架 <draft_id>`、`app <範本ID>` |
| `/strucmed:connect-strucmed` | 檢查並建立與 strucmed API v2、LlmGateway、FMapi 的連線 | — |
| `/strucmed:create-form` | 設計新表單：需求 → 草案直接建 draft → 預覽頁審閱 → 定稿（G2）→ 上架或輸出 | `<表單目的與臨床情境>` |
| `/strucmed:edit-form` | 以既有 `.htm`／`.json`／線上範本為範本改版，原結構原封保留 | `<來源> <要改什麼>` |
| `/strucmed:verify-runtime` | 以 HIS 端 runtime 的本機離線副本開 draft 的預覽頁：給可點的連結與 HIS 文字輸出，你在頁面上填值、看計算結果、留意見；有巨集時實跑一次，截圖只在你要求時做 | `<draft_id>` |
| `/strucmed:tune-prompt` | 調校單一 LLM 按鈕的提示詞：依 PromptPatterns 改寫、formula_check、選用去識別化樣本試跑比較模型，再寫回 draft | `<draft_id> <itemid> [模型別名]` |
| `/strucmed:dictionary-assist` | 欄位字典助手：為欄位、計算式、巨集、LLM prompt 找合適的字典並給引用方式；為新字典寫完整補述（表單功能、使用情境、交換引用）；解析既有表單、補齊它用到的字典補述 | `find <draft_id> <itemid>`／`csv <draft_id>`／`annotate <template_id\|.htm\|draft_id>` |
| `/strucmed:publish-form` | 定稿 G2 的執行段：經 API v2 上架（新建或 If-Match 更新），字典先建後綁；create-form、edit-form 內嵌，也可單獨對既有 draft 使用；線上未設定時改走 `.htm` 匯入 | `<draft_id> [--folder usr\|sub\|dpt] [--update <templateID>]` |
| `/strucmed:build-form-app` | B1 執行條件檢核清單；B2 表單 APP 產生（G4；H0 本機 Docker／H1 既有 struNote／H2 站台 `/apps/`） | `<範本 ID> [b1\|b2]` |
| `/strucmed:report-issue` | 收集 workflow-log、版本與遮蔽後的錯誤，產生 issue 草稿（由你自己送出） | `[一句話描述問題]` |

Agents（headless，由 skill 以 Task 啟動，不直接給使用者用）：`form-planner`（唯讀，產表單草案）、`form-builder`（單一、依序建置 draft）、`form-reviewer`（草案 ↔ draft 對照、自出試算例、白名單、AI 資料流、疑似個資）、`app-builder`（執行 scaffold 與靜態檢查）、`dictionary-annotator`（唯讀，為一張表單用到的字典起草補述；dictionary-assist 模式 3 超過 5 本時啟動）。共同規則在 [AGENTS.md](AGENTS.md)。

## 流程與核准閘門

3.9.0 起是「先建再看」：draft 是本機檔，建錯可以重建，不動線上，所以你看著表單改，只在寫入線上或輸出前核准一次。

```
需求（一次問完）→ 草案直接建成 draft → 預覽頁審閱迴圈（你看著表單改、留意見）→ 定稿 G2（驗證＋字典＋上架一次核准）→ 上架或輸出 → 交付
```

| 階段 | 對話中出現什麼 |
|---|---|
| 需求 | 一次提問 |
| 草案 | ≤ 15 行的摘要＋預覽連結；不停下來核准 |
| 審閱迴圈 | 每輪 ≤ 5 行；意見在預覽頁留，存在 `.strucmed/review/` |
| 定稿 G2 | 一次呈現＋一次核准 |
| 交付 | ≤ 15 行 |

審查報告、結構 tree、對照表、截圖、字典補述都不貼回對話。字典補述與 FHIR 集中在一份 CSV（`dictionary_plan_export`），用 Excel 改完匯回。

| 閘門 | 計畫檔標題 | 核准後才會 |
|---|---|---|
| G2 | `## 定稿` | 依序寫入字典、補述、範本（`online_template_create`／`update` 第二段；範本與新字典只在這裡寫線上；hook 會檢查核准 sidecar，MCP 再開瀏覽器確認頁由使用者按「確認寫入」）；離線時輸出 `.htm` |
| G4 | `## 應用程式計畫` | 產生 B2 app 目錄 |

**表單樣式與 JS 片段（3.10.0）**：
- 欄位的顏色、字級、底色：直接用 `form_update_control` 的 `font_color`／`font_size`／`back_color`，不用開任何開關（編輯器屬性面板也看得到、可再調）。
- 區塊底色、表格格線、整張主題，以及「值不合理立即提示」「輸入後自動帶出分類或判讀」「必填離開即提醒」：要開 flag `formScript`。開啟後多出 `form_set_script`／`form_script_preview` 兩個工具，只接受 `style`（固定主題＋受限規則）、`guard`（條件提示）、`derive`（連動寫進可編輯欄位）、`lookup`（固定對照表判讀；巨集可用 `CUSTOMFUNC("sm_<name>")` 呼叫）、`required`（必填離開即提醒）五種樣板，不接受自由 JS 或 CSS。
- 「開文件時自動跑巨集」「動態表格預設幾列並預填」：另開 `formScriptAdvanced`（`autorun`、`table-rows`）。AI／查詢步驟會在開文件時自動送出，預覽頁會實跑給你看送出了什麼。
- 怎麼開：本機資料夾安裝（開發者）改 plugin 根目錄的 `feature-flags.json`；市集安裝時改快取目錄的同一個檔（Claude Code 在 `~/.claude/plugins/cache/strucmed-marketplace/strucmed/<版本>/feature-flags.json`，更新版本後要再改一次），或在啟動工具的 shell 設 `STRUCMED_FLAGS` 指向自己的 JSON 檔（內容例如 `{ "formScript": true }`）。改完開新工作階段。
- 渲染後的程式碼會原樣列在定稿 G2 與匯入說明給你審閱；片段只在 2.0 runtime 執行，不影響 HIS 文字輸出與倉儲；樣式會影響列印版面。規則見 [references/ScriptAddonRules.md](references/ScriptAddonRules.md)。

**嵌入頁面（3.11.0，flag `embedArea` 預設開）**：
- 表單內嵌入院內網頁（`form_add_area` type `embed`：`url`、`params`、`height`、`inputs`、`outputs`）與按鈕開頁面的巨集 `OPENPANEL(url, title)`。網址只接受 https＋院內主機（`*.cgmh.org.tw`、`*.cgmf.org.tw`、`*.cgmh.me`、10/8、172.16/12、192.168/16、localhost），參數只能是病歷號、科別、使用者、門診序號的占位符或常數，不寫自訂 JS。規則與站台編輯器相同（`E_EMBED_*`），交付時列 `W_EMBED_DATAFLOW`（主機、參數、寫回欄位）。
- 已在站台編輯器實測（2026-11-08）：plugin 產生的嵌入頁面匯入、存檔、重開、「重新編號」都完整保留，送出與寫回欄位跟著欄位走。不需要時把 `feature-flags.json` 的 `embedArea` 改成 `false`。改版既有表單時原表單的嵌入頁面一律原樣保留並檢查。
- **「加載表單」**：站台編輯器需含平台 PR 188（2026-11-08 起部署的院內站台已含）。含嵌入頁面的表單附加到另一張表單時，`inputs`／`outputs` 與計算式會跟著欄位位移，實測對應正確（試點範本附加到有 4 個欄位的原表單：`inputs` 位移 +4、計算式 `A4 * 2` 變 `A8 * 2`）。manifest 不再附避開加載表單的提醒；更早的站台編輯器只位移嵌入頁面的對應、不位移文字區塊的欄位編號，對應會指到錯的欄位而且存檔不報錯，仍在那種站台上的使用者要避開，或改用 edit-form 在 plugin 內合併。規則見 [references/FormDesignRules.md](references/FormDesignRules.md)〈嵌入頁面〉、[references/MacroRecipes.md](references/MacroRecipes.md) R10。
- **站台與 HIS 需求**：站台的編輯器與 runtime 都要含嵌入頁面功能（院內站台 2026-11-08 起已部署）；plugin 不檢查站台版本，上架前請確認。舊版站台的編輯器遇到嵌入頁面區塊會弄壞範本，存檔後區塊消失。HIS 端的 iframe 與 OPENPANEL 浮動面板在現有 StrucForm 可用；導向白名單（1.10.7 起）會擋嵌入頁主機，1.10.9 起預設放行院內範圍並提供子面板與 `NAV-DENIED`，1.10.7、1.10.8 的白名單只認設定主機、會擋掉院內頁面。
- **嵌入頁本身不在 plugin 範圍**：embed 區塊只宣告網址與欄位對應，嵌入頁由第三方開發。開發條件（`frame-ancestors`、postMessage 契約、L1 身分、測試方法、常見症狀）見平台的 B1 嵌入頁 APP 開發說明 `docs/EMBED-APP-GUIDE.md` §3～§10，最小範例 `docs/examples/embed-app-l1.html`。嵌入頁拿到的使用者與科別是 L1（工作站自稱、沒有簽章），只能用在顯示與稽核；開立、簽核這類不可逆動作要等 L2 token（尚未提供），表單設計時不要把這類動作設計成在嵌入頁內完成。
- **常見錯誤碼**（`form_add_area`、`form_update_area`、`form_validate`；與站台編輯器同一套，以 303 個案例逐項比對相同）：

  | 碼 | 原因 | 怎麼改 |
  |---|---|---|
  | `E_EMBED_SCHEME` | 不是 https | 改 https；嵌入頁主機要有工作站信任的憑證 |
  | `E_EMBED_HOST` | 主機不在院內範圍 | 不要猜主機，請使用者提供院內網址 |
  | `E_EMBED_URL` | 網址格式錯誤、含帳密；`OPENPANEL` 的網址不是字串字面值 | 完整 https 網址，不含帳密 |
  | `E_EMBED_PII` | 參數名稱像身分證號或姓名（`idno`、`pid`、`name`、`ptname`、`username`…）、值像身分證號、網址內有 `{…}`、占位符不在允許清單 | 參數只用 `{chtno}`、`{deptNo}`、`{user}`、`{opdno}` 或常數，占位符只放 `params`；病歷號建議改走 `strucmed.context` |
  | `E_EMBED_HEIGHT`、`E_EMBED_FILL` | 高度不是 `"fill"` 或 100～4000；一張表單超過一個 `fill` | |
  | `E_EMBED_INPUT` | `inputs` 的欄位不存在或沒勾「參與計算」 | `form_update_control` 設 `tocalc: true` |
  | `E_EMBED_OUTPUT_MISSING`、`_EMBED`、`_GROUP`、`_DUP` | `outputs` 欄位不存在、指向嵌入頁面、在彈出片語或群組內、與別的嵌入頁面重疊 | 寫回欄位常在區塊之後才建，建好後 `form_update_area` 補 `outputs` |
  | `E_EMBED_MAP` | `inputs`／`outputs` 的 key 不是英數字、`_`、`-`，或值不是欄位 ID | |
  | `E_REF_BROKEN` | 要刪的欄位被嵌入頁面參照 | 先 `form_update_area` 改 `inputs`／`outputs` |

- **被擋時的症狀**（交付時轉告使用者）：iframe 灰底哭臉＝嵌入頁主機的 `frame-ancestors`、`X-Frame-Options` 或連線問題，表單**不會**提示（目前的 runtime 偵測不到）；iframe 空白並提示「未在 StrucForm 導向白名單」＝HIS 的導向白名單。

需求這樣描述就會用到（flag 開啟時）：

```text
幫我做一張「營養評估單」：身高體重算 BMI，BMI 分類自動寫進「分類」欄位（27 以上肥胖、24 以上過重、其他正常）；
體重超過 300 就立刻提示；評估者沒填就提醒；藥名輸入 Aspirin／Metformin 時自動帶出藥物分類；測量區塊淡黃底、表格要格線。
```

G1、G3 編號已停用（舊文件與 CHANGELOG 裡的 G1～G3 指 3.8.0 以前的流程）。定稿檔與核准 sidecar 放在工作目錄的 `.strucmed/plans/<draft_id>/`，`scripts/verify-plan.mjs` 以 sha256 比對；一改，核准就失效。格式見 [references/Gates.md](references/Gates.md)。

## 案例：MMSE／CDR 語音訪談表單

![操作步驟表格](docs/images/case-mmse-cdr/10_form_steps_blank.png)

用一段話描述需求，plugin 一路做到上架：提問卡逐題提示 → 一鍵錄音轉文字 → AI 整理證據、逐題給分（不確定就留給人）→ 總分、切點、CDR 總評由計算式完成，醫師最後確認。

| 階段 | 這個案例學到的 |
|---|---|
| 需求訪談 | 一次問完：分數放哪裡（動態表格不回倉儲）、科部、語音服務、測試或上架 |
| 表單計畫（3.8.0 的 G1） | 前後 4 版；按鈕 `action_id` 不能指向 numberbox |
| runtime 驗證（3.8.0 的 G2） | 語法全過，實跑仍抓到 4 個平台計算差異（`COUNT` 算空白、`SMALL` 出錯、`LEFT` 數字、`0 = ""`） |
| 提示詞優化 | 兩段式、規則寫進 prompt、輸出鎖死、回覆驗證；M2 因「無法核對」被判 NA 的修正 |
| 院內版 | 只用 `VOICETOTEXT`＋`LLMQUERY`，巨集全部自動產生，資料不出院 |

完整過程與截圖：[案例：與 AI 共編 MMSE／CDR 表單](docs/case-mmse-cdr.md)。

想自己試一次：見「安裝」→「第一次使用」裡的〈範例：一段 prompt 做出 MMSE／CDR 語音訪談表單〉，貼一段話就能從登入、規劃一路做到上架。

## MCP 伺服器

`plugin.json` 以 `${CLAUDE_PLUGIN_ROOT}/mcp/strucmed-mcp/src/server.mjs` 註冊 `strucmed`（stdio，Node 20，零相依），tool 名稱為 `mcp__plugin_strucmed_strucmed__<tool>`。

- **離線（一律可用）**：`form_create`／`form_import`／`form_search`／`form_delete`／`form_update_meta`／`form_add_area`／`form_update_area`／`form_remove_area`／`form_add_control`／`form_update_control`／`form_move_control`／`form_remove_control`／`form_fields`／`form_validate`／`form_preview`／`form_review_read`／`form_export`、`dictionary_load`／`search`／`suggest`／`memo_check`／`create`／`plan_export`／`plan_import`、`formula_check`，共 25 個；flag `formScript` 開啟時另有 `form_set_script`／`form_script_preview`（表單 JS 白名單片段）。
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

寫入線上的 tool（`online_template_create`／`update`、`online_dictionary_*`、`online_me_notes_set`）平常建議**不要**預先允許，讓閘門與提示都留著。

用 Claude Code 的 **auto mode** 時，權限分類器可能把上架的第一次呼叫（只產生計畫，不寫入）當成修改共用資源擋下。被擋下時在提示中允許即可；想先排除，可以只加這幾個：

```jsonc
{
  "permissions": {
    "allow": [
      "mcp__plugin_strucmed_strucmed__online_dictionary_batch",
      "mcp__plugin_strucmed_strucmed__online_dictionary_memo_batch",
      "mcp__plugin_strucmed_strucmed__online_template_create",
      "mcp__plugin_strucmed_strucmed__online_template_update"
    ]
  }
}
```

這只略過 Claude Code 的權限提示。第二次呼叫仍要有 G2 核准（hook 檢查 sidecar），並由你在瀏覽器確認頁按「確認寫入」才會寫入。

## Repo 結構

```text
strucmed-plugin/
├── .claude-plugin/
│   ├── plugin.json          # plugin 定義：userConfig（憑證欄位）、MCP 註冊
│   └── marketplace.json     # 市集定義（source 指向 repo 本身）
├── .codex-plugin/plugin.json # Codex 版 manifest
├── plugin.json、mcp_config.json、hooks.json、rules/AGENTS.md  # Antigravity 版 plugin（3.5.0 起）
├── AGENTS.md                # 所有 agent 與 skill 的共同規則
├── feature-flags.json       # 功能開關（online／llmgateway／fmapi 自動；templateUpdate 開；dictionaryWrite 開）
├── skills/                  # 10 個 skill（見上表）
├── agents/                  # form-planner、form-builder、form-reviewer、app-builder、dictionary-annotator
├── references/              # 設計規則、計算式與巨集、提示詞樣板、巨集工作流配方、表格頁籤規則與版面樣板、閘門、上架與 APP 流程、模型白名單、安全不變量
├── hooks/                   # UserPromptSubmit 安全提醒、PreToolUse 核准檢查、PostToolUse workflow-log；antigravity/＝Antigravity 版 G2 定稿
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
| [案例：MMSE／CDR 表單](docs/case-mmse-cdr.md) | 從安裝、需求訪談、閘門（3.8.0 的 G1～G3 流程）、runtime 驗證到提示詞優化的完整案例與截圖 |
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
