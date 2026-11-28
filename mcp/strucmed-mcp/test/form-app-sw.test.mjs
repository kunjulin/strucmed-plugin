// 表單 APP 範本（templates/form-app）的 service worker：首頁不進快取、不攔頁面導覽（平台 struNote 同樣的修正：kunjulin/strucmed#295、#296）。
// 首頁放進快取時，改版後第一次開啟拿到的是舊版。範本沒有 npm 相依可以在這裡建置，所以只檢查設定本身
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = f => fs.readFileSync(path.join(ROOT, 'templates/form-app', f), 'utf8');

test('form-app：workbox 只快取 js／css，navigateFallback 是 null；nginx 對 index.html 與 sw.js 回 no-store', () => {
  const vite = read('vite.config.ts');
  const wb = vite.slice(vite.indexOf('workbox:'), vite.indexOf('manifest:'));
  assert.ok(vite.includes('workbox:') && wb.length, 'vite.config.ts 要有 workbox 設定（在 manifest 之前）');
  assert.ok(wb.includes("globPatterns: ['**/*.{js,css}']"), wb);
  assert.match(wb, /navigateFallback:\s*null/);
  const nginx = read('nginx.conf');
  assert.match(nginx, /location = \/index\.html \{ add_header Cache-Control "no-store"; \}/);
  assert.match(nginx, /location = \/sw\.js \{ add_header Cache-Control "no-store"; \}/);
});
