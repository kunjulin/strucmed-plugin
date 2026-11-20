// 計算式與巨集可用函數的目錄與政策分類（v0.2）。
// BUILTIN：jQuery Calx 2.2.8 內建（由 平台 web/assets/js/vendor/jquery-calx-2.2.8 min.js 擷取，
//          test/v02.test.mjs 會在平台 repo 存在時重新比對，防止漂移）。
// RUNTIME：TempHtml.js 以 registerFunction 註冊的擴充函數（平台 web/js/TempHtml.js:269-425）。
// STEP：只在巨集步驟開頭才有效的指令（calcSetval 以 indexOf(...) === 0 判斷，區分大小寫；
//       平台 web/js/TempHtml.js:3804-3877）。它們沒有註冊成 Calx 函數，寫在其他位置會得到 #NAME?。

export const BUILTIN = new Set([
  'ABS', 'ACCRINT', 'ACCRINTM', 'ACOS', 'ACOSH', 'ACOT', 'ACOTH', 'AGGREGATE', 'AMORDEGRC', 'AMORLINC', 'AND',
  'ARABIC', 'ASIN', 'ASINH', 'ATAN', 'ATAN2', 'ATANH', 'AVEDEV', 'AVERAGE', 'AVERAGEA', 'AVERAGEIF', 'AVERAGEIFS',
  'BASE', 'BETADIST', 'BETAINV', 'BIN2DEC', 'BIN2HEX', 'BIN2OCT', 'BINOMDIST', 'BINOMDISTRANGE', 'BINOMINV',
  'BITAND', 'BITLSHIFT', 'BITOR', 'BITRSHIFT', 'BITXOR', 'CEILING', 'CEILINGMATH', 'CEILINGPRECISE', 'CHAR',
  'CHISQDIST', 'CHISQDISTRT', 'CHISQINV', 'CHISQINVRT', 'CHISQTEST', 'CHOOSE', 'CLEAN', 'CODE', 'COMBIN', 'COMBINA',
  'COMPLEX', 'CONCAT', 'CONCATENATE', 'CONFIDENCENORM', 'CONFIDENCET', 'CONVERT', 'CORREL', 'COS', 'COSH', 'COT',
  'COTH', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'COUNTUNIQUE', 'COUPDAYBS', 'COUPDAYS',
  'COUPDAYSNC', 'COUPNCD', 'COUPNUM', 'COUPPCD', 'COVARIANCEP', 'COVARIANCES', 'CSC', 'CSCH', 'CUMIPMT', 'CUMPRINC',
  'DATE', 'DATEDIFF', 'DATEFORMAT', 'DATEVALUE', 'DAY', 'DAYNAME', 'DAYS', 'DAYS360', 'DB', 'DDB', 'DEC2BIN',
  'DEC2HEX', 'DEC2OCT', 'DECIMAL', 'DEGREES', 'DELTA', 'DEVSQ', 'DISC', 'DIVIDE', 'DOLLAR', 'DOLLARDE', 'DOLLARFR',
  'DURATION', 'EDATE', 'EFFECT', 'EOMONTH', 'ERF', 'ERFC', 'ERFCPRECISE', 'ERFPRECISE', 'EVEN', 'EXACT', 'EXP',
  'EXPONDIST', 'FACT', 'FACTDOUBLE', 'FALSE', 'FDIST', 'FDISTRT', 'FIND', 'FINV', 'FINVRT', 'FISHER', 'FISHERINV',
  'FIXED', 'FLOOR', 'FLOORMATH', 'FLOORPRECISE', 'FORECAST', 'FREQUENCY', 'FROMNOW', 'FTEST', 'FV', 'FVSCHEDULE',
  'GAMMA', 'GAMMADIST', 'GAMMAINV', 'GAMMALN', 'GAMMALNPRECISE', 'GAUSS', 'GCD', 'GEOMEAN', 'GESTEP', 'GRAPH',
  'GROWTH', 'HARMEAN', 'HEX2BIN', 'HEX2DEC', 'HEX2OCT', 'HLOOKUP', 'HOUR', 'HTML2TEXT', 'HUMANIZE', 'HYPGEOMDIST',
  'IF', 'IFERROR', 'IFNA', 'IMABS', 'IMAGINARY', 'IMARGUMENT', 'IMCONJUGATE', 'IMCOS', 'IMCOSH', 'IMCOT', 'IMCSC',
  'IMCSCH', 'IMDIV', 'IMEXP', 'IMLN', 'IMLOG10', 'IMLOG2', 'IMPOWER', 'IMPRODUCT', 'IMREAL', 'IMSEC', 'IMSECH',
  'IMSIN', 'IMSINH', 'IMSQRT', 'IMSUB', 'IMSUM', 'IMTAN', 'INT', 'INTERCEPT', 'INTRATE', 'IPMT', 'IRR', 'ISEVEN',
  'ISOCEILING', 'ISODD', 'ISOWEEKNUM', 'ISPMT', 'JOIN', 'KURT', 'LARGE', 'LCM', 'LEFT', 'LEN', 'LINEST', 'LN', 'LOG',
  'LOG10', 'LOGEST', 'LOGNORMDIST', 'LOGNORMINV', 'LOOKUP', 'LOWER', 'MAX', 'MAXA', 'MDURATION', 'MEDIAN', 'MID',
  'MIN', 'MINA', 'MINUTE', 'MIRR', 'MOD', 'MODEMULT', 'MODESNGL', 'MONTH', 'MROUND', 'MULTINOMIAL', 'MULTIPLY',
  'NEGBINOMDIST', 'NETWORKDAYS', 'NETWORKDAYSINTL', 'NOMINAL', 'NORMDIST', 'NORMINV', 'NORMSDIST', 'NORMSINV', 'NOT',
  'NOW', 'NPER', 'NPV', 'NULL', 'NUMBERVALUE', 'OCT2BIN', 'OCT2DEC', 'OCT2HEX', 'ODD', 'ODDFPRICE', 'ODDFYIELD',
  'ODDLPRICE', 'ODDLYIELD', 'OR', 'PDURATION', 'PEARSON', 'PERCENTILEEXC', 'PERCENTILEINC', 'PERCENTRANKEXC',
  'PERCENTRANKINC', 'PERMUT', 'PERMUTATIONA', 'PHI', 'PI', 'PMT', 'POISSONDIST', 'POWER', 'PPMT', 'PRICE',
  'PRICEDISC', 'PRICEMAT', 'PROB', 'PRODUCT', 'PROPER', 'PV', 'QUARTILEEXC', 'QUARTILEINC', 'QUOTIENT', 'RADIANS',
  'RAND', 'RANDBETWEEN', 'RANKAVG', 'RANKEQ', 'RATE', 'RECEIVED', 'REGEXEXTRACT', 'REGEXMATCH', 'REGEXREPLACE',
  'REPLACE', 'REPT', 'RIGHT', 'ROMAN', 'ROUND', 'ROUNDDOWN', 'ROUNDUP', 'RRI', 'RSQ', 'SEARCH', 'SEC', 'SECH',
  'SECOND', 'SERIESSUM', 'SERVER', 'SIGN', 'SIN', 'SINH', 'SKEW', 'SKEWP', 'SLN', 'SLOPE', 'SMALL', 'SPLIT', 'SQRT',
  'SQRTPI', 'STANDARDIZE', 'STDEVA', 'STDEVP', 'STDEVPA', 'STDEVS', 'STEYX', 'SUBSTITUTE', 'SUBTOTAL', 'SUBTRACT',
  'SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'SUMSQ', 'SUMX2MY2', 'SUMX2PY2', 'SUMXMY2', 'SWITCH', 'SYD', 'T', 'TAN',
  'TANH', 'TBILLEQ', 'TBILLPRICE', 'TBILLYIELD', 'TDIST', 'TDIST2T', 'TDISTRT', 'TEXT', 'TIME', 'TIMEVALUE', 'TINV',
  'TINV2T', 'TODAY', 'TREND', 'TRIM', 'TRIMA', 'TRIMMEAN', 'TRUE', 'TRUNC', 'TTEST', 'UNICHAR', 'UNICODE', 'UPPER',
  'VALUE', 'VARA', 'VARP', 'VARPA', 'VARS', 'VDB', 'VLOOKUP', 'WEEKDAY', 'WEEKNUM', 'WEIBULLDIST', 'WORKDAY',
  'WORKDAYINTL', 'XIRR', 'XNPV', 'XOR', 'YEAR', 'YEARFRAC', 'YIELD', 'YIELDDISC', 'YIELDMAT', 'ZTEST'
]);

