# 表單設計規則（控制項推論、字典、必填、非病人表單、禁止事項）

> 規則依據平台 runtime 實測。由 `create-form`、`edit-form` 與 `form-planner`、`form-reviewer` 載入。

## 控制項推論規則（v0.1）

| 資訊型態 | datatype | 規則 |
|---|---|---|
| 是／否、有／無 | `radiobutton` | row 2；需帶出細項時 `further` 指向該欄位 itemid |
| 單選 ≤ 6 項 | `radiobutton` | |
| 單選 > 6 項 | `selection` | 允許自由輸入改 `combobox` |
| 多選（症狀、病史） | `checkbox` | row 3–4；「其他」選項 `further` → 一個 `textbox` |
| 階層分類 | `submenu` | 選項以 `-`／`--`／`---` 開頭 |
| 數值量測 | `numberbox` | **必設** minval／maxval |
| 日期時間 | `calendar` | format date／time／datetime |
| 短文字 | `textbox` | |
| 自由描述、主訴、計畫 | `textarea` | |
| 顯示另一欄的值 | `label` | format Reference + reference |

`further` 指向的欄位要**先規劃好 itemid**：itemid 由 MCP 依建立順序分配（區塊與控制項共用、從 1 起），`form_add_control` 回傳值會告訴你。先建被引用的欄位，或先規劃順序再建。

**新產生的表單不支援**（告訴使用者，請其匯入後在編輯器手動補，或改用「以既有表單為範本改版」）：圖片、雙欄、群組、彈出片語、子表單綁定（新產生時不支援；改版時原封保留）。計算式、HIS 參照、巨集、LLM 按鈕見 §3b；表格與頁籤見 §3c。

## 必守規則

- **區塊權限**：預設所有人（`doctor`）可顯示、可編輯、回傳文字。只有刻意隱藏（放計算）或表頭不回傳時才宣告 `hidden` / `return_text:false`，並向使用者說明。
- **字典**：
  - 要結構化進倉儲的欄位才綁字典；純說明欄位不綁（`nohis`）。
  - 綁定既有字典時角色可選；**新字典匯入後角色一律 `tohis`**，需要其他角色要請使用者匯入後手動改。
  - 名稱在**同一層級**有多筆同名會被拒絕（`E_DICT_AMBIGUOUS`），請改用 id；不同層級同名時自動綁體系字典（`W_DICT_PREFER_SYSTEM`）。
  - 字典命名依使用者規範；未定案前用 `<表單縮寫>_<欄位語意>` 大寫英數底線，並先搜尋避免重複。
  - 說明、補述、層級與升級見下一節。
- **表單名稱、捷徑、Info 只用 Big5 字**：這三個欄位原樣寫進資料夾清單（不像表單內容是 base64），倉儲（Big5／CP950）存不下的字元會把清單這一筆存壞——表單存了卻不在清單裡、再存回 404（2026-11-22 院內實測：本工具產生的示範表單 Info 含「≥」）。平台 `kunjulin/strucmed#299`（院內、院外 2026-11-23 部署）起保存時回 400。`form_create`／`form_import`／`form_update_meta` 先把有對照的字換掉（`≥`→「大於等於」、`²`→`^2`，回 `W_NON_BIG5`）；沒有對照的（emoji、圈號）由 `form_validate` 回 `E_META_NON_BIG5`，擋住輸出與上架。起草時就避開，替代字表同 `DictionaryMemo.md`。
- **必填**：只標「沒有它表單就失去意義」的欄位；說明必填只在 HIS 端提醒，編輯器存檔不檢查。
- **禁止**：預設值或選項放任何病人資料；自由撰寫表單 JS（只有 flag `formScript` 開啟時以白名單片段產生，見 `ScriptAddonRules.md`；嵌入院內頁面用宣告式 embed 區塊，不寫 JS，見〈嵌入頁面〉）；嵌入圖片；§3b 列出的禁用函數；任何刪除或覆寫線上範本與字典。線上寫入只限 §6 的病人紀錄存檔。
- 使用者要求超出範圍（例如「直接幫我把範本上傳到編輯器」）時，說明目前線上 tool 不含範本寫入，範本仍由使用者匯入 `.htm`；經 API 建立／更新範本的規劃（Phase 2）。

## 樣式（控制項欄位與片段）

- **控制項層級**（不需 flag）：`form_add_control`／`form_update_control` 的 `font_color`、`font_size`（10–24 px，預設 14）、`back_color`，對應平台控制項既有的 `efontcolor`／`efontsize`／`ebackcolor`（編輯器屬性面板的色票，runtime 以 inline style 渲染）。顏色只接受 `#rrggbb`／`#rgb`／`rgb()`／色名白名單；`""` 或 0 清回預設。label 型控制項的字級同時影響說明文字。只影響畫面，不影響 HIS 文字輸出與倉儲。用在：必填或重點欄位淡黃底、結果數值放大、警示 label 紅字。
- **區塊以上與整張主題**（flag `formScript`）：`form_set_script` 的 `style` 片段，見 `ScriptAddonRules.md`。
- 樣式會影響列印版面；交付時提一句。不要用樣式藏欄位（`display`／`visibility` 不開放），藏欄位走區塊 `hidden` 與 `further`。

## 嵌入頁面（embed 區塊，flag `embedArea`）

