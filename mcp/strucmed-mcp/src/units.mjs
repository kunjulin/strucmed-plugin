// 單位比對：寫法不同但同一單位（kg／公斤）不算不同。代碼用 UCUM，與字典 fhir 的 ucum 欄位同一套。
// dim 相同才能換算，factor 是換算到該量的基準單位的倍率。不在表內的單位不猜，回 unknown。
// 「分」「度」不列：可能是分數、角度，無法只看單位判斷。
const U = (ucum, dim, factor, ...names) => ({ ucum, dim, factor, names: [ucum, ...names] });
const UNITS = [
  U('kg', 'mass', 1000, '公斤', '千克'), U('g', 'mass', 1, '公克', '克'), U('mg', 'mass', 0.001, '毫克'), U('ug', 'mass', 0.000001, 'mcg', '微克'),
  U('m', 'length', 100, '公尺', '米'), U('cm', 'length', 1, '公分', '釐米', '厘米'), U('mm', 'length', 0.1, '毫米', '公釐'),
  U('L', 'volume', 1000, '公升', '升'), U('mL', 'volume', 1, 'cc', '毫升'),
  U('a', 'time', 31536000, '年', '歲', 'y', 'yr', 'year'), U('mo', 'time', 2592000, '月', 'month'), U('wk', 'time', 604800, '週', '周', 'week'),
  U('d', 'time', 86400, '天', '日', 'day'), U('h', 'time', 3600, '時', '小時', 'hr'), U('min', 'time', 60, '分鐘'), U('s', 'time', 1, '秒', 'sec'),
  U('Cel', 'temperature', 0, '°c', '度c', '攝氏', '攝氏度'),
  U('mm[Hg]', 'pressure', 1, 'mmhg', '毫米汞柱'),
  U('/min', 'rate', 1, 'bpm', '次/分', '次/分鐘', '下/分', '下/分鐘', 'beats/min', 'breaths/min'),
  U('%', 'ratio', 1, '百分比'),
  U('g/L', 'massconc', 1), U('g/dL', 'massconc', 10), U('mg/dL', 'massconc', 0.01), U('mg/L', 'massconc', 0.001), U('ug/dL', 'massconc', 0.00001), U('ng/mL', 'massconc', 0.000001),
  U('mmol/L', 'molarconc', 1), U('mEq/L', 'eqconc', 1), U('U/L', 'enzyme', 1, 'iu/l'), U('uIU/mL', 'intlconc', 1, 'miu/l'),
  U('kg/m2', 'bmi', 1), U('m2', 'area', 1, 'm^2'), U('mL/min/1.73m2', 'egfr', 1),
  U('mL/h', 'flow', 1, 'ml/hr', 'cc/h', 'cc/hr'), U('mL/min', 'flow', 60, 'cc/min'), U('L/min', 'flow', 60000, 'lpm'),
  U('/uL', 'cellconc', 1), U('10*3/uL', 'cellconc', 1000, '10^3/ul', '10^9/l', 'k/ul'),
  U('mg/kg', 'dose', 1), U('gtt/min', 'drip', 1)
];
const clean = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '').replace(/／/g, '/').replace(/²/g, '2').replace(/³/g, '^3').replace(/[μµ]/g, 'u')
  .replace(/㎏/g, 'kg').replace(/㎝/g, 'cm').replace(/㎜/g, 'mm').replace(/㎎/g, 'mg').replace(/℃/g, '°c');
const TABLE = new Map(UNITS.flatMap(u => u.names.map(n => [clean(n), u])));

export const parseUnit = s => TABLE.get(clean(s)) || null;

// → { kind: 'same' } | { kind: 'convertible', factor }（1 a = factor b）| { kind: 'different' } | { kind: 'unknown' }
export function compareUnits(a, b) {
  if (clean(a) === clean(b)) return { kind: 'same' };
  const x = parseUnit(a), y = parseUnit(b);
  if (!x || !y) return { kind: 'unknown' };
  if (x === y) return { kind: 'same' };
  if (x.dim !== y.dim || !x.factor || !y.factor) return { kind: 'different' };
  return { kind: 'convertible', factor: Number((x.factor / y.factor).toPrecision(6)) };
}
