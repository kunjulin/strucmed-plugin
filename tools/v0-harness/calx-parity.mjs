// v0.2 計算式語法差異測試（真實 Calx 2.2.8 vs mcp/strucmed-mcp/src/calx.mjs）
//   node tools/v0-harness/calx-parity.mjs prep     產生 out/calx-parity/{local-cases,functions}.json
//   （啟動 serve.mjs，瀏覽器開 http://127.0.0.1:8765/__harness/calx-parity.html，結果寫到 out/calx-parity-roundtrip-result.json）
//   node tools/v0-harness/calx-parity.mjs compare  比對並列出不一致的案例
// local-cases 取自 samples/（真實表單，已 gitignore），只存在 out/（已 gitignore）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../../mcp/strucmed-mcp/src/calx.mjs';
import { BUILTIN, RUNTIME } from '../../mcp/strucmed-mcp/src/calx-catalog.mjs';
import { platformSplit } from '../../mcp/strucmed-mcp/src/scriptlint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out', 'calx-parity');
const mode = process.argv[2];

if (mode === 'prep') {
  fs.mkdirSync(OUT, { recursive: true });
  const local = new Set();
  const SAM = path.join(HERE, 'samples');
  if (fs.existsSync(SAM)) {
    for (const f of fs.readdirSync(SAM).filter(f => f.endsWith('.json'))) {
      const walk = v => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) return v.forEach(walk);
        if (typeof v.formula === 'string' && v.formula.trim()) local.add(v.formula);
        if (v.datatype === 'action2' && v.actionScript) local.add(v.actionScript);
        if (v.datatype === 'action' && v.actionScript) {
          for (let step of platformSplit(v.actionScript).steps) {
            if (/^(LLMQUERY|LLMvision|VOICETOTEXT)/.test(step)) {
              const inner = step.substring(step.indexOf('(') + 1, step.lastIndexOf(')'));
              platformSplit(inner).steps.forEach(p => local.add(p));
            } else if (/^MACRO/.test(step)) {
              const m = step.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().match(/MACRO\(([^,]+),\s*(.+)\)/);
              if (m) { local.add(m[1]); local.add(m[2]); }
            } else if (step) local.add(step);
          }
        }
        Object.values(v).forEach(walk);
      };
      walk(JSON.parse(fs.readFileSync(path.join(SAM, f), 'utf8')));
    }
  }
  fs.writeFileSync(path.join(OUT, 'local-cases.json'), JSON.stringify([...local]));
  fs.writeFileSync(path.join(OUT, 'functions.json'), JSON.stringify([...BUILTIN, ...Object.keys(RUNTIME)]));
  console.log(`local cases ${local.size}, functions ${BUILTIN.size + Object.keys(RUNTIME).length}`);
} else if (mode === 'compare') {
  const r = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'calx-parity-roundtrip-result.json'), 'utf8'));
  let mismatch = 0;
  const show = (x, label) => {
    const mine = check(x.expr);
    // Calx 的語法錯誤是 jison 的 "Parse error" / "Lexical error"；其他例外是執行期錯誤（測試資料型別），不算語法不一致
    const calxSyntaxOk = x.ok || !/Parse error|Lexical error|Parsing halted/.test(x.error);
    if (mine.ok !== calxSyntaxOk) {
      mismatch++;
      console.log(`[${label}] MISMATCH calx=${x.ok ? 'ok ' + JSON.stringify(x.value) : 'ERR ' + x.error.split('\n')[0]} | mine=${mine.ok ? 'ok' : mine.message}`);
      console.log('   ', JSON.stringify(x.expr.length > 160 ? x.expr.slice(0, 160) + '…' : x.expr));
    }
    return { expr: x.expr, calx: x.ok, value: x.value, mine: mine.ok };
  };
  const cases = r.cases.map(x => show(x, 'case'));
  r.local.forEach(x => show(x, 'local'));
  console.log(`cases ${r.cases.length}（接受 ${cases.filter(c => c.calx).length}）, local ${r.local.length}, mismatch ${mismatch}`);
  const valueOf = r.cases.filter(c => c.ok && typeof c.value === 'string' && c.value.startsWith('#'));
  if (valueOf.length) console.log('語法接受但執行得到錯誤值：', valueOf.map(c => `${c.expr} → ${c.value}`).join('；'));
  console.log("runtime 相依套件：", JSON.stringify(r.deps), "alerts:", (r.alerts || []).length);
  process.exitCode = mismatch ? 1 : 0;
} else {
  console.log('usage: node tools/v0-harness/calx-parity.mjs prep|compare');
}
