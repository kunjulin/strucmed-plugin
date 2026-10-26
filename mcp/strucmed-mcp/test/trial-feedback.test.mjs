// 3.5.0 試用回饋（M9R，2026-10-26）的離線部分：form_import(for_update)、formdiff、區塊標題、空白巨集腳本、formula_check 種類提示
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORM = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/existing-form.json'), 'utf8'));
let ws, t, pkgMod, fd, store;
const codes = list => list.map(w => w.code);

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-trial-'));
  process.env.STRUCMED_WORKSPACE = ws;
  const { TOOLS } = await import('../src/tools.mjs');
  t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));
  pkgMod = await import('../src/package.mjs');
  fd = await import('../src/formdiff.mjs');
  store = await import('../src/store.mjs');
  const pkg = pkgMod.buildPackage({ form: FORM, meta: { name: '合成原表單', shortcut: 'syn', groups: ['門', '住'], description: '原 Info', dept_no: 'TEST0', folder_type: 'usr' },
    generator: 'test', templateID: 'syn-template-0001' });
  fs.writeFileSync(path.join(ws, 'src.package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(ws, 'noid.json'), JSON.stringify(FORM.map(x => x.itemtype === 'iot' ? { ...x, sheetid: '', templateID: '' } : x)));
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

test('#1／#7 form_import(for_update) keeps the source name, shortcut and groups and records only explicit meta', () => {
  const r = t.form_import({ source_path: 'src.package.json', dept_no: 'TEST0', for_update: true });
  const d = store.loadDraft(r.draft_id);
  assert.equal(d.meta.name, '合成原表單', 'same name allowed and defaulted');
  assert.equal(d.meta.shortcut, 'syn');
  assert.deepEqual(d.meta.groups, ['門', '住']);
  assert.deepEqual(d.metaSet, []);
  assert.ok(d.source.digest && d.source.digest.controls, 'package source keeps a digest for online_since_source');
  t.form_update_meta({ draft_id: r.draft_id, shortcut: '' });
  assert.deepEqual(store.loadDraft(r.draft_id).metaSet, ['shortcut']);
  const named = t.form_import({ source_path: 'src.package.json', name: '新名字', dept_no: 'TEST0', for_update: true });
  assert.deepEqual(store.loadDraft(named.draft_id).metaSet, ['name']);
  // 沒有 for_update：維持原規則
  assert.throws(() => t.form_import({ source_path: 'src.package.json', name: '合成原表單', dept_no: 'TEST0' }), /for_update/);
  const plain = t.form_import({ source_path: 'src.package.json', name: '合成改版', dept_no: 'TEST0' });
  assert.equal(store.loadDraft(plain.draft_id).meta.shortcut, '', 'a new form still does not reuse the shortcut');
  // 來源沒有 templateID 不能用於更新；外部檔案不記錄 digest
  assert.throws(() => t.form_import({ source_path: 'noid.json', dept_no: 'TEST0', for_update: true }), /沒有 templateID/);
  assert.equal(store.loadDraft(t.form_import({ source_path: 'noid.json', name: 'x', dept_no: 'TEST0' }).draft_id).source.digest, null);
});

test('#2 formdiff: captions, controls, JS and iot are compared; editor and server fields are not', () => {
  const a = structuredClone(FORM);
  assert.ok(fd.diffDigest(fd.digestForm(a), fd.digestForm(structuredClone(a))).empty);
  const volatile = structuredClone(a);
  const iot = volatile.find(x => x.itemtype === 'iot');
  Object.assign(iot, { sheetid: 'X', templateID: 'X', modifiedUser: 'someone', modifiedDate: 123, d_url: 'http://x' });
  const js = volatile.find(x => x.itemtype === 'javascript');
  js.content = '// generated-by: strucmed-skill v9\n' + js.content;
  assert.ok(fd.diffDigest(fd.digestForm(a), fd.digestForm(volatile)).empty, JSON.stringify(fd.diffDigest(fd.digestForm(a), fd.digestForm(volatile))));
  const caption = structuredClone(a);
  const textNode = caption[0].item.find(x => x.datatype === 'text');
  textNode.datavalue += '（改）';
  const c = fd.diffDigest(fd.digestForm(a), fd.digestForm(caption));
  assert.deepEqual(c.changed_areas, [String(caption[0].itemid)]);
  assert.deepEqual(c.changed_itemids, []);
  const ctl = structuredClone(a);
  const node = ctl[0].item.find(x => x.itemid !== undefined && x.datatype !== 'text' && x.datatype !== 'newline');
  node.datavalue = 'changed';
  const k = fd.diffDigest(fd.digestForm(a), fd.digestForm(ctl));
  assert.deepEqual(k.changed_itemids, [String(node.itemid)]);
  assert.deepEqual(k.changed_areas, [], 'a control change is not reported as a layout change');
  assert.match(fd.describeDiff(k), new RegExp(`修改控制項 #${node.itemid}`));
});

test('#3 area titles are not visible: visible_title inserts a heading line, otherwise W_AREA_NO_VISIBLE_HEADING', () => {
  const { draft_id } = t.form_create({ name: '標題測試', dept_no: 'TEST0' });
  const hidden = t.form_add_area({ draft_id, title: '原始紀錄' });
  t.form_add_control({ draft_id, area_itemid: hidden.area_itemid, control: { datatype: 'textarea' } });
  const shown = t.form_add_area({ draft_id, title: '用藥清單', visible_title: true });
  t.form_add_control({ draft_id, area_itemid: shown.area_itemid, control: { datatype: 'textarea' } });
  const labelled = t.form_add_area({ draft_id, title: '備註' });
  t.form_add_control({ draft_id, area_itemid: labelled.area_itemid, label_text: '備註：', control: { datatype: 'textbox' } });
  const v = t.form_validate({ draft_id });
  const heads = v.warnings.filter(w => w.code === 'W_AREA_NO_VISIBLE_HEADING');
  assert.deepEqual(heads.map(w => w.itemid), [hidden.area_itemid], JSON.stringify(heads));
  const d = store.loadDraft(draft_id);
  assert.deepEqual(d.areas[1].items.slice(0, 2), [{ datatype: 'text', datavalue: '用藥清單' }, { datatype: 'newline' }]);
  assert.throws(() => t.form_add_area({ draft_id, type: 'tab1', titles: ['a'], title: 'x', visible_title: true }), /只適用文字區塊/);
});

test('#6 action buttons can be created with an empty script; form_validate reports E_ACTION_EMPTY until it is filled', () => {
  const { draft_id } = t.form_create({ name: '空腳本', dept_no: 'TEST0' });
  const a = t.form_add_area({ draft_id, title: '巨集', visible_title: true });
  const target = t.form_add_control({ draft_id, area_itemid: a.area_itemid, label_text: '結果', control: { datatype: 'textarea' } });
  const btn = t.form_add_control({ draft_id, area_itemid: a.area_itemid, control: { datatype: 'action', action_name: '帶入' } });
  assert.ok(codes(t.form_validate({ draft_id }).errors).includes('E_ACTION_EMPTY'));
  t.form_update_control({ draft_id, itemid: btn.itemid, changes: { action_script: `SETVALUEBYID(${target.itemid}, "x")` } });
  assert.ok(!codes(t.form_validate({ draft_id }).errors).includes('E_ACTION_EMPTY'));
});

test('#10 formula_check kind=prompt with a whole LLMQUERY macro hints kind=macro', () => {
  const r = t.formula_check({ kind: 'prompt', text: 'LLMQUERY(1, "請摘要")' });
  const w = codes(r.warnings);
  assert.ok(w.includes('W_KIND_MISMATCH'), JSON.stringify(r));
  assert.ok(!w.includes('W_LLM_NOT_AWAITED'));
  assert.ok(!codes(t.formula_check({ kind: 'prompt', text: 'CONCATENATE("請摘要：", "x")' }).warnings).includes('W_KIND_MISMATCH'));
});
