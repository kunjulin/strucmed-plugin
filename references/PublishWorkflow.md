# 定稿與上架流程（經 strucmed API v2）

> 由 `publish-form` 載入。平台契約為 strucmed API v2 的範本與字典寫入端點；tool 細節見 `mcp/strucmed-mcp/README.md`。閘門是 G2「## 定稿」（`references/Gates.md`）。

## 1. 前提

| 條件 | 怎麼確認 | 不符時 |
|---|---|---|
| 已登入 | `online_me` 成功 | 載入 `connect-strucmed`；不上線就走離線 G2（§3 第 3 步） |
| draft 驗證無 error | `form_validate.valid` | 回 `create-form`／`edit-form` 修正 |
| 待新建字典 | `form_preview` 或 `form_validate.stats`；`online_template_create` 第一次呼叫回 `E_DICT_PENDING` 時 | §2 字典，定稿檔先列已知值（§3 第 3 步） |
| 伺服器允許寫入 | `online_template_create` 第二次呼叫回 `E_WRITES_DISABLED` 表示站台尚未開放範本寫入 | 告知使用者請平台負責人處理；改走 `form_export` |
| 資料夾 | `online_me.folders` 的 usr／sub／dpt | `sys` 不提供（需管理者） |
| 更新既有範本 | flag `templateUpdate` 開，且 draft 的來源就是該範本（`derivedFrom.templateID`＝線上 ID）：`online_template_get(save:true)` 的套件，或 iot `templateID`／`sheetid` 等於線上 ID 的 `.htm`，以 `form_import(for_update:true)` 載入 | 否則新建 |

## 2. 字典（新建、補述）

寫入順序固定：**字典（含 JSON 說明）→ 補述 memo → 範本**。三者的 plan 合併在同一份定稿檔（`publish-plan.md`）呈現、一次核准；執行時依序做第二次呼叫。

- 來源：`dictionary_plan_export` 的 CSV 與預覽頁卡片（`dictionary-assist` 模式 2）。`memo_items` 是 `form_review_read`、`dictionary_plan_import` 回的既有字典補述修改，skill 依 `dic_id` 合併存在 `<workspace>/.strucmed/plans/<draft_id>/memo-items.json`。
- flag `dictionaryWrite`（預設**開**）：
  - 新建：`online_dictionary_batch`（全部）或 `online_dictionary_create`（逐一）。dicComment 由 MCP 以字典 JSON 一次寫好（定稿的 desc＋memo；plan 的 `dic_comment_json` 是實際寫入的內容）。
  - 待新建字典的 FHIR：`online_dictionary_batch`／`create` 只寫 desc＋memo，不寫 FHIR，字典建好後 `pendingDictionaries` 也會清掉。所以取字典 plan 時先以 `form_fields`（`draft_id`、`only: "dictionary"`）找 `dictionary.pending` 為 true 且 `dictionary.fhir` 有內容的字典，寫成 `<workspace>/.strucmed/plans/<draft_id>/pending-fhir.json`（`[{ "name": "…", "fhir": […] }]`），字典建好後由 §4 第 2 步補寫。走 `form_export` 不用這一步：套件的字典說明已含 FHIR。
  - `reused`：同名字典已存在，沿用既有 id（告知使用者）。
  - `E_DELETED_EXISTS`：有已刪除的同名字典。**不自動 force**：請使用者選「還原」（在字典頁垃圾桶操作後，用 `online_dictionary_search(update_index:true)` 重建索引、`form_update_control` 綁 id）或「建立新的」（`online_dictionary_create` 帶 `force:true`，重新取得 plan）。
  - 補述：`memo_items` 用 `online_dictionary_memo_batch`（`items`＝`memo_items`、`draft_id`；第二次呼叫帶 plan 的 `etags`），一次 ≤ 100 本、逐本回報。站台不支援 func／usecase／interop 時回 `W_SERVER_OLD_MEMO_KEYS`（這三格不寫入，告知使用者）。回 `E_CONFLICT`（他人先改了）：以 `details.stale` 合併（保留對方內容再補充）後重新取得 plan，**改過的內容要重新給使用者看**。`E_INVALID_FHIR`：修正 path／code 後重取。
  - hook：補述工具帶 `draft_id` 時，同資料夾有 `memo-plan.md` 就看它，否則看 `publish-plan.md`。先前跑過 `dictionary-assist` 模式 3 的 draft 會有 `memo-plan.md`：這批補述改走模式 3 的計畫（併入 `memo-plan.md`、重新核准），不要刪它。
  - 體系升級建議：**沒有寫入工具**。review.md 的「## 體系升級建議」原樣列進定稿檔「### 字典」與交付清單，請使用者轉給體系字典管理者在字典頁升級（只寫入體系標記，id 與 dicType 不變）。
