// 名稱、捷徑、Info 的 Big5 檢查（平台 kunjulin/strucmed#299）：這三個欄位原樣寫進資料夾清單的 dictVal，
// 倉儲（Big5／CP950）存不下的字元會把清單項目存壞（2026-11-22 院內：本工具產生的示範表單 Info 含「≥」，表單存了卻不在清單裡）。
// 有對照的字在寫進 draft 前換掉（W_NON_BIG5）；沒有對照的由 form_validate 回 E_META_NON_BIG5，擋住輸出與上架
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ws, t;
const codes = list => list.map(e => e.code);

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-metabig5-'));
  process.env.STRUCMED_WORKSPACE = ws;
  const { TOOLS } = await import('../src/tools.mjs');
  t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

function withControl(draft_id) {
  const a = t.form_add_area({ draft_id }).area_itemid;
  t.form_add_control({ draft_id, area_itemid: a, label_text: '體重：', control: { datatype: 'textbox' } });
  return draft_id;
}

test('form_create：有對照的字換掉並回 W_NON_BIG5，draft 存的是換過的值', () => {
  const r = t.form_create({ name: 'BMI≥30 評估', dept_no: 'TEST0', shortcut: 'bmi²', description: '適用 BMI ≥ 30、體重 ≤ 200 kg' });
  assert.ok(r.warnings.some(w => /W_NON_BIG5：表單名稱的「≥」/.test(w)));
  assert.ok(r.warnings.some(w => /W_NON_BIG5：捷徑的「²」/.test(w)));
  assert.ok(r.warnings.some(w => /W_NON_BIG5：Info的「≤」/.test(w)));
  withControl(r.draft_id);
  const v = t.form_validate({ draft_id: r.draft_id });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(!codes(v.errors).includes('E_META_NON_BIG5'));
  const m = t.form_update_meta({ draft_id: r.draft_id }).meta;
  assert.equal(m.name, 'BMI大於等於30 評估');
  assert.equal(m.shortcut, 'bmi^2');
  assert.equal(m.description, '適用 BMI 大於等於 30、體重 小於等於 200 kg');
});

test('沒有對照的字（emoji）：form_validate 回 E_META_NON_BIG5，指出欄位、字元與位置', () => {
  const r = t.form_create({ name: '衛教單', dept_no: 'TEST0', description: '完成後打 ✅' });
  assert.equal(r.warnings, undefined);
  withControl(r.draft_id);
  const v = t.form_validate({ draft_id: r.draft_id });
  assert.equal(v.valid, false);
  const e = v.errors.find(x => x.code === 'E_META_NON_BIG5');
  assert.match(e.message, /Info含有倉儲（Big5／CP950）無法保存的字元「✅」（U\+2705，第 6 字）/);
  assert.match(e.message, /emoji 請刪除/);
  // 改掉就通過
  t.form_update_meta({ draft_id: r.draft_id, description: '完成後打勾' });
  assert.equal(t.form_validate({ draft_id: r.draft_id }).valid, true);
});

test('form_update_meta 同樣換字；一般表單、Big5 有的字（≧、°）不受影響', () => {
  const r = t.form_create({ name: '體溫紀錄', dept_no: 'TEST0', description: '體溫 ≧ 38°C 時通知' });
  assert.equal(r.warnings, undefined);
  const u = t.form_update_meta({ draft_id: r.draft_id, name: '體溫≥38 紀錄' });
  assert.equal(u.meta.name, '體溫大於等於38 紀錄');
  assert.ok(u.warnings.some(w => /表單名稱的「≥」/.test(w)));
  assert.equal(u.meta.description, '體溫 ≧ 38°C 時通知');
});

test('form_import：沿用來源的 Info 也先換字（來源是外部產生的表單時最常見）', () => {
  const r = t.form_create({ name: '來源表單', dept_no: 'TEST0' });
  withControl(r.draft_id);
  const p = t.form_export({ draft_id: r.draft_id, overwrite: true });
  const out = t.form_export({ draft_id: r.draft_id, overwrite: true, confirm_token: p.confirm_token });
  const rel = Object.values(out.files).find(f => /package\.json$/.test(f));
  assert.ok(rel, JSON.stringify(out.files));
  const pkg = JSON.parse(fs.readFileSync(path.join(ws, rel), 'utf8'));
  pkg.template.description = 'BMI≥27 追蹤';
  pkg.template.shortcut = 'bmi²';
  fs.writeFileSync(path.join(ws, 'src-big5.package.json'), JSON.stringify(pkg));
  const im = t.form_import({ source_path: 'src-big5.package.json', name: '改版表單', dept_no: 'TEST0' });
  assert.ok(im.warnings.some(w => /Info的「≥」/.test(w)), JSON.stringify(im.warnings));
  assert.equal(t.form_update_meta({ draft_id: im.draft_id }).meta.description, 'BMI大於等於27 追蹤');
  assert.ok(!codes(im.validation.errors).includes('E_META_NON_BIG5'));
});
