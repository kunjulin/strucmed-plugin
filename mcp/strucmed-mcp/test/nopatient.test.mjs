// 非病人表單（iot f_nopatient）：選項寫入、匯出匯入保留、E_NOPATIENT_* 觸發與不觸發
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ws, t, store, model, pkgmod, flagsFile;
const codes = list => list.map(e => e.code);
const errOf = fn => { try { fn(); } catch (e) { return e; } assert.fail('應該拋錯'); };
const iotOf = draft_id => model.toFormJson(store.loadDraft(draft_id), 'test').find(x => x.itemtype === 'iot');

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-nopatient-'));
  process.env.STRUCMED_WORKSPACE = ws;
  flagsFile = path.join(ws, 'flags.json');
  process.env.STRUCMED_FLAGS = flagsFile;
  fs.writeFileSync(flagsFile, JSON.stringify({ embedArea: true }));
  const { TOOLS } = await import('../src/tools.mjs');
  t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));
  store = await import('../src/store.mjs');
  model = await import('../src/model.mjs');
  pkgmod = await import('../src/package.mjs');
});
after(() => { delete process.env.STRUCMED_FLAGS; fs.rmSync(ws, { recursive: true, force: true }); });

// 一張乾淨的表單：一個區塊、兩個欄位
function draft(name, options) {
  const r = t.form_create({ name, dept_no: 'TEST0', ...(options && { options }) });
  const a = t.form_add_area({ draft_id: r.draft_id }).area_itemid;
  const add = (label_text, control) => t.form_add_control({ draft_id: r.draft_id, area_itemid: a, label_text, control });
  const topic = add('主題：', { datatype: 'textbox' }).itemid;
  const plan = add('教案：', { datatype: 'textarea' }).itemid;
  return { ...r, a, add, topic, plan };
}
function exportDraft(draft_id) {
  const p = t.form_export({ draft_id, overwrite: true });
  return { plan: p.plan, out: t.form_export({ draft_id, overwrite: true, confirm_token: p.confirm_token }) };
}

test('form_create：no_patient 寫入 iot f_nopatient，並帶出三個預設；明確指定時以指定值為準', () => {
  const d = draft('教案一頁通', { no_patient: true });
  assert.equal(d.no_patient, true);
  assert.match(d.no_patient_note, /struNote 不需病歷號/);
  const iot = iotOf(d.draft_id);
  assert.equal(iot.f_nopatient, true);
  assert.equal(iot.f_chtno, false);
  assert.equal(iot.f_opdno, false);
  assert.equal(iot.f_hideprevicon, true);

  const e = draft('教案明確指定', { no_patient: true, f_chtno: true, hide_prev_icon: false });
  const iot2 = iotOf(e.draft_id);
  assert.deepEqual([iot2.f_nopatient, iot2.f_chtno, iot2.f_opdno, iot2.f_hideprevicon], [true, true, false, false]);
  const v = t.form_validate({ draft_id: e.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.match(v.warnings.find(w => w.code === 'W_NOPATIENT_OPTION').message, /f_chtno/);
});

test('一般表單：iot 不寫 f_nopatient、預設不變，也沒有任何 NOPATIENT 訊息', () => {
  const d = draft('一般表單');
  assert.equal(d.no_patient, undefined);
  const iot = iotOf(d.draft_id);
  assert.ok(!('f_nopatient' in iot));
  assert.deepEqual([iot.f_chtno, iot.f_opdno, iot.f_hideprevicon], [true, false, false]);
  const f = draft('明確 false', { no_patient: false });
  assert.ok(!('f_nopatient' in iotOf(f.draft_id)));
  // 病人相關寫法在一般表單照舊可用
  d.add('年齡：', { datatype: 'label', format: 'hisquery', hisquery: 'Procedure.InName(PKG.GET_AGE).GetValueByName(AGE)', his_query_title: 'patient.age' });
  d.add('', { datatype: 'action', action_name: '帶檢驗', action_script: `HISQUERY("${d.plan},LABDATA.InDays(30).GetAllString")` });
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.no_patient, undefined);
  assert.ok(![...v.errors, ...v.warnings].some(x => /NOPATIENT/.test(x.code)));
});

test('options：型別不對或不認得的鍵會被拒絕；空字串視同沒給', () => {
  assert.equal(errOf(() => t.form_create({ name: '壞選項', dept_no: 'TEST0', options: { no_patient: 'yes' } })).code, 'E_INVALID_INPUT');
  assert.equal(errOf(() => t.form_create({ name: '壞選項2', dept_no: 'TEST0', options: { nopatient: true } })).code, 'E_UNKNOWN_KEY');
  const r = t.form_create({ name: '空字串選項', dept_no: 'TEST0', options: { no_patient: true, f_chtno: '', hide_prev_icon: null } });
  assert.deepEqual(store.loadDraft(r.draft_id).meta.options, { no_patient: true });
});

test('乾淨的非病人表單：通過驗證，回 no_patient 與 W_NOPATIENT_FORM；LLM 巨集不受影響', () => {
  const d = draft('教案乾淨', { no_patient: true });
  d.add('', { datatype: 'action', action_name: '產生教案', action_id: d.plan,
    action_script: `LLMQUERY(${d.plan}, IF(LEN(A${d.topic}) < 2, "not available", CONCATENATE("只根據下列主題寫教案，只提供答案：", A${d.topic})), "nemotron35")` });
  // 提示詞文字裡提到函數名稱或 {chtno} 不算
  d.add('', { datatype: 'action', action_name: '說明', action_id: d.plan, action_script: `MACRO(${d.plan}, "本表單不使用 HISQUERY( 或 LOOKUPDW( 或 G_CHTNO()")` });
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.no_patient, true);
  assert.ok(!codes(v.warnings).some(c => /^W_NOPATIENT_(OPTION|DICT_WRITE|EMBED)/.test(c)));
  const w = v.warnings.find(x => x.code === 'W_NOPATIENT_FORM');
  assert.match(w.message, /平台尚未部署/);
  assert.match(w.message, /不要用倉儲以病歷號查詢/);
});