- flag **關**：不能經 API 建字典或寫補述。改走 `form_export` 輸出 `.htm`，請使用者「匯入表單及字典」（套件內新字典的說明同樣是 JSON）；或請使用者先在字典頁建好，再 `online_dictionary_search(update_index:true)` 後綁定。

## 3. 定稿檔（G2）

1. 字典 plan：`dictionary_plan_export`（`draft_id`）更新 CSV；有待新建字典時先寫 `pending-fhir.json`（§2），再 `online_dictionary_batch` 第一次呼叫；`memo-items.json` 有內容時 `online_dictionary_memo_batch` 第一次呼叫（`items`、`draft_id`）。待新建字典還沒有 id，它們的 FHIR 這時進不了補述 plan，只在定稿檔「### 字典」列出。
2. 第一次呼叫 `online_template_create`（`draft_id`、`folder_type`）或 `online_template_update`（`draft_id`、`template_id`），不帶 `confirm_token`。
3. 兩種情況 plan 取不到或換成別的：
   - **有待新建字典**：回 `E_DICT_PENDING`，字典建立後才取得到範本 plan。「### 上架」改用 draft 的已知值（站台、登入者、資料夾、名稱、捷徑／作業別、保存後即上架、區塊／控制項數），本文大小寫「字典建立後才算得出」，執行時照 §4 第 3 步比對。
   - **離線、不上架或 flag `dictionaryWrite` 關且有新字典**：`form_export` 第一次呼叫，「### 上架」換成它的 plan（檔案、覆寫、匯入模式）。回 `E_OUTPUT_EXISTS` 時問使用者是否覆寫（`overwrite: true`）。
4. 寫成 `<workspace>/.strucmed/plans/<draft_id>/publish-plan.md`，「### 驗證結果」「### HIS 文字輸出」「### 字典」三段的格式見 `Gates.md` §3。**`<draft_id>` 是第二次呼叫時傳給 tool 的 draft**：更新範本時是 `form_import` 後的新 draft（不是原 draft），hooks 的 `validate-gate.js` 以呼叫參數的 `draft_id` 找 sidecar。plan 裡的 `draft_sha256` 是 draft 內容的穩定雜湊（不含時間戳），同一個 draft 重取 plan 會相同，可用來確認計畫檔對應的內容沒變。「### 上架」段：

```markdown
### 上架
| 項目 | 值 |
|---|---|
| 動作 | 新增範本 ／ 更新範本 <templateID> |
| 站台 | <plan.site> |
| 登入者／科部 | <user_id>／<dept_no> |
| 資料夾 | 個人（usr／<folder_code>）、次專（sub／<folder_code>）或科部（dpt／<folder_code>） |
| 名稱 | <name>（更新：線上 <meta.name.online> → 寫入 <meta.name.will_write>） |
| 捷徑／作業別 | <shortcut>／<groups>（更新：線上值 → 寫入值，同上） |
| **保存後即上架** | 是／否（有捷徑＋作業別＝是） |
| 區塊／控制項 | <areas>／<controls> |
| 字典 | <id 前 8 碼／名稱／層級…> |
| （更新）If-Match | <if_match> |
| （更新）這次寫入的變更 | <diff.summary>（控制項 <before>→<after>；新增／移除／修改 itemid、區塊版面或說明文字、表單 JS、iot） |
| （更新）線上自來源後的修改 | <diff.online_since_source> |
| 本文大小 | <body_chars> 字元 |

### 警告
- W_AI_DATAFLOW：…
- …
```

