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
  dictionaryWrite: true,   // online_dictionary_create／batch／memo_set（docs/14 起預設開：說明與補述存進字典 JSON）
  llmChatTest: false,      // llmgateway_chat_test（Phase 3）
  appBuilderB2: true,      // build-form-app 的 B2 app 產生（Phase 4）
  playwrightVerify: false, // verify-runtime 以 Playwright 驗證（選用）
  unattended: false,       // 無人值守：所有閘門一律取消並記錄，不自動核准
  formScript: false,       // 表單 JS 增益集：白名單片段（form_set_script／form_script_preview；docs/13）
  formScriptAdvanced: false, // 進階片段 autorun／table-rows（docs/13 §九；需 formScript 也開）
  attachBox: true,         // 附件容器：form_add_control datatype attachbox、巨集 LLMATTACH／ATTACHTRANSCRIBE、函數 ATTACHTEXT／ATTACHCOUNT。3.12.1 起預設開（2026-11-16：院內、院外站台都已啟用 V2:Attachments 並實測可用）；沒啟用的站台上容器只顯示「尚未啟用」；匯入既有含附件容器的表單不受 flag 影響
  runtimeFetch: true,      // runtime_fetch：從站台抓平台前端 web/ 副本到 <HOME>/.strucmed/runtime（兩段式，第二段才連外）。
                           // false＝整個關掉（資安審查要求完全不對外抓檔時）；使用者仍可自己設 STRUCMED_RUNTIME_WEB
  browserApprove: true,    // 線上寫入的瀏覽器確認頁（approve.mjs）。預設 true＝行為與 2.3.0 起相同：第二段呼叫一定要使用者本人在 127.0.0.1 的頁面按「確認寫入」。
                           // false＝第二段呼叫直接寫入，不開那一頁（遠端或手機操作時碰不到它）。兩段式 confirm_token 與 G2 核准不變，
                           // 但「在 AI 之外看過 plan 的人」只剩 AI 工具自己的「要不要允許這次 tool 呼叫」提示；該提示也自動允許時就沒有任何人看過。
                           // 關閉時每次寫入的 plan 都會多一條 W_NO_BROWSER_APPROVE，一定出現在定稿檔的「### 警告」。見 references/SecurityInvariants.md 第 2 條
  embedArea: true          // 嵌入頁面：form_add_area type embed、巨集 OPENPANEL。3.11.0 起預設開（2026-11-08 站台編輯器實測：匯入、存檔重開、重新編號都完整保留）；匯入既有含 embed 的表單不受 flag 影響
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
