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

## 3.6.0（MCP 2.4.0）— 2026-10-26：字典 JSON 說明、補述、FHIR 對應與體系升級

尚未發佈。平台端（`strucmed` 的 `DictComment`、comment／memo／promote／demote／alias 端點、`dictSystem` 權限、字典頁與編輯器 UI）另行合併與部署；**平台上線前不要發佈**。步驟 0（`tools/v0-harness/dict-json-test.mjs`）已於 2026-10-26 在正式倉儲完成。發佈時：未發佈；`npm test` 128 過、1 個略過。

- **字典說明是 JSON 容器**：新增 `dictcomment.mjs`，與平台同一份規格（`{"v":1,"desc":…,"sys":…,"memo":…,"fhir":[…],"alias_of":…}`，壓縮、`v`／`desc` 在最前面、鍵順序固定、空段省略、整段 ≤ 1800 字）。舊純文字字典整段視為 desc；只有 desc 時維持純文字。
- **新建字典一次寫好說明與補述**：`form_add_control`／`form_update_control` 的 `dictionary.comment`／`dictionary.memo`、`dictionary_create` 的 `comment`／`memo`；`online_dictionary_create`／`batch` 與 `form_export` 的套件用同一個 builder 組 dicComment。沒有說明時回 `W_DICT_NO_DESC`。
- **綁定優先體系字典**：`resolve` 依層級 體系 → 本科 → 次專 → 科部；不同層級同名時綁體系那本（`W_DICT_PREFER_SYSTEM`），只有同一層級同名才 `E_DICT_AMBIGUOUS`；`alias_of` 自動改綁目標（`W_DICT_ALIAS`）。綁到沒有 memo 或科部層級的字典時回 `W_DICT_NO_MEMO`／`W_DICT_DEPT_LEVEL`。
- **搜尋**：`online_dictionary_search`、`dictionary_search` 每筆帶 `level`、`desc`、`sys`、`memo`、`fhir`、`alias_of`、`etag`，體系優先排序，fuzzy 也搜 desc 與 memo。站台未升級時回 `W_SERVER_OLD`，由本機解析。離線 CSV 中 JSON 被逗號斷欄時回 `W_DICT_CSV_JSON_BROKEN`。
- **新工具**：`online_dictionary_memo_set`（補述與 FHIR 對應，If-Match，兩段式＋瀏覽器確認；memo 補充合併；本機先做 FHIR 格式檢查 `E_INVALID_FHIR`／`W_FHIR_TYPE_MISMATCH`；線上已被修改回 `E_CONFLICT` 附目前內容）。
- **體系標記 `sys: { code, by, at }`，升級不改 id**：體系字典管理者在字典頁一鍵升級（寫入標記）或降回科部（移除標記），id 與 dicType 都不變。`level(dicType, deptNo, sysCode)`：帶標記且 `code` 等於登入者體系代碼（deptNo 第 2–3 碼）時是 sys；比對範圍與綁定（`resolve`、`search`）納入同體系他科帶標記的字典，並優先綁定。`memo_set` 寫入時保留標記。**MCP 沒有升級工具**：AI 只在 G1「### 體系升級建議」提出，交付時轉給管理者。開發中曾有的 `online_dictionary_promote_request`、`online_dictionary_promotions` 已移除；舊的 `promote` 段落讀取時保留。
- **依正式倉儲實測（步驟 0）**：倉儲不允許同 id 改 dicType，所以升級改為在說明寫入體系標記（見上）；體系內已有同名字典時由管理者設為別名（`alias_of`）；倉儲是 Oracle Big5／CP950：emoji 被存成「？」，上標「²」被換掉還吃掉後面的字元讓整段 JSON 損毀。新增 `cp950.mjs`（與平台 `DictComment.IsStorable` 同一條規則，共 13,622 字），`dictcomment.checkStorable` 在字典名稱、說明、補述、FHIR 只允許這些字，訊息指出字元、碼位與位置；平台另做寫入後讀回比對。中文 1800 字完整保留，上限維持 1800。
- **flag `dictionaryWrite` 預設改為開**。
- **G3 hook**：涵蓋補述；帶 `draft_id` 時檢查該 draft 的上架計畫核准，單獨使用時交給瀏覽器確認頁。
- **form_validate.stats**：新增 `dict_missing_memo`、`dict_dept_level`。
- **skill 與 agent**：`FormDesignRules.md` 新增〈字典說明、補述與層級〉；`Gates.md` §2 結構表加層級、「待新建字典」加說明與補述欄、新增「### 字典補述」（含 FHIR 與驗證狀態）與「### 體系升級建議」；form-planner／builder／reviewer、publish-form（寫入順序：字典 → 補述 → 範本；體系升級建議交給管理者）、create-form（字典來源以線上為主）、edit-form（建議改綁體系字典、同步 memo）、tune-prompt（欄位描述以 memo 為依據）。
- **測試**：`unit.test.mjs`（JSON 格式、舊文字相容、FHIR 檢查、層級、體系標記與綁定、alias、CSV 斷欄、套件說明）、`online.test.mjs`（假伺服器加字典 JSON、memo 端點與帶標記的他科字典；flag 預設開；沒有升級工具）、`gate.test.mjs`（補述的閘門）。

