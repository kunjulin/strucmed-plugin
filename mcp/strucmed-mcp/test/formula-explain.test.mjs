// 3.3.0：formula_check 的標籤化公式與試算（Codex 實測時 BMI 的身高、體重參照對調，語法檢查抓不到）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, sameValue } from '../src/formula-explain.mjs';

let ws, t;

before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-explain-'));
  process.env.STRUCMED_WORKSPACE = ws;
  const { TOOLS } = await import('../src/tools.mjs');
  t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));
});
after(() => fs.rmSync(ws, { recursive: true, force: true }));

test('evaluate: arithmetic, precedence, percent and common functions', () => {
  const v = (src, values = {}) => evaluate(src, values).value;
  assert.equal(v('1 + 2 * 3'), 7);
  assert.equal(v('(1 + 2) * 3'), 9);
  assert.equal(v('2 ^ 3 ^ 2'), 64, '^ 左結合（Calx 文法 %left）');
  assert.equal(v('50% * 4'), 2);
  assert.equal(v('-2 ^ 2'), 4, '單元負號優先於 ^');
  assert.equal(v('ROUND(65 / ((170 / 100) * (170 / 100)), 1)'), 22.5);
  assert.equal(v('ROUND(2.345, 2)'), 2.35);
  assert.equal(v('ROUND(-2.5, 0)'), -3, '四捨五入遠離零（同 Excel）');
  assert.equal(v('ROUNDUP(1.21, 1)'), 1.3);
  assert.equal(v('ROUNDDOWN(1.29, 1)'), 1.2);
  assert.equal(v('SUM(A1:A3)', { A1: 1, A2: 2, A3: 3 }), 6);
  assert.equal(v('AVERAGE(A1, A2, 6)', { A1: 1, A2: 2 }), 3);
  assert.equal(v('IF(A1 >= 3, "high", "low")', { A1: 3 }), 'high');
  assert.equal(v('IF(A1 <> 3, "x", "y")', { A1: 3 }), 'y');
  assert.equal(v('IF(AND(A1 > 1, A1 < 5), 1, 0)', { A1: 2 }), 1);
  assert.equal(v('A1 = "是"', { A1: '是' }), true);
  assert.equal(v('CONCATENATE("BMI ", A1)', { A1: 22.5 }), 'BMI 22.5');
  assert.equal(v('1 / A1', { A1: 0 }), '#DIV/0!');
  assert.equal(v('0.1 + 0.2'), 0.3, '浮點誤差修整');
  assert.equal(v('IF(A1 > 0, 1, A9)', { A1: 1 }), 1, 'IF 只算走到的分支');
});

test('evaluate: missing values and unsupported parts are reported, never guessed', () => {
  assert.match(evaluate('A1 + A2', { A1: 1 }).reason, /缺少試算值：A2/);
  assert.match(evaluate('VLOOKUP(1, A1:A2, 1)', { A1: 1, A2: 2 }).reason, /無法離線試算.*VLOOKUP/);
  assert.match(evaluate('"a" + 1').reason, /無法離線試算/);
  assert.match(evaluate('A1>3').reason, /語法錯誤/);
  assert.ok(evaluate('A3 + 1', { 3: 1 }).ok, '鍵可寫 itemid');
});

test('sameValue: numbers with tolerance, numeric strings, booleans', () => {
  assert.ok(sameValue(22.5, '22.5'));
  assert.ok(sameValue(0.1 + 0.2, 0.3));
  assert.ok(sameValue(true, 'TRUE'));
  assert.ok(!sameValue(22.5, 22.4));
  assert.ok(sameValue('過重', ' 過重 '));
});

test('formula_check: labeled formula exposes swapped references; samples catch them (BMI)', () => {
  const { draft_id } = t.form_create({ name: 'BMI 測試', dept_no: 'TEST0' });
  const { area_itemid: a } = t.form_add_area({ draft_id });
  const add = (label_text, control) => t.form_add_control({ draft_id, area_itemid: a, label_text, control }).itemid;
  const h = add('身高(cm)：', { datatype: 'numberbox', minval: 50, maxval: 250 });
  const w = add('體重(kg)：', { datatype: 'numberbox', minval: 2, maxval: 500 });
  const sample = [{ values: { [`A${h}`]: 170, [`A${w}`]: 65 }, expect: 22.5 }];

  const good = t.formula_check({ kind: 'formula', draft_id, text: `ROUND(A${w} / ((A${h} / 100) * (A${h} / 100)), 1)`, samples: sample });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.equal(good.labeled, 'ROUND([體重(kg)] / (([身高(cm)] / 100) * ([身高(cm)] / 100)), 1)');
  assert.deepEqual(good.ref_labels, { [`A${w}`]: '體重(kg)', [`A${h}`]: '身高(cm)' });
  assert.equal(good.samples[0].value, 22.5);
  assert.equal(good.samples[0].match, true);

  const swapped = t.formula_check({ kind: 'formula', draft_id, text: `ROUND(A${h} / ((A${w} / 100) * (A${w} / 100)), 1)`, samples: sample });
  assert.equal(swapped.ok, false);
  assert.ok(swapped.errors.some(e => e.code === 'E_FORMULA_SAMPLE_MISMATCH'));
  assert.equal(swapped.labeled, 'ROUND([身高(cm)] / (([體重(kg)] / 100) * ([體重(kg)] / 100)), 1)');
  assert.equal(swapped.samples[0].match, false);

  // 不帶 draft 時沒有欄位名稱，但仍可試算
  const bare = t.formula_check({ kind: 'formula', text: 'A1 * 2', samples: [{ values: { A1: 3 } }] });
  assert.equal(bare.labeled, undefined);
  assert.deepEqual(bare.samples, [{ values: { A1: 3 }, value: 6 }]);
});

test('captions: formtable label cells and units after values', () => {
  const { draft_id } = t.form_create({ name: '表格說明', dept_no: 'TEST0' });
  const ft = t.form_add_area({ draft_id, type: 'formtable', rows: ['1,2,1,2'] }).area_itemid;
  const add = (cell, control, label_text = '') => t.form_add_control({ draft_id, area_itemid: ft, cell, label_text, control }).itemid;
  add({ row: 0, col: 0 }, { datatype: 'label', format: 'defaultValue', datavalue: '' }, '收縮壓：');
  const sbp = add({ row: 0, col: 1 }, { datatype: 'numberbox' });
  const dbp = add({ row: 0, col: 2 }, { datatype: 'numberbox' }, ' mmHg 舒張壓：');
  const r = t.formula_check({ kind: 'formula', draft_id, text: `ROUND((A${sbp} + 2 * A${dbp}) / 3, 0)`, samples: [{ values: { [`A${sbp}`]: 120, [`A${dbp}`]: 80 }, expect: 93 }] });
  assert.equal(r.labeled, 'ROUND(([收縮壓] + 2 * [舒張壓]) / 3, 0)', '「 mmHg 舒張壓：」取最後一段');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});