> flag `embedArea` 3.11.0 起預設開（2026-11-08 站台編輯器實測：匯入、存檔重開、「重新編號」都完整保留）。flag 被關閉時 `form_add_area` 不接受 `embed`（`E_FEATURE_DISABLED`），巨集的 `OPENPANEL` 也視為禁用。**改版既有表單時原表單的 embed 一律原樣保留並檢查**，不論 flag。

在表單內以 iframe 顯示院內第三方網頁（「B1 嵌入頁 APP」），與 `form`、`table1` 平行的區塊。表單設計者只宣告，**不寫自訂 JS**；嵌入頁要留在病歷的資料一律經由 `outputs` 寫進一般控制項，走表單既有的存檔、GetText、計算式與倉儲上傳。

```json
{ "itemtype": "embed", "itemid": "8", "title": "急診臨床決策支援",
  "url": "https://assistantai.cgmh.org.tw/ERCDSS/", "params": { "chtno": "{chtno}", "dept": "{deptNo}" },
  "height": "fill", "inputs": { "age": 2 }, "outputs": { "risk_score": 5, "suggestion": 6 },
  "authread": ["doctor"], "authwrite": ["doctor"], "gettext": true }
```

| 參數（`form_add_area` type `embed`） | 規則（與站台編輯器、runtime 同一套；錯誤碼相同） |
|---|---|
| `title` | iframe 上方的標題（選用） |
| `url` | **https**（`E_EMBED_SCHEME`）、主機在院內範圍 `*.cgmh.org.tw`、`*.cgmf.org.tw`、`*.cgmh.me`、10/8、172.16/12、192.168/16、localhost（`E_EMBED_HOST`；只看網址的主機字串、不做 DNS）；完整網址、不含帳密（`E_EMBED_URL`）；網址本身不可含 `{…}` 或身分證號樣式（`E_EMBED_PII`） |
| `params` | 附加到 query 的 `{ 名稱: 值 }`：值只能是 `{chtno}`（病歷號）、`{deptNo}`（科別）、`{user}`（使用者）、`{opdno}`（門診序號）或常數；名稱只能英數字、`_`、`-`、`.`，不可像身分證號或姓名（`idno`、`pid`、`name`、`ptname`、`patientName`、`username`…）→ `E_EMBED_PII`。沒有身分證號、姓名的占位符 |
| `height` | `"fill"` 或像素 100～4000，預設 600（`E_EMBED_HEIGHT`）；一張表單最多一個 `"fill"`（`E_EMBED_FILL`）。**iframe 不會隨嵌入頁內容長高**：`"fill"` 以表單的捲動區量測，只有嵌入頁時剛好填滿、外層不出現捲軸，表單還有其他內容時嵌入區塊（含標題）剛好一個畫面高（平台 `TempHtml.js?v=20261125`）；整頁型 APP（多欄、內容超過一個畫面）用 `"fill"`，小工具才給像素（`EmbedPageContract.md` §3）；需求沒講就問，不要自己挑一個像素值 |
| `inputs` | 表單 → 嵌入頁 `{ key: itemid }`，載入時以 `strucmed.context.values` 送出；欄位必須存在且參與計算（`E_EMBED_INPUT`） |
| `outputs` | 嵌入頁 → 表單 `{ key: itemid }`：欄位必須存在（`E_EMBED_OUTPUT_MISSING`）、不是 embed（`E_EMBED_OUTPUT_EMBED`）、不在彈出片語或群組控制項內（`E_EMBED_OUTPUT_GROUP`）；多個 embed 不可寫同一欄（`E_EMBED_OUTPUT_DUP`） |
| key 格式 | `inputs`／`outputs` 的 key 只能是英數字、`_`、`-`，值是欄位 ID（`E_EMBED_MAP`；呼叫端可寫 `12`、`"12"` 或 `"A12"`，存成數字） |

