// 應用紀錄清單（平台 kunjulin/strucmed#290、#291；docs/PLAN-app-record-list.md）：iot f_applist* 的寫出、改版保留與關閉、
// 只對非病人表單有效、顯示欄位要是綁定的字典、manifest 的說明。寫法與平台編輯器 scripts.js?v=20261123d 相同
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ws, t, store, model;
const codes = list => list.map(e => e.code);
const errOf = fn => { try { fn(); } catch (e) { return e; } assert.fail('應該拋錯'); };
const iotOf = draft_id => model.toFormJson(store.loadDraft(draft_id), 'test').find(x => x.itemtype === 'iot');

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-applist-'));
  process.env.STRUCMED_WORKSPACE = ws;
  const { TOOLS } = await import('../src/tools.mjs');
  t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  model = await import('../src/model.mjs');
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

// 衛教單：兩個綁字典的欄位、一個沒綁的
function draft(name, options) {
  const r = t.form_create({ name, dept_no: 'TEST0', ...(options && { options }) });
  const a = t.form_add_area({ draft_id: r.draft_id }).area_itemid;
  t.form_add_control({ draft_id: r.draft_id, area_itemid: a, label_text: '標題：', control: { datatype: 'textbox', dictionary: { name: 'edu.title' } } });
  t.form_add_control({ draft_id: r.draft_id, area_itemid: a, label_text: '分類：', control: { datatype: 'textbox', dictionary: { name: 'edu.category' } } });
  t.form_add_control({ draft_id: r.draft_id, area_itemid: a, label_text: '內容：', control: { datatype: 'textarea' } });
  return r;
}
const APP = { title: '我的衛教單', key: 'code', key_label: '文件代碼', fields: ['edu.title', 'edu.category'], sort: 'recDate-desc' };

test('form_create：非病人表單＋app_list 寫出六個 f_applist* 鍵（與編輯器相同）', () => {
  const d = draft('衛教單清單', { no_patient: true, app_list: APP });
  const iot = iotOf(d.draft_id);
  assert.deepEqual(
    Object.fromEntries(model.APPLIST_IOT_KEYS.map(k => [k, iot[k]])),
    { f_applist: true, f_applistTitle: '我的衛教單', f_applistKey: 'code', f_applistKeyLabel: '文件代碼', f_applistFields: 'edu.title,edu.category', f_applistSort: 'recDate-desc' });
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(codes(v.warnings).includes('W_NOPATIENT_APPLIST'));
  assert.ok(!codes(v.warnings).includes('W_APPLIST_FIELD_UNBOUND'));
  assert.ok(!codes(v.warnings).includes('W_NOPATIENT_AUTOLOAD'), '以紀錄鍵開啟一律載入，不需要開啟時自動取出');
  const np = v.warnings.find(w => w.code === 'W_NOPATIENT_APPLIST').message;
  assert.match(np, /note\/\?app=<範本ID>/);
  assert.match(np, /不可放病歷號、身分證號、姓名/);
  assert.match(np, /硬刪除、無法復原/);
  assert.match(v.warnings.find(w => w.code === 'W_NOPATIENT_FORM').message, /應用紀錄清單以 recNo 區分多筆/);
});

test('預設值：只帶 {} 就開啟（code、recDate-desc、空標題）；fields 可用逗號字串', () => {
  const d = draft('預設清單', { no_patient: true, app_list: {} });
  const iot = iotOf(d.draft_id);
  assert.equal(iot.f_applist, true);
  assert.equal(iot.f_applistKey, 'code');
  assert.equal(iot.f_applistSort, 'recDate-desc');
  assert.equal(iot.f_applistTitle, '');
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.match(v.warnings.find(w => w.code === 'W_APPLIST_FIELD_UNBOUND').message, /沒有設定顯示欄位/);
  t.form_update_meta({ draft_id: d.draft_id, options: { app_list: { key: 'week', fields: 'edu.title，內容' } } });
  const iot2 = iotOf(d.draft_id);
  assert.equal(iot2.f_applistKey, 'week');
  assert.equal(iot2.f_applistFields, 'edu.title,內容');
  const w = t.form_validate({ draft_id: d.draft_id }).warnings.find(x => x.code === 'W_APPLIST_FIELD_UNBOUND');
  assert.match(w.message, /「內容」 不是這張表單綁定的字典/);
});

