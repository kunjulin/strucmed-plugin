// Signed download links for exported artifacts (HTTP mode): the card asks the host to open
// `<base><path>/files/<draft_id>/<kind>?t=<token>` in the browser. The token is an HMAC over
// draft_id|kind|expiry with a key that lives only in this process (same posture as confirm.mjs),
// so a link cannot be forged, retargeted to another file, or reused after restart.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';
import { safeFileName } from './export.mjs';

const KEY = crypto.randomBytes(32);
const TTL_MS = 24 * 60 * 60 * 1000;
export const KINDS = { htm: { ext: '.htm', mime: 'text/html; charset=utf-8' }, json: { ext: '.package.json', mime: 'application/json; charset=utf-8' }, manifest: { ext: '.manifest.md', mime: 'text/markdown; charset=utf-8' } };
const DRAFT_ID = /^d-[0-9a-f]{12}$/;

const mac = (draftId, kind, exp) => crypto.createHmac('sha256', KEY).update(`${draftId}|${kind}|${exp}`).digest('hex').slice(0, 32);

export function issue(draftId, kind) {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${mac(draftId, kind, exp)}`;
}

/** The on-disk artifact for a signed request, or null when the token is bad, expired or the file is missing. */
export function resolve(draftId, kind, token) {
  if (!DRAFT_ID.test(String(draftId)) || !KINDS[kind] || !token) return null;
  const [expStr, given] = String(token).split('.');
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return null;
  const want = mac(draftId, kind, exp);
  if (!given || given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return null;
  let draft;
  try { draft = store.loadDraft(draftId); } catch { return null; }
  const file = path.join(store.workspace().outDir, safeFileName(draft.meta.name) + KINDS[kind].ext);
  if (!fs.existsSync(file)) return null;
  return { file, name: path.basename(file), mime: KINDS[kind].mime };
}

/** Download URLs for a draft's artifacts under `base` (the HTTP endpoint origin + path); {} when there is no base. */
export function links(base, endpointPath, draftId) {
  if (!base) return {};
  const out = {};
  for (const kind of Object.keys(KINDS)) out[kind] = `${base}${endpointPath}/files/${draftId}/${kind}?t=${encodeURIComponent(issue(draftId, kind))}`;
  return out;
}
