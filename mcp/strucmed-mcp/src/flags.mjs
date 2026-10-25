// Feature flags ：<plugin root>/feature-flags.json，或以 STRUCMED_FLAGS 指定路徑。
// 值：true／false，或 "auto"（依站台判斷與憑證：online＝有可用站台且有 HIS 帳密、llmgateway＝院內且有 LLMGW_API_KEY、fmapi＝院內；見 site.mjs）。
// 關閉的 tool 不在 tools/list 出現，呼叫回 E_FEATURE_DISABLED。檔案不存在或壞掉時用預設值（不中斷 MCP）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as online from './online.mjs';
import * as llmgw from './llmgw.mjs';
import * as fmapi from './fmapi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  online: 'auto',          // strucmed API v2 線上 tool
  llmgateway: 'auto',      // LlmGateway tool（Phase 3）
  fmapi: 'auto',           // FMapi tool（Phase 4）
  templateUpdate: true,    // online_template_update（Phase 2）
  dictionaryWrite: false,  // online_dictionary_create／batch（Phase 2；字典命名規範未定）
  llmChatTest: false,      // llmgateway_chat_test（Phase 3）
  appBuilderB2: true,      // build-form-app 的 B2 app 產生（Phase 4）
  playwrightVerify: false, // verify-runtime 以 Playwright 驗證（選用）
  unattended: false        // 無人值守：所有閘門一律取消並記錄，不自動核准
};

const AUTO = {
  online: () => online.configured(),
  llmgateway: () => llmgw.configured(),
  fmapi: () => fmapi.configured()
};

export function flagsFile() {
  const p = String(process.env.STRUCMED_FLAGS || '').trim();
  return p && !p.startsWith('${') ? path.resolve(p) : path.resolve(HERE, '../../../feature-flags.json');
}

export function loadFlags() {
  const out = { ...DEFAULTS };
  const p = flagsFile();
  if (!fs.existsSync(p)) return out;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    process.stderr.write(`[strucmed-mcp] feature-flags 無法解析（${p}）：${e.message}；使用預設值\n`);
    return out;
  }
  for (const [k, v] of Object.entries(raw || {})) {
    if (k.startsWith('//') || !(k in DEFAULTS)) continue;
    if (v === true || v === false || v === 'auto') out[k] = v;
  }
  return out;
}

export function enabled(name, flags = loadFlags()) {
  const v = flags[name];
  if (v === 'auto') return AUTO[name] ? AUTO[name]() : false;
  return v === true;
}

export function resolved(flags = loadFlags()) {
  return Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, { value: flags[k], enabled: enabled(k, flags) }]));
}