test('E_NOPATIENT_HISQUERY：label HIS 參照與 HISQUERY 巨集', () => {
  const d = draft('教案HIS', { no_patient: true });
  const lab = d.add('年齡：', { datatype: 'label', format: 'hisquery', hisquery: 'Procedure.InName(PKG.GET_AGE).GetValueByName(AGE)', his_query_title: 'patient.age' }).itemid;
  const btn = d.add('', { datatype: 'action', action_name: '帶檢驗', action_script: `HISQUERY("${d.plan},LABDATA.InDays(30).GetAllString")` }).itemid;
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v.valid, false);
  const hits = v.errors.filter(e => e.code === 'E_NOPATIENT_HISQUERY');
  assert.deepEqual(hits.map(e => e.itemid).sort(), [lab, btn].sort());
  assert.match(hits.find(e => e.itemid === lab).message, /label 的 HIS 參照/);
  // 不能輸出
  assert.equal(errOf(() => t.form_export({ draft_id: d.draft_id })).code, 'E_INVALID_INPUT');
  // 移除後通過
  for (const itemid of [btn, lab]) {
    const p = t.form_remove_control({ draft_id: d.draft_id, itemid });
    t.form_remove_control({ draft_id: d.draft_id, itemid, confirm_token: p.confirm_token });
  }
  const v2 = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v2.valid, true, JSON.stringify(v2.errors));
});

test('E_NOPATIENT_LOOKUPDW：LOOKUPDW 與 LOOKUPDEFAULTSETTING；舊式整段引號包住的步驟也抓得到', () => {
  const d = draft('教案倉儲', { no_patient: true });
  const b1 = d.add('', { datatype: 'action', action_name: '查倉儲', action_script: `LOOKUPDW("體重:${d.topic}", null, 7)` }).itemid;
  const b2 = d.add('', { datatype: 'action', action_name: '開表單帶入', action_script: `LOOKUPDEFAULTSETTING("體重:${d.topic}", null, 7)` }).itemid;
  const b3 = d.add('', { datatype: 'action', action_name: '舊寫法', action_script: `"LOOKUPDW('體重:${d.topic}', null, 7)"` }).itemid;
  const v = t.form_validate({ draft_id: d.draft_id });
  const hits = v.errors.filter(e => e.code === 'E_NOPATIENT_LOOKUPDW');
  assert.deepEqual(hits.map(e => e.itemid).sort(), [b1, b2, b3].sort(), JSON.stringify(v.errors));
});

