// v1：表格與頁籤區塊
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ws, t, store, model;
before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-v1t-'));
  process.env.STRUCMED_WORKSPACE = ws;
  const { TOOLS } = await import('../src/tools.mjs');
  t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  model = await import('../src/model.mjs');
  fs.writeFileSync(path.join(ws, 'd.csv'), '"id","dicType","dictName","dicComment","createUser","createDate"\r\n' +
    '"v1t-dic-1","TEST0","V1T_H","x","U","2026-09-28"\r\n');
  t.dictionary_load({ csv_path: 'd.csv', dept_no: 'TEST0' });
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

const out = id => model.toFormJson(store.loadDraft(id), 'test');
const newDraft = name => t.form_create({ name, dept_no: 'TEST0' }).draft_id;

test('areas: exact editor key order and shapes (GetData, scripts.js:3683-3810)', () => {
  const d = newDraft('結構');
  const ft = t.form_add_area({ draft_id: d, type: 'formtable', rows: ['3,3', '2,2,2'] });
  const tb = t.form_add_area({ draft_id: d, type: 'tab1', titles: ['甲', '乙'] });
  t.form_add_area({ draft_id: d, type: 'tab2', titles: ['一'] });
  t.form_add_area({ draft_id: d, type: 'table1', titles: ['欄1', '欄2'] });
  t.form_add_area({ draft_id: d, type: 'table2', titles: ['列1'] });
  assert.deepEqual(ft.cells, ['第 0 列：2 欄（3,3）', '第 1 列：3 欄（2,2,2）']);
  assert.deepEqual(tb.cells, ['0:甲', '1:乙']);
  const f = out(d);
  assert.deepEqual(Object.keys(f[0]), ['itemtype', 'itemid', 'authread', 'authwrite', 'gettext', 'item']);
  assert.deepEqual(f[0].item.map(r => [r.itemtype, r.columns, r.item.length]), [['row', '3,3', 2], ['row', '2,2,2', 3]]);
  assert.deepEqual(Object.keys(f[0].item[0].item[0]), ['itemtype', 'item']);
  for (const a of f.slice(1, 5)) {
    assert.deepEqual(Object.keys(a), ['itemtype', 'authread', 'authwrite', 'gettext', 'item', 'itemid'], a.itemtype);
    assert.equal(typeof a.itemid, 'string');
    for (const c of a.item) assert.deepEqual(Object.keys(c), ['itemtype', 'datatitle', 'item']);
  }
  // 列、格、頁籤不占 itemid：五個區塊用掉 1–5
  assert.deepEqual(f.slice(0, 5).map(a => a.itemid), ['1', '2', '3', '4', '5']);
});

test('area input validation', () => {
  const d = newDraft('參數');
  assert.throws(() => t.form_add_area({ draft_id: d, type: 'form2' }), /不支援/);
  assert.throws(() => t.form_add_area({ draft_id: d, type: 'formtable', rows: ['3,2'] }), /欄寬/);
  assert.throws(() => t.form_add_area({ draft_id: d, type: 'tab1' }), /titles/);
  assert.throws(() => t.form_add_area({ draft_id: d, type: 'tab2', titles: ["it's"] }), /單引號/);
  assert.throws(() => t.form_add_area({ draft_id: d, type: 'table1', titles: ['a\nb'] }), /換行/);
  assert.equal(t.form_add_area({ draft_id: d, type: 'formtable' }).cells.length, 1, '預設一列 3,3');
});