- 建置順序：`outputs` 的欄位常在區塊之後才建，`E_EMBED_OUTPUT_MISSING`／`E_EMBED_INPUT` 先延後（回傳 `pending`），建好欄位後 `form_update_area(itemid, outputs: {...})` 補上；其他 `E_EMBED_*` 當下拒絕、draft 不變。`form_update_area` 的 `url`、`params`、`height`、`inputs`、`outputs` 整項取代。
- 寫回欄位用 `textbox`／`textarea`／`numberbox`（數字欄位收到非數字會被 runtime 拒絕）；要進倉儲就綁字典。被 `inputs`／`outputs` 參照的欄位不能 `form_remove_control`（先改 embed）。
- runtime：表單載入後送 `strucmed.context`（**病歷號、科別、使用者、門診序號**，加 `inputs` 欄位值），只接受來源等於 `url` 的 `strucmed.result`（欄位值放在 `data`：`{ type: 'strucmed.result', data: { key: 值 } }`；嵌入頁送 `strucmed.ready` 時表單重送 context；完整形狀見 `EmbedPageContract.md` §1）；寫回只把值放進控制項、不會存檔；嵌入頁本身不進 HIS 文字輸出與紀錄 XML。`authread` 不允許顯示時不載入 iframe。
- **「加載表單」**：站台編輯器需含平台 PR 188（2026-11-08 起部署的院內站台已含），附加含嵌入頁面的表單時 `inputs`／`outputs` 與計算式會跟著欄位位移，實測正確；manifest 不再附避開加載表單的提醒。更早的站台編輯器只位移嵌入頁面的對應、不位移文字區塊的欄位編號，存檔不報錯，那種站台上要合併表單請用 edit-form 在 plugin 內做。
- 揭露：`form_validate` 每個 embed 列 `W_EMBED_DATAFLOW`（目標主機、網址參數、送出與寫回欄位），manifest「嵌入頁面資料流」、form-reviewer 的 review.md 都要列；與 AI 資料流同等級，交付時不可省略。
- HIS 端要 StrucForm 導向白名單放行該主機：1.10.9 DLL 起預設放行院內範圍（程式碼已完成、抽換時程依 HIS 端）；院內範圍以外的主機由平台在站台的集中白名單登錄，plugin 不產生範圍以外的網址（`E_EMBED_HOST`）。被擋下時 iframe 空白、runtime 提示並送 errorlog `NAV-DENIED`，管理者可依主機彙總查詢。1.10.7／1.10.8 的白名單只認設定主機，會擋掉院內頁面。verify-runtime 的 harness 不載入外部 iframe，只驗表單邏輯。
- 嵌入頁的開發條件（`frame-ancestors`、Chromium 104、postMessage 格式、身分分級、時序、測試方法、常見症狀）在平台的 B1 嵌入頁 APP 開發說明 `docs/EMBED-APP-GUIDE.md`（§3～§10，最小 L1 範例 `docs/examples/embed-app-l1.html`），不在 plugin 範圍。plugin 內另有摘要 `EmbedPageContract.md`（訊息形狀、iframe 限制、高度與版面、本機開發、上架後實測步驟）：對話中要幫使用者寫、改或檢查嵌入頁時先讀它，不要憑記憶猜訊息格式；不一致時以平台說明為準。
- 嵌入頁因 `X-Frame-Options`、`frame-ancestors` 被擋，或主機連線被拒時，iframe 顯示灰底哭臉，runtime 不會提示也不送 `NAV-DENIED`（只有 8 秒沒載入與停在空白頁才會）；交付時請使用者確認嵌入頁主機的標頭，並告訴開發者看開發說明的 §10.5。
- `url` 是 `localhost`（含 `127.0.0.1`、`::1`）時 `form_validate` 列 `W_EMBED_LOCALHOST`：只有執行該服務的電腦開得到，其他工作站嵌入頁空白；只用於示範與測試，定稿與交付要寫明，部署到院內主機後改 `url` 再更新範本（`EmbedPageContract.md` §4）。
- **上架後實測**：verify-runtime 的 harness 不載入外部 iframe，嵌入頁的載入、收到 context、寫回與高度要在站台編輯器的表單預覽或 HIS 實測（`EmbedPageContract.md` §5）；沒做就在定稿與交付寫「未驗證」。
- **需要 API 金鑰才能啟動的 APP**（例如 ERCDSS：伺服器帶金鑰換一個含一次性票券的啟動網址）：金鑰不能放進表單、網址或參數。這類 APP 由站台代持金鑰並登錄代號，`url` 改指向站台的啟動橋接頁 `https://<站台>/strucmed/app-launch.html?app=<代號>`（代號是小寫英數字與減號，由站台管理者提供，不要猜），**不帶 `params`**（病歷號等由 `strucmed.context` 取得），整頁型 APP 用 `height: "fill"`。資料實際送往的是登錄表裡的 APP，不是 `url` 的主機：`form_validate` 的 `W_EMBED_DATAFLOW` 與 `embeds[].bridge` 會標明 APP 代號；登入後先執行 `online_features`（取站台的 APP 目錄，寫成 `.strucmed/embed-apps.json`）再 `form_validate`，才列得出實際主機、站台送給 APP 的欄位與 APP 可寫回的 key；沒有目錄時寫「以站台登錄表為準」，定稿與交付要照寫，不要自己補主機。另有三個警告：`W_EMBED_BRIDGE_APP`（缺代號或格式不合、站台目錄沒有這個 APP、APP 尚未就緒、多帶了 `params`）、`W_EMBED_BRIDGE_OUTPUT`（`outputs` 的 key 不在登錄表允許寫回的清單，橋接頁會丟棄，欄位不會被寫入）、`W_EMBED_BRIDGE_PANEL`（`OPENPANEL` 開橋接頁：不送 context，APP 不會啟動，改用 embed 區塊）。這些是 plugin 的警告，平台的 embed 規則沒有變（`EmbedPageContract.md` §6）。
- 嵌入頁拿到的 `user`、`deptNo` 是 L1（工作站自稱、無簽章），只做顯示與稽核；表單設計不要把開立、簽核等不可逆動作放在嵌入頁內完成（等 L2 token）。
- 只在按下按鈕時才開的頁面改用巨集 `OPENPANEL`（`MacroRecipes.md` R10；1.10.9 起開在右側子面板，收不到 `strucmed.context`、不能寫回欄位），不用 embed。

## 附件容器（attachbox 控制項，flag `attachBox`）

> flag `attachBox` 3.12.1 起預設開。站台也要開啟附件容器（`V2:Attachments`；院內、院外站台都已開）才會顯示；沒開的站台上容器只顯示「尚未啟用」。工具清單的 `form_add_control` datatype 有 `attachbox` 才可用；flag 關閉時改版表單裡既有的容器原樣保留。

使用者在表單頁把檔案貼上、拖放或選檔放進容器，再由巨集 `LLMATTACH` 送給 LLM（`MacroRecipes.md` R11）。容器是一個控制項，放在文字區塊、固定表格或頁籤裡：

