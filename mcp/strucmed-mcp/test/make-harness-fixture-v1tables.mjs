// Generates tools/v0-harness/fixtures/generated-v1tables.json（v1：固定表格、垂直／水平頁籤、欄向／列向動態表格），
// so the real editor harness can check F = G1 (only environment fields differ).
//   node mcp/strucmed-mcp/test/make-harness-fixture-v1tables.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-fx3-'));
process.env.STRUCMED_WORKSPACE = ws;
const { TOOLS } = await import('../src/tools.mjs');
const { toFormJson } = await import('../src/model.mjs');
const store = await import('../src/store.mjs');
const t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));

fs.writeFileSync(path.join(ws, 'd.csv'), '"id","dicType","dictName","dicComment","createUser","createDate"\r\n' +
  '"v1test-dic-001","TEST0","V1_HEIGHT","v1 test","V0TEST","2026-09-28"\r\n');
t.dictionary_load({ csv_path: 'd.csv', dept_no: 'TEST0' });
const { draft_id } = t.form_create({ name: 'V1TEST-tables', dept_no: 'TEST0' });
const add = (area, cell, label_text, control) => t.form_add_control({ draft_id, area_itemid: area, cell, label_text, control }).itemid;

// 固定表格：2 列（3,3 與 2,2,2），格子可綁字典（會上傳 HIS）
const ft = t.form_add_area({ draft_id, type: 'formtable', rows: ['3,3', '2,2,2'], title: '量測' }).area_itemid;
const h = add(ft, { row: 0, col: 0 }, '身高：', { datatype: 'numberbox', minval: 50, maxval: 250, dictionary: { name: 'V1_HEIGHT' }, dicrole: 'puthis' });
const w = add(ft, { row: 0, col: 1 }, '體重：', { datatype: 'numberbox', minval: 1, maxval: 300 });
add(ft, { row: 1, col: 0 }, 'BMI：', { datatype: 'label', format: 'formula', formula: `IF(AND(A${h} > 0, A${w} > 0), ROUND(A${w} / POWER(A${h} / 100, 2), 1), "")` });
add(ft, { row: 1, col: 1 }, '吸菸：', { datatype: 'radiobutton', options: ['有', '無'] });
add(ft, { row: 1, col: 1 }, '備註：', { datatype: 'textbox' });
add(ft, { row: 1, col: 2 }, '日期：', { datatype: 'calendar', format: 'date' });

// 垂直頁籤：兩頁
const t1 = t.form_add_area({ draft_id, type: 'tab1', titles: ['病史', '用藥'] }).area_itemid;
add(t1, { index: 0 }, '主訴：', { datatype: 'textarea' });
add(t1, { index: 0 }, '天數：', { datatype: 'numberbox', minval: 0, maxval: 365 });
add(t1, { index: 1 }, '', { datatype: 'checkbox', options: ['aspirin', 'statin'] });

// 水平頁籤
const t2 = t.form_add_area({ draft_id, type: 'tab2', titles: ['第一頁', '第二頁'] }).area_itemid;
add(t2, { index: 0 }, '', { datatype: 'textbox' });
add(t2, { index: 1 }, '', { datatype: 'selection', options: ['甲', '乙'] });

// 欄向動態表格：三欄
const tb1 = t.form_add_area({ draft_id, type: 'table1', titles: ['藥名', '劑量', '頻次'] }).area_itemid;
add(tb1, { index: 0 }, '', { datatype: 'textbox' });
add(tb1, { index: 1 }, '', { datatype: 'numberbox', minval: 0, maxval: 1000 });
add(tb1, { index: 2 }, '', { datatype: 'selection', options: ['QD', 'BID', 'TID'] });

// 列向動態表格：兩列
const tb2 = t.form_add_area({ draft_id, type: 'table2', titles: ['日期', '數值'] }).area_itemid;
add(tb2, { index: 0 }, '', { datatype: 'calendar', format: 'date' });
add(tb2, { index: 1 }, '', { datatype: 'numberbox', minval: 0, maxval: 100 });

const v = t.form_validate({ draft_id });
if (!v.valid) { console.error(v.errors); process.exit(1); }
const form = toFormJson(store.loadDraft(draft_id), 'strucmed-skill v1.2.0 harness-fixture');
const out = path.join(HERE, '../../../tools/v0-harness/fixtures/generated-v1tables.json');
fs.writeFileSync(out, JSON.stringify({
  name: 'generated-v1tables',
  description: 'strucmed-mcp v1 產生的表格與頁籤區塊（formtable 兩列含字典與計算式、tab1、tab2、table1、table2）；預期 F→G1 只有環境欄位差異',
  deptNo: 'TEST0',
  dicsource: [{ value: 'V1_HEIGHT', id: 'v1test-dic-001', dicType: 'TEST0', dicComment: 'v1 test', createUser: 'V0TEST' }],
  form
}, null, 1));
const idxFile = path.join(HERE, '../../../tools/v0-harness/fixtures/index.json');
const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
if (!idx.includes('generated-v1tables.json')) { idx.push('generated-v1tables.json'); fs.writeFileSync(idxFile, JSON.stringify(idx)); }
console.log(t.form_preview({ draft_id }).content);
fs.rmSync(ws, { recursive: true, force: true });
console.log('written', path.relative(process.cwd(), out), 'warnings:', v.warnings.map(x => x.code).join(',') || 'none');