test('輸入檢查：未知鍵、規則、長度、超過 3 個欄位都拒絕（不默默截斷）', () => {
  assert.equal(errOf(() => t.form_create({ name: 'x1', dept_no: 'T', options: { no_patient: true, app_list: { titel: 'x' } } })).code, 'E_UNKNOWN_KEY');
  assert.match(errOf(() => t.form_create({ name: 'x2', dept_no: 'T', options: { no_patient: true, app_list: { key: 'year' } } })).message, /key 必須是/);
  assert.match(errOf(() => t.form_create({ name: 'x3', dept_no: 'T', options: { no_patient: true, app_list: { title: '標'.repeat(41) } } })).message, /最多 40 字/);
  assert.match(errOf(() => t.form_create({ name: 'x4', dept_no: 'T', options: { no_patient: true, app_list: { key_label: '鍵'.repeat(21) } } })).message, /最多 20 字/);
  assert.match(errOf(() => t.form_create({ name: 'x5', dept_no: 'T', options: { no_patient: true, app_list: { fields: ['a', 'b', 'c', 'd'] } } })).message, /最多 3 個/);
  assert.match(errOf(() => t.form_create({ name: 'x6', dept_no: 'T', options: { no_patient: true, app_list: { sort: 'name' } } })).message, /sort 必須是/);
  assert.match(errOf(() => t.form_create({ name: 'x7', dept_no: 'T', options: { no_patient: true, app_list: true } })).message, /必須是物件/);
});

test('一般表單帶 app_list：E_APPLIST_NOT_NOPATIENT，iot 不寫出 f_applist*', () => {
  const d = draft('一般表單清單', { app_list: APP });
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.ok(codes(v.errors).includes('E_APPLIST_NOT_NOPATIENT'));
  assert.ok(!('f_applist' in iotOf(d.draft_id)));
  t.form_update_meta({ draft_id: d.draft_id, options: { app_list: { enabled: false } } });
  assert.equal(t.form_validate({ draft_id: d.draft_id }).valid, true);
});

test('沒開清單的非病人表單：W_NOPATIENT_AUTOLOAD 與 W_NOPATIENT_FORM 指向應用紀錄清單', () => {
  const d = draft('一人一筆', { no_patient: true, auto_load_on_open: false });
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.match(v.warnings.find(w => w.code === 'W_NOPATIENT_AUTOLOAD').message, /改開應用紀錄清單（options\.app_list）/);
  assert.match(v.warnings.find(w => w.code === 'W_NOPATIENT_FORM').message, /要多筆請開應用紀錄清單/);
  assert.ok(!codes(v.warnings).includes('W_NOPATIENT_APPLIST'));
});