### 試用回饋修正（M9R，3.5.0 試用 2026-10-26）

- **update 不再改名或下架**（高）：`online_template_update` 的名稱、捷徑、作業別、Info 預設沿用線上值，只有 draft 明確修改過的欄位（`form_import` 參數、`form_update_meta`）才覆寫；plan 新增 `meta`（線上／draft／寫入值並列），`W_META_RENAME`、`W_UNPUBLISH`（會從 HIS 清單消失）、`W_META_CHANGED`、`W_META_KEPT_ONLINE`。第二次呼叫重讀線上：ETag 不同 → `E_CONFLICT`（不開確認頁）；名稱等在取得計畫後被改 → `E_CONFIRM_MISMATCH`。
- **`form_import(for_update:true)`**（高，#7）：要更新同一張範本時名稱可省略或與原表單相同，捷徑／作業別／Info 沿用來源；來源沒有 templateID 時拒絕。
- **update 的差異看得到內容**（高）：新增 `formdiff.mjs`，plan.diff 逐項比對控制項、區塊版面與說明文字、表單 JS、iot（排除編輯器與伺服器每次改寫的欄位），回 `changed_itemids`、`changed_areas`、`js_changed`、`iot_changed`、`summary`；來源是線上套件時另比對 `online_since_source`，線上自來源後被改過回 `W_ONLINE_CHANGED_SINCE_SOURCE`（更新會蓋掉）；完全沒變回 `W_NO_CHANGE`。寫入確認頁把警告、meta、diff 排在前面。
- **update 保留 iot ID**（#9）：PUT 本文的 iot `templateID`／`sheetid` 帶線上 ID、`d_url` 沿用來源，不依賴伺服器補回。
- **區塊標題不顯示**（中，#3）：`form_add_area` 說明寫明 title 不會出現在 HIS 表單；新增 `visible_title`（在文字區塊第一行插入可見標題）；`form_validate` 新增 `W_AREA_NO_VISIBLE_HEADING`；form-planner、form-builder、`LayoutPatterns.md` 同步。
- **`online_template_get(save:true)` 只回摘要**（中，#5）：名稱、捷徑、作業別、rev、區塊與控制項數、JS 字數、存檔路徑；`include_package:true` 才回整包；不存檔且超過 5 萬字元時回 `W_LARGE_RESPONSE`。
- **runtime 預覽**（中，#4）：實查編輯器匯出的 `.htm` 只是 `TempHtml.html` 外殼加 `<base href=站台>`，引擎（`js/TempHtml.js`）與函式庫都向站台載入，離線預覽會封鎖，不能代替平台 `web/` 副本；README、verify-runtime、`form_preview` 訊息寫明。
- **巨集腳本可先留空**（低，#6）：`form_add_control` 的 action／action2 可不帶 `action_script`，`form_validate` 回 `E_ACTION_EMPTY` 直到補上；form-builder 不再放佔位 `1`。
- **文件與實作一致**（低，#8）：update 允許的來源寫明為「derivedFrom.templateID＝線上 ID」，包含 iot 帶線上 ID 的外部 `.htm`；edit-form、publish-form、`PublishWorkflow.md` 同步。
- **`formula_check` 種類提示**（低，#10）：`kind=prompt` 的內容以 `LLMQUERY(` 開頭時回 `W_KIND_MISMATCH`（請用 `kind=macro`），不再報 `W_LLM_NOT_AWAITED`。
- **`online_me` 科部空白**（低，#11）：回 `W_NO_DEPT`，說明科部取自登入時填的科部代碼（不是由 HIS 帳號推得）與處理方式。
- **小地方**（低，#12）：院外站台的 `W_LLM_WHITELIST_STALE` 標成「院外預期」（`expected: true`）；`report-issue.mjs` 在非 git 目錄不再印 `fatal: not a git repository`；G3 hook 的未核准訊息補「用 AskUserQuestion 取得核准，不要自己標 Approved」。
- **測試**：新增 `trial-feedback.test.mjs`（for_update、formdiff、可見標題、空白巨集、kind 提示）；`online.test.mjs` 加 update 的 meta 沿用／`W_UNPUBLISH`／`W_META_RENAME`／重讀線上、`W_ONLINE_CHANGED_SINCE_SOURCE`、template_get 摘要、`W_NO_DEPT`。

