// Two-step confirmation : first call returns {plan, confirm_token};
// the token is bound to the exact payload hash and expires in 10 minutes.
// The HMAC key lives only in this process, so tokens cannot be forged or reused
// across server restarts.
import crypto from 'node:crypto';
import { E, fail } from './errors.mjs';

const KEY = crypto.randomBytes(32);
const TTL_MS = 10 * 60 * 1000;

export const hashPayload = obj => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

export function issue(action, payloadHash) {
  const exp = Date.now() + TTL_MS;
  const mac = crypto.createHmac('sha256', KEY).update(`${action}|${payloadHash}|${exp}`).digest('hex').slice(0, 32);
  return `${exp}.${mac}`;
}

export function verify(action, payloadHash, token) {
  if (!token) return false;
  const [expStr, mac] = String(token).split('.');
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) fail(E.CONFIRM_MISMATCH, 'confirm_token 已過期，請重新取得計畫');
  const want = crypto.createHmac('sha256', KEY).update(`${action}|${payloadHash}|${exp}`).digest('hex').slice(0, 32);
  const ok = mac && mac.length === want.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  if (!ok) fail(E.CONFIRM_MISMATCH, 'confirm_token 與目前內容不符（內容在確認後被改動？），請重新取得計畫');
  return true;
}