test('改版：原表單的 f_applist* 原樣保留；enabled:false 存成 f_applist:false；改成一般表單時一併關閉', () => {
  const d = draft('來源清單', { no_patient: true, app_list: APP });
  const form = model.toFormJson(store.loadDraft(d.draft_id), 'test');
  Object.assign(form.find(x => x.itemtype === 'iot'), { sheetid: 'S1', templateID: 'S1' });
  fs.writeFileSync(path.join(ws, 'applist-src.json'), JSON.stringify(form));

  const im = t.form_import({ source_path: 'applist-src.json', name: '改版清單', dept_no: 'TEST0' });
  assert.equal(iotOf(im.draft_id).f_applistFields, 'edu.title,edu.category');
  assert.ok(codes(im.validation.warnings).includes('W_NOPATIENT_APPLIST'));

  const off = t.form_update_meta({ draft_id: im.draft_id, options: { app_list: { enabled: false } } });
  assert.ok(off.options_changed.includes('f_applist'));
  const iot = iotOf(im.draft_id);
  assert.equal(iot.f_applist, false);
  assert.ok(!('f_applistTitle' in iot) && !('f_applistFields' in iot));

  const on = t.form_update_meta({ draft_id: im.draft_id, options: { app_list: { key: 'month', title: '每月紀錄' } } });
  assert.equal(on.iot_options.f_applist, true);
  assert.equal(on.iot_options.f_applistKey, 'month');

  const im2 = t.form_import({ source_path: 'applist-src.json', name: '改回一般', dept_no: 'TEST0' });
  t.form_update_meta({ draft_id: im2.draft_id, options: { no_patient: false } });
  const iot2 = iotOf(im2.draft_id);
  assert.equal(iot2.f_nopatient, undefined);
  assert.equal(iot2.f_applist, false, '比照編輯器：一般表單存成 f_applist:false');
  assert.ok(!('f_applistKey' in iot2));
  assert.ok(!codes(t.form_validate({ draft_id: im2.draft_id }).warnings).includes('W_APPLIST_NOT_NOPATIENT'));
});

test('原表單是一般表單卻帶 f_applist:true（手改或舊工具）：列 W_APPLIST_NOT_NOPATIENT（原表單既有），不擋', () => {
  const d = draft('一般來源');
  const form = model.toFormJson(store.loadDraft(d.draft_id), 'test');
  Object.assign(form.find(x => x.itemtype === 'iot'), { sheetid: 'S2', templateID: 'S2', f_applist: true, f_applistKey: 'week' });
  fs.writeFileSync(path.join(ws, 'applist-plain.json'), JSON.stringify(form));
  const im = t.form_import({ source_path: 'applist-plain.json', name: '一般改版', dept_no: 'TEST0' });
  assert.equal(im.validation.valid, true);
  const w = im.validation.warnings.find(x => x.code === 'W_APPLIST_NOT_NOPATIENT');
  assert.match(w.message, /原表單既有/);
});

test('一般表單的輸出不變：沒有任何 f_applist* 鍵', () => {
  const d = draft('一般表單');
  const iot = iotOf(d.draft_id);
  assert.deepEqual(model.APPLIST_IOT_KEYS.filter(k => k in iot), []);
});

test('manifest：開了清單寫出網址、紀錄鍵規則、刪除無法復原；沒開寫每人一筆與怎麼開', () => {
  const d = draft('衛教單匯出', { no_patient: true, app_list: { ...APP, key: 'week' } });
  const p = t.form_export({ draft_id: d.draft_id, overwrite: true });
  const out = t.form_export({ draft_id: d.draft_id, overwrite: true, confirm_token: p.confirm_token });
  const manifest = fs.readFileSync(path.join(ws, Object.values(out.files).find(f => /manifest/.test(f))), 'utf8');
  assert.match(manifest, /\*\*應用紀錄清單\*\*/);
  assert.match(manifest, /note\/\?app=<範本ID>/);
  assert.match(manifest, /週次（例 2026-W47）/);
  assert.match(manifest, /刪除是硬刪除、無法復原/);
  assert.match(manifest, /runtime\.app_records/);

  const e = draft('一人一筆匯出', { no_patient: true });
  const p2 = t.form_export({ draft_id: e.draft_id, overwrite: true });
  const out2 = t.form_export({ draft_id: e.draft_id, overwrite: true, confirm_token: p2.confirm_token });
  const m2 = fs.readFileSync(path.join(ws, Object.values(out2.files).find(f => /manifest/.test(f))), 'utf8');
  assert.match(m2, /每人每張表單只有一筆。要多筆紀錄請開「應用紀錄清單」/);
  assert.doesNotMatch(m2, /\*\*應用紀錄清單\*\*/);
});