test('E_NOPATIENT_CHTNO_FUNC（G_CHTNO、GETCHTNO）是 error；G_OPDNO 等只列 W_NOPATIENT_OPDNO_FUNC', () => {
  const d = draft('教案病歷號', { no_patient: true });
  const f = d.add('代碼：', { datatype: 'label', format: 'formula', formula: 'G_CHTNO()' }).itemid;
  const m = d.add('', { datatype: 'action', action_name: '寫入', action_script: `MACRO(${d.plan}, CONCATENATE(GETCHTNO(), "-", G_USERNM()))` }).itemid;
  const o = d.add('就醫號：', { datatype: 'label', format: 'formula', formula: 'G_OPDNO()' }).itemid;
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.deepEqual(v.errors.filter(e => e.code === 'E_NOPATIENT_CHTNO_FUNC').map(e => e.itemid).sort(), [f, m].sort());
  assert.ok(!v.errors.some(e => e.itemid === o));
  assert.equal(v.warnings.find(w => w.code === 'W_NOPATIENT_OPDNO_FUNC').itemid, o);
});

test('E_NOPATIENT_EMBED_CHTNO：params 用 {chtno}；{opdno} 只警告；{user}／{deptNo}／常數不觸發', () => {
  const embed = (params) => ({ type: 'embed', title: '教案助手', url: 'https://assistantai.cgmh.org.tw/lesson/', params });
  const d = draft('教案嵌入', { no_patient: true });
  const e1 = t.form_add_area({ draft_id: d.draft_id, ...embed({ chtno: '{chtno}', visit: '{opdno}', user: '{user}' }) }).area_itemid;
  let v = t.form_validate({ draft_id: d.draft_id });
  const hit = v.errors.find(e => e.code === 'E_NOPATIENT_EMBED_CHTNO');
  assert.equal(hit.itemid, e1);
  assert.match(hit.message, /chtno/);
  assert.equal(v.warnings.find(w => w.code === 'W_NOPATIENT_EMBED_OPDNO').itemid, e1);
  t.form_update_area({ draft_id: d.draft_id, itemid: e1, params: { user: '{user}', dept: '{deptNo}', mode: 'edu' } });
  v = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(!codes(v.warnings).includes('W_NOPATIENT_EMBED_OPDNO'));
  assert.ok(codes(v.warnings).includes('W_NOPATIENT_EMBED_CONTEXT'), '嵌入頁仍會收到 strucmed.context 的保留代碼');

  // 一般表單的 {chtno} 照舊
  const n = draft('一般嵌入');
  t.form_add_area({ draft_id: n.draft_id, ...embed({ chtno: '{chtno}' }) });
  v = t.form_validate({ draft_id: n.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(![...v.errors, ...v.warnings].some(x => /NOPATIENT/.test(x.code)));
});

test('匯出 .htm／.package.json／manifest 保留 f_nopatient；重新匯入後仍是非病人表單', () => {
  const d = draft('教案匯出', { no_patient: true });
  const { plan, out } = exportDraft(d.draft_id);
  assert.match(plan.no_patient, /struNote 不需病歷號/);
  const root = store.workspace().root;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, out.files.json), 'utf8'));
  const iot = pkg.form[pkg.form.length - 1];
  assert.deepEqual([iot.f_nopatient, iot.f_chtno, iot.f_opdno, iot.f_hideprevicon], [true, false, false, true]);
  assert.deepEqual(pkgmod.validatePackage(pkg), []);
  const htm = fs.readFileSync(path.join(root, out.files.htm), 'utf8');
  assert.match(htm.slice(0, htm.indexOf('</script>')), /"f_nopatient":true/, '舊版匯入器讀的 tempdata 也有');
  assert.equal(pkgmod.extractPackage(htm).form.at(-1).f_nopatient, true);
  const man = fs.readFileSync(path.join(root, out.files.manifest), 'utf8');
  assert.match(man, /## 非病人表單/);
  assert.match(man, /非病人表單：struNote 不需病歷號，平台以保留代碼/);
  assert.match(man, /平台尚未部署/);
  assert.match(man, /不要用倉儲以病歷號查詢這類紀錄/);
  assert.match(man, /\| 非病人表單 \| 是/);

  // .htm 與 .package.json 兩種來源都保留
  for (const [i, rel] of [out.files.htm, out.files.json].entries()) {
    const r = t.form_import({ source_path: rel, name: `教案改版${i}`, dept_no: 'TEST0' });
    assert.equal(r.no_patient, true);
    assert.ok(r.notes.some(n => /非病人表單/.test(n)));
    assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
    const again = iotOf(r.draft_id);
    assert.deepEqual([again.f_nopatient, again.f_chtno, again.f_opdno, again.f_hideprevicon], [true, false, false, true]);
    const second = exportDraft(r.draft_id);
    const pkg2 = JSON.parse(fs.readFileSync(path.join(root, second.out.files.json), 'utf8'));
    assert.equal(pkg2.form.at(-1).f_nopatient, true);
    assert.match(fs.readFileSync(path.join(root, second.out.files.manifest), 'utf8'), /## 非病人表單/);
  }
  // 一般表單的 manifest 沒有這一節
  const n = draft('一般匯出');
  const o2 = exportDraft(n.draft_id);
  assert.equal(o2.plan.no_patient, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(root, o2.out.files.manifest), 'utf8'), /非病人表單/);
  // 套件驗證：f_nopatient 必須是布林
  const bad = structuredClone(pkg);
  bad.form.at(-1).f_nopatient = 'true';
  bad.integrity.sha256 = pkgmod.packageHash(bad.form, bad.presets);
  assert.ok(pkgmod.validatePackage(bad).some(e => /f_nopatient/.test(e)));
});

