# 上架流程（經 strucmed API v2）

> 由 `publish-form` 載入。平台契約為 strucmed API v2 的範本與字典寫入端點；tool 細節見 `mcp/strucmed-mcp/README.md`。

## 1. 前提

| 條件 | 怎麼確認 | 不符時 |
|---|---|---|
| 已登入 | `online_me` 成功 | 載入 `connect-strucmed` |
| draft 驗證無 error | `form_validate.valid` | 回 `create-form`／`edit-form` 修正 |
| 沒有待新建字典 | `form_preview` 或 `form_validate.stats`；`online_template_create` 第一次呼叫回 `E_DICT_PENDING` 時 | §2 字典 |
| 伺服器允許寫入 | `online_template_create` 第二次呼叫回 `E_WRITES_DISABLED` 表示站台尚未開放範本寫入 | 告知使用者請平台負責人處理；改走 `form_export` |
| 資料夾 | `online_me.folders` 的 usr／sub／dpt | `sys` 不提供（需管理者） |
| 更新既有範本 | flag `templateUpdate` 開，且 draft 的來源就是該範本（`derivedFrom.templateID`＝線上 ID）：`online_template_get(save:true)` 的套件，或 iot `templateID`／`sheetid` 等於線上 ID 的 `.htm`，以 `form_import(for_update:true)` 載入 | 否則新建 |

## 2. 字典（新建、補述）

寫入順序固定：**字典（含 JSON 說明）→ 補述 memo → 範本**。三者的 plan 合併在同一份 G3 計畫呈現、一次核准；執行時依序做第二次呼叫。

- flag `dictionaryWrite`（預設**開**）：
  - 新建：`online_dictionary_batch`（全部）或 `online_dictionary_create`（逐一）。dicComment 由 MCP 以字典 JSON 一次寫好（G1 核准的 desc＋memo；plan 的 `dic_comment_json` 是實際寫入的內容）。
  - `reused`：同名字典已存在，沿用既有 id（告知使用者）。
  - `E_DELETED_EXISTS`：有已刪除的同名字典。**不自動 force**：請使用者選「還原」（在字典頁垃圾桶操作後，用 `online_dictionary_search(update_index:true)` 重建索引、`form_update_control` 綁 id）或「建立新的」（`online_dictionary_create` 帶 `force:true`，重新取得 plan）。
  - 補述：G1「### 字典補述」中動作為「補充」的既有字典，用 `online_dictionary_memo_set`（`dic_id`、`memo`、`fhir`，並帶 `draft_id` 讓 hook 檢查 G3）。plan 有改前／改後與 `etag`；第二次呼叫帶同一個 `etag`。回 `E_CONFLICT`（他人先改了）：以 `details.current` 合併（保留對方內容再補充）後重新取得 plan，**改過的內容要重新給使用者看**。`E_INVALID_FHIR`：修正 path／code 後重取。
  - 體系升級建議：**沒有寫入工具**。G1「### 體系升級建議」原樣列進 G3 計畫與交付清單，請使用者轉給體系字典管理者在字典頁升級（只寫入體系標記，id 與 dicType 不變）。
- flag **關**：不能經 API 建字典或寫補述。改走 `form_export` 輸出 `.htm`，請使用者「匯入表單及字典」（套件內新字典的說明同樣是 JSON）；或請使用者先在字典頁建好，再 `online_dictionary_search(update_index:true)` 後綁定。

## 3. 上架計畫（G3）

1. 第一次呼叫 `online_template_create`（`draft_id`、`folder_type`）或 `online_template_update`（`draft_id`、`template_id`），不帶 `confirm_token`。
2. 把回傳的 `plan` 寫成 `<workspace>/.strucmed/plans/<draft_id>/publish-plan.md`。**`<draft_id>` 是第二次呼叫時傳給 tool 的 draft**：更新範本時是 `form_import` 後的新 draft（不是原 draft），hooks 的 `validate-gate.js` 以呼叫參數的 `draft_id` 找 sidecar。plan 裡的 `draft_sha256` 是 draft 內容的穩定雜湊（不含時間戳），同一個 draft 重取 plan 會相同，可用來確認計畫檔對應的內容沒變：

