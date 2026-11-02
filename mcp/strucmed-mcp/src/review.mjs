// 預覽審閱（docs/15 §2.1、§3.2）：form_preview(html) 的 <draft_id>.meta.json 與 form_review_read 的解讀。
// review 檔由預覽頁寫入，內容是使用者的話：這裡只轉成工具呼叫的建議，不執行，也不把 values 寫到別的地方。
import fs from 'node:fs';
import path from 'node:path';
import { E, fail } from './errors.mjs';
import { fieldMap } from './fieldmap.mjs';
import { areaNode, findControl, isControl, walk } from './formtree.mjs';
import { captions, labelFormula } from './formula-explain.mjs';
import * as dc from './dictcomment.mjs';

const metaPath = (ws, id) => path.join(ws.base, 'preview', id + '.meta.json');
export const reviewDir = (ws, id) => path.join(ws.base, 'review', id);
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// harness 寫的 <workspace>/.strucmed/preview/server.json（實際的埠）。本 MCP 不連線，只用 pid 判斷它還在不在
export function previewServer(ws) {
  const s = readJson(path.join(ws.base, 'preview', 'server.json'));
  if (!s || !Number.isInteger(s.port) || !Number.isInteger(s.pid)) return null;
  try { process.kill(s.pid, 0); return s; } catch (e) { return e.code === 'EPERM' ? s : null; }
}

// 這個 draft 已經有過第幾次意見（review 目錄裡最大的 seq）；還沒有回 0
export function lastReviewSeq(ws, id) {
  const dir = reviewDir(ws, id);
  return fs.existsSync(dir) ? Math.max(0, ...fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).map(f => parseInt(f, 10))) : 0;
}