## 3.5.0（MCP 2.3.0）— 2026-10-26：Antigravity plugin

strucmed-skill#55；發佈：strucmed-plugin `ee5bed5`（由 main `19dc40f` 產生）。發佈時：`release-plugin.mjs` ok、196 個檔案、掃描無發現；`npm test` 104 過、1 略過；`claude plugin validate --strict` 未執行（發佈機器沒有 `claude` 指令）；自 GitHub `git clone` 確認根目錄有 `plugin.json`、`mcp_config.json`、`hooks.json`、`rules/AGENTS.md`。MCP 程式不變。

文件更新（版本不變）：strucmed-skill#57 的 README 安裝說明（依工具分節，每個工具都有「用 prompt 安裝」與「自己用指令安裝」）與案例文件的登入說法，另於 strucmed-plugin `f83e0ab`（由 main `5c87f2f` 產生）發佈；`release-plugin.mjs` ok、3 個檔案有變動、掃描無發現；`npm test` 104 過、1 略過。

文件更新（版本不變）：strucmed-skill#59 在 README「第一次使用」加入〈範例：一段 prompt 做出 MMSE／CDR 語音訪談表單〉，另於 strucmed-plugin `baaaceb`（由 main `077f72f` 產生）發佈；`release-plugin.mjs` ok、2 個檔案有變動、掃描無發現；`npm test` 104 過、1 略過。

文件更新（版本不變）：strucmed-skill#61 在 README「安裝」新增〈更新（已經裝過的人）〉（各工具的更新 prompt、指令與確認方式；Antigravity 以前用複製方式安裝時的處理），另於 strucmed-plugin `ce9a2fd`（由 main `f4b6989` 產生）發佈；`release-plugin.mjs` ok、2 個檔案有變動、掃描無發現；`npm test` 104 過、1 略過。

