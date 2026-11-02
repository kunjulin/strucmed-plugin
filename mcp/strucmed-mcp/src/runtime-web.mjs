// 平台前端（web/）本機副本的位置：form_preview、scripts/preview.mjs、scripts/check-env.mjs 共用同一份判斷。
// STRUCMED_RUNTIME_WEB 有設就用它；沒設時依序找工作目錄附近（工作目錄本身可能就叫 repo，只找一種路徑會疊成雙 repo，F-03）。
import fs from 'node:fs';
import path from 'node:path';

const hasRuntime = dir => fs.existsSync(path.join(dir, 'TempHtml.html'));

// → { path, available, source: 'env'|'search'|'none', tried }；找不到時 path 是第一個候選
export function findRuntimeWeb(root, env = process.env) {
  const set = String(env.STRUCMED_RUNTIME_WEB || '').trim();
  if (set && !set.startsWith('${')) {
    const dir = path.resolve(set);
    return { path: dir, available: hasRuntime(dir), source: 'env', tried: [dir] };
  }
  const tried = [path.join(root, 'strucmed', 'web'), path.join(root, 'repo', 'strucmed', 'web'), path.resolve(root, '..', 'strucmed', 'web')];
  const hit = tried.find(hasRuntime);
  return { path: hit || tried[0], available: !!hit, source: hit ? 'search' : 'none', tried };
}
