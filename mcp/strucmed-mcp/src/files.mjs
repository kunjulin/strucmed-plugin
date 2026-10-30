// Exported artifacts of a draft: signed download links (HTTP mode), `strucmed://export/<draft_id>/<kind>`
// resources (resources/read) and embedded resource blocks (include_content). All three take the file from the
// export record `form_export` wrote into the draft (`draft.exported.files`), never from the form name, so a renamed
// draft or a custom out_dir still resolves and two drafts with the same name cannot serve each other's file.
// The download token is an HMAC over draft_id|kind|expiry with a key that lives only in this process (same posture
// as confirm.mjs), so a link cannot be forged, retargeted to another file, or reused after restart. A browser
// download carries no bearer header, so on that route the token is the only credential.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';

const KEY = crypto.randomBytes(32);
const TTL_MS = 24 * 60 * 60 * 1000;
export const KINDS = { htm: { mime: 'text/html; charset=utf-8' }, json: { mime: 'application/json; charset=utf-8' }, manifest: { mime: 'text/markdown; charset=utf-8' } };
const DRAFT_ID = /^d-[0-9a-f]{12}$/;
export const RESOURCE_PREFIX = 'strucmed://export/';
export const RESOURCE_TEMPLATE = { uriTemplate: `${RESOURCE_PREFIX}{draft_id}/{kind}`, name: 'StrucMed 匯出檔', description: 'form_export 輸出的檔案；kind 為 htm（匯入用）／json（範本套件 v2）／manifest', mimeType: 'text/html' };

const mac = (draftId, kind, exp) => crypto.createHmac('sha256', KEY).update(`${draftId}|${kind}|${exp}`).digest('hex').slice(0, 32);

export function issue(draftId, kind) {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${mac(draftId, kind, exp)}`;
}

/** The on-disk artifact `form_export` recorded for a draft, or null when there is no record, the kind is unknown or the file is gone. */
export function artifact(draftId, kind) {
  if (!DRAFT_ID.test(String(draftId)) || !KINDS[kind]) return null;
  let draft;
  try { draft = store.loadDraft(draftId); } catch { return null; }
  const file = draft.exported && draft.exported.files && draft.exported.files[kind];
  if (!file) return null;
  const abs = path.resolve(String(file));
  // 只送出工作目錄內、仍存在的檔案（紀錄是本程式寫的，仍以路徑再檢查一次）
  if (!abs.startsWith(store.workspaceRoot() + path.sep) || !fs.existsSync(abs)) return null;
  return { file: abs, name: path.basename(abs), mime: KINDS[kind].mime };
}

/** Download target for a signed request, or null when the token is bad or expired, or the artifact is unknown. */
export function resolve(draftId, kind, token) {
  if (!DRAFT_ID.test(String(draftId)) || !KINDS[kind] || !token) return null;
  const [expStr, given] = String(token).split('.');
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return null;
  const want = mac(draftId, kind, exp);
  if (!given || given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return null;
  return artifact(draftId, kind);
}

/** Download URLs for a draft's artifacts under `base` (the HTTP endpoint origin + path); {} when there is no base. */
export function links(base, endpointPath, draftId) {
  if (!base) return {};
  const out = {};
  for (const kind of Object.keys(KINDS)) out[kind] = `${base}${endpointPath}/files/${draftId}/${kind}?t=${encodeURIComponent(issue(draftId, kind))}`;
  return out;
}

export const resourceUri = (draftId, kind) => `${RESOURCE_PREFIX}${draftId}/${kind}`;

/** `strucmed://export/...` URIs for all kinds of a draft (listed in the form_export result; read with resources/read). */
export function resourceUris(draftId) {
  return Object.fromEntries(Object.keys(KINDS).map(kind => [kind, resourceUri(draftId, kind)]));
}

/** resources/read for a `strucmed://export/<draft_id>/<kind>` URI; null when the URI is not one or the file is unknown. */
export function readResource(uri) {
  const m = /^strucmed:\/\/export\/([^/]+)\/([a-z]+)$/.exec(String(uri || ''));
  if (!m) return null;
  const found = artifact(m[1], m[2]);
  if (!found) return null;
  return { contents: [{ uri: String(uri), mimeType: found.mime, text: fs.readFileSync(found.file, 'utf8') }] };
}

/** An embedded-resource content block carrying the file (form_export include_content); null when unknown. */
export function embedded(draftId, kind) {
  const found = artifact(draftId, kind);
  if (!found) return null;
  return { type: 'resource', resource: { uri: resourceUri(draftId, kind), mimeType: found.mime, text: fs.readFileSync(found.file, 'utf8') } };
}