- **Antigravity plugin**：本 repo 根目錄新增 `plugin.json`、`mcp_config.json`、`hooks.json`（Antigravity 格式）、`rules/AGENTS.md`，整個 repo 同時是 Antigravity plugin。安裝：`git clone https://github.com/kunjulin/strucmed-plugin.git ~/.gemini/config/plugins/strucmed`；更新：`git pull`。skills、MCP 與 G3 hook 一起載入。
- **不需要另外安裝 Node.js**：MCP 以 Antigravity 內建的 `agy-node`（Node 24）執行，cwd 是 plugin 資料夾、路徑用相對路徑；hook 以 sh 依序找 `agy-node`、`~/Library/Application Support/Antigravity/bin/agy-node`、`node`，都找不到就阻擋（只支援 macOS／Linux）。
- **規則**：`rules/AGENTS.md` 告訴 Antigravity 的 agent：不得替使用者操作寫入確認頁、`${CLAUDE_PLUGIN_ROOT}` 是 plugin 根目錄、沒有 AskUserQuestion／Task 時改在對話中詢問並依序執行、伺服器名稱是 `strucmed_strucmed`。
- **Antigravity 版 G3 hook**：找不到設定的工作目錄時，改用 MCP 的預設 `~/Documents/StrucMed`（存在才用）；plugin 的 MCP 沒有 `STRUCMED_WORKSPACE`，用的就是這裡。
- **README**：Antigravity 一節改以 plugin 安裝為主，原本的全域 `mcp_config.json` 做法改為「手動設定」；網頁預覽在 plugin 安裝時把平台 `web/` 副本放在 `~/Documents/StrucMed/repo/strucmed/web`。
- **實測**（Antigravity 2.0 app 2.26.0，發佈版內容複製到 `~/.gemini/config/plugins/strucmed`）：Plugins 列出 StrucMed（Skills 9、MCP、Hooks）；MCP 以 `agy-node` 從 plugin 資料夾啟動；`form_search` 成功；未核准的上架計畫下，`online_template_create` 第二次呼叫被 hook 擋下。發現：對話開始時才啟動 MCP，第一次呼叫可能回「not enabled」；伺服器名稱帶 plugin 前綴。
- **測試**：`test/host.test.mjs` 新增 Antigravity manifest 一項（版本同步、相對路徑存在、hook 指令）；`test/gate.test.mjs` 新增預設工作目錄一項。

## 3.4.0（MCP 2.3.0）— 2026-10-26：線上寫入改由瀏覽器確認頁把關

strucmed-skill#53；發佈：strucmed-plugin `4bccc33`（由 main `804d11f` 產生）。發佈時：`release-plugin.mjs` ok、192 個檔案、掃描無發現；`npm test` 102 過、1 略過；`claude plugin validate --strict` 未執行（發佈機器沒有 `claude` 指令）。

原本「核准」靠 AI 遵守流程：對話中問使用者，再由 AI 自己執行 `verify-plan.mjs prepare` 寫核准紀錄，MCP 的 `confirm_token` 也是 AI 第一次呼叫拿到、第二次帶回。Claude Code 有 skill、結構化提問與 hooks 把關；Antigravity 不載入 skill、Turbo 模式下 tool 不跳核准框，Codex 的 hooks 要先信任，都沒有辦法確保「是人按的同意」。

