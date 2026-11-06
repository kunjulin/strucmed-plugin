// S0 控制項樣式欄位（docs/13 §4.0，D0.5）：font_color／font_size／back_color 對應平台既有的 efontcolor／efontsize／ebackcolor，不需 flag。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ws, t, store, model;
const errOf = fn => { try { fn(); } catch (e) { return e; } assert.fail('應該拋錯'); };

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-style-'));
  process.env.STRUCMED_WORKSPACE = ws;
  t = Object.fromEntries((await import('../src/tools.mjs')).TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  model = await import('../src/model.mjs');
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

const node = (draft_id, itemid) => { let hit = null; store.loadDraft(draft_id).areas.forEach(a => (a.items || []).forEach(n => { if (Number(n.itemid) === itemid) hit = n; })); return hit; };

test('form_add_control 帶樣式：寫進 efontcolor／efontsize／ebackcolor；預設值不變', () => {
  const { draft_id } = t.form_create({ name: '樣式', dept_no: 'TEST0' });
  const a = t.form_add_area({ draft_id, title: '測量' }).area_itemid;
  const h = t.form_add_control({ draft_id, area_itemid: a, label_text: '身高：', control: { datatype: 'numberbox', font_color: '#C00', font_size: 18, back_color: 'lightyellow' } }).itemid;
  const w = t.form_add_control({ draft_id, area_itemid: a, label_text: '體重：', control: { datatype: 'numberbox' } }).itemid;
  assert.deepEqual([node(draft_id, h).efontcolor, node(draft_id, h).efontsize, node(draft_id, h).ebackcolor], ['#C00', 18, 'lightyellow']);
  assert.deepEqual([node(draft_id, w).efontcolor, node(draft_id, w).efontsize, node(draft_id, w).ebackcolor], ['', 14, '']);
  // 匯出的表單 JSON 原樣帶出
  const form = model.toFormJson(store.loadDraft(draft_id), 'x');
  const ctl = form[0].item.find(n => Number(n.itemid) === h);
  assert.equal(ctl.efontsize, 18);
  assert.equal(ctl.ebackcolor, 'lightyellow');
  // form_fields 與 form_preview(tree) 顯示非預設的樣式
  const f = t.form_fields({ draft_id }).fields;
  assert.deepEqual(f.find(x => x.itemid === h).style, { font_color: '#C00', font_size: 18, back_color: 'lightyellow' });
  assert.equal(f.find(x => x.itemid === w).style, undefined);
  assert.match(t.form_preview({ draft_id, format: 'tree' }).content, /樣式 字#C00\/18px\/底lightyellow/);
  assert.ok(t.form_validate({ draft_id }).valid);
});

test('form_update_control 設定與清除樣式；無效值拒絕且不改', () => {
  const { draft_id } = t.form_create({ name: '樣式2', dept_no: 'TEST0' });
  const a = t.form_add_area({ draft_id, title: '結果' }).area_itemid;
  const b = t.form_add_control({ draft_id, area_itemid: a, label_text: 'BMI：', control: { datatype: 'label' } }).itemid;
  t.form_update_control({ draft_id, itemid: b, changes: { font_size: '20', font_color: 'darkblue' } });
  assert.deepEqual([node(draft_id, b).efontcolor, node(draft_id, b).efontsize], ['darkblue', 20]);
  assert.ok(store.loadDraft(draft_id).touchedFields[b].includes('style'));
  for (const changes of [{ font_size: 9 }, { font_size: 25 }, { font_size: 1.5 }, { font_color: 'url(x)' }, { font_color: 'red; position:fixed' }, { back_color: '#12345' }, { font_color: 'expression(1)' }]) {
    const e = errOf(() => t.form_update_control({ draft_id, itemid: b, changes }));
    assert.equal(e.code, 'E_INVALID_INPUT', JSON.stringify(changes));
  }
  assert.deepEqual([node(draft_id, b).efontcolor, node(draft_id, b).efontsize], ['darkblue', 20], '無效值沒有改到');
  t.form_update_control({ draft_id, itemid: b, changes: { font_size: '', font_color: '' } });
  assert.deepEqual([node(draft_id, b).efontcolor, node(draft_id, b).efontsize], ['', 14]);
  assert.equal(t.form_fields({ draft_id }).fields.find(x => x.itemid === b).style, undefined);
  const e = errOf(() => t.form_update_control({ draft_id, itemid: b, changes: { color: 'red' } }));
  assert.equal(e.code, 'E_UNKNOWN_KEY');
});

test('form_import：原表單的樣式原樣保留，不算修改', () => {
  const { draft_id } = t.form_create({ name: '來源', dept_no: 'TEST0' });
  const a = t.form_add_area({ draft_id, title: '測量' }).area_itemid;
  const h = t.form_add_control({ draft_id, area_itemid: a, label_text: '身高：', control: { datatype: 'numberbox', font_color: 'red', font_size: 16 } }).itemid;
  fs.writeFileSync(path.join(ws, 'src.json'), JSON.stringify(model.toFormJson(store.loadDraft(draft_id), 'x')));
  const r = t.form_import({ source_path: 'src.json', name: '改版', dept_no: 'TEST0' });
  const f = t.form_fields({ draft_id: r.draft_id }).fields.find(x => x.itemid === h);
  assert.deepEqual(f.style, { font_color: 'red', font_size: 16 });
  assert.equal((store.loadDraft(r.draft_id).touched || []).length, 0);
  const out = model.toFormJson(store.loadDraft(r.draft_id), 'y');
  const ctl = out[0].item.find(n => Number(n.itemid) === h);
  assert.deepEqual([ctl.efontcolor, ctl.efontsize], ['red', 16]);
});