// 政策分類：
//   pure     一般運算，計算式與巨集都可用
//   context  讀取目前使用者／病歷的 header 資訊
//   setting  改變表單行為的設定（可用，但列警告）
//   lookup   讀取病人資料（HIS、倉儲）→ 只能用在巨集，列警告
//   write    寫入其他欄位 → 只能用在巨集
//   ai       送資料到 LLM／ASR → 只能用在巨集，列 AI 資料流
//   forbidden 本工具不產生（任意程式、開網址、存檔、改寫身分或文件 header、連外）
//   custom   CUSTOMFUNC：只允許呼叫同 draft 以 form_set_script 的 lookup 片段定義的函數（flag formScript）；其餘視同 forbidden
//   panel    OPENPANEL(url, title)：只能用在巨集，flag embedArea 開啟時才允許；網址必須是字串字面值且通過 embed 區塊 url 的同一組檢查
//            （E_EMBED_URL／E_EMBED_SCHEME／E_EMBED_HOST／E_EMBED_PII）；flag 關閉時 E_FORBIDDEN_FUNCTION（平台 web/js/TempHtml.js registerFunction）
//   attach   附件容器的函數（flag attachBox）：ATTACHCOUNT(容器id) 回項目數，計算式與巨集都可用；ATTACHTEXT(容器id, 篩選字, 字數上限) 回容器內
//            PDF／試算表／文字／逐字稿的文字，只用在巨集（計算式每次重算都會取一次全文）。第一個參數必須是附件容器的 itemid（平台 web/js/attachbox.js）
export const RUNTIME = {
  ATTACHCOUNT: 'attach', ATTACHTEXT: 'attach',
  CHECKREQUIRED: 'setting', CKAUTOXML: 'setting', CKAUTODWLOOKUP: 'setting', CKAUTOUPLOAD: 'setting', CKIOTOW: 'setting',
  GETTEXT: 'context', GETVALUE: 'context', NOW2: 'context', NOWTIME: 'context',
  G_USERNM: 'context', G_USERID: 'context', G_CHTNO: 'context', G_DEPTNO: 'context', G_OPDNO: 'context',
  GETOPDNO: 'context', GETPACSNO: 'context', GETDEPTNO: 'context', GETUSER: 'context', GETCHTNO: 'context',
  HISQUERY: 'lookup', LOOKUPDW: 'lookup', DWLOOKUP: 'lookup', LOOKUPDEFAULTSETTING: 'lookup', SETLOOKUPDEFAULT: 'lookup',
  LOOKUPIOT: 'lookup', LOADDOC: 'lookup', LOADXML: 'lookup', SETDICTATIONBYID: 'lookup',
  SETVALUEBYID: 'write', APPLYPRESETBYNAME: 'write',
  LLMQUERY: 'ai',
  CUSTOMFUNC: 'custom', OPENPANEL: 'panel', OPENURL: 'forbidden', SAVEDOC: 'forbidden', SETIOTHEADER: 'forbidden',
  S_USERID: 'forbidden', S_DEPTNO: 'forbidden'
};
// 內建函數中需要另外處理的
export const BUILTIN_POLICY = {
  SERVER: 'forbidden',   // 以 ajax 呼叫設定的伺服器
  GRAPH: 'forbidden'     // 需要 flot 繪圖套件，runtime 沒有載入
};
// 巨集步驟指令（區分大小寫的前綴）
// LLMATTACH(id, prompt[, model[, 容器id…]])：附件容器的影像與文件文字連同提示詞送給 LLM；ATTACHTRANSCRIBE(容器id…)：容器內的音檔轉逐字稿（flag attachBox；平台 web/js/TempHtml.js calcSetval）
export const STEP = { LLMQUERY: 'ai', LLMvision: 'ai', LLMATTACH: 'ai', ATTACHTRANSCRIBE: 'ai', MACRO: 'write', VOICETOTEXT: 'ai' };