- **瀏覽器寫入確認頁**（新增 `src/approve.mjs`）：`online_template_create`／`update`、`online_dictionary_create`／`batch`、`online_me_notes_set` 的第二次呼叫，在 127.0.0.1 開一頁列出第一次呼叫時的 plan，使用者按「確認寫入」才寫入。做法同 `online_login`：還沒按時回 `pending`（附 `approve_url`），帶同一個 `confirm_token` 再呼叫一次接著等；按取消回 `E_REJECTED`；10 分鐘內未確認、MCP 重啟或確認已用過，都要重新取得計畫。沒有任何略過確認的開關。
- **確認頁的防護**：只聽 127.0.0.1；網址含一次性 nonce；POST 檢查 Host（防 DNS rebinding）與 Origin（防跨站送出）；plan 內容一律跳脫，回應帶 `Content-Security-Policy: default-src 'none'` 與 `X-Frame-Options: DENY`；不載入外部資源。
- **Antigravity 版 G3 hook**：沒有上架計畫檔（或找不到工作目錄）時改回 `ask`，交給確認頁把關；有計畫檔但未核准、核准後被改過或檢查出錯，仍然阻擋。Claude Code／Copilot／Codex 的 hook 不變：skill 流程照舊寫計畫與 sidecar，再加上確認頁。
- **文件**：publish-form、build-form-app、`PublishWorkflow.md`、`SecurityInvariants.md`、MCP README 與 README 的 Antigravity 一節說明確認頁；agent 不得替使用者確認或操作確認頁。
- **測試**：`test/online.test.mjs` 既有寫入測試改為經確認頁；新增確認頁流程（pending、同頁續等、錯 nonce、Host、Origin、確認一次、取消）；新增 `test/approve.test.mjs`（跳脫與 CSP、計畫須先記下且綁動作）；`test/gate.test.mjs` 更新 Antigravity hook 行為。
- **實測（Antigravity 2.0 app 2.26.0，院外站台）**：Turbo 模式下，以 BMI 測試表單（無捷徑、保存不上架）新建到個人資料夾 `usr`。第一次呼叫取得 plan、未寫入；第二次呼叫開出確認頁，使用者按「確認寫入」後同一次呼叫完成（約 25 秒），回 `template_id`、rev 1；`online_template_get` 取回名稱與 3 個控制項（含 BMI 公式）與 draft 一致。Antigravity 版 G3 hook 在沒有計畫檔時回 ask、交給確認頁，未擋下。取回時套件的 `template.rev` 是 0、新建回應是 1，兩者差異未查證。
- **未實測**：Claude Code、Codex 在真實站台經確認頁上架。

## 3.3.2（MCP 2.2.1）— 2026-10-26：formula_check 試算與 HIS runtime 一致

strucmed-skill#51（README 的 Antigravity 2.0 與網頁預覽：#50）；發佈：strucmed-plugin `c42120d`（由 main `d584712` 產生）。發佈時：`release-plugin.mjs` ok、190 個檔案、掃描無發現；`npm test` 99 過、1 略過；`claude plugin validate --strict` 未執行（發佈機器沒有 `claude` 指令）。

Antigravity 2.0 app 實測 BMI 時發現：`formula_check` 試算身高 160、體重 80 得到 31.3（判定符合），HIS runtime 預覽實際顯示 31.2。原因是離線試算的進位先補了浮點誤差（`+1e-9`），Calx 沒有；80 ÷ 1.6² 在瀏覽器裡是 31.249999…。

- **進位函數照 Calx 2.2.8**：`ROUND`＝`Math.round(x×10^n)/10^n`；`ROUNDUP`／`ROUNDDOWN`／`TRUNC` 以絕對值 ceil／floor 再乘回正負號；都不補浮點誤差。因此 `ROUND(-2.5, 0)` 是 -2（原本照 Excel 算 -3）、`ROUND(1.005, 2)` 是 1。
- **`MOD` 照 Calx**：`|a % b|`，正負號跟除數（`MOD(-7, 3)` 是 1，原本照 Excel 算 2）。
- **少了位數**：`ROUND`／`ROUNDUP`／`ROUNDDOWN` 沒寫第二個參數時，Calx 會算出 NaN；試算改回報「少了小數位數參數」，不再當成 0 位。`TRUNC` 仍預設 0 位（Calx 相同）。
- **錯誤訊息**：`E_FORMULA_SAMPLE_MISMATCH` 只差最後一位時，說明是 runtime 的浮點進位、表單會顯示試算值，而不是叫人檢查參照。`Gates.md` 補上同樣的處理方式。
- **驗證**：以 `jquery-calx-2.2.8 min.js` 的函數原文對照 17 組（含負數、.5 邊界、MOD 正負組合）全數相同；BMI 160／80 在 runtime 預覽實測顯示 31.2，與試算一致。`test/formula-explain.test.mjs` 新增 1 項並修正原本照 Excel 寫的 `ROUND(-2.5, 0)`。

