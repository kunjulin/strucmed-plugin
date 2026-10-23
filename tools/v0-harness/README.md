# v0-harness：離線 round-trip 驗證工具

以平台**真實的編輯器程式碼**（`repo/strucmed/web`，唯讀）在本機驗證表單 JSON 經 `SetData()` → `GetData()` 後是否無損。

## 安全設計
- `serve.mjs` 只監聽 `127.0.0.1`，對 repo 檔案唯讀；唯一可寫入的是 `out/`（已 gitignore）。
- `guard.js` 注入為 editor.html 第一支 script，封鎖所有非同源請求及同源 `/api`、`/struc`（fetch、XHR、sendBeacon、WebSocket、window.open），被擋請求記錄在 `window.__blocked`。→ 編輯器不會連到倉儲、LLM、HIS API。
- 測試資料的使用者、科部、字典皆為 `V0TEST` / `TEST0` / `v0test-dic-*` 佔位值。

## 使用
```bash
node tools/v0-harness/serve.mjs 8765
```
開啟 `http://127.0.0.1:8765/editor.html?autorun=1`，結果寫入 `tools/v0-harness/out/roundtrip-result.json`，頁面頂端顯示摘要。

新增測試：把 `{name, description, deptNo, dicsource[], form[]}` 放進 `fixtures/`，並加入 `fixtures/index.json`。

## 目錄
| 路徑 | 說明 |
|---|---|
| `fixtures/` | 離線測試表單（含假字典 id，**不可匯入真實環境**） |
| `partB/` | 給使用者在真實編輯器（測試科部）匯入的檔案；無假字典 id |
| `out/` | 執行結果（不 commit） |