// runtime 載入計算式前，含下列字串（區分大小寫，連字串內也算）的 formula 會被整個換成錯誤訊息
// （平台 web/js/TempHtml.js:4372-4383）
export const FORMULA_REPLACED = ['LLMQUERY(', 'PIPLINE(', 'MACRO(', 'APPLYPRESETBYNAME('];

export function classify(name) {
  const u = String(name).toUpperCase();
  if (RUNTIME[u]) return RUNTIME[u];
  if (BUILTIN_POLICY[u]) return BUILTIN_POLICY[u];
  if (BUILTIN.has(u)) return 'pure';
  return null;   // 未知 → #NAME?
}

// ── LLM 模型（TempHtml.js:1438-1530、990-1030）────────────
// 模型名稱先 toLowerCase；拼錯或已移除的名稱會「靜默」改用預設模型。
export const LLM_MODELS = {
  '': 'llama3.1:8b（預設）', tw: 'gemma2', math: 'gemma2', phi4: 'phi4', ph4: 'phi4', gemma3: 'gemma3',
  gemma3_12b: 'gemma3:12b', medgemma: 'medgemma',
  // 只經院內 LlmGateway（平台 20261124）：沒有直連端點，站台沒啟用 Gateway 時 LLMQUERY 顯示提示、不送出
  nemotron35: 'Nemotron-3.5-Super-VL（只經 Gateway）', tnemotron35: 'Nemotron-3.5-Super-VL（思考，只經 Gateway）',
  'tnemotron35-low': 'Nemotron-3.5-Super-VL（思考 low，只經 Gateway）', 'tnemotron35-medium': 'Nemotron-3.5-Super-VL（思考 medium，只經 Gateway）',
  'tnemotron35-high': 'Nemotron-3.5-Super-VL（思考 high，只經 Gateway）',
  // 落日模型（LLM_SUNSET）：仍認得，只為了既有表單改版時不變成未知模型；新寫的巨集不得使用
  qwen332b: 'qwen3:32b（落日）', tqwen332b: 'qwen3:32b（思考，落日）',
  qwen3627b: 'Qwen3.6:27B（落日）', tqwen3627b: 'Qwen3.6:27B（思考，落日）', 'tqwen3627b-low': 'Qwen3.6:27B（思考 low，落日）',
  'tqwen3627b-medium': 'Qwen3.6:27B（思考 medium，落日）', 'tqwen3627b-high': 'Qwen3.6:27B（思考 high，落日）'
};
// 落日模型（院方決定 2026-11-19）：qwen 系列院方建議不採用，LlmGateway 於 SUNSET_DATE 下架。
//   - 下架日之前：本次新增／修改的巨集 → E_LLM_MODEL_SUNSET；原表單既有、沒動到的 → W_LLM_MODEL_SUNSET（validate.mjs）
//   - 下架日（台灣時間 00:00）起：一律視為已下架 → E_LLM_MODEL_DEPRECATED
// 要調整日期或替代寫法只改這裡。replace：別名 → 建議的替代別名
export const LLM_SUNSET = {
  date: '2027-01-01',
  family: 'qwen 系列',
  gateway_models: ['Qwen3.6:27B', 'qwen3:32b'],
  replace: {
    qwen3627b: 'nemotron35', qwen332b: 'nemotron35',
    tqwen3627b: 'tnemotron35', 'tqwen3627b-low': 'tnemotron35-low', 'tqwen3627b-medium': 'tnemotron35-medium', 'tqwen3627b-high': 'tnemotron35-high',
    tqwen332b: 'tnemotron35'
  }
};
// 下架日是否已到（now 可由 policy.now 帶入，測試用；預設現在時間）
export function sunsetPassed(now) {
  const t = now ? new Date(now).getTime() : Date.now();
  return t >= Date.parse(`${LLM_SUNSET.date}T00:00:00+08:00`);
}
// 別名（已套用 LLM_ALIASES）或閘道模型 id 是否為落日模型；回 { replacement } 或 null
export function sunsetModel(name) {
  const m = String(name || '').toLowerCase();
  if (!m) return null;
  if (LLM_SUNSET.replace[m]) return { replacement: LLM_SUNSET.replace[m] };
  if (LLM_SUNSET.gateway_models.some(g => g.toLowerCase() === m)) return { replacement: 'nemotron35' };
  return null;
}
// 只掛在 LlmGateway 的模型代號（平台 TempHtml.js LLM_GATEWAY_ONLY_MODELS、attachbox.js GATEWAY_VISION_MODELS）：
// 沒有 Gateway 的站台 LLMQUERY 不送出，LLMvision／LLMATTACH 改用預設 gemma3:12b；請求上限見 GATEWAY_MODEL_MAX_BYTES
export const GATEWAY_ONLY_MODELS = ['nemotron35', 'tnemotron35', 'tnemotron35-low', 'tnemotron35-medium', 'tnemotron35-high'];
// Gateway 模型的請求本體上限（平台 attachbox.js GATEWAY_MODEL_TRAITS；Nemotron 上游 8 MiB，2026-11-17 實測）
export const GATEWAY_MODEL_MAX_BYTES = { 'Nemotron-3.5-Super-VL': 8 * 1024 * 1024 };
// 舊別名（20260103 收斂政策後導向 qwen3:32b；qwen 系列已列落日 → 同樣回報 LLM_SUNSET）
export const LLM_ALIASES = {
  '70b': 'qwen332b', qwen3a3b: 'qwen332b', tqwen3a3b: 'tqwen332b',
  ...Object.fromEntries(['gpt-oss-120b', 'gpt-oss-20b'].flatMap(b => ['', '-low', '-medium', '-high'].map(s => [b + s, 'tqwen332b'])))
};
// 已移除，會落回預設模型（20260905）
export const LLM_REMOVED = ['medgemma:27b', 'gemma3_27b', 'gemma4_31b', 'tgemma4_31b'];
export const VISION_MODELS = { '': 'gemma3:12b（預設）', gemma3: 'gemma3', gemma3_12b: 'gemma3:12b', medgemma: 'medgemma:4b_vision',
  nemotron35: 'Nemotron-3.5-Super-VL（不思考，只經 Gateway）' };
export const ASR_PROVIDERS = ['ASUS'];
// 已下架的語音服務（院內 QWEN 語音服務 2026-10 底下架）：回 E_ASR_PROVIDER 並說明原因
export const ASR_REMOVED = { QWEN: '已於 2026-10 底下架' };
// LLMATTACH 的模型代號（平台 web/js/attachbox.js VISION_MODELS＋GATEWAY_VISION_MODELS）：LLMvision 的代號再加 tnemotron35（思考）。
// 不在表內的名稱不會被改成預設——經 LlmGateway 時原樣當模型 id 送出，直連時才改用預設；院外站台一律用使用者在「LLM 服務設定」選的模型
export const ATTACH_MODELS = { ...VISION_MODELS, tnemotron35: 'Nemotron-3.5-Super-VL（思考，只經 Gateway）' };
// 附件容器可放入的類型（控制項 JSON 的 attachkinds，逗號分隔；沒有這個欄位的舊容器只收影像）
export const ATTACH_KINDS = ['image', 'pdf', 'sheet', 'text', 'audio'];
export const ATTACH_KIND_LABELS = { image: '影像', pdf: 'PDF', sheet: 'Excel／CSV', text: '文字', audio: '音檔' };
