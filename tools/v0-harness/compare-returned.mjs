// Compare what we sent (partB/<name>.json) with what the real editor saved and
// re-exported (partB/returned/<name>.json).
//   node tools/v0-harness/compare-returned.mjs
// Prints grouped differences; IDs issued by the warehouse are masked to their
// first 8 chars so the console output can be pasted into docs safely.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENT = path.join(HERE, 'partB');
const BACK = path.join(SENT, 'returned');
const VOLATILE = new Set(['modifiedDate']);
// fields the editor adds on load (Quill metadata) — verified harmless in part A
const EDITOR_ADDED = new Set(['panelId', 'type', 'id', 'text', 'multiple', 'option', 'datagroup', 'format',
  'hisquery', 'hisQueryTitle', 'textareaHeight', 'furActionID', 'required']);
const mask = v => (typeof v === 'string' ? v.replace(/\b([0-9a-f]{8})-[0-9a-f-]{27}\b/gi, '$1-…') : v);

function diff(a, b, p = '$', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const ta = Array.isArray(a) ? 'array' : typeof a, tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb || a === null || b === null) { out.push({ p, kind: 'changed', from: a, to: b }); return out; }
  if (ta === 'array') {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.push({ p: `${p}[${i}]`, kind: 'added', to: b[i] });
      else if (i >= b.length) out.push({ p: `${p}[${i}]`, kind: 'removed', from: a[i] });
      else diff(a[i], b[i], `${p}[${i}]`, out);
    }
  } else if (ta === 'object') {
    for (const k of Object.keys(a)) {
      if (VOLATILE.has(k)) continue;
      if (!(k in b)) out.push({ p: `${p}.${k}`, kind: 'removed', from: a[k] });
      else diff(a[k], b[k], `${p}.${k}`, out);
    }
    for (const k of Object.keys(b)) if (!(k in a) && !VOLATILE.has(k)) out.push({ p: `${p}.${k}`, kind: 'added', to: b[k] });
  } else out.push({ p, kind: 'changed', from: a, to: b });
  return out;
}

const RUNTIME_ROLE = 'doctor';
function lint(form) {
  const w = [];
  const ids = new Map();
  const walk = (items, where) => (items || []).forEach(it => {
    if (it && it.itemid !== undefined && it.datatype) {
      const k = String(it.itemid);
      ids.set(k, (ids.get(k) || 0) + 1);
    }
    if (it && Array.isArray(it.item)) walk(it.item, where);
    if (it && Array.isArray(it.datavalue)) walk(it.datavalue, where);
  });
  form.forEach((a, i) => {
    if (!a || a.itemtype === 'javascript' || a.itemtype === 'iot') return;
    const where = `$[${i}] ${a.itemtype}#${a.itemid}`;
    if (!(a.authread || []).includes(RUNTIME_ROLE)) w.push(`W_AREA_HIDDEN ${where}`);
    if (!(a.authwrite || []).includes(RUNTIME_ROLE)) w.push(`W_AREA_READONLY ${where}`);
    if (a.gettext !== true) w.push(`W_AREA_NO_TEXT ${where}`);
    walk(a.item, where);
  });
  for (const [k, n] of ids) if (n > 1) w.push(`E_DUP_ITEMID itemid=${k} x${n}`);
  return w;
}

for (const f of fs.readdirSync(BACK).filter(f => f.endsWith('.json')).sort()) {
  const sent = JSON.parse(fs.readFileSync(path.join(SENT, f), 'utf8'));
  const back = JSON.parse(fs.readFileSync(path.join(BACK, f), 'utf8'));
  const d = diff(sent, back);
  const groups = {};
  let editorAdded = 0;
  for (const x of d) {
    const leaf = x.p.split('.').pop();
    if (x.kind === 'added' && EDITOR_ADDED.has(leaf)) { editorAdded++; continue; }
    const key = `${x.kind} ${x.p.replace(/\[\d+\]/g, '[]')}`;
    (groups[key] ||= []).push(x);
  }
  console.log(`\n=== ${f}  (總差異 ${d.length}；其中編輯器 metadata 新增 ${editorAdded})`);
  for (const [k, v] of Object.entries(groups)) {
    const e = v[0];
    const s = JSON.stringify(e.kind === 'added' ? mask(e.to) : e.kind === 'removed' ? mask(e.from) : [mask(e.from), mask(e.to)]);
    console.log(String(v.length).padStart(3), k, '例:', (s || '').slice(0, 120));
  }
  const iot = back.find(a => a.itemtype === 'iot') || {};
  const js = back.find(a => a.itemtype === 'javascript') || {};
  console.log('  iot.sheetid/templateID 已賦值:', Boolean(iot.sheetid), Boolean(iot.templateID), '| editorver:', iot.editorver);
  console.log('  javascript 標記:', JSON.stringify(js.content));
  const lw = lint(back);
  console.log('  lint:', lw.length ? lw.join('; ') : '無');
}