test('改版：原表單既有的違規列 warning（原表單既有）；這次改到的、或這次才設成非病人的，一律 error', () => {
  // 來源：一張有 HIS 參照、讀取型字典的一般表單
  const s = draft('來源表單');
  const lab = s.add('年齡：', { datatype: 'label', format: 'hisquery', hisquery: 'Procedure.InName(PKG.GET_AGE).GetValueByName(AGE)', his_query_title: 'patient.age' }).itemid;
  const src = exportDraft(s.draft_id).out;
  const root = store.workspace().root;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, src.files.json), 'utf8'));
  // 另做一份：來源本身就是非病人表單（例如平台編輯器存的），帶著既有的 HIS 參照與 fromhis 欄位
  const np = structuredClone(pkg);
  np.template.name = '來源非病人';
  np.form.at(-1).f_nopatient = true;
  const ctl = np.form[0].item.find(x => String(x.itemid) === String(s.topic));
  Object.assign(ctl, { dictionary: '主題', dicid: '00000000-0000-0000-0000-000000000001', dicrole: 'fromhis' });
  np.integrity.sha256 = pkgmod.packageHash(np.form, np.presets);
  fs.writeFileSync(path.join(root, 'np-src.package.json'), JSON.stringify(np));

  const a = t.form_import({ source_path: 'np-src.package.json', name: '非病人改版', dept_no: 'TEST0' });
  assert.equal(a.no_patient, true);
  let v = t.form_validate({ draft_id: a.draft_id });
  assert.ok(!v.errors.some(e => /^E_NOPATIENT/.test(e.code)), JSON.stringify(v.errors));
  const w = v.warnings.find(x => x.code === 'E_NOPATIENT_HISQUERY');
  assert.match(w.message, /原表單既有/);
  assert.ok(v.warnings.some(x => x.code === 'E_NOPATIENT_DICT_READ' && x.itemid === s.topic));
  // 改到那個 HIS 參照 → error
  t.form_update_control({ draft_id: a.draft_id, itemid: lab, changes: { hisquery: 'Procedure.InName(PKG.GET_SEX).GetValueByName(SEX)' } });
  v = t.form_validate({ draft_id: a.draft_id });
  assert.ok(v.errors.some(e => e.code === 'E_NOPATIENT_HISQUERY' && e.itemid === lab));

  // 一般表單改版，這次才設成非病人（form_update_meta）→ 既有的也是 error
  const b = t.form_import({ source_path: src.files.json, name: '轉成非病人', dept_no: 'TEST0' });
  assert.equal(b.no_patient, undefined);
  assert.equal(t.form_validate({ draft_id: b.draft_id }).valid, true);
  const m = t.form_update_meta({ draft_id: b.draft_id, options: { no_patient: true } });
  assert.equal(m.no_patient, true);
  assert.deepEqual(m.options_changed.sort(), ['f_chtno', 'f_hideprevicon', 'f_nopatient']);
  assert.deepEqual(m.iot_options, { f_nopatient: true, f_chtno: false, f_opdno: false, f_hideprevicon: true, f_hideAssist: false, f_hidePreset: false, f_day: '30', f_histext: 'histextbyblock' });
  v = t.form_validate({ draft_id: b.draft_id });
  assert.ok(v.errors.some(e => e.code === 'E_NOPATIENT_HISQUERY' && e.itemid === lab && !/原表單既有/.test(e.message)));
  // 取消：回到一般表單，不自動改回其他選項
  const off = t.form_update_meta({ draft_id: b.draft_id, options: { no_patient: false } });
  assert.equal(off.no_patient, undefined);
  assert.deepEqual(off.options_changed, ['f_nopatient']);
  assert.equal(off.iot_options.f_chtno, false);
  assert.equal(t.form_validate({ draft_id: b.draft_id }).valid, true);
  assert.ok(!('f_nopatient' in iotOf(b.draft_id)));
});

