// 產生 tools/v0-harness/fixtures/generated-attachbox.json：附件容器（flag attachBox）的表單，
// 給真實編輯器的 harness 檢查 F = G1（只有環境欄位不同）。
//   node mcp/strucmed-mcp/test/make-harness-fixture-attachbox.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-fx-'));
process.env.STRUCMED_WORKSPACE = ws;
process.env.STRUCMED_FLAGS = path.join(ws, 'flags.json');
fs.writeFileSync(process.env.STRUCMED_FLAGS, JSON.stringify({ attachBox: true }));
const { TOOLS } = await import('../src/tools.mjs');
const { toFormJson } = await import('../src/model.mjs');
const store = await import('../src/store.mjs');
const t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));

const { draft_id } = t.form_create({ name: 'V0TEST-attachbox', dept_no: 'TEST0' });
const { area_itemid: a1 } = t.form_add_area({ draft_id, title: '附件' });
const add = (label_text, control, area = a1, cell) => t.form_add_control({ draft_id, area_itemid: area, label_text, control, ...(cell && { cell }) }).itemid;
const box = add('附件：', { datatype: 'attachbox', datavalue: '請放入影像、PDF、Excel 或音檔' });
const img = add('影像：', { datatype: 'attachbox', datavalue: '只收影像', attach_kinds: ['image'], attach_max: 3, attach_pages: 5 });
const out = add('結果：', { datatype: 'textarea' });
add('', { datatype: 'action', action_name: '產生摘要', action_script: `LLMATTACH(${out},"只根據附件內容摘要，附件沒有的資訊寫 not available","","${box},${img}")` });
add('', { datatype: 'action', action_name: '轉逐字稿', action_script: `ATTACHTRANSCRIBE(${box})` });
add('附件數：', { datatype: 'label', format: 'formula', formula: `ATTACHCOUNT(${box}) + ATTACHCOUNT(${img})` });
// 固定表格與頁籤裡的容器
const { area_itemid: ft } = t.form_add_area({ draft_id, type: 'formtable', rows: ['3,3'] });
add('表格內：', { datatype: 'attachbox', attach_kinds: 'pdf,sheet' }, ft, { row: 0, col: 1 });
const { area_itemid: tab } = t.form_add_area({ draft_id, type: 'tab2', titles: ['影像', '文件'] });
add('頁籤內：', { datatype: 'attachbox', attach_kinds: 'audio,text', attach_max: 30 }, tab, { index: 1 });

const v = t.form_validate({ draft_id });
if (!v.valid) { console.error(v.errors); process.exit(1); }
const form = toFormJson(store.loadDraft(draft_id), 'strucmed-skill harness-fixture');
const dir = path.join(HERE, '../../../tools/v0-harness/fixtures');
fs.writeFileSync(path.join(dir, 'generated-attachbox.json'), JSON.stringify({
  name: 'generated-attachbox',
  description: 'strucmed-mcp 產生的附件容器表單（文字區塊、固定表格、頁籤內的容器；LLMATTACH、ATTACHTRANSCRIBE、ATTACHCOUNT）；預期 F→G1 只有環境欄位差異',
  deptNo: 'TEST0', dicsource: [], form
}, null, 1));
const idxFile = path.join(dir, 'index.json');
const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
if (!idx.includes('generated-attachbox.json')) { idx.push('generated-attachbox.json'); fs.writeFileSync(idxFile, JSON.stringify(idx)); }
fs.rmSync(ws, { recursive: true, force: true });
console.log('written generated-attachbox.json; warnings:', v.warnings.map(w => w.code).join(',') || 'none');
