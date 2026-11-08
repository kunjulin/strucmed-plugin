// 預覽審閱模式（docs/15）：serve.mjs 的 /__review、form_preview 的 meta、form_review_read、字典 CSV 往返、W_HIS_TEXT_KEYS。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dc from '../src/dictcomment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.resolve(HERE, '../../../tools/v0-harness/serve.mjs');
const DIC = 'aaaaaaaa-0000-0000-0000-000000000001', DIC2 = 'aaaaaaaa-0000-0000-0000-000000000002', DIC3 = 'aaaaaaaa-0000-0000-0000-000000000003';
let ws, web, t, tools, store, child, port;

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
// fetch 不能改 Host，用 http.request
const raw = (method, p, { headers = {}, body } = {}) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, x => {
    let text = '';
    x.setEncoding('utf8');
    x.on('data', c => (text += c));
    x.on('end', () => res({ status: x.statusCode, text, json: () => JSON.parse(text) }));
  });
  r.on('error', rej);
  if (body !== undefined) r.write(body);
  r.end();
});
const JSON_CT = { 'Content-Type': 'application/json' };
const review = (draft_id, extra = {}) => ({ v: 1, draft_id, status: 'revise', values: { 1: '170' }, items: [], ...extra });
const post = (id, obj) => raw('POST', `/__review/${id}`, { headers: JSON_CT, body: JSON.stringify(obj) });

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-review-'));
  web = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-review-web-'));
  fs.writeFileSync(path.join(web, 'TempHtml.html'), '<html><head><title>t</title></head><body></body></html>');
  process.env.STRUCMED_WORKSPACE = ws;
  process.env.STRUCMED_RUNTIME_WEB = web;
  const mod = await import('../src/tools.mjs');
  tools = mod.TOOLS;
  t = Object.fromEntries(tools.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  store.saveDictIndex({ loadedAt: '2026-11-01', source: 'test', deptNo: 'TEST0', hasIds: true, deleted: 0, warnings: [], duplicates: [], entries: [
    { id: DIC, dicType: 'TEST0', dicName: '身高', dicComment: dc.build({ desc: '身高', memo: { type: 'numberbox', unit: 'cm', calx: '=BMI 的分母' }, fhir: [{ res: 'Observation', path: 'Observation.valueQuantity', code: 'http://loinc.org|8302-2', ucum: 'cm', note: '量測' }, { res: 'Observation', path: 'Observation.code' }] }), createDate: '20250101' },
    { id: DIC2, dicType: 'TEST0', dicName: '體重', dicComment: dc.build({ desc: '體重' }), createDate: '20250101' },
    { id: DIC3, dicType: 'TEST0', dicName: '腰圍', dicComment: dc.build({ desc: '腰圍' }), createDate: '20250101' }
  ] });
  port = await freePort();
  child = spawn(process.execPath, [SERVE, String(port)], { env: { ...process.env, STRUCMED_WORKSPACE: ws, STRUCMED_RUNTIME_WEB: web }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await raw('GET', '/__health')).status === 200) break; } catch { /* 伺服器還沒起來 */ }
    await new Promise(r => setTimeout(r, 100));
  }
});
after(() => {
  child.kill();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(web, { recursive: true, force: true });
});

// BMI 表單：#2 身高（既有字典）、#3 體重（待新建）、#4 性別（連動 #5）、#5 備註、#6 BMI（計算式）
function bmi() {
  const { draft_id } = t.form_create({ name: 'BMI 審閱', dept_no: 'TEST0', his_text_keys: ['Report'] });
  const { area_itemid } = t.form_add_area({ draft_id, title: '基本', visible_title: true });
  const add = (label_text, control) => t.form_add_control({ draft_id, area_itemid, label_text, control }).itemid;
  const h = add('身高：', { datatype: 'numberbox', dictionary: { id: DIC } });
  const w = add('體重：', { datatype: 'numberbox', dictionary: { name: 'BW_NEW', comment: '體重（kg）', memo: { unit: 'kg' } } });
  const sex = add('性別：', { datatype: 'radiobutton', options: ['男', '女'] });
  const note = add('備註：', { datatype: 'textbox' });
  t.form_update_control({ draft_id, itemid: sex, changes: { options: [{ value: '男', further: [note] }, '女'] } });
  const b = add('BMI：', { datatype: 'label', format: 'formula', formula: `IF(A${h} > 0, ROUND(A${w} / POWER(A${h} / 100, 2), 1), "")` });
  return { draft_id, area_itemid, h, w, sex, note, b };
}

