// Generates tools/v0-harness/fixtures/generated-v01.json by driving the MCP tool
// handlers (same code path as the server), so the real editor harness can check
// that generator output round-trips with F = G1 (only environment fields differ).
//   node mcp/strucmed-mcp/test/make-harness-fixture.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-fx-'));
process.env.STRUCMED_WORKSPACE = ws;
const { TOOLS } = await import('../src/tools.mjs');
const { toFormJson } = await import('../src/model.mjs');
const store = await import('../src/store.mjs');
const t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));

fs.writeFileSync(path.join(ws, 'd.csv'), '"id","dicType","dictName","dicComment","createUser","createDate"\r\n' +
  '"v01test-dic-001","TEST0","V01_FALL","v0.1 test","V0TEST","2026-09-27"\r\n');
t.dictionary_load({ csv_path: 'd.csv', dept_no: 'TEST0' });
const { draft_id } = t.form_create({ name: 'V01TEST-generated', dept_no: 'TEST0' });
const { area_itemid: a1 } = t.form_add_area({ draft_id, title: '基本資料' });
const add = (label_text, control, area = a1) => t.form_add_control({ draft_id, area_itemid: area, label_text, control });
add('跌倒史：', { datatype: 'radiobutton', dictionary: { name: 'V01_FALL' }, dicrole: 'puthis', options: [{ value: '有', further: [3] }, '無'] });
add('說明：', { datatype: 'textbox' });
add('年齡：', { datatype: 'numberbox', minval: 0, maxval: 120, required: true });
add('主訴：', { datatype: 'textarea' });
add('日期：', { datatype: 'calendar', format: 'datetime' });
const { area_itemid: a2 } = t.form_add_area({ draft_id, title: '評估' });
add('科別：', { datatype: 'selection', options: ['內科', '外科'] }, a2);
add('藥物：', { datatype: 'combobox', options: ['A', 'B'], multiple: true }, a2);
add('症狀：', { datatype: 'checkbox', options: ['發燒', '咳嗽'], datagroup: 'g1', row: 3 }, a2);
add('部位：', { datatype: 'submenu', options: ['-頭頸', '--頸部', '-胸部'] }, a2);
add('年齡回顯：', { datatype: 'label', reference: 4 }, a2);
const { area_itemid: a3 } = t.form_add_area({ draft_id, title: '隱藏計算', hidden: true, return_text: false });
add('隱藏欄位：', { datatype: 'textbox' }, a3);

const v = t.form_validate({ draft_id });
if (!v.valid) { console.error(v.errors); process.exit(1); }
const form = toFormJson(store.loadDraft(draft_id), 'strucmed-skill v0.1.0 harness-fixture');
const out = path.join(HERE, '../../../tools/v0-harness/fixtures/generated-v01.json');
fs.writeFileSync(out, JSON.stringify({
  name: 'generated-v01',
  description: 'strucmed-mcp v0.1 產生的表單（10 種控制項、字典 id 綁定 puthis、隱藏且不回傳的區塊）；預期 F→G1 只有環境欄位差異',
  deptNo: 'TEST0',
  dicsource: [{ value: 'V01_FALL', id: 'v01test-dic-001', dicType: 'TEST0', dicComment: 'v0.1 test', createUser: 'V0TEST' }],
  form
}, null, 1));
const idxFile = path.join(HERE, '../../../tools/v0-harness/fixtures/index.json');
const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
if (!idx.includes('generated-v01.json')) { idx.push('generated-v01.json'); fs.writeFileSync(idxFile, JSON.stringify(idx)); }
fs.rmSync(ws, { recursive: true, force: true });
console.log('written', path.relative(process.cwd(), out), 'warnings:', v.warnings.map(w => w.code).join(',') || 'none');
