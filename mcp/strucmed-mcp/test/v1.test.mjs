// v1：以既有表單為範本改版（form_import / form_update_* / form_remove_control）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'fixtures/existing-form.json'), 'utf8');
const FORM = JSON.parse(SRC);
let ws, t, pkgMod, model, store;

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-v1-'));
  process.env.STRUCMED_WORKSPACE = ws;
  const { TOOLS } = await import('../src/tools.mjs');
  t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));
  pkgMod = await import('../src/package.mjs');
  model = await import('../src/model.mjs');
  store = await import('../src/store.mjs');
  fs.writeFileSync(path.join(ws, 'src.json'), SRC);
  fs.writeFileSync(path.join(ws, 'legacy.htm'), `<html><body><script>var tempdata =${JSON.stringify(FORM)}</script></body></html>`);
  const pkg = pkgMod.buildPackage({ form: FORM, meta: { name: '合成原表單', shortcut: 'syn', groups: ['門'], description: '原 Info', dept_no: 'TEST0', folder_type: 'usr' },
    presets: [{ name: '預設一', user: 'all', xmlContent: '<x/>' }], generator: 'test', templateID: 'syn-template-0001' });
  fs.writeFileSync(path.join(ws, 'src.package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(ws, 'src.htm'), pkgMod.renderHtm(pkg, '合成原表單'));
  const tampered = structuredClone(pkg); tampered.form[0].item[0].datavalue = '竄改：';
  fs.writeFileSync(path.join(ws, 'tampered.package.json'), JSON.stringify(tampered));
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

const exportForm = id => model.toFormJson(store.loadDraft(id), 'test');
const withoutEnv = f => f.map(x => (x.itemtype === 'iot' || x.itemtype === 'javascript') ? { itemtype: x.itemtype } : x);

test('import: all three source kinds give the same draft; untouched export is byte-identical except new-form fields', () => {
  const kinds = {};
  for (const src of ['src.json', 'legacy.htm', 'src.package.json', 'src.htm']) {
    const r = t.form_import({ source_path: src, name: '合成改版', dept_no: 'TEST0' });
    kinds[src] = r.source_kind;
    assert.equal(r.next_itemid, 15, 'next itemid = max(14) + 1');
    const out = exportForm(r.draft_id);
    // 區塊原封保留
    assert.deepEqual(withoutEnv(out), withoutEnv(FORM), src);
    // JS 保留，只在最前面加標記
    const js = out.find(x => x.itemtype === 'javascript').content;
    assert.equal(js, '// generated-by: test\nfunction synHelper(){ return 1; }');
    // iot：保留選項，新表單欄位清空
    const iot = out.find(x => x.itemtype === 'iot');
    assert.equal(iot.sheetid, ''); assert.equal(iot.templateID, ''); assert.equal(iot.d_url, '');
    assert.equal(iot.f_opdno, true); assert.equal(iot.f_day, '7'); assert.equal(iot.modifiedUser, 'strucmed-skill');
  }
  assert.deepEqual(kinds, { 'src.json': 'getdata-json', 'legacy.htm': 'legacy-htm', 'src.package.json': 'package-json', 'src.htm': 'package-htm' });
});

test('import: rejects tampered package, same name as source, and paths outside the workspace', () => {
  assert.throws(() => t.form_import({ source_path: 'tampered.package.json', name: 'x', dept_no: 'TEST0' }), /驗證失敗/);
  assert.throws(() => t.form_import({ source_path: 'src.package.json', name: '合成原表單', dept_no: 'TEST0' }), /不可與原表單相同/);
  assert.throws(() => t.form_import({ source_path: '../outside.json', name: 'x', dept_no: 'TEST0' }), /工作目錄內/);
});

test('import from package: shortcut/groups are NOT carried over by default; Info and presets are', () => {
  const r = t.form_import({ source_path: 'src.package.json', name: '合成改版B', dept_no: 'TEST0' });
  const d = store.loadDraft(r.draft_id);
  assert.equal(d.meta.shortcut, ''); assert.deepEqual(d.meta.groups, []);
  assert.equal(d.meta.description, '原 Info');
  assert.equal(r.presets, 1);
  assert.equal(r.derived_from.templateID, 'syn-template-0001');
  assert.equal(r.derived_from.name, '合成原表單');
});

test('validate: preserved problems are warnings; problems in new/modified parts are errors', () => {
  const r = t.form_import({ source_path: 'src.json', name: '合成改版C', dept_no: 'TEST0' });
  let v = t.form_validate({ draft_id: r.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(v.warnings.some(w => w.code === 'E_REF_BROKEN' && w.itemid === 9 && w.message.includes('原表單既有')), 'A99 in preserved formula → warning');
  assert.ok(v.warnings.some(w => w.code === 'W_CUSTOM_JS'));
  // 只改 #9 的說明文字：與參照無關 → 原有問題仍是 warning，不擋輸出
  t.form_update_control({ draft_id: r.draft_id, itemid: 9, label_text: '舊參照（改）：' });
  v = t.form_validate({ draft_id: r.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(v.warnings.some(w => w.code === 'E_REF_BROKEN' && w.itemid === 9));
  // 改 #5 的選項，讓 further 指向不存在的 #77 → 本次造成的問題 → error
  t.form_update_control({ draft_id: r.draft_id, itemid: 5, changes: { options: [{ value: '無' }, { value: '有', further: [77] }] } });
  v = t.form_validate({ draft_id: r.draft_id });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => e.code === 'E_REF_BROKEN' && e.itemid === 5));
  // 只改必填：原表單的字典 id（不在 CSV）不因此升級
  const r2 = t.form_import({ source_path: 'src.json', name: '合成改版C2', dept_no: 'TEST0' });
  t.form_update_control({ draft_id: r2.draft_id, itemid: 2, changes: { required: true } });
  assert.equal(t.form_validate({ draft_id: r2.draft_id }).valid, true);
  // 改字典綁定 → 字典檢查升級（沒載入 CSV 時指定 id 是 error）
  assert.throws(() => t.form_update_control({ draft_id: r2.draft_id, itemid: 2, changes: { dictionary: { id: 'syn-dic-001' } } }), /尚未載入/);
});

test('add control: itemid continues after the max, stream format preserved; tables need a cell', () => {
  const r = t.form_import({ source_path: 'src.json', name: '合成改版D', dept_no: 'TEST0' });
  const add = t.form_add_control({ draft_id: r.draft_id, area_itemid: 1, label_text: '吸菸：',
    control: { datatype: 'radiobutton', options: ['有', '無'] } });
  assert.equal(add.itemid, 15);
  // v1 表格：沒指定格子就拒絕
  assert.throws(() => t.form_add_control({ draft_id: r.draft_id, area_itemid: 10, control: { datatype: 'textbox' } }), /固定表格，請指定 cell/);
  const out = exportForm(r.draft_id);
  const items = out[0].item;
  assert.deepEqual(items.slice(-3).map(x => x.datatype), ['newline', 'text', 'radiobutton'], 'newline before, no trailing newline');
  assert.deepEqual(items.slice(0, -3), FORM[0].item, 'existing items untouched');
  assert.deepEqual(out[1], FORM[1], 'formtable untouched');
  // 新區塊的 itemid 也接續
  assert.equal(t.form_add_area({ draft_id: r.draft_id }).area_itemid, 16);
});

test('update control: options keep further, label text changes, complex types limited', () => {
  const r = t.form_import({ source_path: 'src.json', name: '合成改版E', dept_no: 'TEST0' });
  t.form_update_control({ draft_id: r.draft_id, itemid: 5, label_text: '藥物過敏：', changes: { options: [{ value: '無' }, { value: '有', further: [6] }, { value: '不詳' }], required: true } });
  const out = exportForm(r.draft_id);
  const radio = out[0].item.find(x => x.itemid === 5);
  assert.deepEqual(radio.option, [{ value: '無', further: '' }, { value: '有', further: '6' }, { value: '不詳', further: '' }]);
  assert.equal(radio.required, true);
  assert.equal(out[0].item[out[0].item.indexOf(radio) - 1].datavalue, '藥物過敏：');
  assert.throws(() => t.form_update_control({ draft_id: r.draft_id, itemid: 4, changes: { options: ['x'] } }), /編輯器調整/);
  assert.throws(() => t.form_update_control({ draft_id: r.draft_id, itemid: 12, changes: { datavalue: 'x' } }), /子項陣列/);
  // 巢狀（表格格內）控制項也能改必填
  t.form_update_control({ draft_id: r.draft_id, itemid: 11, changes: { required: true } });
  assert.equal(exportForm(r.draft_id)[1].item[0].item[0].item[1].required, true);
  assert.deepEqual(store.loadDraft(r.draft_id).touched.sort((a, b) => a - b), [5, 11]);
});

test('remove control: blocked while referenced (further / formula / macro), two-step otherwise, children go too', () => {
  const r = t.form_import({ source_path: 'src.json', name: '合成改版F', dept_no: 'TEST0' });
  const id = r.draft_id;
  for (const [target, kind] of [[6, 'further'], [2, 'formula'], [4, 'actionScript'], [8, 'actionID']]) {
    try { t.form_remove_control({ draft_id: id, itemid: target }); assert.fail('should refuse #' + target); }
    catch (e) { assert.equal(e.code, 'E_REF_BROKEN'); assert.ok(e.details.blockers.some(b => b.kind === kind), `#${target} blocked by ${kind}`); }
  }
  // #9 無人參照 → 兩段式移除，連同說明文字與多餘換行
  const plan = t.form_remove_control({ draft_id: id, itemid: 9 });
  assert.match(plan.plan, /舊參照/);
  assert.deepEqual(t.form_remove_control({ draft_id: id, itemid: 9, confirm_token: plan.confirm_token }).removed, [9]);
  const items = exportForm(id)[0].item;
  assert.ok(!items.some(x => x.itemid === 9 || x.datavalue === '舊參照：'));
  assert.notEqual(items.at(-1).datatype, 'newline', 'no trailing newline left in the area');
  // 群組 #12 連同子項 #13、#14 一起移除
  const p2 = t.form_remove_control({ draft_id: id, itemid: 12 });
  assert.match(p2.plan, /#13/);
  assert.deepEqual(t.form_remove_control({ draft_id: id, itemid: 12, confirm_token: p2.confirm_token }).removed.sort(), [12, 13, 14]);
});

test('export: package carries derivedFrom, new templateID, presets; manifest explains the derivation', async () => {
  const r = t.form_import({ source_path: 'src.package.json', name: '合成改版G', dept_no: 'TEST0', folder_type: 'dpt' });
  t.form_add_control({ draft_id: r.draft_id, area_itemid: 1, label_text: '備註：', control: { datatype: 'textarea' } });
  const plan = t.form_export({ draft_id: r.draft_id });
  const done = t.form_export({ draft_id: r.draft_id, confirm_token: plan.confirm_token });
  const pkg = JSON.parse(fs.readFileSync(path.join(ws, done.files.json), 'utf8'));
  assert.deepEqual(pkgMod.validatePackage(pkg), []);
  assert.equal(pkg.template.templateID, '');
  assert.equal(pkg.template.derivedFrom.templateID, 'syn-template-0001');
  const { sha256 } = await import('../src/importer.mjs');
  assert.equal(pkg.template.derivedFrom.sha256, sha256(JSON.stringify(FORM)), 'source form hash for traceability');
  assert.equal(pkg.presets.length, 1);
  assert.ok(pkg.dictionaries.some(d => d.id === 'syn-dic-001'), 'nested dictionary refs collected');
  const manifest = fs.readFileSync(path.join(ws, done.files.manifest), 'utf8');
  assert.match(manifest, /改版自\*\*：合成原表單/);
  assert.match(manifest, /新增或修改的控制項：#15/);
  const pv = t.form_preview({ draft_id: r.draft_id }).content;
  assert.match(pv, /固定表格/);
  assert.match(pv, /#15 段落 ✎/);
  assert.match(pv, /改版自：合成原表單/);
});
