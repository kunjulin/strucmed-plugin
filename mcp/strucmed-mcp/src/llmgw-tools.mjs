// LlmGateway tools。只在 LLMGW_BASE_URL＋LLMGW_API_KEY 設定且 flag llmgateway 開啟時列出。
import { E, fail } from './errors.mjs';
import * as store from './store.mjs';
import * as llmgw from './llmgw.mjs';
import * as online from './online.mjs';
import * as policy from './policy.mjs';
import { LLM_ALIASES, LLM_SUNSET, sunsetModel, sunsetPassed, thinkingParams } from './calx-catalog.mjs';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TW_ID = /[A-Z][12]\d{8}/;
const PHI_WORDS = /(病歷號|身分證|姓名)\s*[:：]\s*\S/;
const LONG_DIGITS = /\b\d{7,10}\b/;
const MAX_PROMPT = 8_000;
const MAX_TOKENS = 1024;

export const LLMGW_TOOLS = [
  {
    name: 'llmgateway_models',
    group: 'llmgw',
    description: '（LlmGateway，唯讀）取得這把金鑰可用的模型清單（GET /v1/models：id、context_length、vision、thinking、status、description），寫成本機白名單快取 .strucmed/llm-models.json；' +
      '之後 form_validate／formula_check 檢查巨集模型時會對照快取（不在清單→error、deprecated→error、maintenance→warning、LLMvision 用無視覺模型→error）。不計入閘道配額。',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: '即使快取未過期也重新取得（預設 true）' } } },
    async handler({ refresh }) {
      const ws = store.workspace();
      const cached = policy.loadCache(ws);
      if (refresh === false && cached && !cached.stale) return summary(cached, false);
      const r = await llmgw.request('GET', 'v1/models', {}, '讀取模型清單');
      const data = Array.isArray(r && r.data) ? r.data : [];
      const models = data.map(x => ({ id: String(x.id || ''), owned_by: String(x.owned_by || ''), context_length: x.context_length ?? null,
        vision: !!x.vision, thinking: x.thinking ?? null, status: String(x.status || ''), description: String(x.description || '') })).filter(x => x.id);
      if (!models.length) fail(E.UPSTREAM, 'LlmGateway 回傳的模型清單是空的（金鑰可能沒有任何模型權限）');
      const cache = { fetched_at: new Date().toISOString(), base_url: llmgw.baseUrl(), models };
      policy.saveCache(ws, cache);
      return summary({ ...cache, stale: false, age_days: 0 }, true);
    }
  },
  {
    name: 'llmgateway_chat_test',
    group: 'llmgw',
    flag: 'llmChatTest',
    description: '（LlmGateway，flag llmChatTest）用白名單內的模型試跑一段 prompt（POST /v1/chat/completions，stream:false，max_tokens ≤ 1024），回答與 usage 供設計 LLM 巨集時參考。' +
      '模型以 TempHtml 別名（gemma3、nemotron35、tnemotron35、gemma4_31b、tgemma4_31b…）或閘道 id 指定；Nemotron、Gemma 4 的思考開關與強度依別名比照 HIS 端送出（t 開頭＝思考，-low／-medium／-high＝強度）；不在快取白名單或 deprecated／maintenance 一律拒絕；prompt 先做個資偵測（身分證、病歷號樣式→拒絕）；不送影像。會計入金鑰配額。',
    inputSchema: { type: 'object', required: ['model', 'prompt'], properties: {
      model: str('TempHtml 別名（例如 nemotron35）或閘道模型 id；qwen 系列已列落日，只供既有表單比對用（W_LLM_MODEL_SUNSET）'), prompt: str('使用者訊息（≤ 8000 字；不要放真實病人資料）'),
      system: str('system 訊息（選填）'), max_tokens: { type: 'number', description: '回答上限（預設 512，最多 1024）' },
      temperature: { type: 'number', description: '預設 0.2' }, thinking: { type: 'boolean', description: '思考模式：對以 enable_thinking 切換的 Nemotron-3.5-Super-VL、Gemma-4-31b、Qwen3.6（落日模型）有效，其他模型忽略。沒給時 Nemotron、Gemma 4 依別名決定（tnemotron35、tgemma4_31b 系列＝思考），其餘為 false' },
      reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'], description: '思考強度（選填，思考開啟時才有作用）：Gemma-4-31b 送 reasoning_effort；Nemotron-3.5-Super-VL 的 medium 加 medium_effort、low 再加 thinking_token_budget、high 只開思考。沒給時依別名的後綴；其他模型忽略' } } },
    async handler({ model, prompt, system, max_tokens, temperature, thinking, reasoning_effort }) {
      const ws = store.workspace();
      const cache = policy.loadCache(ws);
      if (!cache) fail(E.NOT_WHITELISTED, '尚未取得模型白名單：請先呼叫 llmgateway_models');
      const text = String(prompt || '');
      if (!text.trim()) fail(E.INVALID_INPUT, 'prompt 不可空白');
      if (text.length > MAX_PROMPT) fail(E.INVALID_INPUT, `prompt 超過 ${MAX_PROMPT} 字`);
      const all = `${system || ''}\n${text}`;
      if (TW_ID.test(all) || PHI_WORDS.test(all)) fail(E.PHI_SUSPECT, 'prompt 疑似含個資（身分證字號或「病歷號／身分證／姓名：…」），不送出；請改用去識別化的範例');
      const warnings = [];
      if (LONG_DIGITS.test(all)) warnings.push('W_PHI_SUSPECT：prompt 含 7–10 位數字，請確認不是病歷號');
      // 別名 → 閘道 id；直接給 id 也可以
      const alias = String(model || '').trim();
      let gm = policy.gatewayModelFor(alias, 'LLMQUERY');
      let hit = gm ? cache.models.find(x => x.id.toLowerCase() === gm.toLowerCase()) : null;
      if (!hit) { hit = cache.models.find(x => x.id.toLowerCase() === alias.toLowerCase()); gm = hit ? hit.id : gm; }
      if (!hit) fail(E.NOT_WHITELISTED, `模型「${alias}」不在白名單快取（${cache.models.map(x => x.id).join('、')}）`, { gateway_model: gm });
      if (/^(deprecated|maintenance)$/i.test(hit.status)) fail(E.NOT_WHITELISTED, `模型「${hit.id}」狀態為 ${hit.status}，不可使用`);
      const sunset = sunsetModel(LLM_ALIASES[alias.toLowerCase()] || alias) || sunsetModel(hit.id);
      if (sunset) warnings.push(`W_LLM_MODEL_SUNSET：模型「${hit.id}」屬 ${LLM_SUNSET.family}，${sunsetPassed() ? '已' : '將'}於 ${LLM_SUNSET.date} 自 LlmGateway 下架，院方建議不採用；只供既有表單比對，新的巨集請改用 ${sunset.replacement}`);
      if (cache.stale) warnings.push(`W_LLM_WHITELIST_STALE：白名單快取已 ${cache.age_days} 天，建議重新 llmgateway_models`);
      const messages = [];
      if (system) messages.push({ role: 'system', content: String(system) });
      messages.push({ role: 'user', content: text });
      const body = { model: hit.id, messages, stream: false, max_tokens: Math.min(Math.max(Number(max_tokens) || 512, 1), MAX_TOKENS), temperature: Number.isFinite(temperature) ? temperature : 0.2 };
      // Nemotron、Gemma 4：比照 HIS 端（TempHtml.js 20261127）依別名送思考開關與強度；明確給的 thinking／reasoning_effort 優先
      const byAlias = /^t(?:nemotron35|gemma4_31b)(?:-(low|medium|high))?$/.exec(alias.toLowerCase());
      if (reasoning_effort !== undefined && !['low', 'medium', 'high'].includes(String(reasoning_effort))) fail(E.INVALID_INPUT, 'reasoning_effort 只接受 low、medium、high');
      const think = typeof thinking === 'boolean' ? thinking : !!byAlias;
      const tp = thinkingParams(hit.id, think, reasoning_effort || (byAlias && byAlias[1]) || '');
      if (tp) {
        Object.assign(body, tp);
        if (think) warnings.push(`W_LLM_THINKING_BUDGET：思考內容也算在 max_tokens（這次 ${body.max_tokens}，試跑上限 ${MAX_TOKENS}；HIS 端思考代號是 16000），回答可能被截斷或是空的，請看 finish_reason`);
      }
      else if (/qwen3\.6/i.test(hit.id)) body.chat_template_kwargs = { enable_thinking: !!thinking };
      const headers = { 'X-Client-Feature': 'strucmed-skill' };
      const s = online.status();
      if (s.logged_in && s.user_id) headers['X-Client-User'] = encodeURIComponent(s.user_id);
      const r = await llmgw.request('POST', 'v1/chat/completions', { body, headers, timeoutMs: llmgw.CHAT_TIMEOUT }, '試跑模型');
      const choice = (r && r.choices && r.choices[0]) || {};
      const msg = choice.message || {};
      return { model: String(r && r.model || hit.id), content: String(msg.content || ''), reasoning: msg.reasoning ? String(msg.reasoning).slice(0, 2000) : null,
        finish_reason: choice.finish_reason || null, usage: r && r.usage ? r.usage : null, warnings };
    }
  }
];

function summary(cache, fetched) {
  return { fetched: fetched, fetched_at: cache.fetched_at, stale: !!cache.stale, age_days: cache.age_days, count: cache.models.length,
    models: cache.models.map(x => ({ id: x.id, status: x.status || 'ok', vision: x.vision, thinking: x.thinking, context_length: x.context_length })),
    aliases: Object.fromEntries(['', 'nemotron35', 'tnemotron35', 'gemma4_31b', 'tgemma4_31b', 'gemma3', 'gemma3_12b', 'medgemma', 'tw', 'ph4', 'qwen332b', 'tqwen332b', 'qwen3627b', 'tqwen3627b'].map(a => {
      const c = policy.checkAlias(a, 'LLMQUERY', cache.models);
      const note = sunsetModel(a) ? `（落日：${LLM_SUNSET.date} 下架，不要新用，改 ${sunsetModel(a).replacement}）` : '';
      return [a || '(預設)', (c && c.found ? `${c.gateway_model}${c.status ? `（${c.status}）` : ''}` : `${c && c.gateway_model || '?'}（不在清單）`) + note];
    })),
    warnings: [...(cache.stale ? [`W_LLM_WHITELIST_STALE：快取已 ${cache.age_days} 天`] : []),
      ...(cache.models.some(x => sunsetModel(x.id)) ? [`W_LLM_MODEL_SUNSET：清單中的 ${cache.models.filter(x => sunsetModel(x.id)).map(x => x.id).join('、')} 屬 ${LLM_SUNSET.family}，${LLM_SUNSET.date} 自 LlmGateway 下架，院方建議不採用；不要建議或新用，改用 nemotron35／tnemotron35`] : [])] };
}