test('meta.json：欄位、區塊、計算式、applied_seq 沿用與 html 回傳', () => {
  const f = bmi();
  const r = t.form_preview({ draft_id: f.draft_id, format: 'html' });
  assert.equal(r.meta_file, path.join('.strucmed', 'preview', `${f.draft_id}.meta.json`));
  assert.equal(r.review_dir, path.join('.strucmed', 'review', f.draft_id));
  const read = () => JSON.parse(fs.readFileSync(path.join(ws, r.meta_file), 'utf8'));
  const m = read();
  assert.equal(m.v, 1); assert.equal(m.name, 'BMI 審閱'); assert.equal(m.applied_seq, 0);
  assert.equal(m.histext, 'histextbyblock');
  assert.deepEqual(m.his_text_keys, ['Report']);
  assert.deepEqual(m.pending_dictionaries, ['BW_NEW']);
  assert.deepEqual(m.areas, [{ itemid: f.area_itemid, type: 'form', title: '基本', gettext: true }]);
  assert.deepEqual(m.fields, JSON.parse(JSON.stringify(t.form_fields({ draft_id: f.draft_id }).fields)));
  assert.match(m.formulas[0].labeled, /\[體重\]/);
  assert.deepEqual(m.formulas[0].samples, []);

  // formula_check 回傳的 samples 原樣寫入；之後不帶 formulas、applied_seq 時沿用
  const c = t.formula_check({ kind: 'formula', text: m.formulas[0].formula, draft_id: f.draft_id, samples: [{ values: { [`A${f.h}`]: 170, [`A${f.w}`]: 65 }, expect: 22.5 }] });
  const dir = path.join(ws, r.review_dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['001.json', '002.json']) fs.writeFileSync(path.join(dir, n), '{}');
  t.form_preview({ draft_id: f.draft_id, format: 'html', applied_seq: 2, formulas: [{ itemid: f.b, samples: c.samples }] });
  assert.deepEqual(read().formulas[0].samples, c.samples);
  t.form_preview({ draft_id: f.draft_id, format: 'html' });
  assert.equal(read().applied_seq, 2);
  assert.deepEqual(read().formulas[0].samples, c.samples);
  // 計算式改了，舊試算不算數
  t.form_update_control({ draft_id: f.draft_id, itemid: f.b, changes: { formula: `ROUND(A${f.w}, 1)` } });
  t.form_preview({ draft_id: f.draft_id, format: 'html' });
  assert.deepEqual(read().formulas[0].samples, []);
  assert.throws(() => t.form_preview({ draft_id: f.draft_id, format: 'html', applied_seq: -1 }), { code: 'E_INVALID_INPUT' });
});

test('his_text_keys 只存在 draft.meta，不進表單 JSON；W_HIS_TEXT_KEYS 區分缺的與大小寫不同', () => {
  const { draft_id } = t.form_create({ name: '文字鍵', dept_no: 'TEST0', his_text_keys: ['Report', 'Impression', 'Plan'] });
  assert.deepEqual(store.loadDraft(draft_id).meta.hisTextKeys, ['Report', 'Impression', 'Plan']);
  assert.throws(() => t.form_create({ name: 'x', dept_no: 'TEST0', his_text_keys: ['a:b'] }), { code: 'E_INVALID_INPUT' });
  const { area_itemid } = t.form_add_area({ draft_id, type: 'tab1', titles: ['Report'] });
  const text = t.form_add_area({ draft_id, title: '印象' }).area_itemid;
  t.form_add_control({ draft_id, area_itemid: text, label_text: '[impression:]', control: { datatype: 'textbox' } });
  t.form_add_control({ draft_id, area_itemid, cell: { index: 0 }, control: { datatype: 'textbox' } });
  const w = t.form_validate({ draft_id }).warnings.find(x => x.code === 'W_HIS_TEXT_KEYS');
  assert.deepEqual(w.missing, ['Plan']);
  assert.deepEqual(w.case_mismatch, [{ want: 'Impression', found: 'impression' }]);
  t.form_update_meta({ draft_id, his_text_keys: ['Report'] });
  assert.ok(!t.form_validate({ draft_id }).warnings.some(x => x.code === 'W_HIS_TEXT_KEYS'));
  t.form_preview({ draft_id, format: 'html' });
  const form = fs.readFileSync(path.join(ws, '.strucmed', 'preview', `${draft_id}.json`), 'utf8');
  assert.ok(!form.includes('hisTextKeys') && !form.includes('his_text_keys'));
});

