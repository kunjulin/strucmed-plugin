// 字典助手（plugin 3.7.0）：依欄位事實從本機字典索引排出候選字典（dictionary_suggest）。
// 只用確定的規則計分（名稱、說明與補述的字詞命中、控制項型別、單位、選項、層級、使用表單數），每一分都列在 reasons，讓 AI 與使用者看得懂為什麼推薦。
// 索引來源：online_dictionary_search(update_index:true；scope:'all' 會合併他科字典)或 dictionary_load；使用表單數來自 online_dictionary_usage（不帶 dic_id）。
import * as dc from './dictcomment.mjs';
import { deptTypes } from './dictionary.mjs';
import { compareUnits, parseUnit } from './units.mjs';

const LEVEL_BONUS = { sys: 8, own: 6, sub: 4, dpt: 3, system: 2, other: 0 };
const CJK = /[㐀-鿿]/;
const norm = s => String(s || '').toLowerCase().replace(/[\s（）()【】\[\]：:，,、。．.\/／\-_]/g, '');
// 說明文字或字典名稱中的單位：括號內（例「體重(kg)」）或結尾的常見單位
const UNIT_RE = /[（(]\s*([A-Za-z%°µμ/²³0-9.\s^]{1,12}|[次分秒時天週月年歲公斤克毫升公分公尺度]{1,4})\s*[)）]\s*[:：]?\s*$|\b(kg|g|mg|mcg|cm|mm|m|mmHg|bpm|%|mL|ml|L|°C|mg\/dL|mmol\/L|kg\/m2)\s*[:：]?\s*$/i;

// 對照表認得的優先（次/分、℃、分鐘、1.73m2 這些 UNIT_RE 抓不到）；查不到的括號內容不算單位，避免把「(右側)」當單位
const TAIL_PAREN = /[（(]\s*([^（）()]{1,20}?)\s*[)）]\s*[:：]?\s*$/;

export function unitOf(text) {
  const t = String(text || '');
  const paren = t.match(TAIL_PAREN);
  if (paren && parseUnit(paren[1])) return paren[1].trim();
  const last = t.replace(/[:：\s]+$/, '').split(/\s+/);
  if (last.length > 1 && parseUnit(last[last.length - 1])) return last[last.length - 1];
  const m = t.match(UNIT_RE);
  return m ? String(m[1] || m[2]).trim() : '';
}
// 詞：英數字串整段；中文取相鄰兩字（「體重測量」→ 體重、重測、測量）
function terms(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const han = [...t].filter(ch => CJK.test(ch));
  for (let i = 0; i + 1 < han.length; i++) out.add(han[i] + han[i + 1]);
  if (han.length === 1) out.add(han[0]);
  return [...out];
}
const memoText = m => (m ? Object.values(m).flat().join(' ') : '');

// high 才會在計畫中自動選用（使用者仍在 G1 確認）；他科字典再像也不自動選
const confidence = ({ sameName, conflict, level, score }) =>
  sameName && !conflict && level !== 'other' ? 'high' : score >= 25 && !conflict ? 'medium' : 'low';