| 參數（`form_add_control` datatype `attachbox`） | 規則 |
|---|---|
| `datavalue` | 容器上的提示文字（例「請放入 PACS 截圖與報告 PDF」）；不是預設值，不可放病人資料 |
| `attach_kinds` | 可放入的類型，預設全部：`image`（PNG、JPEG、TIFF；不收 WebP）、`pdf`、`sheet`（Excel、CSV）、`text`、`audio`（WAV、MP3、M4A、AAC、OGG、FLAC；不收影片） |
| `attach_max` | 項目上限 1–30，預設 8 |
| `attach_pages` | PDF 勾選「一併送出頁面影像」時最多轉幾頁 1–100，預設 20 |

- **內容不存檔**：附件、抽出的文字、逐字稿都只留在當次畫面，不進倉儲、不進 HIS 文字、重新開表單就沒有。要留下的結果由巨集寫進 `textarea` 等欄位，那個欄位才綁字典。
- 不能綁字典、不能必填、不參與計算（`tocalc` 固定 false）、不能放動態表格（`E_ATTACH_IN_TABLE`）。
- 各類型送給 LLM 的方式：影像當影像；PDF、Excel／CSV、文字當文字（PDF 的文字一律送，使用者可在卡片上勾選一併送頁面影像；沒有文字層的掃描檔會自動勾選）；音檔先轉逐字稿再當文字。
- 音檔一個最長 2 小時；院外站台 10 分鐘一段轉寫，院內 30 秒一段（長音檔會遇到每分鐘次數上限而等待）。
- 院外站台每次送出前都會跳確認，列出送出的影像張數、文件數與對象；語音轉寫另有語音服務的同意畫面。
- 揭露：用到容器的巨集列進 `W_AI_DATAFLOW`（哪些容器、可放入的類型、送給哪個模型），`form_fields` 的容器欄位也會標示。

## 非病人表單（表單選項 `no_patient`）

醫學教育、行政用途、與病人無關的表單（例：「教案一頁通」——教師備課、上傳參考資料、院內 LLM Gateway 產生教案；會議紀錄；教學評量的教師備課）。這類表單由平台自動帶**固定保留代碼**（預設 `APP-NP`）開啟，struNote 不要求病歷號；紀錄只有填寫者本人看得到。

依據：平台 `kunjulin/strucmed` 的 `docs/API-V2.md`「非病人表單」（2026-11-20 實作，院方 2026-11-22 核定紀錄表頭規格；同日部署到院內站台 LVAIW `/strucmed` 與院外站台 `cgmh.ddns.net`）。

**怎麼設**：`form_create`（或改版時 `form_update_meta`）的 `options.no_patient: true` → 定義檔 iot 的 `f_nopatient: true`。同時預設 `f_chtno: false`、`f_opdno: false`、`hide_prev_icon: true`（不以病歷號／就醫號查近期紀錄、隱藏「上次紀錄」圖示）與 `auto_load_on_open: true`（iot `f_autoLoadOnOpen`，見〈紀錄主體與紀錄鍵〉）；使用者明確指定時以指定值為準（`W_NOPATIENT_OPTION`、`W_NOPATIENT_AUTOLOAD` 提醒）。匯出 `.htm`／`.package.json`、`form_import`、改版、上架都保留這些選項。一般表單不寫出 `f_nopatient`、`f_autoLoadOnOpen`（平台預設 false）。

**何時提出**：需求明顯與病人無關時，由 skill 在需求階段提出這個選項給使用者決定；不要自行認定。表單裡只要有任何一欄在記錄特定病人（病歷號、床號、病人的檢驗或評估），就**不是**非病人表單。平台的使用規範：目前只用於「填寫者本人可見、沒有特定主體」的表單（例如個人教案）；要跨使用者共享，或主體是特定的人、課程、會議的用途，等平台的紀錄主體功能（階段 2）再做——需求是這一類時要明講目前做不到彙整。

**站台是否支援**：

- 院內站台（LVAIW `/strucmed`）：已支援（2026-11-22 部署）。
- 院外站台（`cgmh.ddns.net`）：已支援（2026-11-22 部署；`api/v2/runtime/features` 回 `noPatientChtno: "APP-NP"`）。院外以測試帳號登入時，非病人表單不換成測試病人、照樣用保留代碼（一般表單仍換成固定測試值）。
- 其他站台、回退後的站台或無法確定版本時：以站台實際回應為準——`online_features` 的 `runtime.no_patient`（來源是站台 `GET api/v2/runtime/features` 的 `noPatientChtno`）。`supported: true` 時 `chtno` 是站台的保留代碼；`supported: false` 時 `reason` 說明是站台尚未更新（沒有回這個欄位），還是站台停用（保留代碼設成空字串）。
- 不支援的站台會把 `f_nopatient` 的表單當成一般表單、要求病歷號：**不要在那個站台使用**——不輸入真實病歷號，也不自行輸入保留代碼（已更新的平台對一般表單帶保留代碼回 400；代碼由平台決定，範本與用戶端只送旗標）。
- 沒有登入、無法呼叫 `online_features` 時：無法判斷，交付時寫「站台是否支援非病人表單尚未確認，請登入後以 `online_features` 確認」，不要推定。

**取捨（提問時寫在選項說明）**：

