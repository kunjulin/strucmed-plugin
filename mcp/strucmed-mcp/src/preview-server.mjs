// MCP 常駐預覽伺服器管理：讓 form_preview(format: "html") 直接在 MCP 行程內啟動／沿用 127.0.0.1 預覽伺服器。
// Antigravity 等環境的 shell 指令結束時會回收背景子行程，導致 scripts/preview.mjs detach 的 serve.mjs 立即被殺；
// 改由常駐的 strucmed-mcp 行程承載，與 approve.mjs 相同只聽 127.0.0.1、不連外，MCP 結束時自動關閉並清理 server.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreviewServer } from '../../../tools/v0-harness/serve.mjs';

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const OWN_SERVE = real(fileURLToPath(new URL('../../../tools/v0-harness/serve.mjs', import.meta.url)));

const active = new Map();   // workspace root → { server, port, nonce, workspace, web, close, writeServerInfo }

function readExternalOurs(wsRoot, webRoot) {
  const file = path.join(wsRoot, '.strucmed', 'preview', 'server.json');
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!s || !Number.isInteger(s.port) || !Number.isInteger(s.pid) || !s.nonce) return null;
  if (s.pid === process.pid) return null;
  if (!s.serve || real(String(s.serve)) !== OWN_SERVE) return null;
  if (real(String(s.workspace || '')) !== real(wsRoot) || real(String(s.web || '')) !== real(webRoot)) return null;
  try { process.kill(s.pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
  return { port: s.port, nonce: String(s.nonce), reused: true, managed: false };
}

export async function ensurePreviewServer({ workspace, web, startPort = 8765, tries = 10, log = () => {} }) {
  const wsRoot = path.resolve(workspace);
  const webRoot = path.resolve(web);
  const cur = active.get(wsRoot);
  if (cur) {
    if (cur.server.listening && cur.web === webRoot) {
      cur.writeServerInfo();
      return { port: cur.port, nonce: cur.nonce, reused: true, managed: true };
    }
    cur.close();
    active.delete(wsRoot);
  }
  const ext = readExternalOurs(wsRoot, webRoot);
  if (ext) return ext;

  const ports = [...Array.from({ length: tries }, (_, i) => startPort + i), 0];
  let lastErr;
  for (const port of ports) {
    try {
      const entry = await startPreviewServer({
        workspace: wsRoot, web: webRoot, port, unref: true, exitOnIdle: false, log,
        onClose: () => { if (active.get(wsRoot) === entry) active.delete(wsRoot); }
      });
      active.set(wsRoot, entry);
      return { port: entry.port, nonce: entry.nonce, reused: false, managed: true };
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) continue;
      throw e;
    }
  }
  throw lastErr || new Error('無法啟動本機預覽伺服器');
}

export function stopPreviewServers() {
  for (const entry of [...active.values()]) entry.close();
  active.clear();
}
