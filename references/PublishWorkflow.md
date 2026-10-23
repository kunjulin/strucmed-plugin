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
| 更新既有範本 | flag `templateUpdate` 開，且 draft 是 `online_template_get(save:true)` → `form_import` 改版而來 | 否則新建 |

## 2. 待新建字典

- flag `dictionaryWrite` **開**：`online_dictionary_batch`（全部）或 `online_dictionary_create`（逐一）。兩段式；它們的 plan 合併顯示在 G3。
  - `reused`：同名字典已存在，沿用既有 id（告知使用者）。
  - `E_DELETED_EXISTS`：有已刪除的同名字典。**不自動 force**：請使用者選「還原」（在字典頁垃圾桶操作後，用 `online_dictionary_search(update_index:true)` 重建索引、`form_update_control` 綁 id）或「建立新的」（`online_dictionary_create` 帶 `force:true`，重新取得 plan）。
- flag **關**：不能經 API 建字典。改走 `form_export` 輸出 `.htm`，請使用者「匯入表單及字典」；或請使用者先在字典頁建好，再 `online_dictionary_search(update_index:true)` 後綁定。

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
| 名稱 | <name> |
| 捷徑／作業別 | <shortcut>／<groups> |
| **保存後即上架** | 是／否（有捷徑＋作業別＝是） |
| 區塊／控制項 | <areas>／<controls> |
| 字典 | <id 前 8 碼／名稱…> |
| （更新）If-Match | <if_match> |
| （更新）差異 | 控制項 <before>→<after>，新增 itemid …，移除 itemid … |
| 本文大小 | <body_chars> 字元 |

### 字典（若有）
| 名稱 | 說明 | 動作 |

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

- 第二次呼叫帶 `confirm_token`（更新另帶 plan 的 `if_match`）。
- 成功：記下 `template_id`、`rev`、`folder`；draft 內也存了 `published`。
- 錯誤對照：

| 錯誤碼 | 意思 | 做法 |
|---|---|---|
| `E_CONFIRM_MISMATCH` | token 過期（10 分鐘）或內容變了 | 回第 3 步 |
| `E_DICT_PENDING` | 還有待新建字典 | §2 |
| `E_WRITES_DISABLED` | 站台尚未開放範本寫入 | 告知使用者，改走 `form_export` |
| `E_PRECONDITION` | 缺 If-Match | 重新取得計畫 |
| `E_CONFLICT` | 線上內容在取得計畫後被改 | 重新 `online_template_get(save:true)` → `form_import` 改版 |
| `E_LIMIT` | 本文過大或頻率（每分鐘 20 次寫入） | 等候或精簡 |
| `E_UPSTREAM` 且 `details.pending` | 倉儲寫入中途失敗 | **不要重複保存**；用 `online_template_versions`、`online_folder_list` 看狀態，請管理者在管理頁處理待重送 |
| `W_DIVERGED` | 上次經 API 保存後曾被其他方式修改 | 已保存；告知使用者 |

## 5. 收尾（最後一個 tool call）

- `online_template_get(template_id)`：確認 `template.name` 與控制項數與 draft 相同（伺服器的 `sha256` 是 head 雜湊，與套件 `integrity` 不同，不能直接比對）。
- 更新時另跑 `online_template_versions` 回報新 rev 與 `current`。
- 交付：templateID、資料夾、rev、是否已上架（捷徑＋作業別）、W_AI_DATAFLOW、W_RENUMBER_MACRO（在編輯器開啟後不要按「重新編號」）、人工確認清單（編輯器開啟檢查人形圖示與字典角色；新字典角色一律 tohis）。
