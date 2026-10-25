# 變更紀錄

strucmed plugin（`.claude-plugin/plugin.json`）與 MCP 伺服器（`mcp/strucmed-mcp`）的版本紀錄，新的在前。
「發佈」指以 `tools/release/release-plugin.mjs` 產生並推送到 `kunjulin/strucmed-plugin`（同仁安裝用的市集）。平台端的對應變更記在 `kunjulin/strucmed` 的 `docs/CHANGELOG.md`。

同仁更新：

```bash
claude plugin marketplace update strucmed-marketplace
claude plugin update strucmed@strucmed-marketplace
```

更新後開新工作階段。

---

## 3.0.0（MCP 2.0.0）— 2026-10-25：瀏覽器登入（未發佈）

docs/13 第 2 期的 MCP 端。HIS 密碼改在 strucmed 站台的登入頁輸入，plugin 與 AI 工具都拿不到。**需先部署平台 kunjulin/strucmed#127（含 `api/v2/auth/authorize`）再發佈**，否則無法登入。

- **`online_login` 改走瀏覽器**：OAuth 2.0 授權碼 + PKCE（S256），在 `127.0.0.1` 隨機 port 等待回呼，以系統瀏覽器開啟站台登入頁（不經 shell）。
  - 最多等約 2 分鐘。還沒完成時回 `pending` 與 `authorize_url`，再呼叫一次會接著等同一個登入。
  - 已登入時直接回目前狀態。
  - `state` 不符的回呼一律忽略；使用者在登入頁按「拒絕」時回 `E_AUTH`。
- **token**：只存在 MCP 記憶體。access token 30 分鐘，過期時以 refresh token 換新，站台每次都會輪替 refresh token；同一次登入最長 8 小時。`online_logout` 與 MCP 結束時呼叫 `auth/revoke` 作廢登入。
- **移除帳密**：`/plugin configure` 的「院內 HIS 帳號／密碼」欄位，以及環境變數 `STRUCMED_USER`、`STRUCMED_PASS` 都已移除。密碼錯誤後要重新設定的流程不再需要；HIS 密碼變更後，直接在登入頁輸入新密碼。
- **站台偵測**：不再以「有沒有帳密」決定是否連線；啟動時一律探測 `api/health`（不帶憑證），`STRUCMED_SITE=offline` 可完全不連線。
- **多工具**：Copilot CLI 與 Codex 不需要 `userConfig` 也能登入線上（未實測）。Codex 沒有 hooks，上架仍建議回 Claude Code，直到 G3 關卡移進 MCP。
- **hooks**：`auth-reminder` 改為在登入未完成時提示使用者到瀏覽器完成，不再提示重新設定密碼；`prompt-reminder` 同步修改。
- **新增環境變數**：`STRUCMED_NO_BROWSER=1`（不自動開啟瀏覽器）、`STRUCMED_LOGIN_WAIT_MS`。
- **文件**：README 與公開版 README、MCP README、docs/11、docs/13、SecurityInvariants 第 1 條、connect-strucmed skill。
- **測試**：新增 `test/fake-login.mjs`（假登入頁立即導回）。`online.test.mjs` 與 `site.test.mjs` 改為瀏覽器登入，涵蓋：
  - 授權請求參數（S256、本機回呼）
  - 授權碼兌換的請求內容
  - 偽造的 `state` 會被忽略
  - 在登入頁按「拒絕」
  - 登出時 revoke
  - 不需帳密也能偵測站台

  共 87 項：86 過、1 略過。

## 2.6.0（MCP 1.10.0）— 2026-10-25：移除病人紀錄 tool

strucmed-skill#35；發佈：strucmed-plugin `e4ea991`。

- 平台權限白名單（kunjulin/strucmed#124）上線後，`strucmed-mcp` 的 token 呼叫病人紀錄 API 一律 403，所以移除 `online_records_query`、`online_records_save`。伺服器指示改為「沒有查詢或存檔病人紀錄的 tool，請在編輯器或 HIS 操作」。
- hooks：`log-write` 的 matcher 去掉 `records_save`；`prompt-reminder` 改為說明 plugin 不提供病人資料。
- 文件：docs/11、MCP README、README、SecurityInvariants 第 2、3 條、docs/13。
- 發佈時：掃描無發現；`npm test` 87 過、1 略過；`claude plugin validate --strict` 通過。

## 2.5.0（MCP 1.9.0）— 2026-10-25：多工具支援、`online_login` 帶 `clientId`

strucmed-skill#32；發佈：strucmed-plugin `84a457b`。

- **權限白名單**：`online_login` 一律帶 `clientId: "strucmed-mcp"`。配合平台 kunjulin/strucmed#124，token 只能使用範本、字典與自己的 struNote 清單。
- **多工具**：README 新增「支援的工具」表（Claude Code 完整；Copilot CLI、Codex 實驗性；其他 MCP client 只有 tool；ChatGPT 不支援），並附各工具的安裝步驟。
- **Copilot CLI 相容**：
  - hooks 以 `PLUGIN_ROOT`／`CLAUDE_PLUGIN_ROOT` 定位腳本，matcher 涵蓋兩邊的 tool 命名，也支援 Copilot 的回應格式。
  - MCP 的 cwd 是 plugin 根目錄時，改用 `PWD` 當工作區；未展開的 `${…}` 視為未設定。
- **docs/13**：MCP 瀏覽器登入與院外 MFA 設計（草案）。
- 發佈時：掃描無發現；`npm test` 89 過、1 略過；`claude plugin validate --strict` 通過。

## 更早的版本

| 版本 | 日期 | 內容 |
|---|---|---|
| 2.4.0 | 2026-10-23 | 發佈流程 `tools/release/`，第一次發佈到 strucmed-plugin（#34，strucmed-plugin `6703dc6`） |
| 2.3.0（MCP 1.8.0） | 2026-10-23 | 站台自動判斷院內／院外；plugin 設定只需 HIS 帳密；密碼錯誤時提示重新設定（#31） |
| 2.2.1（MCP 1.7.1） | 2026-10-23 | 版面樣板 LayoutPatterns、reviewer L1～L10 版面檢查（#29） |
| 2.2.0（MCP 1.7.0） | 2026-10-23 | 提示詞樣板、巨集工作流配方、prompt lint 與 tune-prompt skill（#28） |
| 2.1.0（MCP 1.6.0） | 2026-10-22 | 憑證改由 `/plugin configure` 填寫（`userConfig`）（#23） |
| 2.0.0（MCP 1.6.0） | 2026-10-22 | plugin 化完成：Phase 1～5（skills、agents、閘門 G1～G4、經 API 上架、LlmGateway、表單 APP 產生器、安全提醒 hook）（#21） |

2.0.0 之前是 plugin 化以前的開發階段（v0.1→v1、P0～P3e），不另列。