test('controls in cells: addressing, stream format, per-kind rules', () => {
  const d = newDraft('格子');
  const ft = t.form_add_area({ draft_id: d, type: 'formtable', rows: ['3,3'] }).area_itemid;
  const tab = t.form_add_area({ draft_id: d, type: 'tab2', titles: ['一', '二'] }).area_itemid;
  const tbl = t.form_add_area({ draft_id: d, type: 'table1', titles: ['藥名', '劑量'] }).area_itemid;
  const add = (area, cell, control, label_text = '') => t.form_add_control({ draft_id: d, area_itemid: area, cell, label_text, control });

  assert.throws(() => add(ft, undefined, { datatype: 'textbox' }), /固定表格，請指定 cell: \{row, col\}/);
  assert.throws(() => add(ft, { row: 1, col: 0 }, { datatype: 'textbox' }), /沒有第 1 列/);
  assert.throws(() => add(tab, {}, { datatype: 'textbox' }), /頁籤，請指定 cell: \{index\}/);
  assert.throws(() => add(tbl, {}, { datatype: 'textbox' }), /動態表格，請指定 cell: \{index\}/);

  // 固定表格：與文字區塊相同，可綁字典（會上傳 HIS）
  const h = add(ft, { row: 0, col: 0 }, { datatype: 'numberbox', minval: 50, maxval: 250, dictionary: { name: 'V1T_H' }, dicrole: 'puthis' }, '身高：');
  assert.equal(h.dicid, 'v1t-dic-1');
  assert.equal(h.dicrole, 'puthis');
  add(ft, { row: 0, col: 0 }, { datatype: 'textbox' }, '備註：');
  // 頁籤：不能綁字典；可參與計算
  assert.throws(() => add(tab, { index: 0 }, { datatype: 'textbox', dictionary: { name: 'V1T_H' } }), /不上傳 HIS/);
  assert.throws(() => add(tab, { index: 0 }, { datatype: 'textbox', dicrole: 'tohis' }), /不上傳 HIS/);
  const tx = add(tab, { index: 1 }, { datatype: 'textbox' });
  // 動態表格：tocalc 強制 false；不能放計算式／巨集
  assert.throws(() => add(tbl, { index: 0 }, { datatype: 'textbox', tocalc: true }), /不能參與計算/);
  assert.throws(() => add(tbl, { index: 0 }, { datatype: 'label', format: 'formula', formula: '1 + 1' }), /計算式/);
  assert.throws(() => add(tbl, { index: 0 }, { datatype: 'action', action_script: 'SETVALUEBYID(1, 1)' }), /巨集/);
  const drug = add(tbl, { index: 0 }, { datatype: 'textbox' });

  const f = out(d);
  const cell0 = f[0].item[0].item[0].item;
  assert.deepEqual(cell0.map(x => x.datatype), ['text', 'numberbox', 'newline', 'text', 'textbox'], '前面補換行、結尾不留換行');
  assert.equal(f[1].item[1].item[0].tocalc, true);
  assert.equal(f[2].item[0].item[0].tocalc, false);
  assert.equal(f[2].item[0].item[0].dicrole, 'nohis');

  // 計算式參照動態表格欄位 → 不參與計算；巨集寫入動態表格欄位 → 會寫到所有列
  const v0 = t.form_validate({ draft_id: d });
  assert.equal(v0.valid, true, JSON.stringify(v0.errors));
  const lbl = add(ft, { row: 0, col: 1 }, { datatype: 'label', format: 'formula', formula: `A${drug.itemid} + 1` });
  assert.ok(lbl.deferred_errors.some(x => x.startsWith('E_FORMULA_REF_NOT_CALC')));
  assert.throws(() => add(ft, { row: 0, col: 1 }, { datatype: 'action', action_name: 'x', action_script: `SETVALUEBYID(${drug.itemid}, "a")` }), /計算式／巨集有錯誤/);
  assert.throws(() => add(ft, { row: 0, col: 1 }, { datatype: 'action2', action_name: 'x', action_id: drug.itemid, action_script: '"hi"' }), /計算式／巨集有錯誤/);
  // 引用頁籤內的欄位可以
  t.form_update_control({ draft_id: d, itemid: lbl.itemid, changes: { formula: `CONCATENATE("x", A${tx.itemid})` } });
  assert.equal(t.form_validate({ draft_id: d }).valid, true);

  // 刪除格子內的控制項：說明文字與多餘換行一起收拾
  const p = t.form_remove_control({ draft_id: d, itemid: Number(cell0[4].itemid) });
  t.form_remove_control({ draft_id: d, itemid: Number(cell0[4].itemid), confirm_token: p.confirm_token });
  assert.deepEqual(out(d)[0].item[0].item[0].item.map(x => x.datatype), ['text', 'numberbox']);

  // tree 預覽標出格子位置
  const pv = t.form_preview({ draft_id: d }).content;
  assert.match(pv, /\[row 0\] 列 3,3 › \[col 0\]：身高：/);
  assert.match(pv, /\[index 1\] 頁籤「二」/);
  assert.match(pv, /\[index 1\] 欄「劑量」：（空白）/);
  assert.ok(t.form_validate({ draft_id: d }).warnings.some(w => w.code === 'W_EMPTY_AREA' && /劑量/.test(w.message)));
});

