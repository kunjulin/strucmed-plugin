// Streamable HTTP transport (MCP 2025-03-26+), zero dependencies: node:http only.
// Shape: one POST = one JSON-RPC request (or batch) → one JSON response; notifications-only → 202.
// Stateless: no Mcp-Session-Id, no server-initiated stream (GET → 405). Clients that only speak
// request/response (server-side agent platforms such as MaiAgent) need exactly this subset.
// Security posture:
//   - binds 127.0.0.1 unless STRUCMED_HTTP_HOST says otherwise; a non-loopback bind requires STRUCMED_HTTP_TOKEN
//   - STRUCMED_HTTP_TOKEN (when set) is checked on every request as `Authorization: Bearer <token>`, constant-time
//   - requests carrying an Origin header are refused (browser pages must not drive this endpoint; DNS-rebinding guard)
//   - body limit 1 MiB; only POST on the configured path; stdout stays free (diagnostics go to stderr)
//   - GET <path>/files/<draft_id>/<kind>?t=<token> serves an exported artifact to a browser; the signed token
//     (files.mjs) is the only credential on that route, since a browser download carries no bearer header
import http from 'node:http';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { requestContext } from './reqctx.mjs';
import * as files from './files.mjs';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PATH = '/mcp';
const MAX_BODY = 1024 * 1024;
const unset = v => v === undefined || v === null || String(v).trim() === '' || /^\$\{.*\}$/.test(String(v).trim());
const env = name => unset(process.env[name]) ? '' : String(process.env[name]).trim();

export const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** HTTP settings from the environment; null when STRUCMED_HTTP_PORT is unset (stdio mode). Throws on invalid values. */
export function httpConfig(e = process.env) {
  const read = name => unset(e[name]) ? '' : String(e[name]).trim();
  const portRaw = read('STRUCMED_HTTP_PORT');
  if (!portRaw) return null;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`STRUCMED_HTTP_PORT 必須是 0–65535 的整數（收到：${portRaw}）`);
  const host = read('STRUCMED_HTTP_HOST') || DEFAULT_HOST;
  const token = read('STRUCMED_HTTP_TOKEN');
  if (!LOOPBACK.has(host) && !token) throw new Error(`STRUCMED_HTTP_HOST=${host} 不是本機位址，必須同時設定 STRUCMED_HTTP_TOKEN`);
  let path = read('STRUCMED_HTTP_PATH') || DEFAULT_PATH;
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { port, host, token, path };
}

function bearerOk(req, token) {
  if (!token) return true;
  const header = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1].trim());
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function reply(res, status, body, headers = {}) {
  const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      if (size > MAX_BODY) return;   // 已超限：丟棄其餘本文，連線留著才回得了 413
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; reject(Object.assign(new Error('payload too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the HTTP listener. `respond(msg)` resolves to the JSON-RPC response for one message, or undefined for a
 * notification. `onRequest(promise)` lets the caller track in-flight work for graceful shutdown.
 */
/** The origin a browser would use to reach this server, honouring a reverse proxy's forwarded headers. */
function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function serveFile(req, res, config, url) {
  const m = new RegExp(`^${config.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/files/([^/]+)/([a-z]+)$`).exec(url.pathname);
  if (!m) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { reply(res, 405, { error: 'method not allowed' }, { Allow: 'GET' }); return true; }
  const found = files.resolve(m[1], m[2], url.searchParams.get('t'));
  if (!found) { reply(res, 404, { error: 'not found' }); return true; }
  const body = fs.readFileSync(found.file);
  res.writeHead(200, {
    'Content-Type': found.mime, 'Content-Length': body.length, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.name)}`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

export function startHttp(config, respond, { log = () => {}, onRequest = () => {} } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (serveFile(req, res, config, url)) return;
    if (url.pathname !== config.path) return reply(res, 404, { error: 'not found' });
    if (req.headers.origin !== undefined) return reply(res, 403, { error: 'Origin not allowed' });
    if (!bearerOk(req, config.token)) return reply(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (req.method === 'GET' || req.method === 'DELETE') return reply(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    const ctype = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ctype)) return reply(res, 415, { error: 'Content-Type must be application/json' });
    let raw;
    try { raw = await readBody(req); } catch (e) { return reply(res, e.status || 400, { error: String(e.message || e) }, { Connection: 'close' }); }
    let msg;
    try { msg = JSON.parse(raw); } catch { return reply(res, 400, rpcError(null, -32700, 'Parse error')); }
    const batch = Array.isArray(msg);
    const msgs = batch ? msg : [msg];
    if (msgs.length === 0 || msgs.some(m => !m || typeof m !== 'object' || m.jsonrpc !== '2.0')) {
      return reply(res, 400, rpcError(null, -32600, 'Invalid Request'));
    }
    const ctx = { origin: requestOrigin(req), path: config.path };
    const job = requestContext.run(ctx, () => Promise.all(msgs.map(m => respond(m))));
    onRequest(job);
    let results;
    try { results = (await job).filter(r => r !== undefined); } catch (e) {
      log('http handler error', e && e.stack);
      return reply(res, 500, rpcError(null, -32603, 'Internal error'));
    }
    if (results.length === 0) { res.writeHead(202); return res.end(); }
    return reply(res, 200, batch ? results : results[0]);
  });
  server.keepAliveTimeout = 65000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      const { port } = server.address();
      resolve({ server, port, url: `http://${config.host}:${port}${config.path}` });
    });
  });
}
