// 3.9.1 少重建、重建不丟東西（docs/16 M7～M12）：搬動與區塊工具、form_create(from_draft_id)、applied_seq 保護、補述自動檢查、Big5 預檢、review.md 的試算。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dc from '../src/dictcomment.mjs';
import { SUBSTITUTES, isStorable, replaceUnstorable } from '../src/cp950.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'fixtures/existing-form.json'), 'utf8');
const DIC = 'bbbbbbbb-0000-0000-0000-000000000001';
let ws, t, store, model;

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-rebuild-'));
  process.env.STRUCMED_WORKSPACE = ws;
  t = Object.fromEntries((await import('../src/tools.mjs')).TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  model = await import('../src/model.mjs');
  fs.writeFileSync(path.join(ws, 'src.json'), SRC);
  store.saveDictIndex({ loadedAt: '2026-11-02', source: 'test', deptNo: 'TEST0', hasIds: true, deleted: 0, warnings: [], duplicates: [], entries: [
    { id: DIC, dicType: 'TEST0', dicName: '身高', dicComment: dc.build({ desc: '身高', memo: { unit: 'cm' } }), createDate: '20250101' }
  ] });
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

// 文字區塊 #A：#b1 甲、#b2 乙、#b3 丙＝甲＋乙
function draft() {
  const { draft_id } = t.form_create({ name: '搬動', dept_no: 'TEST0' });
  const A = t.form_add_area({ draft_id, title: '第一區', visible_title: true }).area_itemid;
  const add = (area_itemid, label_text, control = { datatype: 'numberbox' }, extra = {}) => t.form_add_control({ draft_id, area_itemid, label_text, control, ...extra }).itemid;
  const b1 = add(A, '甲：'), b2 = add(A, '乙：');
  const b3 = add(A, '丙：', { datatype: 'label', format: 'formula', formula: `A${b1} + A${b2}` });
  return { draft_id, A, b1, b2, b3, add };
}
const stream = (draft_id, area) => {
  const a = store.loadDraft(draft_id).areas.find(x => Number(x.imported ? x.area.itemid : x.itemid) === area);
  return (a.items || a.area.item).map(n => n.itemid !== undefined ? `#${n.itemid}` : n.datatype === 'text' ? n.datavalue : '↵');
};
const areaIds = id => store.loadDraft(id).areas.map(a => Number(a.imported ? a.area.itemid : a.itemid));

test('form_move_control：同區塊換順序、0＝最前面，itemid 不變，說明文字跟著走，參照不受影響', () => {
  const { draft_id, A, b1, b2, b3 } = draft();
  const next = store.loadDraft(draft_id).nextItemId;
  const r = t.form_move_control({ draft_id, itemid: b3, to_area_itemid: A, after_itemid: b1 });
  assert.equal(r.itemid, b3);
  assert.deepEqual(stream(draft_id, A), ['第一區', '↵', '甲：', `#${b1}`, '↵', '丙：', `#${b3}`, '↵', '乙：', `#${b2}`, '↵']);
  t.form_move_control({ draft_id, itemid: b2, to_area_itemid: A, after_itemid: 0 });
  assert.deepEqual(stream(draft_id, A), ['乙：', `#${b2}`, '↵', '第一區', '↵', '甲：', `#${b1}`, '↵', '丙：', `#${b3}`, '↵']);
  t.form_move_control({ draft_id, itemid: b2, to_area_itemid: A });
  assert.deepEqual(stream(draft_id, A).slice(-3), ['乙：', `#${b2}`, '↵']);
  const d = store.loadDraft(draft_id);
  assert.equal(d.nextItemId, next, '不占用新 itemid');
  assert.ok(d.touchedFields[b3].includes('moved'));
  const v = t.form_validate({ draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(t.form_fields({ draft_id }).fields.find(f => f.itemid === b3).refs_out.length, 2);
});

test('form_move_control：搬到固定表格與頁籤的格子；同一行的後綴文字跟著走', () => {
  const { draft_id, A, b1, b2, add } = draft();
  const unit = add(A, '體重：', { datatype: 'numberbox' }, { newline_after: false });
  const p = store.loadDraft(draft_id);
  const items = p.areas[0].items;
  items.push({ datatype: 'text', datavalue: ' kg' }, { datatype: 'newline' });
  store.saveDraft(p);
  const table = t.form_add_area({ draft_id, type: 'formtable', rows: ['3,3'] }).area_itemid;
  const tab = t.form_add_area({ draft_id, type: 'tab2', titles: ['一', '二'] }).area_itemid;
  t.form_move_control({ draft_id, itemid: unit, to_area_itemid: table, cell: { row: 0, col: 1 } });
  const cell = store.loadDraft(draft_id).areas[1].area.item[0].item[1].item;
  assert.deepEqual(cell.map(n => n.itemid ?? n.datavalue), ['體重：', unit, ' kg']);
  assert.ok(!stream(draft_id, A).includes(' kg'), '後綴不留在原處');
  t.form_move_control({ draft_id, itemid: b1, to_area_itemid: tab, cell: { index: 1 } });
  t.form_move_control({ draft_id, itemid: b2, to_area_itemid: tab, cell: { index: 1 }, after_itemid: b1 });
  const second = store.loadDraft(draft_id).areas[2].area.item[1].item;
  assert.deepEqual(second.map(n => n.itemid ?? n.datavalue ?? '↵'), ['甲：', b1, '↵', '乙：', b2]);
  assert.throws(() => t.form_move_control({ draft_id, itemid: b1, to_area_itemid: table }), { code: 'E_UNSUPPORTED_DATATYPE' }, '表格沒有 cell');
  assert.throws(() => t.form_move_control({ draft_id, itemid: b1, to_area_itemid: tab, cell: { index: 1 }, after_itemid: 999 }), { code: 'E_NOT_FOUND' });
  assert.throws(() => t.form_move_control({ draft_id, itemid: b1, to_area_itemid: tab, cell: { index: 1 }, after_itemid: b1 }), { code: 'E_INVALID_INPUT' });
  assert.throws(() => t.form_move_control({ draft_id, itemid: 999, to_area_itemid: tab }), { code: 'E_NOT_FOUND' });
  assert.equal(t.form_validate({ draft_id }).valid, true, JSON.stringify(t.form_validate({ draft_id }).errors));
});

test('form_move_control：搬進動態表格的限制與 form_add_control 相同', () => {
  const { draft_id, A, b1, b3, add } = draft();
  const dict = add(A, '身高：', { datatype: 'numberbox', dictionary: { id: DIC } });
  const free = add(A, '備註：', { datatype: 'textbox' });
  const table = t.form_add_area({ draft_id, type: 'table1', titles: ['欄'] }).area_itemid;
  const move = itemid => t.form_move_control({ draft_id, itemid, to_area_itemid: table, cell: { index: 0 } });
  assert.throws(() => move(dict), /不上傳 HIS/);
  assert.throws(() => move(b3), /計算式、HIS 參照與巨集/);
  assert.throws(() => move(b1), /被計算式或巨集引用/);
  const before = stream(draft_id, A);
  const r = move(free);
  assert.match(r.warnings[0], /^W_MOVED_TOCALC/);
  assert.equal(store.loadDraft(draft_id).areas[1].area.item[0].item.find(n => n.itemid === free).tocalc, false);
  assert.equal(stream(draft_id, A).length, before.length - 3);
  assert.equal(t.form_validate({ draft_id }).valid, true);
});

test('form_move_control：原表單的串流（結尾沒有換行）不多留換行；群組子項不能搬；既有字典不誤報', () => {
  const { draft_id } = t.form_import({ source_path: 'src.json', name: '改版搬動', dept_no: 'TEST0' });
  t.form_move_control({ draft_id, itemid: 9, to_area_itemid: 1, after_itemid: 2 });
  const s = stream(draft_id, 1);
  assert.notEqual(s[s.length - 1], '↵', '結尾沒有換行');
  assert.deepEqual(s.slice(0, 6), ['體重：', '#2', '↵', '舊參照：', '#9', '↵']);
  t.form_move_control({ draft_id, itemid: 2, to_area_itemid: 1 });
  assert.deepEqual(stream(draft_id, 1).slice(-3), ['↵', '體重：', '#2']);
  assert.ok(!t.form_validate({ draft_id }).errors.some(e => e.code === 'E_DICT_UNKNOWN_ID'), '搬動不算改字典，索引沒有的舊字典不升級成 error');
  assert.throws(() => t.form_move_control({ draft_id, itemid: 13, to_area_itemid: 1 }), /子項/);
  // 同一行的兩個控制項：搬前一個，後一個留在原行
  t.form_move_control({ draft_id, itemid: 5, to_area_itemid: 1, after_itemid: 0 });
  assert.deepEqual(stream(draft_id, 1).slice(0, 3), ['過敏：', '#5', '↵']);
  assert.ok(stream(draft_id, 1).includes('#6'));
});

test('form_update_area：改標題連同可見標題行、visible_title 開關、hidden、原表單的權限不改', () => {
  const { draft_id, A, b1 } = draft();
  const r = t.form_update_area({ draft_id, itemid: A, title: '基本資料' });
  assert.deepEqual([r.title, r.visible_title], ['基本資料', true]);
  assert.deepEqual(stream(draft_id, A).slice(0, 2), ['基本資料', '↵']);
  assert.equal(t.form_update_area({ draft_id, itemid: A, visible_title: false }).visible_title, false);
  assert.equal(stream(draft_id, A)[0], '甲：');
  assert.equal(t.form_update_area({ draft_id, itemid: A, visible_title: true }).visible_title, true);
  assert.deepEqual(stream(draft_id, A).slice(0, 3), ['基本資料', '↵', '甲：']);
  assert.equal(t.form_update_area({ draft_id, itemid: A, hidden: true }).hidden, true);
  assert.deepEqual(store.loadDraft(draft_id).areas[0].authread, []);
  assert.ok(!t.form_validate({ draft_id }).warnings.some(w => w.code === 'W_AREA_AUTH' && /顯示/.test(w.message)), '宣告 hidden 不算權限問題');
  t.form_update_area({ draft_id, itemid: A, hidden: false });
  assert.deepEqual(store.loadDraft(draft_id).areas[0].authread, ['doctor']);
  const table = t.form_add_area({ draft_id, type: 'tab1', titles: ['一'], title: '舊' }).area_itemid;
  t.form_update_area({ draft_id, itemid: table, title: '新', hidden: true });
  const a = store.loadDraft(draft_id).areas[1];
  assert.deepEqual([a.title, a.area.authread], ['新', []]);
  assert.throws(() => t.form_update_area({ draft_id, itemid: table, visible_title: true }), { code: 'E_UNSUPPORTED_DATATYPE' });
  assert.throws(() => t.form_update_area({ draft_id, itemid: A }), { code: 'E_INVALID_INPUT' });
  assert.throws(() => t.form_update_area({ draft_id, itemid: 999, title: 'x' }), { code: 'E_NOT_FOUND' });
  assert.throws(() => t.form_update_area({ draft_id, itemid: b1, title: 'x' }), { code: 'E_NOT_FOUND' }, 'itemid 要是區塊');
  const imp = t.form_import({ source_path: 'src.json', name: '改版區塊', dept_no: 'TEST0' }).draft_id;
  assert.throws(() => t.form_update_area({ draft_id: imp, itemid: 1, hidden: true }), /編輯器調整/);
  t.form_update_area({ draft_id: imp, itemid: 1, title: '原表單標題', visible_title: true });
  assert.deepEqual(stream(imp, 1).slice(0, 3), ['原表單標題', '↵', '體重：']);
});

test('form_remove_area：只刪空區塊；有控制項、說明文字或被連動引用時拒絕；不需要 confirm', () => {
  const { draft_id, A, b1, add } = draft();
  const empty = t.form_add_area({ draft_id, title: '空區塊', visible_title: true }).area_itemid;
  const blank = t.form_add_area({ draft_id, type: 'formtable', rows: ['3,3'] }).area_itemid;
  assert.deepEqual(t.form_remove_area({ draft_id, itemid: empty }), { removed_area: empty, areas_left: 2 }, '只有可見標題行也算空');
  t.form_remove_area({ draft_id, itemid: blank });
  assert.deepEqual(areaIds(draft_id), [A]);
  assert.throws(() => t.form_remove_area({ draft_id, itemid: A }), e => e.code === 'E_INVALID_INPUT' && e.details.controls.includes(b1));
  assert.throws(() => t.form_remove_area({ draft_id, itemid: 999 }), { code: 'E_NOT_FOUND' });

  const texts = t.form_add_area({ draft_id, title: '說明' }).area_itemid;
  const d = store.loadDraft(draft_id);
  d.areas[1].items.push({ datatype: 'text', datavalue: '請先確認同意書' });
  store.saveDraft(d);
  assert.throws(() => t.form_remove_area({ draft_id, itemid: texts }), /說明文字/);

  const linked = t.form_add_area({ draft_id, title: '連動目標' }).area_itemid;
  const radio = add(A, '有無：', { datatype: 'radiobutton', options: [{ value: '有', further: [linked] }, '無'] });
  assert.throws(() => t.form_remove_area({ draft_id, itemid: linked }), { code: 'E_REF_BROKEN' });
  t.form_update_control({ draft_id, itemid: radio, changes: { options: ['有', '無'] } });
  t.form_remove_area({ draft_id, itemid: linked });
  assert.equal(store.loadDraft(draft_id).areas.length, 2);
  // 刪掉的 itemid 不回收
  const again = t.form_add_area({ draft_id }).area_itemid;
  assert.ok(again > linked);
});

test('form_add_area：after_itemid 插在指定區塊之後，0＝最前面', () => {
  const { draft_id, A } = draft();
  const last = t.form_add_area({ draft_id, title: '最後' }).area_itemid;
  const mid = t.form_add_area({ draft_id, title: '中間', after_itemid: A }).area_itemid;
  const first = t.form_add_area({ draft_id, type: 'tab1', titles: ['一'], after_itemid: 0 }).area_itemid;
  assert.deepEqual(areaIds(draft_id), [first, A, mid, last]);
  assert.throws(() => t.form_add_area({ draft_id, after_itemid: 999 }), { code: 'E_NOT_FOUND' });
  assert.deepEqual(model.toFormJson(store.loadDraft(draft_id), 'x').slice(0, 4).map(x => Number(x.itemid)), [first, A, mid, last]);
});

test('form_create(from_draft_id)：待新建字典的 desc、memo、fhir 與既有綁定依名稱帶過來；沒用到的不進待新建清單', () => {
  const fhir = [{ res: 'Observation', path: 'Observation.valueQuantity', ucum: 'kg' }];
  const { draft_id: old } = t.form_create({ name: '舊', dept_no: 'TEST0' });
  const a = t.form_add_area({ draft_id: old }).area_itemid;
  t.form_add_control({ draft_id: old, area_itemid: a, label_text: '體重：', control: { datatype: 'numberbox', dictionary: { name: 'BW_NEW', comment: '體重 kg', memo: { meaning: '當次體重', unit: 'kg' }, fhir } } });
  t.form_add_control({ draft_id: old, area_itemid: a, label_text: '腰圍：', control: { datatype: 'numberbox', dictionary: { name: 'WAIST_NEW', comment: '腰圍', memo: { meaning: '腰圍' } } } });
  t.form_add_control({ draft_id: old, area_itemid: a, label_text: '身高：', control: { datatype: 'numberbox', dictionary: { id: DIC } } });

  const r = t.form_create({ name: '新', dept_no: 'TEST0', from_draft_id: old });
  assert.deepEqual(r.carried, { from: old, pending: ['BW_NEW', 'WAIST_NEW'], bound: ['身高'] });
  const id = r.draft_id;
  assert.deepEqual(store.loadDraft(id).pendingDictionaries, [], '還沒有欄位用到，不會被建立');
  const area = t.form_add_area({ draft_id: id }).area_itemid;
  const w = t.form_add_control({ draft_id: id, area_itemid: area, label_text: '重量：', control: { datatype: 'numberbox', dictionary: { name: 'BW_NEW' } } });
  assert.ok(!w.warnings.some(x => x.startsWith('W_DICT_NO_DESC')), JSON.stringify(w.warnings));
  assert.deepEqual(store.loadDraft(id).pendingDictionaries, [{ name: 'BW_NEW', comment: '體重 kg', memo: { meaning: '當次體重', unit: 'kg' }, fhir }]);
  const h = t.form_add_control({ draft_id: id, area_itemid: area, label_text: '身長：', control: { datatype: 'numberbox', dictionary: { name: '身高' } } });
  assert.equal(h.dicid, DIC);
  // 新寫的鍵覆蓋、其他鍵保留
  const b = t.form_add_control({ draft_id: id, area_itemid: area, label_text: '腰：', control: { datatype: 'numberbox', dictionary: { name: 'WAIST_NEW', memo: { unit: 'cm' } } } });
  assert.ok(b.itemid);
  assert.deepEqual(store.loadDraft(id).pendingDictionaries[1].memo, { meaning: '腰圍', unit: 'cm' });
  // 再重建一次：還沒用到的也不丟
  const third = t.form_create({ name: '再新', dept_no: 'TEST0', from_draft_id: id });
  assert.deepEqual(third.carried.pending.sort(), ['BW_NEW', 'WAIST_NEW']);
  assert.throws(() => t.form_create({ name: 'x', dept_no: 'TEST0', from_draft_id: 'd-000000000000' }), { code: 'E_NOT_FOUND' });
  assert.equal(t.form_preview({ draft_id: id, format: 'tree' }).content.includes('carried'), false);
});

test('W_APPLIED_SEQ_RESET：新 draft 沒有意見時不採用傳入的 applied_seq；有意見時不超過最大值', () => {
  const { draft_id } = draft();
  const meta = () => JSON.parse(fs.readFileSync(path.join(ws, '.strucmed', 'preview', `${draft_id}.meta.json`), 'utf8'));
  const r = t.form_preview({ draft_id, format: 'html', applied_seq: 2 });
  assert.match(r.warnings[0], /^W_APPLIED_SEQ_RESET/);
  assert.equal(meta().applied_seq, 0);
  assert.deepEqual(t.form_preview({ draft_id, format: 'html', applied_seq: 0 }).warnings, []);
  const dir = path.join(ws, '.strucmed', 'review', draft_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001.json'), '{}');
  fs.writeFileSync(path.join(dir, 'latest.json'), '{}');
  assert.deepEqual(t.form_preview({ draft_id, format: 'html', applied_seq: 1 }).warnings, []);
  assert.equal(meta().applied_seq, 1);
  assert.match(t.form_preview({ draft_id, format: 'html', applied_seq: 5 }).warnings[0], /只有 1 次意見/);
  assert.equal(meta().applied_seq, 1);
});

test('帶 dictionary.memo 時自動檢查；dictionary_memo_check 只帶 itemid 時讀 draft 內的 memo', () => {
  const { draft_id, A, add } = draft();
  const r = t.form_add_control({ draft_id, area_itemid: A, label_text: '握力：', control: { datatype: 'numberbox', minval: 0, maxval: 100, dictionary: { name: 'GRIP_NEW', comment: '握力', memo: { meaning: '握力', range: '0-50', type: 'textbox' } } } });
  assert.ok(r.warnings.some(w => w.startsWith('W_MEMO_TYPE_MISMATCH')), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some(w => w.startsWith('W_MEMO_RANGE_MISMATCH')));
  const u = t.form_update_control({ draft_id, itemid: r.itemid, changes: { dictionary: { name: 'GRIP_NEW', memo: { type: 'numberbox', range: '0-100' } } } });
  assert.ok(!u.warnings.some(w => /W_MEMO_(TYPE|RANGE)_MISMATCH/.test(w)), JSON.stringify(u.warnings));
  assert.ok(!u.warnings.some(w => w.startsWith('W_DICT_NO_DESC')), 'F-29：desc 還在，不誤報');
  const c = t.dictionary_memo_check({ draft_id, itemid: r.itemid });
  assert.equal(c.checked, 'draft');
  assert.equal(c.merged.meaning, '握力');
  assert.ok(c.chars > 0);
  assert.ok(!c.warnings.some(w => w.code === 'W_MEMO_NO_MEANING'), '不是檢查空值');
  const none = add(A, '無字典：');
  assert.throws(() => t.dictionary_memo_check({ draft_id, itemid: none }), /沒有綁字典/);
  assert.throws(() => t.dictionary_memo_check({}), { code: 'E_INVALID_INPUT' });
  const bound = t.form_add_control({ draft_id, area_itemid: A, label_text: '身高：', control: { datatype: 'numberbox', dictionary: { id: DIC, memo: { unit: 'm' } } } });
  assert.ok(bound.warnings.some(w => w.startsWith('W_DICT_MEMO_IGNORED')), '既有字典的補述不在 draft，不靜默忽略');
  assert.equal(t.dictionary_memo_check({ draft_id, itemid: bound.itemid }).merged.unit, 'cm');
});

test('W_NON_BIG5：有對照的字元改寫並提示，沒有對照的仍然拒絕；dictionary_memo_check 只建議不改', () => {
  for (const ch of Object.keys(SUBSTITUTES)) { assert.equal(isStorable(ch), false, ch); assert.ok([...SUBSTITUTES[ch]].every(isStorable), SUBSTITUTES[ch]); }
  assert.equal(isStorable('°'), true, '° 倉儲存得下，不用換');
  assert.deepEqual(replaceUnstorable('≥18 歲 ≥ 1'), { text: '大於等於18 歲 大於等於 1', replaced: [{ char: '≥', to: '大於等於' }] });

  const { draft_id, A } = draft();
  const r = t.form_add_control({ draft_id, area_itemid: A, label_text: '年齡：', control: { datatype: 'numberbox', dictionary: { name: 'AGE_NEW', comment: '年齡≥18', memo: { range: '≥18 且 ≤120', asr: ['BMI kg/m²'] } } } });
  assert.deepEqual(r.warnings.filter(w => w.startsWith('W_NON_BIG5')).length, 4);
  assert.ok(r.warnings.some(w => /「≥」.*大於等於/.test(w)));
  const p = store.loadDraft(draft_id).pendingDictionaries.find(x => x.name === 'AGE_NEW');
  assert.equal(p.comment, '年齡大於等於18');
  assert.equal(p.memo.range, '大於等於18 且 小於等於120');
  assert.deepEqual(p.memo.asr, ['BMI kg/m^2']);
  assert.throws(() => t.form_add_control({ draft_id, area_itemid: A, control: { datatype: 'textbox', dictionary: { name: 'EMOJI_NEW', comment: '😀' } } }), { code: 'E_INVALID_INPUT' });

  const u = t.form_update_control({ draft_id, itemid: r.itemid, changes: { dictionary: { name: 'AGE_NEW', memo: { scope: '≥18' } } } });
  assert.ok(u.warnings.some(w => w.startsWith('W_NON_BIG5')));

  const c = t.dictionary_memo_check({ memo: { range: '≥18' } });
  assert.equal(c.ok, false);
  const w = c.warnings.find(x => x.code === 'W_NON_BIG5');
  assert.equal(w.suggestion, '大於等於');
  assert.match(c.errors[0].message, /建議改成「大於等於」/);
});

test('dictionary_plan_import：desc 與補述的非 Big5 字元改寫後套用，checks 列 W_NON_BIG5', () => {
  const { draft_id, A } = draft();
  t.form_add_control({ draft_id, area_itemid: A, label_text: '年齡：', control: { datatype: 'numberbox', dictionary: { name: 'AGE_CSV', comment: '年齡' } } });
  t.dictionary_plan_export({ draft_id });
  const file = path.join(ws, '.strucmed', 'plans', draft_id, 'dictionaries.csv');
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  const head = lines[0].replace(/^﻿/, '').split(',');
  const row = lines.find(l => l.startsWith('new,')).split(',');
  row[head.indexOf('range')] = '≥18';
  row[head.indexOf('desc')] = '年齡≤120';
  const r = t.dictionary_plan_import({ draft_id, csv_text: [lines[0], row.join(',')].join('\r\n') + '\r\n' });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.warnings.length, 2);
  assert.ok(r.checks[0].warnings.includes('W_NON_BIG5'));
  const p = store.loadDraft(draft_id).pendingDictionaries.find(x => x.name === 'AGE_CSV');
  assert.deepEqual([p.comment, p.memo.range], ['年齡小於等於120', '大於等於18']);
});

test('formulas_from_review：讀 review.md「## 試算」；草案資料夾是 slug 時以內容比對；公式已改時不採用', () => {
  const { draft_id, b1, b2, b3 } = draft();
  const formula = `A${b1} + A${b2}`;
  const write = (dir, list, tail = '') => {
    const p = path.join(ws, '.strucmed', 'plans', dir);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'review.md'), `# 審查 1\nStatus: Ready\n## 必須修正（error）\n無\n## 試算\n\`\`\`json\n${JSON.stringify(list)}\n\`\`\`\n${tail}`);
  };
  const meta = () => JSON.parse(fs.readFileSync(path.join(ws, '.strucmed', 'preview', `${draft_id}.meta.json`), 'utf8'));
  const none = t.form_preview({ draft_id, format: 'html', formulas_from_review: true });
  assert.ok(none.warnings.some(w => w.startsWith('W_REVIEW_FORMULAS')));

  const samples = [{ values: { [`A${b1}`]: 1, [`A${b2}`]: 2 }, expect: 3, value: 3, match: true }];
  write('別張表單', [{ itemid: b3, formula: 'A1 + 999', samples: [] }]);
  write('bmi-測試', [{ itemid: b3, formula, labeled: '[甲] + [乙]', samples }], '## 其他\n沒有\n');
  const r = t.form_preview({ draft_id, format: 'html', formulas_from_review: true });
  assert.equal(r.formulas_source, path.join('.strucmed', 'plans', 'bmi-測試', 'review.md'));
  assert.deepEqual(meta().formulas[0].samples, samples);
  assert.equal(meta().formulas[0].labeled, '[甲] + [乙]');

  // 參數 formulas 優先
  t.form_preview({ draft_id, format: 'html', formulas_from_review: true, formulas: [{ itemid: b3, samples: [] }] });
  assert.deepEqual(meta().formulas[0].samples, []);

  // review.md 落後於 draft：舊公式的試算不採用
  write(draft_id, [{ itemid: b3, formula: `A${b1} - A${b2}`, samples }]);
  const stale = t.form_preview({ draft_id, format: 'html', formulas_from_review: true });
  assert.ok(stale.warnings.some(w => w.startsWith('W_REVIEW_FORMULA_STALE')));
  // reviewer 縮寫的公式不比對
  write(draft_id, [{ itemid: b3, formula: `A${b1} + …`, samples }]);
  t.form_preview({ draft_id, format: 'html', formulas_from_review: true });
  assert.deepEqual(meta().formulas[0].samples, samples);
  // JSON 壞掉
  fs.writeFileSync(path.join(ws, '.strucmed', 'plans', draft_id, 'review.md'), '## 試算\n```json\n[{oops\n```\n');
  fs.rmSync(path.join(ws, '.strucmed', 'plans', 'bmi-測試'), { recursive: true });
  assert.ok(t.form_preview({ draft_id, format: 'html', formulas_from_review: true }).warnings.some(w => w.startsWith('W_REVIEW_FORMULAS')));
});
