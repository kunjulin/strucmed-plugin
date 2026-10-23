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
export const RUNTIME = {
  CHECKREQUIRED: 'setting', CKAUTOXML: 'setting', CKAUTODWLOOKUP: 'setting', CKAUTOUPLOAD: 'setting', CKIOTOW: 'setting',
  GETTEXT: 'context', GETVALUE: 'context', NOW2: 'context', NOWTIME: 'context',
  G_USERNM: 'context', G_USERID: 'context', G_CHTNO: 'context', G_DEPTNO: 'context', G_OPDNO: 'context',
  GETOPDNO: 'context', GETPACSNO: 'context', GETDEPTNO: 'context', GETUSER: 'context', GETCHTNO: 'context',
  HISQUERY: 'lookup', LOOKUPDW: 'lookup', DWLOOKUP: 'lookup', LOOKUPDEFAULTSETTING: 'lookup', SETLOOKUPDEFAULT: 'lookup',
  LOOKUPIOT: 'lookup', LOADDOC: 'lookup', LOADXML: 'lookup', SETDICTATIONBYID: 'lookup',
  SETVALUEBYID: 'write', APPLYPRESETBYNAME: 'write',
  LLMQUERY: 'ai',
  CUSTOMFUNC: 'forbidden', OPENURL: 'forbidden', SAVEDOC: 'forbidden', SETIOTHEADER: 'forbidden',
  S_USERID: 'forbidden', S_DEPTNO: 'forbidden'
};
// 內建函數中需要另外處理的
export const BUILTIN_POLICY = {
  SERVER: 'forbidden',   // 以 ajax 呼叫設定的伺服器
  GRAPH: 'forbidden'     // 需要 flot 繪圖套件，runtime 沒有載入
};
// 巨集步驟指令（區分大小寫的前綴）
export const STEP = { LLMQUERY: 'ai', LLMvision: 'ai', MACRO: 'write', VOICETOTEXT: 'ai' };

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
  gemma3_12b: 'gemma3:12b', medgemma: 'medgemma', qwen332b: 'qwen3:32b', tqwen332b: 'qwen3:32b（思考）',
  qwen3627b: 'Qwen3.6:27B', tqwen3627b: 'Qwen3.6:27B（思考）', 'tqwen3627b-low': 'Qwen3.6:27B（思考 low）',
  'tqwen3627b-medium': 'Qwen3.6:27B（思考 medium）', 'tqwen3627b-high': 'Qwen3.6:27B（思考 high）'
};
// 仍可用但只是別名（20260103 收斂政策後導向 qwen3:32b）
export const LLM_ALIASES = {
  '70b': 'qwen332b', qwen3a3b: 'qwen332b', tqwen3a3b: 'tqwen332b',
  ...Object.fromEntries(['gpt-oss-120b', 'gpt-oss-20b'].flatMap(b => ['', '-low', '-medium', '-high'].map(s => [b + s, 'tqwen332b'])))
};
// 已移除，會落回預設模型（20260905）
export const LLM_REMOVED = ['medgemma:27b', 'gemma3_27b', 'gemma4_31b', 'tgemma4_31b'];
export const VISION_MODELS = { '': 'gemma3:12b（預設）', gemma3: 'gemma3', gemma3_12b: 'gemma3:12b', medgemma: 'medgemma:4b_vision' };
export const ASR_PROVIDERS = ['ASUS', 'QWEN'];