## 3.3.1（MCP 2.2.0）— 2026-10-26：Antigravity 版閘門 G3

strucmed-skill#48；發佈：strucmed-plugin `c57cdb3`（由 main `1a8fd0c` 產生）。發佈時：`release-plugin.mjs` ok、190 個檔案、掃描無發現；`npm test` 98 過、1 略過；`claude plugin validate --strict` 未執行（發佈機器沒有 `claude` 指令）。MCP 程式不變。

- **Antigravity 版 G3 hook**：新增 `hooks/antigravity/validate-gate.js`（PreToolUse，matcher `call_mcp_tool`）。從 `toolCall.args.ToolName`／`Arguments` 判斷上架類 tool 的第二段呼叫，沒有核准過的上架計畫就在 stdout 回 `{"decision":"deny"}`；其餘回 `ask`，照 Antigravity 原本的核准流程，不替使用者核准。hook 的 cwd 是 `hooks.json` 所在目錄，工作目錄改從 `STRUCMED_WORKSPACE` 環境變數或 `mcp_config.json` 裡 strucmed 伺服器的 `STRUCMED_WORKSPACE` 取得，都找不到就阻擋。輸入無法解析或檢查出錯一律阻擋。
- **共用檢查**：G3 的核准檢查抽到 `hooks/gate-check.js`，`hooks/validate-gate.js`（Claude Code、Copilot CLI、Codex）與 Antigravity 版共用；Claude 版的行為與輸出不變。
- **實測**：Antigravity IDE 2.5.5，站台指向本機不存在的位址：沒有計畫的 draft 帶 `confirm_token` 呼叫 `online_template_create` 被擋下（「Tool call denied by pre-tool hook」）；已核准的計畫回 `ask`，Antigravity 照常跳出核准框。
- **文件**：README 的 Antigravity 一節加上安裝 hook 的步驟 4；`Gates.md` 的雜湊說明改指 `gate-check.js`。發佈用的 `tools/release/overrides/README.md` 補上 Antigravity 的支援表列與整節（strucmed-skill#47 只改了開發用 README，發佈版沒有）。
- **測試**：新增 `test/gate.test.mjs`（5 項，含與 Antigravity 實際送出內容同形的輸入）。

## 3.3.0（MCP 2.2.0）— 2026-10-26：計算式試算、閘門註解不再顯示

strucmed-skill#45；發佈：strucmed-plugin `27ada5d`（由 main `7302d92` 產生）。發佈時：`release-plugin.mjs` ok、187 個檔案、掃描無發現；`npm test` 93 過、1 略過；`claude plugin validate --strict` 通過。

Codex app 實測（BMI 測試表單）的兩個問題：BMI 公式的身高、體重參照對調，`formula_check` 只檢查語法沒有抓到；閘門的 `<!-- gate: … -->` 在 Codex 顯示成文字。