| | 非病人表單 | 一般表單 |
|---|---|---|
| 開啟 | 不需病歷號，平台帶保留代碼；目前只在 struNote／表單頁使用 | 要有病歷號（HIS 帶入或 struNote 輸入） |
| HIS 內開啟 | **不能存檔**（HIS 仍帶真實病歷號，平台拒絕）；不要設作業別上架到 HIS 清單 | 正常 |
| 「上次紀錄」 | 只看自己的；圖示預設隱藏 | 依病歷號／就醫號查 |
| HIS 參照、HISQUERY、LOOKUPDW 等 | **不能用**（沒有病人可查；平台執行時不送出） | 可用 |
| 字典寫入（tohis） | 可以，值存在同一個保留代碼下，但**只有建立者本人查得到、下載得到，目前無法彙整他人的紀錄**；**不要用倉儲以病歷號查詢這類紀錄**。不需要統計的欄位不綁字典 | 依病歷號進倉儲 |
| 紀錄筆數 | 從 struNote 的表單清單開：每人每張表單一筆（重開會載入並覆寫同一筆）。**每人要填多筆**（一週一筆、一篇一筆）時開〈應用紀錄清單〉 | 依病歷號／就醫號 |
| LLM 巨集、附件容器、樣式片段 | 照常 | 照常 |

### 紀錄主體與紀錄鍵（`opdno`、`recNo`）

紀錄表頭（院方 2026-11-22 核定；值由平台填，表單與 APP 不自行填代碼）：

| 表頭欄位 | 非病人表單紀錄 |
|---|---|
| `chtno` | 保留代碼 `APP-NP` |
| `deptNo` | `APP` |
| `opdno` | **紀錄主體**（APP 設定欄位）。現行固定 `APP`（沒有特定主體）；表單頁忽略傳入的 `opdno`、`pacsno` |
| `recNo` | **紀錄鍵**（APP 設定欄位）：區分同一張表單的多筆紀錄。沒帶時是 `none`，自成一個鍵 |
| `user`、`sheetid`、`recType`、`status`、`pacsno` | 定義與病歷文件相同（`user`＝紀錄擁有者） |

- 一筆紀錄由 `user`＋`sheetid`＋`opdno`＋`recNo` 定位。
- `recNo` 由開啟表單頁的 APP 帶入：`GET api/v2/forms/{id}/page?recNo=<鍵>`，英數字與 `_`、`.`、`-`，最多 64 字。取值規則要先登錄（GitBook「OPEN 結構化工具 → HIS 交換整合規格 → 文件規格 → 非病人表單紀錄」），程式與表單不得自行填入未登錄的值。
- 取出與覆寫只認 `recNo` **完全相同**的紀錄；`none`（沒帶鍵）不會與帶鍵的紀錄互相覆寫。
- **帶 `recNo` 開啟時一律載入既有紀錄**（不論有沒有勾「開啟時自動取出」）；沒帶時依表單選項 `f_autoLoadOnOpen`。
- **struNote 的表單清單不帶 `recNo`**：從表單清單開，每人每張表單只有一筆（`none`）。所以非病人表單預設 `auto_load_on_open: true`：沒勾時開頁是空白表單，存檔會覆寫上次存的那一筆（`W_NOPATIENT_AUTOLOAD`）。要多筆紀錄時開〈應用紀錄清單〉，由 struNote 產生並帶入 `recNo`。
- **帶 `recNo` 開啟時不帶入近期紀錄**（平台 `TempHtml.js?v=20261124i` 起）：表單選項「依病歷號／就醫號帶入近期紀錄」不分紀錄鍵，會把最新一筆的值填進正在開啟的紀錄，所以帶 `recNo` 時不執行；沒帶 `recNo` 時照舊。
- `G_OPDNO()`、`GETOPDNO()` 讀到的是紀錄主體代碼（現行 `APP`），不是就醫號。

### 應用紀錄清單（`options.app_list`）

一張非病人表單要讓每人填**多筆**紀錄（PGY 一週一筆的學習歷程、一篇一筆的衛教資料、一案一筆的病歷審查練習）時用。依據：平台 `kunjulin/strucmed#290`、`#291`（`docs/PLAN-app-record-list.md`；院內 LVAIW 2026-11-22、院外 2026-11-22 部署，院外 `APP_RECORDS` 開啟）。

- **怎麼開**：struNote 以 `<站台>/note/?app=<範本ID>` 開啟（院內 `https://lvaiw.cgmf.org.tw/strucmed/note/?app=…`、院外 `https://cgmh.ddns.net/note/?app=…`）。登入後不顯示表單清單，改列出**填寫者本人**在這張表單的紀錄，一個紀錄鍵一筆；點一筆以 `recNo` 開表單頁，可新增、修改、刪除。不帶 `app` 時 struNote 照舊。表單不必放進 struNote 清單（`online_me_notes_set`），直接給這個網址。
- **怎麼設**：`form_create`／`form_update_meta` 的 `options.app_list`（→ iot `f_applist*`，與編輯器 Option 面板「應用紀錄清單」相同）。只對非病人表單有效：一般表單帶了平台一律忽略（`E_APPLIST_NOT_NOPATIENT`）。`{ enabled:false }` 關閉；改回一般表單（`no_patient:false`）時一併關閉。

