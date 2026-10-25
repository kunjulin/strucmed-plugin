// 假站台的瀏覽器登入（auth/authorize 立即導回本機回呼，模擬使用者已在登入頁按「登入並同意」）與測試端的「瀏覽器」。
import crypto from 'node:crypto';

const b64url = buf => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const loopback = u => { try { const x = new URL(u); return x.protocol === 'http:' && x.hostname === '127.0.0.1' && !!x.port; } catch { return false; } };

export function fakeAuthorize() {
  const codes = new Map();
  const auth = { codes, issuedCodes: [], deny: false, lastQuery: null };
  // GET api/v2/auth/authorize：檢查參數後 302 導回 redirect_uri
  auth.authorize = (url, res) => {
    const q = Object.fromEntries(url.searchParams);
    auth.lastQuery = q;
    if (q.client_id !== 'strucmed-mcp' || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge || '') || !loopback(q.redirect_uri) || !q.state) {
      res.writeHead(400, { 'Content-Type': 'text/html' }); return res.end('bad request');
    }
    const target = new URL(q.redirect_uri);
    if (auth.deny) target.searchParams.set('error', 'access_denied');
    else {
      const code = 'ac_' + b64url(crypto.randomBytes(16));
      codes.set(code, { challenge: q.code_challenge, redirectUri: q.redirect_uri, used: false });
      auth.issuedCodes.push(code);
      target.searchParams.set('code', code);
    }
    target.searchParams.set('state', q.state);
    res.writeHead(302, { Location: target.toString() }); res.end();
  };
  // POST api/v2/auth/token（grantType authorization_code）：成功回 true
  auth.exchange = body => {
    const c = codes.get(body.code);
    if (!c || c.used || body.clientId !== 'strucmed-mcp' || body.redirectUri !== c.redirectUri) return false;
    c.used = true;
    return b64url(crypto.createHash('sha256').update(String(body.codeVerifier || '')).digest()) === c.challenge;
  };
  return auth;
}

// 測試端的瀏覽器：第一次 online_login 回 pending 與 authorize_url，開啟網址（fetch 會跟著導回本機回呼）後再呼叫一次
export async function browserLogin(m, args = {}) {
  const first = await m.call('online_login', args);
  if (!first.ok || !first.data.pending) return first;
  const r = await fetch(first.data.authorize_url);
  await r.text();
  return m.call('online_login', args);
}
