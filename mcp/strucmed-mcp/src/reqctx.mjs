// Per-request context for the HTTP transport (public base URL for links the card opens).
// stdio has no request, so the context is empty there and link fields stay undefined.
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();

/** The current request's context, or {} outside a request. */
export const current = () => requestContext.getStore() || {};

/** Public base URL for download links: STRUCMED_PUBLIC_URL wins, then the request's own origin. */
export function publicBase() {
  const env = String(process.env.STRUCMED_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  return current().origin || '';
}