| 鍵 | iot | 說明 |
|---|---|---|
| `title` | `f_applistTitle` | 清單標題，最多 40 字；空白時顯示「紀錄清單」 |
| `key` | `f_applistKey` | 「新增」時紀錄鍵的產生規則：`code`＝使用者輸入（預設）、`week`＝`2026-W47`、`month`＝`2026-11`、`date`＝`2026-11-22`、`time`＝`20261122-153045`（每次新增一筆）。`week`／`month`／`date` 先帶入、可改（補填上週）；輸入已有的鍵等於開啟那一筆 |
| `key_label` | `f_applistKeyLabel` | 紀錄鍵在畫面上的名稱（週次、文件代碼…），最多 20 字 |
| `fields` | `f_applistFields` | 清單顯示欄位：**這張表單綁定的字典名稱**，最多 3 個，第一個當標題。取自存檔的明細，沒綁字典的欄位顯示不出來（`W_APPLIST_FIELD_UNBOUND`） |
| `sort` | `f_applistSort` | `recDate-desc`（預設）、`recDate-asc`、`recNo-desc`、`recNo-asc` |

- **怎麼選紀錄鍵規則**：一週一筆 → `week`；一月一筆 → `month`；一天一筆 → `date`；每次都是新的一筆、不需要回頭找 → `time`；以代碼區分（衛教單代號、案例編號）→ `code`。紀錄鍵只能用英數字與 `_`、`.`、`-`（1～64 字），**不可放病歷號、身分證號、姓名**——`code` 規則要在 `key_label` 與交付說明寫清楚該填什麼。
- **刪除**：清單每筆有「刪除」，struNote 在那一筆上再確認一次才送出（`POST api/v2/records/delete`）。**倉儲是硬刪除，無法復原**；每次存檔另寫的純文字紀錄（`XMLtxt`）不會一起刪。只能刪本人建立的。
- **限制**：只有本人的紀錄（他人或主管看不到，要等平台的紀錄主體階段 2）；主體 `opdno` 固定 `APP`；沒有分頁與日期範圍，最多列 500 筆；清單以明細為準，明細寫入失敗的紀錄不會列出（同鍵開啟仍載得到）；HIS 內沒有這個畫面。
- **站台**：院內受存檔與查詢白名單管控（`online_features` 的 `runtime.save`、`runtime.query`）；院外不開那兩項，改由 `runtime.app_records`（`V2:Note:AppRecords`）讓本人的非病人表單紀錄經登入後的 `records/*` 存取——院外 `save`、`query` 是 false 不影響非病人表單。`strucmed-mcp` 的 token 不能呼叫這些端點，plugin 也沒有查詢、刪除紀錄的 tool。
- 開了清單時 `W_NOPATIENT_AUTOLOAD` 不再提醒（紀錄一律以紀錄鍵開啟並載入）；`W_NOPATIENT_APPLIST` 列出網址、紀錄鍵規則與刪除，交付時必須告知。

### 查詢、下載與分析

- **只有填寫者本人查得到**：經 `api/v2/records/query/*` 查保留代碼的紀錄**必須帶 `sheetid`**，否則 400 `E_INVALID_INPUT`（`status` 為 `DRAWimg`、`XMLtxt` 例外：這兩種紀錄沒有 `sheetid` 欄位）；只回呼叫者自己建立的紀錄。
- **資料下載**（編輯器的資料下載、`data-export`）對非病人表單只含下載者本人建立的紀錄，原作者與管理者（superuser）也一樣。
- plugin 沒有、也不提供查詢或存檔病人紀錄的 tool；上面是交付時要告知使用者與 APP 開發者的平台行為。
- **保留代碼登錄**（分析與報表排除用）：`chtno` 為 `Shortcut` 或以 `APP` 開頭的都不是病人紀錄（`Shortcut`＝範本與清單、`APP`＝struNote 表單清單、`APP-NP`＝非病人表單紀錄）；`500` 不是保留代碼，是測試用病歷號（DLL 預設、展示用測試帳號），一併排除。統計時排除 `chtno LIKE 'APP%'`、`Shortcut`、`500`。

### `form_validate` 的檢查

非病人表單才有；本工具新建的表單、或這次才設成非病人的，一律 error；改版時原表單本來就是非病人表單、這次沒動到的部分照慣例列 warning「原表單既有」：

