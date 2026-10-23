// Generates tools/v0-harness/fixtures/generated-v02.json（v0.2：計算式、HIS 參照、巨集、LLM 按鈕、輸入後觸發巨集），
// so the real editor harness can check F = G1 (only environment fields differ).
//   node mcp/strucmed-mcp/test/make-harness-fixture-v02.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-fx2-'));
process.env.STRUCMED_WORKSPACE = ws;
const { TOOLS } = await import('../src/tools.mjs');
const { toFormJson } = await import('../src/model.mjs');
const store = await import('../src/store.mjs');
const t = Object.fromEntries(TOOLS.map(x => [x.name, x.handler]));

const { draft_id } = t.form_create({ name: 'V02TEST-generated', dept_no: 'TEST0' });
const { area_itemid: a } = t.form_add_area({ draft_id, title: '計算與巨集' });
const add = (label_text, control) => t.form_add_control({ draft_id, area_itemid: a, label_text, control }).itemid;
const h = add('身高(cm)：', { datatype: 'numberbox', minval: 50, maxval: 250 });
const w = add('體重(kg)：', { datatype: 'numberbox', minval: 1, maxval: 300 });
const bmi = add('BMI：', { datatype: 'label', format: 'formula', formula: `IF(A${h} > 0, ROUND(A${w} / POWER(A${h} / 100, 2), 1), "")` });
add('年齡：', { datatype: 'label', format: 'hisquery', hisquery: 'Procedure.InName(PKG.GET_AGE).GetValueByName(AGE)', his_query_title: 'patient.age' });
const note = add('摘要：', { datatype: 'textarea' });
const btn = add('', { datatype: 'action', action_name: '產生摘要', action_id: note,
  action_script: `LLMQUERY(${note}, CONCATENATE("BMI=", A${bmi}, "；請用一句話摘要"), "qwen332b"), MACRO(${note}, CONCATENATE(A${note}, "（AI 產生，請查核）"))` });
add('LLM：', { datatype: 'action2', action_name: '問 AI', action_id: note, action_script: `CONCATENATE("BMI 是 ", A${bmi})` });
add('觸發：', { datatype: 'textbox', fur_action_id: btn });

const v = t.form_validate({ draft_id });
if (!v.valid) { console.error(v.errors); process.exit(1); }
const form = toFormJson(store.loadDraft(draft_id), 'strucmed-skill v1.1.0 harness-fixture');
const out = path.join(HERE, '../../../tools/v0-harness/fixtures/generated-v02.json');
fs.writeFileSync(out, JSON.stringify({
  name: 'generated-v02',
  description: 'strucmed-mcp v0.2 產生的表單（計算式、HIS 參照、巨集按鈕、LLM 按鈕、輸入後觸發巨集）；預期 F→G1 只有環境欄位差異',
  deptNo: 'TEST0', dicsource: [], form
}, null, 1));
const idxFile = path.join(HERE, '../../../tools/v0-harness/fixtures/index.json');
const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
if (!idx.includes('generated-v02.json')) { idx.push('generated-v02.json'); fs.writeFileSync(idxFile, JSON.stringify(idx)); }
fs.rmSync(ws, { recursive: true, force: true });
console.log('written', path.relative(process.cwd(), out), 'warnings:', v.warnings.map(x => x.code).join(',') || 'none');
