// Local workspace: <root>/.strucmed/{drafts/*.json, dictionaries.json}
// <root> = STRUCMED_WORKSPACE or the server's cwd. Nothing leaves this machine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { E, fail } from './errors.mjs';
import { loadCache } from './policy.mjs';

export function workspace() {
  const root = path.resolve(process.env.STRUCMED_WORKSPACE || process.cwd());
  const base = path.join(root, '.strucmed');
  const drafts = path.join(base, 'drafts');
  fs.mkdirSync(drafts, { recursive: true });
  return { root, base, drafts, dictFile: path.join(base, 'dictionaries.json'), outDir: path.join(root, 'output') };
}

const ID_RE = /^d-[0-9a-f]{12}$/;

export function newDraftId() {
  return 'd-' + crypto.randomBytes(6).toString('hex');
}

function draftPath(id) {
  if (!ID_RE.test(String(id))) fail(E.INVALID_INPUT, `draft_id 格式不正確：${id}`);
  return path.join(workspace().drafts, id + '.json');
}

export function loadDraft(id) {
  const p = draftPath(id);
  if (!fs.existsSync(p)) fail(E.NOT_FOUND, `找不到 draft：${id}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function saveDraft(d) {
  d.updated = new Date().toISOString();
  fs.writeFileSync(draftPath(d.draft_id), JSON.stringify(d, null, 2));
  return d;
}

export function deleteDraft(id) {
  fs.rmSync(draftPath(id));
}

export function listDrafts() {
  const dir = workspace().drafts;
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

export function loadDictIndex() {
  const f = workspace().dictFile;
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export function saveDictIndex(idx) {
  fs.writeFileSync(workspace().dictFile, JSON.stringify(idx, null, 2));
}

// 本院政策（院方決議後由使用者設定）：<root>/.strucmed/policy.json
//   { "llm_models": ["", "qwen332b", ...] }   // 允許的 LLMQUERY 模型（'' = 預設模型）；未設定＝平台清單內都允許
// 另合併 LlmGateway 白名單快取（llmgateway_models 寫入的 .strucmed/llm-models.json）：policy.gateway_models／gateway_fetched_at／gateway_stale
export function loadPolicy() {
  const ws = workspace();
  const f = path.join(ws.base, 'policy.json');
  let p = {};
  if (fs.existsSync(f)) {
    try {
      p = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (p.llm_models !== undefined && !Array.isArray(p.llm_models)) fail(E.INVALID_INPUT, 'policy.json 的 llm_models 必須是字串陣列');
    } catch (e) {
      if (e.code) throw e;
      fail(E.INVALID_INPUT, `policy.json 不是合法的 JSON：${e.message}`);
    }
  }
  const cache = loadCache(ws);
  if (cache) { p.gateway_models = cache.models; p.gateway_fetched_at = cache.fetched_at; p.gateway_stale = cache.stale; p.gateway_age_days = cache.age_days; }
  return p;
}
