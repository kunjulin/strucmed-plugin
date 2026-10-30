// Local workspace: <root>/.strucmed/{drafts/*.json, dictionaries.json}
// <root> = STRUCMED_WORKSPACE or the server's cwd. Nothing leaves this machine.
// Copilot CLI and Codex (.codex-plugin/plugin.json, cwd ".") start plugin MCP servers with cwd = plugin root; then <root> falls back to PWD (the directory the CLI was launched from).
// Without a usable PWD (Codex app, Windows) <root> is ~/Documents/StrucMed: the plugin root is a cache that plugin updates replace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { E, fail } from './errors.mjs';
import { loadCache } from './policy.mjs';
import * as site from './site.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const unset = v => { const s = String(v || '').trim(); return !s || s.startsWith('${'); };
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export function workspaceRoot() {
  if (!unset(process.env.STRUCMED_WORKSPACE)) return path.resolve(process.env.STRUCMED_WORKSPACE.trim());
  const cwd = real(process.cwd());
  const roots = [PLUGIN_ROOT, process.env.PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT].filter(r => !unset(r)).map(real);
  if (!roots.includes(cwd)) return cwd;
  const pwd = unset(process.env.PWD) ? '' : real(process.env.PWD);
  if (pwd && !roots.includes(pwd) && pwd !== path.parse(pwd).root && fs.existsSync(pwd)) return pwd;
  return defaultWorkspace();
}

export function defaultWorkspace() {
  const docs = path.join(os.homedir(), 'Documents');
  return path.join(fs.existsSync(docs) ? docs : os.homedir(), 'StrucMed');
}

export function workspace() {
  const root = workspaceRoot();
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

export function saveDraft(d, { touch = true } = {}) {
  if (touch) d.updated = new Date().toISOString();   // touch:false：只記錄狀態（例如匯出紀錄），不算編輯
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

// 站台接受的補述欄位（GET api/v2/dictionaries 的 memoKeys）：本行程記住最近一次的回應，並寫進本機索引；都沒有時回 null（呼叫端當舊站台）
let memoKeysSeen = null;
export function rememberMemoKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  memoKeysSeen = keys.map(String);
  const idx = loadDictIndex();
  if (idx && JSON.stringify(idx.memoKeys) !== JSON.stringify(memoKeysSeen)) saveDictIndex({ ...idx, memoKeys: memoKeysSeen });
}
export function serverMemoKeys() {
  if (memoKeysSeen) return memoKeysSeen;
  const idx = loadDictIndex();
  return idx && Array.isArray(idx.memoKeys) ? idx.memoKeys : null;
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
  // 院外站台沒有 LlmGateway：白名單只能用內建靜態表，W_LLM_WHITELIST_STALE 是預期狀況
  try { p.site_external = site.profile() === 'external'; } catch { p.site_external = false; }
  return p;
}