test('imported forms: existing tables and tabs accept new controls; cell rules check original items as warnings', () => {
  const form = [
    { itemtype: 'form', authread: ['doctor'], authwrite: ['doctor'], gettext: true, item: [{ datatype: 'text', datavalue: 'x' }], itemid: '1' },
    { itemtype: 'tab1', authread: ['doctor'], authwrite: ['doctor'], gettext: true, item: [
      { itemtype: 'td', datatitle: '甲', item: [{ ...model.buildControl(3, { datatype: 'textbox' }), dicrole: 'tohis', dictionary: 'X', dicid: 'abc' }] }], itemid: '2' },
    { itemtype: 'table2', authread: ['doctor'], authwrite: ['doctor'], gettext: true, item: [
      { itemtype: 'td', datatitle: '列', item: [model.buildControl(5, { datatype: 'textbox' })] }], itemid: '4' },
    { itemtype: 'javascript', content: '' },
    { itemtype: 'iot', editorver: '1.6', sheetid: 's', templateID: 's', d_url: '', modifiedUser: 'u', modifiedDept: '', modifiedDate: 1 }
  ];
  fs.writeFileSync(path.join(ws, 'imp.json'), JSON.stringify(form));
  const r = t.form_import({ source_path: 'imp.json', name: '匯入改版', dept_no: 'TEST0' });
  const v = t.form_validate({ draft_id: r.draft_id });
  assert.equal(v.valid, true, '原表單既有問題只列 warning');
  assert.ok(v.warnings.some(w => w.code === 'E_CELL_DICT' && /原表單既有/.test(w.message)));
  assert.ok(v.warnings.some(w => w.code === 'E_TABLE_TOCALC' && /原表單既有/.test(w.message)));
  const a = t.form_add_control({ draft_id: r.draft_id, area_itemid: 2, cell: { index: 0 }, label_text: '新：', control: { datatype: 'numberbox', minval: 0, maxval: 9 } });
  assert.equal(a.itemid, 6);
  const f = out(r.draft_id);
  assert.deepEqual(f[1].item[0].item.map(x => x.datatype), ['textbox', 'newline', 'text', 'numberbox']);
  assert.deepEqual(f[2], form[2], '沒動到的區塊原封保留');
});

test('layout: adjacent formtable cells without a separator are flagged (W_LAYOUT_CELL_SEP)', () => {
  const d = newDraft('版面');
  const ft = t.form_add_area({ draft_id: d, type: 'formtable', rows: ['1,2,1,2', '3,3'] }).area_itemid;
  const add = (cell, control, label_text = '') => t.form_add_control({ draft_id: d, area_itemid: ft, cell, label_text, control });
  const codes = () => t.form_validate({ draft_id: d }).warnings.filter(w => w.code === 'W_LAYOUT_CELL_SEP').map(w => w.message);
  // 第 0 列：身高：[值] 體重：[值] → 值格之後的「體重：」沒有空白 → 黏在一起
  add({ row: 0, col: 0 }, { datatype: 'label', format: 'defaultValue', datavalue: '' }, '身高：');
  add({ row: 0, col: 1 }, { datatype: 'numberbox' });
  add({ row: 0, col: 2 }, { datatype: 'label', format: 'defaultValue', datavalue: '' }, '體重：');
  add({ row: 0, col: 3 }, { datatype: 'numberbox' });
  let m = codes();
  assert.equal(m.length, 1);
  assert.match(m[0], /第 0 列第 1 欄→第 2 欄/);
  assert.doesNotMatch(m[0], /第 0 欄→第 1 欄|第 2 欄→第 3 欄/, '以「身高：」「體重：」純文字 label 結尾的格子已有冒號分隔');
  // 第 1 列：值格之後的說明文字以空白＋單位開頭 → 不警告
  add({ row: 1, col: 0 }, { datatype: 'numberbox' }, '收縮壓：');
  add({ row: 1, col: 1 }, { datatype: 'numberbox' }, ' mmHg 舒張壓：');
  m = codes();
  assert.equal(m.length, 1, '第 1 列有分隔，不新增警告');
  assert.equal(t.form_validate({ draft_id: d }).valid, true, '只是警告');
});