5. 在對話中呈現同一份內容（含 Trigger／Why we ask／Cancel leaves），`AskUserQuestion` 三選項：核准（建議）／要求修改／取消；選項描述加「有疑問請先在對話問，不要在這裡選」。使用者在對話提問時回答後再問一次，定稿內容不重貼。
6. 核准 → 改「## 核准」為 `Approved`（填 Revision、時間、`online_me.user_id`，離線用 `local`）→
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-plan.mjs" prepare <workspace>/.strucmed/plans/<draft_id>/publish-plan.md --by <user_id>
   ```
   hooks 的 `validate-gate.js` 在第二次呼叫前會檢查這個 sidecar；沒有或不符就阻擋。
7. 要求修改 → 修 draft（字典改 CSV 後 `dictionary_plan_import`）後回第 1 步，`Revision` +1（plan 內容變了，`confirm_token` 也失效）。

## 4. 執行

依序做，每一步都要等前一步完成：

1. 字典新建：`online_dictionary_batch`／`create` 第二次呼叫。
2. 補述：`online_dictionary_memo_batch` 第二次呼叫（同一份 `items`、`draft_id`、plan 的 `etags`、`confirm_token`）。**有 `pending-fhir.json` 時**先補上新字典的 FHIR：
   - 以第 1 步回傳的 id 併進 `memo-items.json`，每本加 `{ "dic_id": "…", "fhir": […] }`：`online_dictionary_batch` 看 `done[]` 的 `name`、`id`、`action`，`online_dictionary_create` 看 `id`、`reused`。中斷後重來時 id 以 `form_fields` 查。
   - `reused`（沿用同名既有字典）不併入：補述工具的 `fhir` 是整組取代，會蓋掉別人的對應；列給使用者決定。建立失敗的字典留在 `pending-fhir.json`，建好後再併入。
   - 重新做一次第一次呼叫（`items` 變了，舊 token 不能用），取得新的 plan 與 `etags`。既有字典的列與定稿檔相同、新增的列只有定稿檔列過的 FHIR → 原樣列給使用者，接著做第二次呼叫；不同 → 停下來，`Revision` +1 重新呈現。
3. 範本：第二次呼叫（更新另帶 plan 的 `if_match`）。**第 1 步有建字典時**，先做範本的第一次呼叫：字典綁回後 draft 內容變了，這時才拿得到 plan。plan 的名稱、捷徑、作業別、資料夾、保存後即上架、控制項數與「### 上架」相同 → 原樣列給使用者，接著做第二次呼叫；不同 → 停下來，`Revision` +1 重新呈現。`publish-plan.md` 不要回填這份 plan：核准後一改就失效。
4. 離線：`form_export` 第二次呼叫。

- 第二次呼叫會在瀏覽器開啟「寫入確認頁」（MCP 2.3.0 起）：回 `pending`（附 `approve_url`）時，請使用者在頁面核對站台、登入者、資料夾與名稱後按「確認寫入」，再帶同一個 `confirm_token` 呼叫一次。**不要替使用者確認、不要自己開啟或操作確認頁**；回 `E_REJECTED`（使用者按取消）就停止，需要時重新取得計畫。
- **確認頁被關掉**：把回傳的 `approve_url` 給使用者重開（同一份確認，仍然由使用者按）。手上沒有連結時帶同一個 `confirm_token` 再呼叫一次，會回同一個 `approve_url`，但不會自動重開瀏覽器。回 `E_CONFIRM_MISMATCH`（過期、已使用或 MCP 重啟過）就重新第一次呼叫。
- **權限擋下第一次呼叫**：Claude Code 的 auto mode 權限分類器可能把「只產生 plan」的呼叫當成修改共用資源擋下，這不是 plugin 的 hook。不要繞過，請使用者允許後重試；要先排除見 README〈減少核准提示〉。
- 對話中的 G2 核准與瀏覽器確認頁是兩件事：前者是 skill 流程（Claude Code、Codex），後者由 MCP 強制、任何 client 都有；兩者都通過才寫入。
- `confirm_token` 10 分鐘過期：G2 讀得久時是常態。重新做第一次呼叫取新 token；plan 與定稿檔相同就直接用，定稿檔不用改；不同才 `Revision` +1 重新呈現。
- 成功：記下 `template_id`、`rev`、`folder`；draft 內也存了 `published`。
- 錯誤對照：

| 錯誤碼 | 意思 | 做法 |
|---|---|---|
| `E_CONFIRM_MISMATCH` | token 過期（10 分鐘）或內容變了 | 重新第一次呼叫；內容變了回 §3 第 1 步 |
| `E_DICT_PENDING` | 還有待新建字典 | §2 |
| `E_CONFLICT`（字典補述） | 字典在取得 plan 後被他人修改 | 以 `details.stale`（單本 `details.current`）合併後重取 plan，重新給使用者看 |
| `E_INVALID_FHIR` | FHIR 對應格式不符（path 開頭、code system 白名單） | 修正後重取 plan |
| `E_WRITES_DISABLED` | 站台尚未開放範本寫入 | 告知使用者，改走 `form_export` |
| `E_PRECONDITION` | 缺 If-Match | 重新取得計畫 |
| `E_CONFLICT` | 線上內容在取得計畫後被改（更新的第二次呼叫會先重讀線上，ETag 不同就不開確認頁） | 重新 `online_template_get(save:true)` → `form_import(for_update:true)` 改版 |
| `E_CONFIRM_MISMATCH`（更新） | 取得計畫後線上的名稱、捷徑、作業別或 Info 被改 | 重新取得計畫，`plan.meta` 重新給使用者看 |
| `E_LIMIT` | 本文過大或頻率（每分鐘 20 次寫入） | 等候或精簡 |
| `E_UPSTREAM` 且 `details.pending` | 倉儲寫入中途失敗 | **不要重複保存**；用 `online_template_versions`、`online_folder_list` 看狀態，請管理者在管理頁處理待重送 |
| `W_DIVERGED` | 上次經 API 保存後曾被其他方式修改 | 已保存；告知使用者 |

字典已建好、範本失敗時，字典留著不用重建：修好後從範本的第一次呼叫重來。

## 5. 收尾（最後一個 tool call）

- `online_template_get(template_id, save:true)`（只回摘要）：確認 `summary` 的名稱、捷徑、作業別與控制項數與定稿相同（伺服器的 `sha256` 是 head 雜湊，與套件 `integrity` 不同，不能直接比對）。
- 更新時另跑 `online_template_versions` 回報新 rev 與 `current`。
- 交付：templateID、資料夾（格式同 §3 的表）、rev、是否已上架（捷徑＋作業別）、W_AI_DATAFLOW、W_RENUMBER_MACRO（在編輯器開啟後不要按「重新編號」）、人工確認清單（編輯器開啟檢查人形圖示與字典角色；新字典角色一律 tohis）。
- 字典：新建與補述的字典（id 前 8 碼）；有體系升級建議時列出字典名稱、id 前 8 碼與理由，註明「**請轉給體系字典管理者在字典頁升級**；升級不改 id，這次上架的表單不用改」。FHIR 對應中標「待人工確認」的代碼列出請使用者查核。
