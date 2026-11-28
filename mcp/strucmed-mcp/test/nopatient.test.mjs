// 非病人表單（iot f_nopatient）：選項寫入、匯出匯入保留、E_NOPATIENT_* 觸發與不觸發；
// 3.16.0 起依平台現況（kunjulin/strucmed docs/API-V2.md「非病人表單」，院內 2026-11-22 部署）：{opdno} 是 error、開啟時自動取出、紀錄表頭與查詢限制的說明
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('form_create：no_patient 寫入 iot f_nopatient，並帶出四個預設；明確指定時以指定值為準', () => {
  const d = draft('教案一頁通', { no_patient: true });
  assert.equal(d.no_patient, true);
  assert.match(d.no_patient_note, /struNote 不需病歷號/);
  const iot = iotOf(d.draft_id);
  assert.equal(iot.f_nopatient, true);
  assert.equal(iot.f_chtno, false);
  assert.equal(iot.f_opdno, false);
  assert.equal(iot.f_hideprevicon, true);
  assert.equal(iot.f_autoLoadOnOpen, true, 'struNote 不帶 recNo：預設開啟時自動取出');
  assert.match(d.no_patient_note, /只有填寫者本人查得到/);
  assert.match(d.no_patient_note, /HIS 內開啟時存檔會被平台拒絕/);
  assert.doesNotMatch(d.no_patient_note, /尚未部署|暫行/);

  const e = draft('教案明確指定', { no_patient: true, f_chtno: true, hide_prev_icon: false, auto_load_on_open: false });
  const iot2 = iotOf(e.draft_id);
  assert.deepEqual([iot2.f_nopatient, iot2.f_chtno, iot2.f_opdno, iot2.f_hideprevicon], [true, true, false, false]);
  assert.ok(!('f_autoLoadOnOpen' in iot2), '明確關閉時不寫出');
  const v = t.form_validate({ draft_id: e.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.match(v.warnings.find(w => w.code === 'W_NOPATIENT_OPTION').message, /f_chtno/);
  // 沒開「開啟時自動取出」：struNote 開頁是空白，存檔會覆寫上一筆
  const al = v.warnings.find(w => w.code === 'W_NOPATIENT_AUTOLOAD');
  assert.match(al.message, /存檔會覆寫上次存的那一筆/);
  assert.match(al.message, /auto_load_on_open:true/);
  t.form_update_meta({ draft_id: e.draft_id, options: { auto_load_on_open: true } });
  assert.equal(iotOf(e.draft_id).f_autoLoadOnOpen, true);
  assert.ok(!codes(t.form_validate({ draft_id: e.draft_id }).warnings).includes('W_NOPATIENT_AUTOLOAD'));
});

test('一般表單：iot 不寫 f_nopatient、預設不變，也沒有任何 NOPATIENT 訊息', () => {
  const d = draft('一般表單');
  assert.equal(d.no_patient, undefined);
  const iot = iotOf(d.draft_id);
  assert.ok(!('f_nopatient' in iot));
  assert.deepEqual([iot.f_chtno, iot.f_opdno, iot.f_hideprevicon], [true, false, false]);
  assert.ok(!('f_autoLoadOnOpen' in iot), '一般表單不寫出 f_autoLoadOnOpen：輸出與既有版本相同');
  // 一般表單的 iot 鍵與順序逐一固定（3.15.1 的輸出）
  assert.deepEqual(Object.keys(iot).slice(0, 10), ['itemtype', 'editorver', 'sheetid', 'f_opdno', 'f_chtno', 'templateID', 'f_histext', 'f_hideprevicon', 'f_hideAssist', 'f_hidePreset']);
  const f = draft('明確 false', { no_patient: false, auto_load_on_open: false });
  assert.ok(!('f_nopatient' in iotOf(f.draft_id)));
  assert.ok(!('f_autoLoadOnOpen' in iotOf(f.draft_id)));
  // 一般表單明確要求時才寫出，且沒有任何 NOPATIENT 訊息
  const g = draft('一般自動取出', { auto_load_on_open: true });
  assert.equal(iotOf(g.draft_id).f_autoLoadOnOpen, true);
  assert.ok(![...t.form_validate({ draft_id: g.draft_id }).warnings].some(x => /NOPATIENT/.test(x.code)));
  assert.equal(errOf(() => t.form_create({ name: '壞選項3', dept_no: 'TEST0', options: { auto_load_on_open: 'yes' } })).code, 'E_INVALID_INPUT');
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
  assert.ok(!codes(v.warnings).some(c => /^W_NOPATIENT_(OPTION|DICT_WRITE|EMBED|AUTOLOAD|HIS_LIST)/.test(c)));
  const w = v.warnings.find(x => x.code === 'W_NOPATIENT_FORM');
  // 平台已部署（院內 2026-11-22）：不再有「暫行輸入固定代碼」的說法
  assert.doesNotMatch(w.message, /平台尚未部署|暫行/);
  assert.match(w.message, /院內、院外站台都已支援（2026-11-22）/);
  assert.match(w.message, /online_features 的 runtime\.no_patient/);
  assert.match(w.message, /不輸入真實病歷號，也不自行輸入保留代碼/);
  // 紀錄表頭（院方核定）與查詢限制
  assert.match(w.message, /chtno＝APP-NP、deptNo＝APP、opdno＝APP（紀錄主體）、recNo＝紀錄鍵/);
  assert.match(w.message, /只有填寫者本人查得到、下載得到，查詢須帶 sheetid/);
  assert.match(w.message, /HIS 內開啟時存檔會被平台拒絕/);
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
  const ow = v.warnings.find(w => w.code === 'W_NOPATIENT_OPDNO_FUNC');
  assert.equal(ow.itemid, o);
  assert.match(ow.message, /紀錄主體代碼（現行固定 APP）/);
  assert.doesNotMatch(ow.message, /多半是空值/);
});

test('W_NOPATIENT_LOADDOC：LOADDOC／LOADXML 只警告，說明平台只取回這張表單、同一個 recNo、自己的紀錄', () => {
  const d = draft('教案取出', { no_patient: true });
  const b1 = d.add('', { datatype: 'action', action_name: '取出', action_script: 'LOADDOC()' }).itemid;
  const b2 = d.add('', { datatype: 'action', action_name: '取出 XML', action_script: 'LOADXML()' }).itemid;
  const v = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const hits = v.warnings.filter(w => w.code === 'W_NOPATIENT_LOADDOC');
  assert.deepEqual(hits.map(w => w.itemid).sort(), [b1, b2].sort());
  for (const h of hits) {
    assert.match(h.message, /只取回這張表單、同一個紀錄鍵（recNo；struNote 不帶，是 none）、自己建立的紀錄/);
    assert.doesNotMatch(h.message, /尚未部署|可能取到別人的/);
  }
});

test('W_NOPATIENT_HIS_LIST：設了捷徑與作業別（會進 HIS 清單）時警告 HIS 內不能存檔；沒有作業別不警告', () => {
  const r = t.form_create({ name: '教案上HIS', dept_no: 'TEST0', shortcut: '教案', groups: ['門'], options: { no_patient: true } });
  t.form_add_control({ draft_id: r.draft_id, area_itemid: t.form_add_area({ draft_id: r.draft_id }).area_itemid, label_text: '主題：', control: { datatype: 'textbox' } });
  let v = t.form_validate({ draft_id: r.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const w = v.warnings.find(x => x.code === 'W_NOPATIENT_HIS_LIST');
  assert.match(w.message, /存檔會被平台拒絕/);
  assert.match(w.message, /form_update_meta\(groups: \[\]\)/);
  t.form_update_meta({ draft_id: r.draft_id, groups: [] });
  v = t.form_validate({ draft_id: r.draft_id });
  assert.ok(!codes(v.warnings).includes('W_NOPATIENT_HIS_LIST'));
  // 一般表單有作業別：沒有這個警告
  const n = t.form_create({ name: '一般上HIS', dept_no: 'TEST0', shortcut: '一般', groups: ['門'] });
  t.form_add_control({ draft_id: n.draft_id, area_itemid: t.form_add_area({ draft_id: n.draft_id }).area_itemid, label_text: '主題：', control: { datatype: 'textbox' } });
  assert.ok(![...t.form_validate({ draft_id: n.draft_id }).warnings].some(x => /NOPATIENT/.test(x.code)));
});

test('E_NOPATIENT_EMBED_CHTNO／E_NOPATIENT_EMBED_OPDNO：params 用 {chtno}、{opdno} 都是 error（平台 E_EMBED_NOPATIENT）；{user}／{deptNo}／常數不觸發', () => {
  const embed = (params) => ({ type: 'embed', title: '教案助手', url: 'https://assistantai.cgmh.org.tw/lesson/', params });
  const d = draft('教案嵌入', { no_patient: true });
  const e1 = t.form_add_area({ draft_id: d.draft_id, ...embed({ chtno: '{chtno}', visit: '{opdno}', user: '{user}' }) }).area_itemid;
  let v = t.form_validate({ draft_id: d.draft_id });
  const hit = v.errors.find(e => e.code === 'E_NOPATIENT_EMBED_CHTNO');
  assert.equal(hit.itemid, e1);
  assert.match(hit.message, /chtno/);
  assert.match(hit.message, /E_EMBED_NOPATIENT/);
  // {opdno}：平台與 {chtno} 同樣擋下（編輯器不能存檔、runtime 不載入）→ 3.16.0 起是 error
  const opd = v.errors.find(e => e.code === 'E_NOPATIENT_EMBED_OPDNO');
  assert.equal(opd.itemid, e1);
  assert.match(opd.message, /visit 用了 \{opdno\}/);
  assert.match(opd.message, /E_EMBED_NOPATIENT/);
  assert.ok(![...v.errors, ...v.warnings].some(x => x.code === 'W_NOPATIENT_EMBED_OPDNO'), '舊的 warning 代碼不再出現');
  // 只剩 {opdno} 也擋
  t.form_update_area({ draft_id: d.draft_id, itemid: e1, params: { visit: '{opdno}', user: '{user}' } });
  v = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v.valid, false);
  assert.deepEqual(codes(v.errors).filter(c => /NOPATIENT/.test(c)), ['E_NOPATIENT_EMBED_OPDNO']);
  assert.equal(errOf(() => t.form_export({ draft_id: d.draft_id })).code, 'E_INVALID_INPUT');
  t.form_update_area({ draft_id: d.draft_id, itemid: e1, params: { user: '{user}', dept: '{deptNo}', mode: 'edu' } });
  v = t.form_validate({ draft_id: d.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  // strucmed.context：非病人表單送空字串與 noPatient: true，不送保留代碼
  const ctx = v.warnings.find(w => w.code === 'W_NOPATIENT_EMBED_CONTEXT');
  assert.match(ctx.message, /chtno、opdno 是空字串，另帶 noPatient: true（不送保留代碼）/);
  assert.doesNotMatch(ctx.message, /內容是保留代碼/);
  assert.match(v.warnings.find(w => w.code === 'W_EMBED_DATAFLOW').message, /送出科別、使用者（非病人表單：病歷號與門診序號是空字串/);

  // 一般表單的 {chtno} 照舊
  const n = draft('一般嵌入');
  t.form_add_area({ draft_id: n.draft_id, ...embed({ chtno: '{chtno}' }) });
  v = t.form_validate({ draft_id: n.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(![...v.errors, ...v.warnings].some(x => /NOPATIENT/.test(x.code)));
  assert.match(v.warnings.find(w => w.code === 'W_EMBED_DATAFLOW').message, /送出病歷號、科別、使用者、門診序號/, '一般表單的資料流訊息不變');
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
  assert.doesNotMatch(man, /平台尚未部署|暫行/);
  assert.match(man, /院內、院外站台都已支援（2026-11-22）/);
  assert.match(man, /`online_features` 的 `runtime\.no_patient`/);
  assert.match(man, /`chtno`＝APP-NP、`deptNo`＝APP、`opdno`＝APP（紀錄主體，現行固定）、`recNo`＝紀錄鍵/);
  assert.match(man, /`user`＋`sheetid`＋`opdno`＋`recNo`/);
  assert.match(man, /英數字與 `_`、`\.`、`-`，最多 64 字/);
  assert.match(man, /必須帶 `sheetid`、只回呼叫者自己建立的紀錄/);
  assert.match(man, /原作者與管理者也一樣，目前無法彙整他人的紀錄/);
  assert.match(man, /HIS 內不能存檔/);
  assert.match(man, /開啟時自動取出\*\*已開啟/);
  assert.match(man, /`chtno` 為 `Shortcut` 或以 `APP` 開頭的都不是病人紀錄，`500` 是測試用病歷號/);
  assert.match(man, /嵌入頁 \{chtno\}／\{opdno\} 參數/);
  assert.match(man, /不要用倉儲以病歷號查詢這類紀錄/);
  assert.equal(iot.f_autoLoadOnOpen, true);
  assert.match(htm.slice(0, htm.indexOf('</script>')), /"f_autoLoadOnOpen":true/);
  assert.match(man, /\| 非病人表單 \| 是/);

  // .htm 與 .package.json 兩種來源都保留
  for (const [i, rel] of [out.files.htm, out.files.json].entries()) {
    const r = t.form_import({ source_path: rel, name: `教案改版${i}`, dept_no: 'TEST0' });
    assert.equal(r.no_patient, true);
    assert.ok(r.notes.some(n => /非病人表單/.test(n)));
    assert.equal(r.validation.valid, true, JSON.stringify(r.validation.errors));
    const again = iotOf(r.draft_id);
    assert.deepEqual([again.f_nopatient, again.f_chtno, again.f_opdno, again.f_hideprevicon, again.f_autoLoadOnOpen], [true, false, false, true, true]);
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
  const bad2 = structuredClone(pkg);
  bad2.form.at(-1).f_autoLoadOnOpen = 'true';
  bad2.integrity.sha256 = pkgmod.packageHash(bad2.form, bad2.presets);
  assert.ok(pkgmod.validatePackage(bad2).some(e => /f_autoLoadOnOpen/.test(e)));
  // 一般表單的套件沒有這兩個鍵
  const npkg = JSON.parse(fs.readFileSync(path.join(root, o2.out.files.json), 'utf8'));
  assert.ok(!('f_nopatient' in npkg.form.at(-1)) && !('f_autoLoadOnOpen' in npkg.form.at(-1)));
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
  // 來源（平台編輯器存的）沒有勾「開啟時自動取出」：原樣保留、只警告
  assert.ok(!('f_autoLoadOnOpen' in iotOf(a.draft_id)));
  assert.ok(codes(v.warnings).includes('W_NOPATIENT_AUTOLOAD'));
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
  assert.deepEqual(m.options_changed.sort(), ['f_autoLoadOnOpen', 'f_chtno', 'f_hideprevicon', 'f_nopatient']);
  assert.deepEqual(m.iot_options, { f_nopatient: true, f_chtno: false, f_opdno: false, f_hideprevicon: true, f_hideAssist: false, f_hidePreset: false, f_autoLoadOnOpen: true, f_day: '30', f_histext: 'histextbyblock' });
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
  const w = v.warnings.find(x => x.code === 'W_NOPATIENT_DICT_WRITE');
  assert.match(w.message, /不要用倉儲以病歷號查詢/);
  assert.match(w.message, /只有建立者本人查得到、下載得到（資料下載對原作者與管理者也只含本人的紀錄），目前無法彙整他人的紀錄/);
});

// 批次建置（form_build）：create.options.no_patient 與逐筆 form_create 相同；E_NOPATIENT_* 由最後的 form_validate 回報
test('form_build：create.options.no_patient 寫出 f_nopatient，違規欄位在 validate 回 E_NOPATIENT_*', () => {
  const ok = t.form_build({ create: { name: '批次非病人表單', dept_no: 'TEST0', options: { no_patient: true } },
    areas: [{ id: 'A1', controls: [{ id: 'C1', label_text: '主題：', control: { datatype: 'textbox' } }] }] });
  const iot = iotOf(ok.draft_id);
  assert.deepEqual([iot.f_nopatient, iot.f_chtno, iot.f_opdno, iot.f_hideprevicon, iot.f_autoLoadOnOpen], [true, false, false, true, true]);
  assert.deepEqual(codes(ok.validate.errors), []);
  assert.ok(codes(ok.validate.warnings).includes('W_NOPATIENT_FORM'));
  const bad = t.form_build({ create: { name: '批次非病人表單 2', dept_no: 'TEST0', options: { no_patient: true } },
    areas: [{ id: 'A1', controls: [{ id: 'C1', label_text: '近期門診：', control: { datatype: 'label', format: 'hisquery', hisquery: 'OPDDATA.InDays(30).GetLatestString()' } }] }] });
  assert.ok(codes(bad.validate.errors).includes('E_NOPATIENT_HISQUERY'));
});

// 規則文件與平台現況一致（kunjulin/strucmed docs/API-V2.md「非病人表單」；院內 2026-11-22 部署）。
// 這些是給 skill／agent 讀的規則，改了平台行為卻忘了改文字時由這裡擋下
test('規則文件：沒有「平台尚未部署前的暫行做法」；紀錄主體與紀錄鍵、查詢限制、HIS 內不能存檔、保留代碼登錄都寫進去', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
  const docs = ['references/FormDesignRules.md', 'references/FormulaMacroRules.md', 'references/Gates.md', 'references/PublishWorkflow.md', 'references/AppBuildWorkflow.md',
    'references/RevisionWorkflow.md', 'references/EmbedPageContract.md', 'skills/create-form/SKILL.md', 'skills/edit-form/SKILL.md', 'skills/publish-form/SKILL.md', 'skills/build-form-app/SKILL.md',
    'agents/form-planner.md', 'agents/form-builder.md', 'agents/form-reviewer.md', 'README.md', 'tools/release/overrides/README.md', 'mcp/strucmed-mcp/README.md'];
  // 發佈樹沒有 tools/release/overrides：不存在的檔案略過，其餘一律檢查
  for (const rel of docs.filter(r => r !== 'tools/release/overrides/README.md' || fs.existsSync(path.join(root, r)))) {
    const s = read(rel);
    assert.doesNotMatch(s, /平台尚未部署|平台部署前|暫行做法|暫行輸入/, `${rel} 還有過時的暫行做法`);
    assert.doesNotMatch(s, /仍(會)?以 `?strucmed\.context`? 送出(保留代碼|病歷號欄位，內容是保留代碼)/, `${rel} 對 strucmed.context 的說法過時`);
  }
  const rules = read('references/FormDesignRules.md');
  const sec = rules.slice(rules.indexOf('## 非病人表單'), rules.indexOf('## 字典說明、補述與層級'));
  // 1. 站台是否支援
  assert.match(sec, /院內站台（LVAIW `\/strucmed`）：已支援（2026-11-22 部署）/);
  assert.match(sec, /院外站台（`cgmh\.ddns\.net`）：已支援（2026-11-22 部署/);
  assert.match(sec, /`online_features` 的 `runtime\.no_patient`/);
  assert.match(sec, /無法判斷，交付時寫「站台是否支援非病人表單尚未確認/);
  // 2. 表頭與 context
  assert.match(sec, /\| `deptNo` \| `APP` \|/);
  assert.match(sec, /`chtno`、`opdno` 是空字串，另帶 `noPatient: true`/);
  assert.match(sec, /\| `E_NOPATIENT_EMBED_OPDNO` \|/);
  assert.doesNotMatch(sec, /\| `W_NOPATIENT_EMBED_OPDNO` \|/);
  // 3. 紀錄主體與紀錄鍵
  assert.match(sec, /`opdno` \| \*\*紀錄主體\*\*（APP 設定欄位）。現行固定 `APP`/);
  assert.match(sec, /`recNo` \| \*\*紀錄鍵\*\*（APP 設定欄位）/);
  assert.match(sec, /api\/v2\/forms\/\{id\}\/page\?recNo=<鍵>`，英數字與 `_`、`\.`、`-`，最多 64 字/);
  assert.match(sec, /沒帶時是 `none`，自成一個鍵/);
  assert.match(sec, /帶 `recNo` 開啟時一律載入既有紀錄/);
  assert.match(sec, /只認 `recNo` \*\*完全相同\*\*的紀錄/);
  assert.match(sec, /一筆紀錄由 `user`＋`sheetid`＋`opdno`＋`recNo` 定位/);
  assert.match(sec, /struNote 的表單清單不帶 `recNo`/);
  assert.match(sec, /### 應用紀錄清單（`options.app_list`）/);
  // 4. 查詢與下載
  assert.match(sec, /必須帶 `sheetid`\*\*，否則 400/);
  assert.match(sec, /`status` 為 `DRAWimg`、`XMLtxt` 例外/);
  assert.match(sec, /只含下載者本人建立的紀錄，原作者與管理者（superuser）也一樣/);
  assert.match(sec, /只有建立者本人查得到、下載得到，目前無法彙整他人的紀錄/);
  // 5. HIS 內不能存檔
  assert.match(sec, /\| HIS 內開啟 \| \*\*不能存檔\*\*/);
  // 6. LOADDOC
  assert.match(sec, /`LOADDOC`、`LOADXML`（平台只取回這張表單、同一個 `recNo`、自己建立的紀錄）/);
  // 7. 開啟時自動取出
  assert.match(sec, /`auto_load_on_open: true`（iot `f_autoLoadOnOpen`/);
  // 8. 保留代碼登錄
  assert.match(sec, /`chtno` 為 `Shortcut` 或以 `APP` 開頭的都不是病人紀錄/);
  assert.match(sec, /`500` 不是保留代碼，是測試用病歷號/);

  // build-form-app：B1 擋下非病人表單；B2 寫明 recNo 與查詢限制
  const app = read('skills/build-form-app/SKILL.md');
  assert.match(app, /\*\*非病人表單不走 B1\*\*/);
  assert.match(app, /\| 非病人表單（f_nopatient；是才列） \| ✗ \| \*\*不能在 HIS 內使用\*\*/);
  assert.match(app, /api\/v2\/forms\/\{id\}\/page\?recNo=<鍵>/);
  assert.match(app, /不要自行編一個未登錄的取值規則/);
  const wf = read('references/AppBuildWorkflow.md');
  assert.match(wf, /## 2b\. 非病人表單/);
  assert.match(wf, /查保留代碼必須帶 `sheetid`，否則 400/);
  assert.match(wf, /產生的 APP 與 scaffold \*\*沒有\*\*查詢紀錄的程式/);
  assert.match(wf, /`runtime\.no_patient`/);
  assert.match(read('references/EmbedPageContract.md'), /`chtno`、`opdno` 是空字串，另帶 `noPatient: true`/);

  // 產生的 APP 沒有查詢病人紀錄的程式（有的話查保留代碼必須帶 sheetid）：只開表單頁、讀寫 me/notes
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const src = [...walk(path.join(root, 'templates', 'form-app', 'src')).filter(f => /\.(ts|tsx)$/.test(f)), path.join(root, 'scripts', 'scaffold-form-app.mjs')];
  assert.ok(src.length > 10);
  for (const f of src) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /records\/query|runtime\/query/, `${f} 有查詢紀錄的程式：查保留代碼必須帶 sheetid`);
});