- **`formula_check` 標籤化公式**：帶 `draft_id` 時多回傳 `labeled`（`A<itemid>` 換成欄位名稱，例如 `ROUND([體重(kg)] / (([身高(cm)] / 100) * ([身高(cm)] / 100)), 1)`）與 `ref_labels`。欄位名稱取控制項前最近的說明文字（固定表格的說明格、動態表格的欄標題；沒有時用字典名稱）。
- **`formula_check` 試算**：`kind: formula` 可帶 `samples: [{ values, expect }]` 實際計算；結果與 `expect` 不符回 `E_FORMULA_SAMPLE_MISMATCH`（error）。新模組 `src/formula-explain.mjs` 以既有的 Calx 詞法分析加上計算，運算子優先順序依 Calx 2.2.8 文法；支援四則、`^`、`%`、比較、`IF`／`AND`／`OR`／`NOT`、`ROUND`／`ROUNDUP`／`ROUNDDOWN`／`TRUNC`／`INT`／`ABS`／`SQRT`／`POWER`／`MOD`、`SUM`／`AVERAGE`／`MIN`／`MAX`（含同欄範圍）、`CONCATENATE`。不支援的函數或寫法回 `reason`（無法離線試算），不猜；不需要 runtime 副本。
- **計畫與審查**：`Gates.md` §2 的「計算式與巨集」表新增「白話（欄位名稱）」與「試算例」欄（planner 依臨床定義手算，有 IF 時每個分支一例）；form-reviewer 以 `samples` 實際計算並對照 `labeled` 與白話，不符列入必須修正；G2 列出每條計算式的欄位名稱版與試算結果；沒有 runtime 時以離線試算為準。
- **閘門註解**：`<!-- gate: … -->` 只寫在計畫檔，對話中不再輸出（`Gates.md` §1、create-form 呈現 G1 時略去該行）。沒有程式讀取這個註解，Claude Code 的行為不變。
- **測試**：新增 `test/formula-explain.test.mjs`（5 項）。

## 3.2.1（MCP 2.1.1）— 2026-10-26：Codex app 工作目錄

strucmed-skill#43；發佈：strucmed-plugin `0911993`（由 main `538dc48` 產生）。發佈時：`release-plugin.mjs` ok、185 個檔案、掃描無發現；`npm test` 88 過、1 略過；`claude plugin validate --strict` 通過。

- **工作目錄不再落在 plugin 快取**：Codex app 實測（Windows）時，草稿與匯出檔寫進了 Codex 的 plugin 快取資料夾，使用者找不到，且更新 plugin 時會被清掉。`store.mjs` 在 cwd 是 plugin 目錄、又沒有可用的 `PWD`（未設定、不存在、就是 plugin 目錄，或是磁碟根目錄）時，改用 `~/Documents/StrucMed`（沒有 Documents 時用 `~/StrucMed`）。`STRUCMED_WORKSPACE` 仍最優先；Claude Code 不受影響。Copilot CLI 在 Windows 也一樣受惠。
- **`form_export` 回傳 `workspace`**：計畫與結果都帶工作目錄的完整路徑，agent 可以直接告訴使用者檔案在哪。
- **文件**：README「支援的工具」改為 Codex（CLI、app），記錄 app 實測結果（安裝、瀏覽器登入、建表單與匯出可用；hooks 需核准；runtime 預覽需 `STRUCMED_RUNTIME_WEB`）。
- **測試**：`host.test.mjs` 的工作目錄測試改為「永遠不是 plugin 目錄」，涵蓋沒有 PWD、PWD 不存在、PWD 是 plugin 目錄、PWD 是磁碟根目錄。

## 3.2.0（MCP 2.1.0）— 2026-10-26：Codex 一行安裝

strucmed-skill#41；發佈：strucmed-plugin `2b1c88a`（由 main `afefc70` 產生）。發佈時：`release-plugin.mjs` ok、185 個檔案、掃描無發現；`npm test` 88 過、1 略過；`claude plugin validate --strict` 通過。

- **Codex manifest**：新增 `.codex-plugin/plugin.json`（skills、hooks、MCP）。Codex CLI 直接讀既有的 `.claude-plugin/marketplace.json`，所以 `codex plugin marketplace add kunjulin/strucmed-plugin` → `codex plugin add strucmed@strucmed-marketplace` 即可安裝，不必再手動連結 skills 與編輯 `config.toml`。
  - Codex 不展開 `${CLAUDE_PLUGIN_ROOT}`：MCP 以 `cwd: "."`（plugin 根目錄）與相對路徑啟動；工作目錄沿用 Copilot 的 `PWD` 機制，Windows PowerShell 需先設 `STRUCMED_WORKSPACE`。
  - `tool_timeout_sec` 180 秒：Codex 預設 60 秒，短於 `online_login` 的 120 秒等待。
  - 只轉傳環境變數名稱（`env_vars`），token 不寫進設定檔。
  - hooks 與 Claude Code 共用 `hooks/hooks.json`（Codex 會設定 `PLUGIN_ROOT`／`CLAUDE_PLUGIN_ROOT`）；需使用者在 `/hooks` 信任後才執行。G3 在 Codex 的阻擋行為尚未實測，上架仍建議回 Claude Code。