test('serve：Host、Origin、Content-Type、大小、draft_id、seq 遞增、latest 覆寫', async () => {
  const id = 'd-0123456789ab';
  assert.ok(JSON.parse((await raw('GET', '/__health')).text).features.includes('review'));
  assert.equal((await raw('GET', `/__review/${id}/latest`)).status, 404);
  const ok = JSON.stringify(review(id));
  assert.equal((await raw('POST', `/__review/${id}`, { headers: { ...JSON_CT, Host: 'evil.example' }, body: ok })).status, 403);
  assert.equal((await raw('POST', `/__review/${id}`, { headers: { ...JSON_CT, Origin: 'http://evil.example' }, body: ok })).status, 403);
  assert.equal((await raw('GET', `/__review/${id}/latest`, { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await raw('POST', `/__review/${id}`, { headers: { 'Content-Type': 'text/plain' }, body: ok })).status, 415);
  assert.equal((await raw('POST', '/__review/d-XYZ', { headers: JSON_CT, body: ok })).status, 400);
  assert.equal((await post('d-ffffffffffff', review(id))).status, 400, '本文的 draft_id 要與路徑相同');
  assert.equal((await raw('POST', `/__review/${id}`, { headers: JSON_CT, body: '{oops' })).status, 400);
  assert.equal((await post(id, review(id, { status: 'publish' }))).status, 400);
  assert.equal((await raw('POST', `/__review/${id}`, { headers: JSON_CT, body: JSON.stringify(review(id, { text_output: { all: 'x'.repeat(1024 * 1024) } })) })).status, 413);
  assert.ok(!fs.existsSync(path.join(ws, '.strucmed', 'review', id)), '被拒絕的請求不留檔');

  const first = (await post(id, review(id, { seq: 99, at: 'forged' }))).json();
  assert.deepEqual(first, { ok: true, seq: 1, file: path.join('.strucmed', 'review', id, '001.json') });
  const second = (await raw('POST', `/__review/${id}`, { headers: { 'Content-Type': 'application/json; charset=utf-8', Host: `localhost:${port}` }, body: JSON.stringify(review(id, { status: 'finalize' })) })).json();
  assert.equal(second.seq, 2);
  const latest = (await raw('GET', `/__review/${id}/latest`)).json();
  assert.equal(latest.seq, 2); assert.equal(latest.status, 'finalize');
  const saved = JSON.parse(fs.readFileSync(path.join(ws, first.file), 'utf8'));
  assert.equal(saved.seq, 1, '伺服器補 seq，不用本文帶的');
  assert.notEqual(saved.at, 'forged');
  assert.ok(fs.existsSync(path.join(ws, '.strucmed', 'review', id, '002.json')));
});

test('serve：/__preview 注入 meta 並跳脫 <，載入 review-mode.js', async () => {
  const f = bmi();
  t.form_update_meta({ draft_id: f.draft_id, name: '</script><b>x' });
  t.form_preview({ draft_id: f.draft_id, format: 'html' });
  const page = await raw('GET', `/__preview/${f.draft_id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /window\.__reviewMeta = \{"v":1/);
  assert.ok(!page.text.includes('</script><b>x'));
  assert.ok(page.text.indexOf('preview-shim.js') < page.text.indexOf('review-mode.js'));
  assert.equal((await raw('GET', '/__harness/review-mode.js')).status, 200);
});

test('form_review_read：suggested_calls、memo_items、comments、pending_seqs、連動保留', async () => {
  const f = bmi();
  assert.throws(() => t.form_review_read({ draft_id: f.draft_id }), { code: 'E_NOT_FOUND' });
  t.form_preview({ draft_id: f.draft_id, format: 'html', applied_seq: 0 });
  const items = [
    { itemid: f.h, kind: 'caption', before: '身高：', after: '身高(cm)：' },
    { itemid: f.sex, kind: 'options', before: ['男', '女'], after: ['男性', '女性'] },
    { itemid: f.note, kind: 'default', before: '', after: '無' },
    { itemid: f.note, kind: 'required', before: false, after: true },
    { itemid: f.h, kind: 'memo', dic_id: DIC, dic_name: '身高', before: { unit: 'cm' }, after: { func: 'BMI 的輸入' } },
    { itemid: f.h, kind: 'fhir', dic_id: DIC, dic_name: '身高', after: [{ res: 'Observation', path: 'Observation.valueQuantity', ucum: 'cm' }] },
    { itemid: f.w, kind: 'memo', dic_id: '', dic_name: 'BW_NEW', before: {}, after: { func: '使用者輸入' } },
    { itemid: f.w, kind: 'fhir', dic_id: '', dic_name: 'BW_NEW', after: [{ res: 'Observation', path: 'Observation.valueQuantity', ucum: 'kg' }] },
    { itemid: f.b, kind: 'comment', text: '要顯示分級' },
    { area: f.area_itemid, kind: 'comment', text: '搬到最後' },
    { kind: 'comment', text: '整體' }
  ];
  await post(f.draft_id, review(f.draft_id, { items: [] }));
  const { seq } = (await post(f.draft_id, review(f.draft_id, { items }))).json();
  const r = t.form_review_read({ draft_id: f.draft_id });
  assert.equal(r.review.seq, seq);
  assert.deepEqual(r.pending_seqs, [seq - 1, seq]);
  assert.deepEqual(r.warnings, []);
  const call = i => r.suggested_calls.find(c => c.item === i);
  assert.deepEqual(call(0).args, { draft_id: f.draft_id, itemid: f.h, label_text: '身高(cm)：' });
  assert.deepEqual(call(1).args.changes.options, [{ value: '男性', further: [f.note] }, '女性'], '有連動的選項帶 further，否則連動會被清掉');
  assert.deepEqual(call(2).args.changes, { datavalue: '無' });
  assert.deepEqual(call(3).args.changes, { required: true });
  assert.equal(call(4).tool, 'dictionary_memo_check');
  assert.equal(call(4).args.dic_id, DIC);
  assert.equal(call(4).then, undefined, '既有字典不產生 form_update_control');
  assert.deepEqual(r.memo_items, [{ dic_id: DIC, memo: { func: 'BMI 的輸入' }, fhir: items[5].after }]);
  assert.deepEqual(call(6).args.memo, { unit: 'kg', func: '使用者輸入' }, '待新建字典以合併後的補述檢查');
  assert.deepEqual(call(6).then.args.changes.dictionary, { name: 'BW_NEW', memo: { func: '使用者輸入' } });
  assert.deepEqual(call(7).then.args.changes.dictionary, { name: 'BW_NEW', fhir: items[7].after });
  assert.deepEqual(r.comments, [
    { item: 8, scope: 'control', itemid: f.b, caption: 'BMI', text: '要顯示分級' },
    { item: 9, scope: 'area', area: f.area_itemid, title: '基本', text: '搬到最後' },
    { item: 10, scope: 'form', text: '整體' }
  ]);
  assert.equal(t.form_review_read({ draft_id: f.draft_id, seq: seq - 1 }).review.seq, seq - 1);
  assert.throws(() => t.form_review_read({ draft_id: f.draft_id, seq: 99 }), { code: 'E_NOT_FOUND' });

  // 照 suggested_calls 套用：連動還在、待新建字典的補述與 FHIR 寫進 draft
  for (const c of r.suggested_calls) {
    const res = t[c.tool](c.args);
    if (c.then) { assert.equal(res.ok, true); t[c.then.tool](c.then.args); }
  }
  const d = store.loadDraft(f.draft_id);
  assert.deepEqual(d.pendingDictionaries[0].memo, { unit: 'kg', func: '使用者輸入' });
  assert.equal(d.pendingDictionaries[0].fhir[0].ucum, 'kg');
  // publish-form 建字典前以 form_fields 取得要補寫的 FHIR
  const pendingFhir = t.form_fields({ draft_id: f.draft_id, only: 'dictionary' }).fields.find(x => x.dictionary.pending);
  assert.equal(pendingFhir.dictionary.fhir[0].ucum, 'kg');
  const fm = t.form_fields({ draft_id: f.draft_id }).fields;
  assert.equal(fm.find(x => x.itemid === f.h).caption, '身高(cm)');
  assert.deepEqual(fm.find(x => x.itemid === f.sex).options, ['男性', '女性']);
  assert.ok(fm.find(x => x.itemid === f.note).refs_in.some(x => x.kind === 'further'));
  assert.equal(t.form_validate({ draft_id: f.draft_id }).valid, true);
  t.form_preview({ draft_id: f.draft_id, format: 'html', applied_seq: seq });
  assert.deepEqual(t.form_review_read({ draft_id: f.draft_id }).pending_seqs, []);

  // 待新建字典清除補述鍵
  t.form_update_control({ draft_id: f.draft_id, itemid: f.w, changes: { dictionary: { name: 'BW_NEW', memo: { unit: '' } } } });
  assert.deepEqual(store.loadDraft(f.draft_id).pendingDictionaries[0].memo, { func: '使用者輸入' });

  // 意見檔壞掉
  fs.writeFileSync(path.join(ws, '.strucmed', 'review', f.draft_id, 'latest.json'), '{oops');
  assert.throws(() => t.form_review_read({ draft_id: f.draft_id }), { code: 'E_INVALID_INPUT' });
});

test('form_review_read：W_REVIEW_EMPTY 只在 revise 且沒有任何修改或意見時回', async () => {
  const f = bmi();
  await post(f.draft_id, review(f.draft_id));
  const r = t.form_review_read({ draft_id: f.draft_id });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^W_REVIEW_EMPTY：第 1 次意見/);
  await post(f.draft_id, review(f.draft_id, { status: 'finalize' }));
  assert.deepEqual(t.form_review_read({ draft_id: f.draft_id }).warnings, [], '定稿沒有修改是正常的');
  await post(f.draft_id, review(f.draft_id, { items: [{ kind: 'comment', text: '同意' }] }));
  assert.deepEqual(t.form_review_read({ draft_id: f.draft_id }).warnings, []);
});

test('預覽頁審閱模式的文字：中文 datatype、說明欄位、字典補述段落、藍點提示、零修改提示、橫幅提示', async () => {
  const js = (await raw('GET', '/__harness/review-mode.js')).text;
  for (const s of ["label: '計算式／顯示'", '控制項前的文字（說明）', '字典補述（可在此修改）', '審閱：改說明文字、補述、留意見', '沒有修改，要直接「定稿」嗎？', '字典補述已由 AI 預填，請看藍點卡片']) assert.ok(js.includes(s), s);
  assert.ok(!js.includes("row('說明文字'"));
  assert.doesNotThrow(() => new Function(js), 'review-mode.js 語法正確');
});

test('form_review_read：W_REVIEW_STALE、W_REVIEW_OPTION_REF', async () => {
  const f = bmi();
  t.form_add_control({ draft_id: f.draft_id, area_itemid: f.area_itemid, label_text: '分數：', control: { datatype: 'label', format: 'formula', formula: `IF(A${f.sex} = "男", 1, 0)` } });
  await post(f.draft_id, review(f.draft_id, { items: [
    { itemid: f.sex, kind: 'options', before: ['甲', '乙'], after: ['丙', '丁'] },
    { itemid: 999, kind: 'caption', before: 'x', after: 'y' },
    { itemid: f.sex, kind: 'options', before: ['男', '女'], after: ['男性', '女'] }
  ] }));
  const r = t.form_review_read({ draft_id: f.draft_id });
  assert.deepEqual(r.suggested_calls.map(c => c.item), [2], '舊版選項與已刪除的欄位都不產生');
  assert.equal(r.warnings.filter(w => w.startsWith('W_REVIEW_STALE')).length, 2);
  assert.ok(r.warnings.some(w => w.startsWith('W_REVIEW_OPTION_REF')));
  // 已套用後重讀：不再產生，也不算舊版
  t.form_update_control(r.suggested_calls[0].args);
  await post(f.draft_id, review(f.draft_id, { items: [{ itemid: f.sex, kind: 'options', before: ['男', '女'], after: ['男性', '女'] }] }));
  const again = t.form_review_read({ draft_id: f.draft_id });
  assert.deepEqual(again.suggested_calls, []);
  assert.deepEqual(again.warnings, []);
});

const csvPath = id => path.join(ws, '.strucmed', 'plans', id, 'dictionaries.csv');
const cols = line => line.split(',');
// 改 CSV 的一列：以 parsePlan／toCsv 操作，模擬 Excel 編輯後存檔
async function editCsv(id, fn, { bom = true, lf = false } = {}) {
  const { parsePlan, toCsv } = await import('../src/dictcsv.mjs');
  const rows = parsePlan(fs.readFileSync(csvPath(id), 'utf8'));
  fn(rows);
  let text = toCsv(rows);
  if (!bom) text = text.replace(/^﻿/, '');
  if (lf) text = text.replace(/\r\n/g, '\n');
  return text;
}

test('dictionary_plan_export：BOM、CRLF、欄位、候選、唯讀欄', () => {
  const f = bmi();
  const r = t.dictionary_plan_export({ draft_id: f.draft_id });
  assert.equal(r.file, path.join('.strucmed', 'plans', f.draft_id, 'dictionaries.csv'));
  assert.equal(r.rows, 2);
  assert.equal(r.csv_text, undefined, 'stdio 模式不回 csv_text');
  const text = fs.readFileSync(path.join(ws, r.file), 'utf8');
  assert.ok(text.startsWith('﻿action,id,dicType,dicName,level,role,used_by,desc,meaning,type,unit,range,func,usecase,interop,asr（多值以／分隔）,calx,llm,scope,fhir_res,fhir_path,fhir_code,fhir_display,fhir_ucum,fhir_more,fhir_status,memo_by,candidates,note\r\n'));
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 3);
  const bound = cols(lines[1]), pend = cols(lines[2]);
  assert.deepEqual(bound.slice(0, 7), ['bind', DIC, 'TEST0', '身高', 'own', 'tohis', `${f.h}:身高`]);
  assert.deepEqual(pend.slice(0, 7), ['new', '', 'TEST0', 'BW_NEW', '', 'tohis', `${f.w}:體重`]);
  assert.ok(lines[1].includes('沿用既有'));
  assert.match(lines[2], /體重\(\w+\)/, '待新建字典列出候選');
  assert.ok(lines[1].includes("'=BMI 的分母"), '= 開頭加保護，Excel 才不會當公式');
  assert.throws(() => t.dictionary_plan_export({ draft_id: f.draft_id, out_path: '../outside.csv' }), { code: 'E_INVALID_INPUT' });
  assert.equal(t.dictionary_plan_export({ draft_id: f.draft_id, out_path: 'exports/d.csv' }).file, path.join('exports', 'd.csv'));
});

test('dictionary_plan：往返不變（含逗號、引號、換行；有 BOM 與無 BOM）', async () => {
  const f = bmi();
  const tricky = '有逗號, 引號"與\n換行';
  t.form_update_control({ draft_id: f.draft_id, itemid: f.w, changes: { dictionary: { name: 'BW_NEW', comment: '體重, "kg"', memo: { meaning: tricky, range: '1-12', calx: '=體重/身高^2', scope: "'引號開頭", asr: ['體重', 'BW'] } } } });
  t.dictionary_plan_export({ draft_id: f.draft_id });
  const before = structuredClone(store.loadDraft(f.draft_id).pendingDictionaries);
  const updated = store.loadDraft(f.draft_id).updated;
  const r = t.dictionary_plan_import({ draft_id: f.draft_id });
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.memo_items, []);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.checks.map(c => c.name), ['身高', 'BW_NEW']);
  assert.deepEqual(store.loadDraft(f.draft_id).pendingDictionaries, before);
  assert.equal(store.loadDraft(f.draft_id).updated, updated, '沒有改動時不動 draft');
  // 無 BOM＋LF（Numbers 存回的樣子）
  const text = (await editCsv(f.draft_id, () => {}, { bom: false, lf: true }));
  const r2 = t.dictionary_plan_import({ draft_id: f.draft_id, csv_text: text });
  assert.deepEqual([r2.applied, r2.skipped], [[], []]);

  const { parsePlan, toCsv } = await import('../src/dictcsv.mjs');
  const rows = parsePlan(fs.readFileSync(csvPath(f.draft_id), 'utf8'));
  assert.equal(rows[1].meaning, tricky);
  assert.equal(rows[1].calx, '=體重/身高^2');
  assert.equal(rows[1].range, '1-12');
  assert.equal(rows[1].scope, "'引號開頭");
  assert.equal(rows[1].asr, '體重／BW');
  assert.ok(toCsv(rows).includes("\"有逗號, 引號\"\"與\n換行\""));
});

// 3.9.3 F-05：asr 用 ; 起草，匯入後變成一筆「A;B;C」
test('dictionary_plan_import：asr 的 ; , | 都拆成多筆並回 W_ASR_DELIMITER；／不警告；「、」拆不開時提醒；舊表頭 asr 也認得', async () => {
  const f = bmi();
  t.dictionary_plan_export({ draft_id: f.draft_id });
  const asrOf = () => store.loadDraft(f.draft_id).pendingDictionaries.find(p => p.name === 'BW_NEW').memo.asr;
  const put = async v => t.dictionary_plan_import({ draft_id: f.draft_id, csv_text: await editCsv(f.draft_id, rows => { rows[1].asr = v; }) });
  for (const [v, want] of [['體質量指數;BMI;body mass index', ['體質量指數', 'BMI', 'body mass index']], ['甲, 乙', ['甲', '乙']], ['丙|丁｜戊', ['丙', '丁', '戊']], ['己；庚，辛', ['己', '庚', '辛']]]) {
    const r = await put(v);
    assert.deepEqual(asrOf(), want, v);
    assert.ok(r.warnings.some(w => w.startsWith('W_ASR_DELIMITER') && w.includes(`${want.length} 筆`)), JSON.stringify(r.warnings));
    assert.ok(r.checks.find(c => c.name === 'BW_NEW').warnings.includes('W_ASR_DELIMITER'));
  }
  const slash = await put('體重／BW');
  assert.deepEqual(asrOf(), ['體重', 'BW']);
  assert.ok(!slash.warnings.some(w => w.startsWith('W_ASR_DELIMITER')));
  const unit = await put('kg/m2');
  assert.ok(!unit.warnings.some(w => w.startsWith('W_ASR_DELIMITER')), '/ 是單位，不算分隔符');
  const comma = await put('體重、BW');
  assert.deepEqual(asrOf(), ['體重、BW']);
  assert.ok(comma.warnings.some(w => w.startsWith('W_ASR_DELIMITER') && w.includes('只有一筆')));
  // 舊表頭（3.9.2 以前匯出的 CSV）
  const old = (await editCsv(f.draft_id, rows => { rows[1].asr = '甲;乙'; })).replace('asr（多值以／分隔）', 'asr');
  assert.ok(!old.includes('asr（'));
  t.dictionary_plan_import({ draft_id: f.draft_id, csv_text: old });
  assert.deepEqual(asrOf(), ['甲', '乙']);
});

test('dictionary_plan_import：action 五種與 id 被改', async () => {
  const f = bmi();
  const waist = t.form_add_control({ draft_id: f.draft_id, area_itemid: f.area_itemid, label_text: '腰圍：', control: { datatype: 'numberbox', dictionary: { name: 'WAIST_NEW', comment: '腰' } } }).itemid;
  const other = t.form_add_control({ draft_id: f.draft_id, area_itemid: f.area_itemid, label_text: '體重2：', control: { datatype: 'numberbox', dictionary: { id: DIC2 } } }).itemid;
  const extra = t.form_add_control({ draft_id: f.draft_id, area_itemid: f.area_itemid, label_text: '其他：', control: { datatype: 'numberbox', dictionary: { name: 'SKIP_NEW' } } }).itemid;
  t.dictionary_plan_export({ draft_id: f.draft_id });
  const text = await editCsv(f.draft_id, rows => {
    const by = n => rows.find(r => r.dicName === n);
    Object.assign(by('身高'), { action: 'memo', func: 'BMI 的輸入', calx: '', fhir_ucum: 'm', note: '請心臟科確認' });   // 既有：不寫 draft
    Object.assign(by('BW_NEW'), { desc: '體重 kg', meaning: '當次體重', fhir_res: 'Observation', fhir_path: 'Observation.valueQuantity', dicName: 'BW_RENAMED' });   // 待新建：寫 draft，連同改名
    Object.assign(by('WAIST_NEW'), { action: `rebind:${DIC3}` });
    Object.assign(by('體重'), { action: 'bind', desc: '被改的 desc' });
    Object.assign(by('SKIP_NEW'), { action: 'skip', meaning: '不會寫入' });
    rows.push({ ...by('體重'), action: 'bind', id: 'tampered-id', row: 0 });
    rows.push({ ...by('身高'), action: 'teleport', note: '', row: 0 });
  });
  const r = t.dictionary_plan_import({ draft_id: f.draft_id, csv_text: text });
  assert.deepEqual(r.applied.find(x => x.action === 'memo'), { name: '身高', action: 'memo', changed: ['func', 'calx', 'fhir'] });
  assert.deepEqual(Object.keys(r.memo_items[0]), ['dic_id', 'memo', 'fhir']);
  assert.deepEqual(r.memo_items[0].memo, { func: 'BMI 的輸入', calx: '' });
  assert.equal(r.memo_items[0].fhir[0].ucum, 'm');
  assert.equal(r.memo_items[0].fhir[0].note, '量測', '第一組的 note 沒有欄位，沿用目前內容');
  assert.equal(r.memo_items[0].fhir[1].path, 'Observation.code', 'fhir_more 往返');
  assert.deepEqual(r.rebinds, [{ itemid: waist, from: 'WAIST_NEW', to: DIC3 }]);
  assert.deepEqual(r.applied.find(x => x.action === 'new'), { name: 'BW_RENAMED', action: 'new', changed: ['dicName', 'desc', 'meaning', 'fhir'] });
  assert.ok(r.checks.find(c => c.name === '體重').warnings.includes('W_DESC_READONLY'));
  assert.equal(r.skipped.length, 3);
  assert.match(r.skipped[0].reason, /action=skip/);
  assert.match(r.skipped[1].reason, /id 欄不可改/);
  assert.match(r.skipped[2].reason, /action「teleport」/);

  const d = store.loadDraft(f.draft_id);
  const pend = Object.fromEntries(d.pendingDictionaries.map(p => [p.name, p]));
  assert.deepEqual(Object.keys(pend).sort(), ['BW_RENAMED', 'SKIP_NEW'], 'WAIST_NEW 改綁後移出待新建');
  assert.equal(pend.BW_RENAMED.comment, '體重 kg');
  assert.equal(pend.BW_RENAMED.fhir[0].path, 'Observation.valueQuantity');
  assert.equal(pend.SKIP_NEW.memo, undefined);
  const fm = t.form_fields({ draft_id: f.draft_id }).fields;
  assert.equal(fm.find(x => x.itemid === f.w).dictionary.name, 'BW_RENAMED');
  assert.equal(fm.find(x => x.itemid === waist).dictionary.id, DIC3);
  assert.equal(fm.find(x => x.itemid === other).dictionary.desc, '體重', '既有字典的 desc 不動');
  assert.equal(fm.find(x => x.itemid === extra).dictionary.name, 'SKIP_NEW');
  assert.equal(t.form_validate({ draft_id: f.draft_id }).valid, true);
});

// 3.10.2 F-05：既有字典 bind、沒補述，補述缺漏的提醒只回一次
test('dictionary_plan_import：既有字典 bind 的補述缺漏只提醒一次，第二次併成一條', async () => {
  const f = bmi();
  t.dictionary_plan_export({ draft_id: f.draft_id });
  const put = async fn => t.dictionary_plan_import({ draft_id: f.draft_id, csv_text: await editCsv(f.draft_id, fn) });
  const codes = (r, name) => r.checks.find(c => c.name === name).warnings;
  const r1 = await put(() => {});
  assert.ok(codes(r1, '身高').includes('W_MEMO_INCOMPLETE'), '第一次照常提醒：' + JSON.stringify(r1.checks));
  assert.ok(!r1.warnings.some(w => w.startsWith('W_MEMO_EXISTING_REPEAT')));
  const first = codes(r1, '身高').filter(c => /^W_MEMO_(INCOMPLETE|NO_MEANING)$/.test(c));
  const r2 = await put(() => {});
  assert.deepEqual(codes(r2, '身高').filter(c => /^W_MEMO_(INCOMPLETE|NO_MEANING)$/.test(c)), [], '第二次不再逐本回');
  const rep = r2.warnings.filter(w => w.startsWith('W_MEMO_EXISTING_REPEAT'));
  assert.equal(rep.length, 1);
  assert.match(rep[0], /既有字典 1 本沒補述，上次已提醒/);
  assert.ok(first.length >= 1);
  // 待新建字典（action=new）不受影響：每次照常提醒
  assert.ok(codes(r2, 'BW_NEW').includes('W_MEMO_INCOMPLETE'));
  // 使用者改了既有字典的補述（action=memo）：警告照常
  const r3 = await put(rows => { Object.assign(rows.find(r => r.dicName === '身高'), { action: 'memo', func: 'BMI 的輸入' }); });
  assert.equal(r3.warnings.filter(w => w.startsWith('W_MEMO_EXISTING_REPEAT')).length, 0);
  assert.ok(codes(r3, '身高').includes('W_MEMO_INCOMPLETE'));
});

test('dictionary_plan_import：CSV 只含要改的列時，沒列到的字典不動', async () => {
  const f = bmi();
  t.dictionary_plan_export({ draft_id: f.draft_id });
  const text = await editCsv(f.draft_id, rows => {
    rows.splice(0, 1);                      // 拿掉既有字典那一列
    rows[0].meaning = '當次體重';
  });
  const r = t.dictionary_plan_import({ draft_id: f.draft_id, csv_text: text });
  assert.deepEqual(r.applied, [{ name: 'BW_NEW', action: 'new', changed: ['meaning'] }]);
  assert.deepEqual([r.skipped, r.memo_items], [[], []]);
  assert.deepEqual(r.checks.map(c => c.name), ['BW_NEW']);
  assert.equal(store.loadDraft(f.draft_id).pendingDictionaries[0].memo.meaning, '當次體重');
});

test('dictionary_plan_import：error 的列進 skipped；缺欄、路徑限制', async () => {
  const f = bmi();
  t.dictionary_plan_export({ draft_id: f.draft_id });
  const text = await editCsv(f.draft_id, rows => {
    rows[0].action = 'memo'; rows[0].meaning = '身分證 A123456789';
    rows[1].meaning = '病人 B223456789'; rows[1].fhir_res = 'bad';
  });
  const before = structuredClone(store.loadDraft(f.draft_id).pendingDictionaries);
  const r = t.dictionary_plan_import({ draft_id: f.draft_id, csv_text: text });
  assert.deepEqual(r.memo_items, []);
  assert.deepEqual(r.skipped.map(x => x.row), [2, 3]);
  assert.match(r.skipped[0].reason, /E_PHI_SUSPECT/);
  assert.deepEqual(r.checks[0].errors, ['E_PHI_SUSPECT']);
  assert.deepEqual(store.loadDraft(f.draft_id).pendingDictionaries, before);
  assert.throws(() => t.dictionary_plan_import({ draft_id: f.draft_id, csv_text: 'id,desc\r\n1,2\r\n' }), e => e.code === 'E_INVALID_INPUT' && e.details.missing.includes('action') && e.details.missing.includes('dicName'));
  assert.throws(() => t.dictionary_plan_import({ draft_id: f.draft_id, csv_path: '../x.csv' }), { code: 'E_INVALID_INPUT' });
  assert.throws(() => t.dictionary_plan_import({ draft_id: f.draft_id, csv_path: 'no-such.csv' }), { code: 'E_NOT_FOUND' });
  assert.throws(() => t.dictionary_plan_import({ draft_id: f.draft_id, csv_path: 'a.csv', csv_text: 'x' }), { code: 'E_INVALID_INPUT' });
});

test('dictionary_plan_export：HTTP 模式回 csv_text', async () => {
  const { requestContext } = await import('../src/reqctx.mjs');
  const f = bmi();
  const r = requestContext.run({ path: '/mcp' }, () => t.dictionary_plan_export({ draft_id: f.draft_id }));
  assert.ok(r.csv_text.startsWith('﻿action,'));
  assert.equal(r.rows, 2);
});
