// 3.9.2：3.9.1 實跑（integration-3.9.1.md）的發現。F-03 頁籤改名不必重建、F-06 可見標題行被搬動後仍找得到、F-10／F-11 dictionary_suggest 回傳。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dc from '../src/dictcomment.mjs';

let ws, t, store;
const HEIGHT = 'cccccccc-0000-0000-0000-000000000001';

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-392-'));
  process.env.STRUCMED_WORKSPACE = ws;
  t = Object.fromEntries((await import('../src/tools.mjs')).TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  const memo = { meaning: '病人身高', type: 'label', unit: 'cm', range: '30–250', func: '供 BMI 計算', usecase: '門診初診', interop: '與身長(嬰兒)不同', asr: ['身高', 'BH'] };
  const others = Array.from({ length: 7 }, (_, i) => ({ id: `cccccccc-0000-0000-0000-00000000010${i}`, dicType: 'TEST0', dicName: `身高測量${i}`,
    dicComment: dc.build({ desc: `身高 ${i}`, memo: { meaning: `第 ${i} 種身高`, unit: 'cm', func: '很長的補述'.repeat(20) } }), createDate: '20250101' }));
  store.saveDictIndex({ loadedAt: '2026-11-03', source: 'test', deptNo: 'TEST0', hasIds: true, deleted: 0, warnings: [], duplicates: [], entries: [
    { id: HEIGHT, dicType: 'TEST0', dicName: '身高', dicComment: dc.build({ desc: '身高', memo }), createDate: '20250101' }, ...others
  ] });
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

const cells = (draft_id, area) => store.loadDraft(draft_id).areas.find(a => Number(a.itemid ?? a.area.itemid) === area).area.item;
const stream = (draft_id, area) => store.loadDraft(draft_id).areas.find(a => Number(a.itemid) === area).items
  .map(n => n.itemid !== undefined ? `#${n.itemid}` : n.datatype === 'text' ? n.datavalue : '↵');

function tabs() {
  const { draft_id } = t.form_create({ name: '頁籤改名', dept_no: 'TEST0' });
  const tab = t.form_add_area({ draft_id, type: 'tab1', titles: ['報告', '結論'] }).area_itemid;
  const ctl = (index, label_text) => t.form_add_control({ draft_id, area_itemid: tab, cell: { index }, label_text, control: { datatype: 'numberbox' } }).itemid;
  return { draft_id, tab, h: ctl(0, '身高：'), b: ctl(1, 'BMI：') };
}

test('F-03 form_update_area(titles)：頁籤改名，欄位留在原頁籤，itemid 不變', () => {
  const { draft_id, tab, h, b } = tabs();
  const next = store.loadDraft(draft_id).nextItemId;
  const r = t.form_update_area({ draft_id, itemid: tab, titles: ['report', 'impression'] });
  assert.deepEqual(r.titles, ['report', 'impression']);
  assert.deepEqual(r.mapping, [{ index: 0, title: 'report', from: 0, was: '報告' }, { index: 1, title: 'impression', from: 1, was: '結論' }]);
  assert.deepEqual(r.removed, []);
  const c = cells(draft_id, tab);
  assert.deepEqual(c.map(x => x.datatitle), ['report', 'impression']);
  assert.deepEqual([c[0].item.find(n => n.itemid !== undefined).itemid, c[1].item.find(n => n.itemid !== undefined).itemid].map(Number), [h, b]);
  assert.equal(store.loadDraft(draft_id).nextItemId, next, '不占用新 itemid');
  assert.equal(t.form_validate({ draft_id }).valid, true);
});

test('F-03 titles：同名保留原頁籤、可調換順序、新增空白頁籤、刪掉的頁籤有控制項就拒絕並列出 itemid', () => {
  const { draft_id, tab, h, b } = tabs();
  // 新增：多出來的是空白頁籤
  let r = t.form_update_area({ draft_id, itemid: tab, titles: ['報告', '結論', '備註'] });
  assert.deepEqual(r.mapping.map(m => m.from), [0, 1, null]);
  assert.ok(r.warnings.some(w => w.startsWith('W_EMPTY_CELL')));
  // 調換順序：名稱相同的跟著走
  r = t.form_update_area({ draft_id, itemid: tab, titles: ['結論', '報告', '備註'] });
  assert.deepEqual(r.mapping.map(m => m.from), [1, 0, 2]);
  assert.equal(Number(cells(draft_id, tab)[0].item.find(n => n.itemid !== undefined).itemid), b);
  // 刪掉空白的「備註」可以
  r = t.form_update_area({ draft_id, itemid: tab, titles: ['結論', '報告'] });
  assert.deepEqual(r.removed, [{ index: 2, title: '備註' }]);
  // 刪掉有欄位的「報告」拒絕，什麼都不改
  assert.throws(() => t.form_update_area({ draft_id, itemid: tab, titles: ['結論'] }),
    e => e.code === 'E_INVALID_INPUT' && /報告」#/.test(e.message) && e.details.removed[0].controls.includes(h));
  assert.deepEqual(cells(draft_id, tab).map(x => x.datatitle), ['結論', '報告']);
  // 名稱沒對上的依序沿用剩下的頁籤：結論保留，報告改名為 comment
  r = t.form_update_area({ draft_id, itemid: tab, titles: ['comment', '結論'] });
  assert.deepEqual(r.mapping, [{ index: 0, title: 'comment', from: 1, was: '報告' }, { index: 1, title: '結論', from: 0 }]);
  assert.equal(Number(cells(draft_id, tab)[0].item.find(n => n.itemid !== undefined).itemid), h);
});

test('F-03 titles：輸入檢查與適用的區塊類型、HIS 文字鍵提醒', () => {
  const { draft_id, tab } = tabs();
  assert.throws(() => t.form_update_area({ draft_id, itemid: tab, titles: [] }), { code: 'E_INVALID_INPUT' });
  assert.throws(() => t.form_update_area({ draft_id, itemid: tab, titles: ['a', 'a'] }), /不可重複/);
  assert.throws(() => t.form_update_area({ draft_id, itemid: tab, titles: ["it's"] }), /單引號/);
  assert.throws(() => t.form_update_area({ draft_id, itemid: tab, titles: [' '] }), /空白/);
  const form = t.form_add_area({ draft_id, title: '文字' }).area_itemid;
  const fixed = t.form_add_area({ draft_id, type: 'formtable', rows: ['3,3'] }).area_itemid;
  assert.throws(() => t.form_update_area({ draft_id, itemid: form, titles: ['x'] }), { code: 'E_UNSUPPORTED_DATATYPE' });
  assert.throws(() => t.form_update_area({ draft_id, itemid: fixed, titles: ['x'] }), { code: 'E_UNSUPPORTED_DATATYPE' });
  const dyn = t.form_add_area({ draft_id, type: 'table1', titles: ['藥名', '劑量'] }).area_itemid;
  assert.deepEqual(t.form_update_area({ draft_id, itemid: dyn, titles: ['藥名', '劑量', '頻次'] }).titles, ['藥名', '劑量', '頻次'], '動態表格的欄標題也可以改');
  // HIS 接收端要的鍵（his_text_keys）對不上時提醒
  t.form_update_meta({ draft_id, his_text_keys: ['report', 'impression'] });
  const r = t.form_update_area({ draft_id, itemid: tab, titles: ['report', '結論'] });
  assert.ok(r.warnings.some(w => w.startsWith('W_HIS_TEXT_KEYS') && w.includes('impression')));
  assert.ok(!t.form_update_area({ draft_id, itemid: tab, titles: ['report', 'impression'] }).warnings.some(w => w.startsWith('W_HIS_TEXT_KEYS')));
  // 3.9.3 F-08：改名後直接說是哪個頁籤改成什麼，給改好的清單
  const renamed = t.form_update_area({ draft_id, itemid: tab, titles: ['report', 'note'] });
  const w = renamed.warnings.find(x => x.startsWith('W_HIS_TEXT_KEYS'));
  assert.ok(w && w.includes('頁籤 impression 已改名 note'), w);
  assert.ok(w.includes('form_update_meta(his_text_keys: ["report","note"])'), w);
  // 刪掉的頁籤（空的）：說已刪除，建議清單拿掉
  t.form_update_area({ draft_id, itemid: tab, titles: ['report', 'note', 'tmp'] });
  t.form_update_meta({ draft_id, his_text_keys: ['report', 'note', 'tmp'] });
  const removed = t.form_update_area({ draft_id, itemid: tab, titles: ['report', 'note'] });
  const w2 = removed.warnings.find(x => x.startsWith('W_HIS_TEXT_KEYS'));
  assert.ok(w2 && w2.includes('頁籤 tmp 已刪除') && w2.includes('["report","note"]'), w2);
});

test('F-03 titles：原表單（form_import）的頁籤也能改名', async () => {
  const model = await import('../src/model.mjs');
  const { draft_id, h } = tabs();
  fs.writeFileSync(path.join(ws, 'tabs.json'), JSON.stringify(model.toFormJson(store.loadDraft(draft_id), 'test')));
  const imp = t.form_import({ source_path: 'tabs.json', name: '改版頁籤', dept_no: 'TEST0' }).draft_id;
  const a = store.loadDraft(imp).areas.find(x => x.area && x.area.itemtype === 'tab1');
  assert.ok(a.imported);
  const r = t.form_update_area({ draft_id: imp, itemid: Number(a.area.itemid), titles: ['report', 'impression'] });
  assert.deepEqual(r.titles, ['report', 'impression']);
  const c = store.loadDraft(imp).areas.find(x => x.area && x.area.itemtype === 'tab1').area.item;
  assert.equal(Number(c[0].item.find(n => n.itemid !== undefined).itemid), h);
});

test('F-06 改標題時依標記找可見標題行：欄位被搬到最前面後，標題行仍會一起改', () => {
  const { draft_id } = t.form_create({ name: '標題行', dept_no: 'TEST0' });
  const A = t.form_add_area({ draft_id, title: '甲', visible_title: true }).area_itemid;
  const x = t.form_add_control({ draft_id, area_itemid: A, label_text: '備註：', control: { datatype: 'textbox' } }).itemid;
  const mv = t.form_move_control({ draft_id, itemid: x, to_area_itemid: A, after_itemid: 0 });
  assert.ok(mv.warnings.some(w => w.startsWith('W_BEFORE_TITLE') && w.includes('「甲」')), JSON.stringify(mv.warnings));
  assert.deepEqual(stream(draft_id, A), ['備註：', `#${x}`, '↵', '甲', '↵']);
  const r = t.form_update_area({ draft_id, itemid: A, title: '乙' });
  assert.equal(r.visible_title, true);
  assert.equal(r.title_line, 3);
  assert.deepEqual(stream(draft_id, A), ['備註：', `#${x}`, '↵', '乙', '↵'], '標題行改成乙，說明文字「備註：」不動');
  // 拿掉再加回來：標題回到第一行
  t.form_update_area({ draft_id, itemid: A, visible_title: false });
  assert.deepEqual(stream(draft_id, A), ['備註：', `#${x}`, '↵']);
  t.form_update_area({ draft_id, itemid: A, visible_title: true });
  assert.deepEqual(stream(draft_id, A), ['乙', '↵', '備註：', `#${x}`, '↵']);
  // 沒有可見標題行的區塊搬到最前面不提醒
  const B = t.form_add_area({ draft_id, title: '丙' }).area_itemid;
  const y = t.form_add_control({ draft_id, area_itemid: B, label_text: '其他：', control: { datatype: 'textbox' } }).itemid;
  assert.deepEqual(t.form_move_control({ draft_id, itemid: y, to_area_itemid: B, after_itemid: 0 }).warnings, []);
  // 欄位搬走後只剩標題行仍算空區塊
  t.form_move_control({ draft_id, itemid: x, to_area_itemid: B });
  assert.equal(t.form_remove_area({ draft_id, itemid: A }).removed_area, A);
});

test('F-06 標題行在串流最後一行（沒有結尾換行）時也能拿掉', () => {
  const { draft_id } = t.form_create({ name: '標題行2', dept_no: 'TEST0' });
  const A = t.form_add_area({ draft_id, title: '甲', visible_title: true }).area_itemid;
  const x = t.form_add_control({ draft_id, area_itemid: A, label_text: '備註：', control: { datatype: 'textbox' } }).itemid;
  const d = store.loadDraft(draft_id);
  d.areas[0].items = [{ datatype: 'text', datavalue: '備註：' }, d.areas[0].items.find(n => n.itemid === x), { datatype: 'newline' }, { datatype: 'text', datavalue: '甲' }];
  store.saveDraft(d);
  t.form_update_area({ draft_id, itemid: A, visible_title: false });
  assert.deepEqual(stream(draft_id, A), ['備註：', `#${x}`]);
});

test('F-11 dictionary_suggest：預設 5 筆、memo 只回 meaning；full_memo:true 回完整補述', () => {
  const r = t.dictionary_suggest({ field: { caption: '身高' } });
  assert.equal(r.candidates.length, 5);
  for (const c of r.candidates) assert.deepEqual(Object.keys(c.memo || {}).filter(k => k !== 'meaning'), []);
  assert.equal(r.candidates[0].memo.meaning, '病人身高');
  assert.ok(r.candidates[0].cite.bind, 'cite 仍在');
  assert.equal(t.dictionary_suggest({ field: { caption: '身高' }, limit: 8 }).candidates.length, 8);
  const full = t.dictionary_suggest({ field: { caption: '身高' }, full_memo: true });
  assert.equal(full.candidates[0].memo.unit, 'cm');
  assert.ok(JSON.stringify(full).length > JSON.stringify(r).length);
});

test('F-10 dictionary_suggest：補述型別與欄位不一致時 reasons 說明信心為什麼降為 low', () => {
  const r = t.dictionary_suggest({ field: { caption: '身高', datatype: 'numberbox' } });
  const h = r.candidates.find(c => c.id === HEIGHT);
  assert.equal(h.confidence, 'low');
  assert.ok(h.reasons.some(x => /補述型別（label）與欄位不一致，信心降為 low/.test(x)), JSON.stringify(h.reasons));
  const u = t.dictionary_suggest({ field: { caption: '身高', unit: 'm' } }).candidates.find(c => c.id === HEIGHT);
  assert.ok(u.reasons.some(x => /單位（cm）與欄位不一致/.test(x)), JSON.stringify(u.reasons));
  const ok = t.dictionary_suggest({ field: { caption: '身高', datatype: 'label' } }).candidates.find(c => c.id === HEIGHT);
  assert.ok(!ok.reasons.some(x => /不一致/.test(x)));
});