// review.md「## 試算」的 JSON（agents/form-reviewer.md）；不是合法的內容回 null
function parseTrial(text) {
  const head = /^##\s*試算\s*$/m.exec(text);
  if (!head) return null;
  const rest = text.slice(head.index + head[0].length), end = rest.search(/^##\s/m);
  const section = end < 0 ? rest : rest.slice(0, end), fence = /```(?:json)?\s*([\s\S]*?)```/.exec(section);
  try { const j = JSON.parse(fence ? fence[1] : section); return Array.isArray(j) ? j.filter(f => f && Number.isInteger(Number(f.itemid))) : null; } catch { return null; }
}
// 找這個 draft 的 review.md：plans/<draft_id>/ 優先；草案資料夾是 slug，draft_id 不一定寫在裡面，所以比對內容（同 itemid、同計算式），最新的優先
export function reviewFormulas(ws, d) {
  const plans = path.join(ws.base, 'plans');
  const own = new Map();
  walk(d, n => { if (isControl(n) && n.formula) own.set(Number(n.itemid), n.formula); });
  const files = (fs.existsSync(plans) ? fs.readdirSync(plans) : []).map(x => ({ dir: x, file: path.join(plans, x, 'review.md') })).filter(x => fs.existsSync(x.file))
    .sort((a, b) => Number(b.dir === d.draft_id) - Number(a.dir === d.draft_id) || fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
  for (const { dir, file } of files) {
    const list = parseTrial(fs.readFileSync(file, 'utf8'));
    if (list && (dir === d.draft_id || list.some(f => own.get(Number(f.itemid)) === f.formula))) return { formulas: list, file: path.relative(ws.root, file) };
  }
  return { warning: 'W_REVIEW_FORMULAS：找不到這個 draft 的 review.md「## 試算」（或內容不是合法的 JSON）；預覽頁的計算式沒有試算例，由 runtime 現場算' };
}

// 計算式清單：formulas 參數優先；沒帶時沿用上一份 meta 的試算（計算式沒變才算數），否則 samples 空。
// 帶了 formula 而與 draft 不同的試算是舊的（review.md 可能落後），不採用；reviewer 縮寫（含 …）的公式不比對
function formulaList(d, given, prev, stale) {
  const names = captions(d);
  const passed = new Map((given || []).map(f => [Number(f.itemid), f]));
  const old = new Map(((prev && prev.formulas) || []).map(f => [Number(f.itemid), f]));
  const out = [];
  walk(d, n => {
    if (!isControl(n) || n.datatype !== 'label' || !n.formula) return;
    const id = Number(n.itemid), o = old.get(id);
    let p = passed.get(id);
    if (p && p.formula && !String(p.formula).includes('…') && p.formula !== n.formula) { stale.push(id); p = undefined; }
    let labeled = n.formula;
    try { labeled = labelFormula(n.formula, names); } catch { /* 語法錯誤的計算式留給 form_validate */ }
    out.push({ itemid: id, formula: n.formula, labeled: (p && p.labeled) || labeled,
      samples: p && Array.isArray(p.samples) ? p.samples : o && o.formula === n.formula ? o.samples : [] });
  });
  return out;
}

// form 是這次寫給預覽頁的表單 JSON（toFormJson）；histext 以它的 iot 為準（改版 draft 沿用來源設定）
export function writeMeta(ws, d, form, idx, policy, { applied_seq, formulas } = {}) {
  const file = metaPath(ws, d.draft_id);
  const prev = readJson(file);
  const iot = form.find(x => x.itemtype === 'iot') || {};
  const stale = [];
  const meta = {
    v: 1, draft_id: d.draft_id, name: d.meta.name, updated_at: d.updated || d.created,
    applied_seq: applied_seq !== undefined ? applied_seq : (prev && prev.applied_seq) || 0,   // 沒帶時不退回，否則已套用的意見又變成待處理
    histext: iot.f_histext || 'histextbyblock',
    his_text_keys: d.meta.hisTextKeys || [],
    pending_dictionaries: (d.pendingDictionaries || []).map(p => p.name),
    areas: d.areas.map(a => { const n = areaNode(a); return { itemid: Number(n.itemid), type: n.itemtype, title: a.title || '', gettext: n.gettext !== false }; }),
    fields: fieldMap(d, idx, policy).fields,
    formulas: formulaList(d, formulas, prev, stale)
  };
  fs.writeFileSync(file, JSON.stringify(meta));
  return { meta_file: path.relative(ws.root, file), review_dir: path.relative(ws.root, reviewDir(ws, d.draft_id)), stale_formulas: stale };
}

// 預覽頁把選項改了文字：計算式與巨集常以字串比對選項值，這些要跟著改
function optionRefs(d, before, after) {
  const changed = before.filter((v, i) => v !== after[i]);
  const hits = [];
  walk(d, n => {
    if (!isControl(n)) return;
    const text = `${n.formula || ''} ${n.actionScript || ''}`;
    if (changed.some(v => text.includes(`"${v}"`) || text.includes(`'${v}'`))) hits.push(Number(n.itemid));
  });
  return hits;
}
// 改選項文字時保留連動（further）：form_update_control 以字串陣列取代時連動會被清掉
function optionArgs(node, after) {
  const opts = Array.isArray(node.option) ? node.option.filter(o => (o && typeof o === 'object' ? String(o.value ?? '') : String(o))) : [];
  return after.map((value, i) => {
    const further = opts[i] && typeof opts[i] === 'object' ? String(opts[i].further ?? '').split(',').map(s => s.trim()).filter(Boolean).map(Number) : [];
    return further.length ? { value, further } : value;
  });
}

export function readReview(ws, d, seq, idx, policy) {
  const dir = reviewDir(ws, d.draft_id);
  const wanted = seq === undefined || seq === null || seq === '' ? null : Number(seq);
  if (wanted !== null && !(Number.isInteger(wanted) && wanted > 0)) fail(E.INVALID_INPUT, `seq 必須是正整數：${seq}`);
  const file = path.join(dir, wanted === null ? 'latest.json' : String(wanted).padStart(3, '0') + '.json');
  if (!fs.existsSync(file)) fail(E.NOT_FOUND, wanted === null ? `draft ${d.draft_id} 還沒有送出過意見` : `找不到第 ${wanted} 次意見`);
  let review;
  try { review = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(E.INVALID_INPUT, `意見檔不是合法的 JSON：${e.message}`); }
  if (!review || typeof review !== 'object' || !Array.isArray(review.items) || review.draft_id !== d.draft_id) fail(E.INVALID_INPUT, '意見檔格式不正確（缺 items，或 draft_id 不符）');

  const applied = (readJson(metaPath(ws, d.draft_id)) || {}).applied_seq || 0;
  const pending_seqs = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).map(f => parseInt(f, 10)).filter(n => n > applied).sort((a, b) => a - b);
  const byId = new Map(fieldMap(d, idx, policy).fields.map(f => [f.itemid, f]));
  const areaTitle = id => { const a = d.areas.find(x => Number(areaNode(x).itemid) === Number(id)); return a ? a.title || '' : ''; };
  const draft_id = d.draft_id;
  const suggested_calls = [], comments = [], warnings = [], memoByDic = new Map();
  const stale = msg => warnings.push(`W_REVIEW_STALE：${msg}`);
  // 按「送出意見」但什麼都沒改：不是定稿，要問使用者（F-38）；status=finalize 沒有修改是正常的定稿
  if (!review.items.length && review.status !== 'finalize') warnings.push(`W_REVIEW_EMPTY：第 ${review.seq} 次意見沒有任何修改或意見，不是定稿；請問使用者要不要定稿`);
  const update = (item, args) => suggested_calls.push({ item, tool: 'form_update_control', args: { draft_id, ...args } });

  review.items.forEach((it, item) => {
    if (!it || typeof it !== 'object') return warnings.push(`W_REVIEW_ITEM：第 ${item} 筆不是物件，略過`);
    if (it.kind === 'comment') {
      const text = String(it.text ?? '');
      if (it.itemid !== undefined) comments.push({ item, scope: 'control', itemid: Number(it.itemid), caption: (byId.get(Number(it.itemid)) || {}).caption || '', text });
      else if (it.area !== undefined) comments.push({ item, scope: 'area', area: Number(it.area), title: areaTitle(it.area), text });
      else comments.push({ item, scope: 'form', text });
      return;
    }
    const itemid = Number(it.itemid), f = byId.get(itemid), hit = findControl(d, itemid);
    if (!f || !hit) return stale(`第 ${item} 筆：#${it.itemid} 已不在 draft`);
    const after = it.after;
    if (it.kind === 'caption') {
      if (typeof after !== 'string' || /[\r\n]/.test(after)) return warnings.push(`W_REVIEW_ITEM：第 ${item} 筆的說明文字不是單行字串，略過`);
      update(item, { itemid, label_text: after });
    } else if (it.kind === 'default') {
      update(item, { itemid, changes: { datavalue: String(after ?? '') } });
    } else if (it.kind === 'required') {
      update(item, { itemid, changes: { required: !!after } });
    } else if (it.kind === 'options') {
      const cur = f.options || [];
      if (JSON.stringify(cur) === JSON.stringify(after)) return;    // 已套用過
      if (JSON.stringify(cur) !== JSON.stringify(it.before)) return stale(`第 ${item} 筆：#${itemid} 的選項已改成 ${cur.join('／')}，使用者看的是舊版；不產生修改，請使用者重新整理後再確認`);
      if (!Array.isArray(after) || after.length !== cur.length || after.some(x => typeof x !== 'string' || !x.trim())) return warnings.push(`W_REVIEW_ITEM：第 ${item} 筆的選項必須與原選項同長度且不可空白，略過`);
      const refs = optionRefs(d, cur, after);
      if (refs.length) warnings.push(`W_REVIEW_OPTION_REF：#${itemid} 改了選項文字，但 ${refs.map(id => '#' + id).join('、')} 的計算式或巨集用字串比對舊選項，要一起改`);
      update(item, { itemid, changes: { options: optionArgs(hit.node, after) } });
    } else if (it.kind === 'memo' || it.kind === 'fhir') {
      const n = hit.node, isMemo = it.kind === 'memo';
      if (it.dic_id && n.dicid !== it.dic_id) return stale(`第 ${item} 筆：#${itemid} 已不是綁字典 ${String(it.dic_id).slice(0, 8)}…`);
      const check = { memo: isMemo ? after : {}, ...(!isMemo && { fhir: after }) };
      if (n.dicid) {
        // 既有字典的補述不在 draft 裡：收進 memo_items，G2 與上架一起寫
        const row = memoByDic.get(n.dicid) || { dic_id: n.dicid };
        if (isMemo) row.memo = { ...row.memo, ...after }; else row.fhir = after;
        memoByDic.set(n.dicid, row);
        if (idx && idx.entries.some(e => e.id === n.dicid)) suggested_calls.push({ item, tool: 'dictionary_memo_check', args: { ...check, dic_id: n.dicid, draft_id, itemid } });
        else warnings.push(`W_DICT_NOT_IN_INDEX：字典 ${String(n.dicid).slice(0, 8)}… 不在本機索引，無法先檢查補述`);
      } else if (n.dictionary && (d.pendingDictionaries || []).some(p => p.name === n.dictionary)) {
        const pend = d.pendingDictionaries.find(p => p.name === n.dictionary);
        let full = after;
        if (isMemo) { try { full = dc.mergeMemo(pend.memo, after) || {}; } catch { /* 內容不合法：留給 dictionary_memo_check 報錯 */ } }
        suggested_calls.push({ item, tool: 'dictionary_memo_check', args: { ...check, ...(isMemo && { memo: full }), draft_id, itemid },
          then: { tool: 'form_update_control', args: { draft_id, itemid, changes: { dictionary: { name: n.dictionary, ...(isMemo ? { memo: after } : { fhir: after }) } } } } });
      } else stale(`第 ${item} 筆：#${itemid} 已沒有綁字典`);
    } else warnings.push(`W_REVIEW_ITEM：第 ${item} 筆的 kind「${it.kind}」不認識，略過`);
  });
  return { review, pending_seqs, suggested_calls, comments, memo_items: [...memoByDic.values()], warnings };
}