// field：{ caption, datatype, unit, options, intent }；opts：{ deptNo, limit, usage:{counts}, include_other }
export function suggest(idx, field, opts = {}) {
  const entries = ((idx && idx.entries) || []).filter(e => e.dicName && !e.dicName.startsWith('__'));
  const deptNo = opts.deptNo || (idx && idx.deptNo) || '';
  const scopeTypes = deptTypes(deptNo);
  const counts = (opts.usage && opts.usage.counts) || {};
  const caption = norm(field.caption), bare = norm(String(field.caption || '').replace(/[（(][^）)]*[）)]/g, ''));   // bare：去掉括號內的單位
  const aliases = (Array.isArray(field.aliases) ? field.aliases : []).map(a => [a, norm(a)]).filter(([, n]) => n.length >= 2);
  const words = terms(`${field.caption || ''} ${field.intent || ''} ${aliases.map(([a]) => a).join(' ')}`);
  const results = [];
  for (const raw of entries) {
    const e = dc.enrich(raw, deptNo);
    const level = e.level || dc.level(e.dicType, deptNo, e.sys && e.sys.code);
    if (level === 'other' && !opts.include_other && !scopeTypes.includes(e.dicType)) continue;
    const reasons = [];
    let score = 0;
    const add = (n, why) => { if (n) { score += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`); } };
    const name = norm(e.dicName);
    const asr = (e.memo && e.memo.asr ? [].concat(e.memo.asr) : []).map(norm).filter(Boolean);
    const sameAsr = !!caption && !!(asr.includes(caption) || (bare && asr.includes(bare)));
    const sameName = !!caption && (name === caption || name === bare || sameAsr);
    if (sameAsr && !(name === caption || name === bare)) add(40, '欄位說明與補述的別名相同');
    else if (sameName) add(40, '名稱與欄位說明相同');
    else if (caption && name && (name.includes(caption) || caption.includes(name))) add(25, '名稱與欄位說明部分相同');
    if (!sameName) {
      const alias = aliases.find(([, n]) => n === name || asr.includes(n));
      if (alias) add(30, `別名「${alias[0]}」與字典名稱或補述別名相同`);
    }
    const hay = `${e.dicName} ${e.desc || ''} ${memoText(e.memo)}`.toLowerCase();
    const hits = words.filter(w => hay.includes(w));
    if (hits.length) add(Math.min(20, hits.length * 3), `名稱、說明或補述命中「${hits.slice(0, 6).join('、')}」`);
    if (!score) continue;                                   // 字面完全無關的不列
    const m = e.memo || {};
    const typeConflict = !!(field.datatype && m.type && m.type !== field.datatype), unitCmp = field.unit && m.unit ? compareUnits(m.unit, field.unit).kind : '', unitConflict = !!unitCmp && unitCmp !== 'same';
    if (field.datatype && m.type) add(m.type === field.datatype ? 10 : -10, m.type === field.datatype ? `補述的控制項也是 ${m.type}` : `補述的控制項是 ${m.type}（欄位是 ${field.datatype}）`);
    if (unitCmp) add(unitCmp === 'same' ? 8 : -8, unitCmp === 'same' ? `單位相同（${m.unit}）` : `單位不同（字典 ${m.unit}，欄位 ${field.unit}）`);
    if (Array.isArray(field.options) && field.options.length && m.range) {
      const n = field.options.filter(o => String(m.range).includes(o)).length;
      if (n) add(Math.min(6, n), `補述範圍包含 ${n} 個相同選項`);
    }
    add(LEVEL_BONUS[level] || 0, `層級：${dc.LEVEL_LABEL[level] || level}`);
    const used = Number(counts[e.id]) || 0;
    if (used) add(Math.min(10, Math.round(2 * Math.log2(1 + used))), `${used} 張表單在用`);
    if (!e.memo) add(-3, '沒有補述（引用前建議先補）');
    if (e.alias_of) reasons.push(`別名：綁定時會改綁 ${e.alias_of}`);
    results.push({
      id: e.id, name: e.dicName, dic_type: e.dicType, level, desc: e.desc || '', memo: e.memo || null, fhir: e.fhir || [], alias_of: e.alias_of || '', used_by: used,
      score, confidence: confidence({ sameName, conflict: typeConflict || unitConflict, level, score }), reasons,
      cite: {
        bind: { dictionary: { id: e.alias_of || e.id } },
        prompt: m.llm || [e.desc || e.dicName, m.unit && `（${m.unit}）`].filter(Boolean).join(''),
        ...(m.calx && { calx: m.calx }),
        ...(field.itemid !== undefined && { ref: `A${field.itemid}` })
      }
    });
  }
  results.sort((a, b) => b.score - a.score || dc.levelRank(a.level) - dc.levelRank(b.level) || b.used_by - a.used_by);
  return results.slice(0, Math.max(1, Math.min(Number(opts.limit) || 8, 30)));
}