| 代碼 | 觸發 |
|---|---|
| `E_NOPATIENT_HISQUERY` | label 的 HIS 參照（format=hisquery）、巨集 `HISQUERY`（平台執行時不送出） |
| `E_NOPATIENT_LOOKUPDW` | `LOOKUPDW`、`DWLOOKUP`、`LOOKUPDEFAULTSETTING`、`SETLOOKUPDEFAULT`、`LOOKUPIOT`（以病歷號查倉儲；平台執行時不送出） |
| `E_NOPATIENT_DICT_READ` | 字典角色 `fromhis`／`puthis`（開表單時以病歷號從倉儲帶值）；改 `tohis` 或 `nohis` |
| `E_NOPATIENT_CHTNO_FUNC` | `G_CHTNO()`、`GETCHTNO()`（讀到的是保留代碼，不是病歷號） |
| `E_NOPATIENT_EMBED_CHTNO` | 嵌入頁 `params` 用 `{chtno}`（平台 `E_EMBED_NOPATIENT`：編輯器擋存檔、runtime 不載入） |
| `E_NOPATIENT_EMBED_OPDNO` | 嵌入頁 `params` 用 `{opdno}`（同上；3.15.x 是 `W_NOPATIENT_EMBED_OPDNO`） |
| `W_NOPATIENT_OPDNO_FUNC` | `G_OPDNO()`、`GETOPDNO()`、`GETPACSNO()`（讀到紀錄主體代碼 `APP`，不是就醫／檢查號） |
| `W_NOPATIENT_EMBED_CONTEXT` | 有 embed 區塊：`strucmed.context` 的 `chtno`、`opdno` 是空字串，另帶 `noPatient: true`（不送保留代碼）；嵌入頁要能處理沒有病人的情境 |
| `W_NOPATIENT_LOADDOC` | `LOADDOC`、`LOADXML`（平台只取回這張表單、同一個 `recNo`、自己建立的紀錄） |
| `W_NOPATIENT_OPTION` | 明確開了 `f_chtno`／`f_opdno` 或顯示「上次紀錄」圖示 |
| `W_NOPATIENT_AUTOLOAD` | 沒有開「開啟時自動取出」（`f_autoLoadOnOpen`）：struNote 開頁是空白，存檔會覆寫上一筆（開了應用紀錄清單時不提醒） |
| `W_NOPATIENT_APPLIST` | 開了應用紀錄清單：網址、紀錄鍵規則、刪除無法復原，交付時必須告知 |
| `W_APPLIST_FIELD_UNBOUND` | 清單顯示欄位不是這張表單綁定的字典，或沒有設定顯示欄位 |
| `E_APPLIST_NOT_NOPATIENT` | 一般表單設了應用紀錄清單（改版時原表單既有的列 `W_APPLIST_NOT_NOPATIENT`） |
| `W_NOPATIENT_HIS_LIST` | 設了捷徑與作業別（會出現在 HIS 清單）：HIS 內存檔會被平台拒絕 |
| `W_NOPATIENT_DICT_WRITE` | 有欄位寫入字典（值以保留代碼進倉儲；只有建立者本人查得到、下載得到） |
| `W_NOPATIENT_FORM` | 每張非病人表單都有：交付時必須告知下面各點 |

函數名稱只比對字串以外的部分：提示詞文字裡提到函數名或 `{chtno}` 不算。`{user}`、`{deptNo}` 與常數參數、`G_USERNM()`、`G_DEPTNO()` 照常可用。

**交付時必須告知**（manifest「## 非病人表單」、定稿檔「### 上架」、`W_NOPATIENT_FORM`）：
- 非病人表單：struNote 不需病歷號，平台以保留代碼開啟。
- 站台是否支援（上面〈站台是否支援〉的結果）；不支援的站台不要使用、不輸入真實病歷號。
- 紀錄只有填寫者本人查得到、下載得到，目前無法彙整他人的紀錄；**不要用倉儲以病歷號查詢這類紀錄**。
- 沒開應用紀錄清單：從 struNote 開，每人每張表單一筆。開了：給 `<站台>/note/?app=<範本ID>`、紀錄鍵規則（不可放病歷號、身分證號、姓名）、刪除無法復原。兩者都只在 struNote／表單頁使用，HIS 內開啟時存檔會被拒絕。
- 尚未更新的站台的編輯器不認得 `f_nopatient`：在那裡另存，選項可能遺失，請在支援的站台確認 Option 面板的「非病人表單（不需病歷號）」。

## 字典說明、補述與層級

字典的說明欄（dicComment）是一個 JSON 容器（MCP 2.4.0 起），由 MCP 與平台用同一份規格組裝，**不要自己拼 JSON**：

| 段落 | 內容 | 誰能改 | 怎麼寫入 |
|---|---|---|---|
| `desc` | 一行語意（≤ 300 字、不可換行） | 原作者；體系字典（2 碼，或帶體系標記）另含該體系的字典管理者 | 新建時 `dictionary.comment`；既有的**不動** |
| `memo` | 補述：`meaning` 語意、`type` 建議 datatype、`unit` 單位、`range` 合理範圍、`func` 表單功能、`usecase` 使用情境、`interop` 交換引用、`asr` 語音別名（陣列）、`calx` 計算式用途白話、`llm` 給 prompt 的欄位描述、`scope` 適用範圍（寫法見 `DictionaryMemo.md`） | 所有登入者與 AI | 新建時 `dictionary.memo`；既有字典用 `online_dictionary_memo_set`，一張表單多本用 `online_dictionary_memo_batch` |
| `fhir` | FHIR 對應（陣列）：`res`、`path`、`code`（`system\|code`）、`display`、`ucum` | 所有登入者與 AI，寫入前檢查格式 | `online_dictionary_memo_set` |
| `sys` | 體系標記 `{ code, by, at }`：升級為體系字典時寫入，id 與 dicType 都不變 | 只有該體系的字典管理者（字典頁一鍵升級／降回科部） | 不由 AI 寫入，沒有工具 |
| `alias_of` | 已併入另一本字典 | 只有體系管理者（升級時體系內已有同名，在字典頁設定） | 不由 AI 寫入 |

