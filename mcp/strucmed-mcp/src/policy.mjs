// 模型白名單（references/ModelWhitelist.md）：
//   - 表單巨集寫的是 TempHtml 別名（tw、gemma3、qwen332b…），runtime 依別名送出實際模型名；Gateway 模式再把 Ollama 名稱加標籤
//   - llmgateway_models 把 GET /v1/models 的結果寫成 <workspace>/.strucmed/llm-models.json，這裡提供「別名 → 閘道模型」對應與檢查
import fs from 'node:fs';
import path from 'node:path';
import { LLM_ALIASES } from './calx-catalog.mjs';

export const CACHE_FILE = 'llm-models.json';
export const STALE_DAYS = 7;

// LLMQUERY 別名 → TempHtml 送出的模型名（TempHtml.js LLMquery 路由）→ Gateway 名稱（LLM_GATEWAY_MODEL_NAMES：Ollama 名加 :latest）
const LLMQUERY_SENT = {
  '': 'llama3.1:8b-instruct-q8_0', tw: 'gemma2:latest', math: 'gemma2:latest',
  ph4: 'phi4', phi4: 'phi4', gemma3: 'gemma3', gemma3_12b: 'gemma3:12b', medgemma: 'medgemma',
  qwen332b: 'qwen3:32b', tqwen332b: 'qwen3:32b',
  qwen3627b: 'Qwen3.6:27B', tqwen3627b: 'Qwen3.6:27B', 'tqwen3627b-low': 'Qwen3.6:27B', 'tqwen3627b-medium': 'Qwen3.6:27B', 'tqwen3627b-high': 'Qwen3.6:27B'
};
const LLMVISION_SENT = { '': 'gemma3:12b', gemma3: 'gemma3', gemma3_12b: 'gemma3:12b', medgemma: 'medgemma:4b_vision' };
const GATEWAY_NAMES = { gemma3: 'gemma3:latest', medgemma: 'medgemma:latest', phi4: 'phi4:latest' };

// 別名（已小寫）→ Gateway 的模型 id；未知別名回 null
export function gatewayModelFor(alias, fn = 'LLMQUERY') {
  const m = String(alias || '').toLowerCase();
  const canon = fn === 'LLMQUERY' ? (LLM_ALIASES[m] || m) : m;
  const sent = (fn === 'LLMvision' ? LLMVISION_SENT : LLMQUERY_SENT)[canon];
  if (sent === undefined) return null;
  return GATEWAY_NAMES[sent] || sent;
}

export function cachePath(ws) { return path.join(ws.base, CACHE_FILE); }

export function loadCache(ws) {
  const f = cachePath(ws);
  if (!fs.existsSync(f)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!c || !Array.isArray(c.models)) return null;
    const ageDays = (Date.now() - Date.parse(c.fetched_at || 0)) / 86_400_000;
    return { ...c, stale: !Number.isFinite(ageDays) || ageDays > STALE_DAYS, age_days: Number.isFinite(ageDays) ? Math.round(ageDays * 10) / 10 : null };
  } catch { return null; }
}

export function saveCache(ws, data) {
  fs.mkdirSync(ws.base, { recursive: true });
  fs.writeFileSync(cachePath(ws), JSON.stringify(data, null, 2));
}

const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// 檢查一個別名在閘道上的狀態：{ gateway_model, found, status, vision, thinking } 或 null（沒有快取）
export function checkAlias(alias, fn, models) {
  if (!Array.isArray(models)) return null;
  const gm = gatewayModelFor(alias, fn);
  if (!gm) return { gateway_model: null, found: false };
  const hit = models.find(x => eq(x.id, gm));
  if (!hit) return { gateway_model: gm, found: false };
  return { gateway_model: gm, found: true, status: String(hit.status || ''), vision: !!hit.vision, thinking: hit.thinking || null };
}