test('form_update_meta：新 draft 的 options 只改有帶的鍵；明確指定的值優先', () => {
  const d = draft('後來才設', { f_day: 90, hide_assist: true });
  d.add('年齡：', { datatype: 'label', format: 'hisquery', hisquery: 'Procedure.InName(PKG.GET_AGE).GetValueByName(AGE)', his_query_title: 'patient.age' });
  assert.equal(t.form_validate({ draft_id: d.draft_id }).valid, true);
  const m = t.form_update_meta({ draft_id: d.draft_id, options: { no_patient: true, hide_prev_icon: false } });
  assert.deepEqual(m.meta.options, { f_day: 90, hide_assist: true, no_patient: true, hide_prev_icon: false });
  const iot = iotOf(d.draft_id);
  assert.deepEqual([iot.f_nopatient, iot.f_chtno, iot.f_hideprevicon, iot.f_hideAssist, iot.f_day], [true, false, false, true, '90']);
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.ok(codes(v.errors).includes('E_NOPATIENT_HISQUERY'));
  assert.ok(codes(v.warnings).includes('W_NOPATIENT_OPTION'));
  // 沒帶 options 時不動
  t.form_update_meta({ draft_id: d.draft_id, description: '說明' });
  assert.equal(store.loadDraft(d.draft_id).meta.options.no_patient, true);
});

test('W_NOPATIENT_DICT_WRITE：寫入字典的欄位以保留代碼存進倉儲', () => {
  const d = draft('教案字典', { no_patient: true });
  d.add('學員人數：', { datatype: 'numberbox', dictionary: { name: '教案學員人數', comment: '教案的學員人數' } });
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.match(v.warnings.find(w => w.code === 'W_NOPATIENT_DICT_WRITE').message, /不要用倉儲以病歷號查詢/);
});

// 批次建置（form_build）：create.options.no_patient 與逐筆 form_create 相同；E_NOPATIENT_* 由最後的 form_validate 回報
test('form_build：create.options.no_patient 寫出 f_nopatient，違規欄位在 validate 回 E_NOPATIENT_*', () => {
  const ok = t.form_build({ create: { name: '批次非病人表單', dept_no: 'TEST0', options: { no_patient: true } },
    areas: [{ id: 'A1', controls: [{ id: 'C1', label_text: '主題：', control: { datatype: 'textbox' } }] }] });
  const iot = iotOf(ok.draft_id);
  assert.deepEqual([iot.f_nopatient, iot.f_chtno, iot.f_opdno, iot.f_hideprevicon], [true, false, false, true]);
  assert.deepEqual(codes(ok.validate.errors), []);
  assert.ok(codes(ok.validate.warnings).includes('W_NOPATIENT_FORM'));
  const bad = t.form_build({ create: { name: '批次非病人表單 2', dept_no: 'TEST0', options: { no_patient: true } },
    areas: [{ id: 'A1', controls: [{ id: 'C1', label_text: '近期門診：', control: { datatype: 'label', format: 'hisquery', hisquery: 'OPDDATA.InDays(30).GetLatestString()' } }] }] });
  assert.ok(codes(bad.validate.errors).includes('E_NOPATIENT_HISQUERY'));
});