```markdown
# <表單名稱> 上架計畫

## 上架計畫
<!-- gate: publish-form:publish | category=write | cancel-leaves=nothing -->
Status: Ready
Revision: 1

| 項目 | 值 |
|---|---|
| 動作 | 新增範本 ／ 更新範本 <templateID> |
| 站台 | <plan.site> |
| 登入者／科部 | <user_id>／<dept_no> |
| 資料夾 | <folder_type>（代碼 <folder_code>） |
| 名稱 | <name>（更新：線上 <meta.name.online> → 寫入 <meta.name.will_write>） |
| 捷徑／作業別 | <shortcut>／<groups>（更新：線上值 → 寫入值，同上） |
| **保存後即上架** | 是／否（有捷徑＋作業別＝是） |
| 區塊／控制項 | <areas>／<controls> |
| 字典 | <id 前 8 碼／名稱／層級…> |
| （更新）If-Match | <if_match> |
| （更新）這次寫入的變更 | <diff.summary>（控制項 <before>→<after>；新增／移除／修改 itemid、區塊版面或說明文字、表單 JS、iot） |
| （更新）線上自來源後的修改 | <diff.online_since_source> |
| 本文大小 | <body_chars> 字元 |

### 字典（若有）
| 名稱 | 說明（desc） | 補述（memo 摘要） | 動作（新建／reused／補述） |

### 警告
- W_AI_DATAFLOW：…
- …

## 核准
Status: Pending
Approved-Revision:
Approved-At:
Approved-By:
```

3. 在對話中呈現同一份內容（含 Trigger／Why we ask／Cancel leaves），`AskUserQuestion` 三選項：核准（建議）／要求修改／取消。
4. 核准 → 改「## 核准」為 `Approved`（填 Revision、時間、`online_me.user_id`）→
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <publish-plan.md> --by <user_id>
   ```
   hooks 的 `validate-gate.js` 在第二次呼叫前會檢查這個 sidecar；沒有或不符就阻擋。
5. 要求修改 → 修 draft 後回第 1 步（plan 內容變了，`confirm_token` 也失效）。

## 4. 執行

- 第二次呼叫帶 `confirm_token`（更新另帶 plan 的 `if_match`）。第二次呼叫會在瀏覽器開啟「寫入確認頁」（MCP 2.3.0 起）：回 `pending`（附 `approve_url`）時，請使用者在頁面核對站台、登入者、資料夾與名稱後按「確認寫入」，再帶同一個 `confirm_token` 呼叫一次。**不要替使用者確認、不要自己開啟或操作確認頁**；回 `E_REJECTED`（使用者按取消）就停止，需要時重新取得計畫。
- 對話中的 G3 核准與瀏覽器確認頁是兩件事：前者是 skill 流程（Claude Code、Codex），後者由 MCP 強制、任何 client 都有；兩者都通過才寫入。
- 成功：記下 `template_id`、`rev`、`folder`；draft 內也存了 `published`。
- 錯誤對照：

| 錯誤碼 | 意思 | 做法 |
|---|---|---|
| `E_CONFIRM_MISMATCH` | token 過期（10 分鐘）或內容變了 | 回第 3 步 |
| `E_DICT_PENDING` | 還有待新建字典 | §2 |
| `E_CONFLICT`（字典補述／升級） | 字典在取得 plan 後被他人修改 | 以 `details.current` 合併後重取 plan，重新給使用者看 |
| `E_INVALID_FHIR` | FHIR 對應格式不符（path 開頭、code system 白名單） | 修正後重取 plan |
| `E_WRITES_DISABLED` | 站台尚未開放範本寫入 | 告知使用者，改走 `form_export` |
| `E_PRECONDITION` | 缺 If-Match | 重新取得計畫 |
| `E_CONFLICT` | 線上內容在取得計畫後被改（更新的第二次呼叫會先重讀線上，ETag 不同就不開確認頁） | 重新 `online_template_get(save:true)` → `form_import(for_update:true)` 改版 |
| `E_CONFIRM_MISMATCH`（更新） | 取得計畫後線上的名稱、捷徑、作業別或 Info 被改 | 重新取得計畫，`plan.meta` 重新給使用者看 |
| `E_LIMIT` | 本文過大或頻率（每分鐘 20 次寫入） | 等候或精簡 |
| `E_UPSTREAM` 且 `details.pending` | 倉儲寫入中途失敗 | **不要重複保存**；用 `online_template_versions`、`online_folder_list` 看狀態，請管理者在管理頁處理待重送 |
| `W_DIVERGED` | 上次經 API 保存後曾被其他方式修改 | 已保存；告知使用者 |

## 5. 收尾（最後一個 tool call）

- `online_template_get(template_id, save:true)`（只回摘要）：確認 `summary` 的名稱、捷徑、作業別與控制項數與計畫相同（伺服器的 `sha256` 是 head 雜湊，與套件 `integrity` 不同，不能直接比對）。
- 更新時另跑 `online_template_versions` 回報新 rev 與 `current`。
- 交付：templateID、資料夾、rev、是否已上架（捷徑＋作業別）、W_AI_DATAFLOW、W_RENUMBER_MACRO（在編輯器開啟後不要按「重新編號」）、人工確認清單（編輯器開啟檢查人形圖示與字典角色；新字典角色一律 tohis）。
- 字典：新建與補述的字典（id 前 8 碼）；有體系升級建議時列出字典名稱、id 前 8 碼與理由，註明「**請轉給體系字典管理者在字典頁升級**；升級不改 id，這次上架的表單不用改」。FHIR 對應中標「待人工確認」的代碼列出請使用者查核。