舊字典的說明是純文字，讀取時整段視為 `desc`。早期版本留下的 `promote`（升級申請）段落讀取時保留，已不再使用。整段長度上限 1800 字（正式倉儲實測中文 1800 字完整保留），所以 memo 每格寫精簡的一句。**只用 Big5 字集裡的字**：倉儲是 Oracle 的 Big5（CP950）字集，字集外的字會被換掉，上標「²」還會弄壞整段說明（實測）。MCP 與平台都會拒絕（`E_INVALID_INPUT`，訊息指出是哪個字）。可以用：中文（含常見簡體字）、英數、全形標點、「÷ ＝ ± ℃ ㎏」等常見符號；要改寫的：上標下標（「²」寫成「^2」或「平方」）、圈號數字「①」、項目符號「•」、emoji。

### 綁定順序

`online_dictionary_search(update_index:true)` 後，依序找：**體系（sys：第 2–3 碼的字典，或帶體系標記、`sys.code` 等於登入者體系代碼的他科字典）→ 本科（own）→ 次專（sub，前 4 碼）→ 科部（dpt，前 3 碼）→ 新建科部字典**。
- **先找再建**：每個存檔欄位都先跑 `dictionary_suggest`。`confidence: high`（名稱或補述別名 `asr` 與欄位說明相同、在比對範圍內、型別與單位不衝突、範圍內沒有名稱相近的其他字典）直接選入計畫，仍在 G1 給使用者確認；他科字典不自動選。待新建字典有高信心候選時，`form_validate` 回 `W_DICT_CANDIDATE_EXISTS`，要改綁或寫出理由。
- 同名多層時 MCP 自動綁體系字典（`W_DICT_PREFER_SYSTEM`），計畫裡寫出綁的是哪一本。
- 字典有 `alias_of` 時 MCP 會改綁目標（`W_DICT_ALIAS`）。
- 綁既有字典前先讀它的 `memo`：datatype、單位、範圍、選項、計算式白話與 prompt 的欄位描述以 memo 為依據；memo 與需求衝突時列入「待決」，不要默默改用別的字典。
- 已有 `fhir` 的直接沿用，並用它反推 datatype 與單位（`valueQuantity`→numberbox＋ucum 單位、`valueCodeableConcept`→radiobutton／selection、`valueBoolean`→checkbox、`valueDateTime`→calendar、`valueString`→textbox／textarea）。

### memo 怎麼寫

完整寫法（11 個欄位、表單功能／使用情境／交換引用三個角度、範例）見 `references/DictionaryMemo.md`；寫完用 `dictionary_memo_check` 檢查。重點：

- **保留既有內容再補充**：`online_dictionary_memo_set` 的 memo 只覆寫給的鍵，其他鍵保留；要清除某鍵才給 `""`。不要因為「寫得不好」就整段改寫別人的 memo。
- `meaning`：一句臨床語意（「病人自述過去一年內跌倒次數」），不是重複名稱。
- `type`／`unit`／`range`：與表單實際控制項相同（numberbox 的 minval／maxval 就是 range）。
- `asr`：語音輸入時醫師會說的叫法（中文、英文縮寫、口語），給語音巨集對欄位用。
- `calx`：這個欄位參與的計算式白話（「BMI＝體重 ÷（身高 m）²」）；不寫 Calx 原文。
- `llm`：寫 prompt 時描述這個欄位的那句話（tune-prompt 與 LLM 按鈕直接引用），不放病人資料。
- `func`：在表單中的角色（使用者輸入、計算式輸入、計算結果、巨集寫入目標、LLM 輸入或回覆、HIS 帶入、存檔回寫），以 `form_fields` 的 `derived.func` 為底改寫；不寫 itemid。
- `usecase`：哪種表單、什麼時間點、誰填、臨床目的。
- `interop`：別的表單引用時要知道的：值的格式與精度、與哪些字典同義或不可混用、單位換算。
- `scope`：適用科別或情境；跨科共用時寫出來，作為升級理由。
- `fhir`：`path` 必須以 `res` 開頭；`code` 的 system 只能是 LOINC（`http://loinc.org`）、SNOMED CT（`http://snomed.info/sct`）、ICD-10-CM（`http://hl7.org/fhir/sid/icd-10-cm`）、UCUM 或院內 CodeSystem。ICD-10-CM 以已連線的 ICD-10 MCP（`lookup_code`、`validate_code`）驗證；LOINC、SNOMED 沒有查詢工具，由 planner 提建議並在 G1 標「待人工確認」。datatype 與 FHIR 型別不一致只警告（`W_FHIR_TYPE_MISMATCH`）。

### 何時建議升級為體系字典

- 同體系不同科部會用到同一個量測或評估（體重、身高、疼痛分數、跌倒史），且目前只有科部層級字典。
- 計畫中綁的既有字典是 own／sub／dpt 層級、而表單要給其他科共用。
- 體系內已有同名字典時不要建議，直接綁體系那本。

**AI 不升級，也沒有升級工具**：建議列入定稿檔「### 字典」（字典、id 前 8 碼、理由；reviewer 寫在 review.md 的「## 體系升級建議」），交付時請使用者轉給體系字典管理者，由管理者在字典頁按「升級為體系 XX」。
- 倉儲不允許同一個 id 改類型（正式倉儲實測 HTTP 500），所以升級**不改 id、也不改 dicType**，只在說明寫入體系標記 `sys`。
- 升級後同體系其他科部的比對範圍會納入這本字典，層級是 sys；已綁這本字典的表單不必改。
- 管理者也可以降回科部（移除標記）。
- 體系內已有同名字典時無法升級；管理者可以把這本設為那本的別名（`alias_of`），之後 MCP 會改綁體系那本（`W_DICT_ALIAS`）。