- **skills**：用到 `${CLAUDE_PLUGIN_ROOT}` 的 6 個 skill 加註：不展開這個變數的工具改用 `skills/` 的上一層。
- **文件**：README 與公開版 README 的 Codex 段落改為市集安裝；「支援的工具」表更新；docs/13 G3 移進 MCP 的說明同步。
- **測試**：`host.test.mjs` 新增 Codex manifest 檢查（版本與 `.claude-plugin` 一致、路徑在 plugin 根目錄內、不含 `${…}`、逾時大於登入等待）。共 89 項：88 過、1 略過。
- 實測：Codex CLI 0.164.0 以本機資料夾市集安裝成功（`codex plugin list` 3.2.0、`codex mcp get strucmed` 設定正確、`codex debug prompt-input` 列出 9 個 `strucmed:*` skill）；以 Codex 的環境變數啟動 MCP，工作目錄取自 `PWD`。對話中的登入與 hooks 待實機驗收。

## 3.1.0（MCP 2.1.0）— 2026-10-25：院外站台內建

strucmed-skill#37；發佈：strucmed-plugin `b0d54db`（由 main `ff2c0ee` 產生）。發佈時：`release-plugin.mjs` ok、184 個檔案、掃描無發現；`npm test` 87 過、1 略過；`claude plugin validate --strict` 通過。發佈前確認 LVAIW 與 cgmh.ddns.net 兩站的 `api/v2/auth/authorize` 皆存在。

- **院外站台不再需要設定**：`src/site.mjs` 內建 `DEFAULT_EXTERNAL_URL = https://cgmh.ddns.net`（已公開的院外入口；登入仍需 HIS 帳密）。院內連不到時自動改用院外站台，`/plugin configure` 的「院外站台網址」改為覆寫用：留空＝預設、填網址＝覆寫（必須 https）、`none`／`off`／`0`／`false`＝不探測院外。
- **訊息**：`E_ONLINE_DISABLED` 的原因與 `check-env.mjs` 的站台檢查不再說「未設定院外站台網址」，改說「院外站台已停用或網址無效」。
- **發佈掃描**：`tools/release/release.config.json` 移除 `ddns` 禁用字樣；公開版 README（`tools/release/overrides/README.md`）同步寫入預設網址。
- **文件**：README、MCP README、docs/10 §十二、docs/11、connect-strucmed skill。
- **測試**：`site.test.mjs` 改為以 `STRUCMED_EXTERNAL_URL=none` 驗證停用，新增預設值／覆寫／停用的單元測試。
- 與 3.0.0 相同，需先部署含 `api/v2/auth/authorize` 的平台（院內與院外兩站）才能登入。

## 3.0.0（MCP 2.0.0）— 2026-10-25：瀏覽器登入

strucmed-skill#36；發佈：strucmed-plugin `0ebbf6d`（由 main `0b25c26` 產生）。發佈時：`release-plugin.mjs` ok、184 個檔案、掃描無發現；`npm test` 86 過、1 略過；`claude plugin validate --strict` 通過。平台 kunjulin/strucmed#127 已於同日部署 LVAIW 與院外站。

docs/13 第 2 期的 MCP 端。HIS 密碼改在 strucmed 站台的登入頁輸入，plugin 與 AI 工具都拿不到。

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
