# 以既有表單為範本改版（v1）

> 規則依據平台 runtime 實測。由 `edit-form` 載入；閘門與子代理分工同 `create-form`。

## 以既有表單為範本改版（v1）

**使用者需提供來源檔**，放在工作目錄內。下列任一種都可以：
- 編輯器「匯出範本套件 (v2)」的 `.htm`（最完整，含選項與表單預設）
- 「匯出 JSON 文件」的 `.json`
- 舊版 `.htm`

**流程：**
1. `form_import`（`source_path`、**新名稱**、`dept_no`）。
   - 原表單的所有區塊、計算式、巨集、表單 JS 都原封保留。
   - 輸出是**新表單**，不沿用原 templateID。
   - **捷徑與作業別預設不沿用**：沿用會與原表單在 HIS 清單重複。只有使用者明確要求時才以 `form_update_meta` 設定。
2. `form_preview` 給使用者看原表單結構與 itemid，確認要改哪些地方。
3. 依需求修改：
   - `form_update_meta`：名稱、捷徑、作業別、Info、表單選項（`options`；改版 draft 直接改來源的 iot 選項）
   - `form_update_control`：說明文字、預設值、必填、選項、字典；計算式、HIS 參照、巨集腳本（v0.2，見 §3b）
   - `form_add_control`：只能加在文字區塊。itemid 自動接續原表單最大值
   - `form_add_area`：新增文字區塊；`after_itemid` 插在指定區塊之後
   - `form_move_control`：搬欄位（itemid 不變）；`form_update_area`：改區塊標題，`titles` 改頁籤名稱、增減頁籤；`form_remove_area`：刪空區塊
   - `form_remove_control`：兩段式確認；仍被參照的控制項會被拒絕，須先改參照方
4. `form_validate`：
   - **本次改到的面向**有問題 → error，必須修正。
   - 原表單既有的問題 → warning（標示「原表單既有」）。要逐條告知使用者，但不擋輸出。
   - `W_CUSTOM_JS`：原表單有自訂 JS，本工具未審查。要明確告知使用者。
   - 非病人表單（`FormDesignRules.md`〈非病人表單〉）：來源 iot 有 `f_nopatient: true` 時 `form_import` 回 `no_patient: true`，選項原樣保留到輸出與上架（來源沒有勾「開啟時自動取出」時也原樣保留，`W_NOPATIENT_AUTOLOAD` 提醒，問使用者要不要 `form_update_meta(options: { auto_load_on_open: true })`）。原表單既有的 HIS 參照等列 warning（原表單既有），改到就是 error。要把一般表單改成非病人表單用 `form_update_meta(options: { no_patient: true })`：這是本次的修改，既有的 HIS 參照、`HISQUERY`、`LOOKUPDW`、讀取型字典角色、嵌入頁 `{chtno}`／`{opdno}` 一律 `E_NOPATIENT_*`，要先移除或改寫；原本有作業別的要一併拿掉（`W_NOPATIENT_HIS_LIST`：HIS 內不能存檔），而且原本以病歷號存的舊紀錄不會出現在非病人表單的資料下載裡，要先告知。
5. 定稿 G2 後 `form_export` 兩段式。manifest 會列出「改版自」與本次改動的控制項（✎）。

**v1 限制**（告訴使用者，請其匯入後在編輯器調整）：
- 圖形、雙欄區塊內**不能新增**控制項（可以修改既有控制項的屬性）。表格與頁籤見 §3c。
- 線上範本以 `online_template_get` 取回時就不含片語（一律帶 `presets=false`；舊版站台由本工具在本機清除並重算 `integrity`，回 `W_SITE_PRESETS_UNSUPPORTED`），`presets` 固定是 `[]`。
- 表單預設（片語）`form_import` 預設不帶入（`presets_dropped` 為來源筆數），上架本文也不含；`keep_presets: true` 才保留並由 `form_export` 寫進套件。保留的片語由 `form_validate` 掃描疑似個資（身分證、「姓名／病歷號／身分證：」→ `E_PHI_SUSPECT`；7–10 位數字 → `W_PHI_SUSPECT`；沒命中也有 `W_PRESETS_EXPORTED` 提醒），`form_update_meta(drop_presets: true)` 移除。
