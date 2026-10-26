// 2.3.0：寫入確認頁（approve.mjs）的頁面內容一律跳脫，未記下計畫或已過期時拒絕
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.STRUCMED_NO_BROWSER = '1';
process.env.STRUCMED_APPROVE_WAIT_MS = '0';
const approve = await import('../src/approve.mjs');

test('approval page escapes plan content and sends a strict CSP', async () => {
  approve.offer('online_template_create', 'h1', '新增範本', { action: '新增範本', name: '<script>alert(1)</script>', groups: ['門', '<b>住</b>'], diff: { note: '"><img src=x>' } });
  const p = await approve.awaitApproval('online_template_create', 'h1');
  assert.equal(p.pending, true);
  const res = await fetch(p.approve_url);
  const html = await res.text();
  assert.ok(!html.includes('<script>alert'), 'name escaped');
  assert.ok(!html.includes('<b>住</b>') && !html.includes('<img src=x>'), 'arrays and objects escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const u = new URL(p.approve_url);
  const r = await fetch(new URL('/decide', u), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ n: u.searchParams.get('n'), d: 'reject' }).toString() });
  await r.text();
  await assert.rejects(approve.awaitApproval('online_template_create', 'h1'), e => e.code === 'E_REJECTED');
  assert.equal(approve.pendingCount(), 0);
});

test('a confirmation needs a plan offered for the same action and payload', async () => {
  await assert.rejects(approve.awaitApproval('online_template_create', 'never-offered'), e => e.code === 'E_CONFIRM_MISMATCH');
  approve.offer('online_template_update', 'h2', '更新範本', { action: '更新範本 T-1' });
  await assert.rejects(approve.awaitApproval('online_template_create', 'h2'), e => e.code === 'E_CONFIRM_MISMATCH', 'bound to the action');
});
