// 2.3.0：寫入確認頁（approve.mjs）的頁面內容一律跳脫，未記下計畫或已過期時拒絕
// ＋ feature flag browserApprove：關閉時不開那一頁、直接放行，plan 一定帶 W_NO_BROWSER_APPROVE
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STRUCMED_NO_BROWSER = '1';
process.env.STRUCMED_APPROVE_WAIT_MS = '0';
const approve = await import('../src/approve.mjs');

// feature flag 每次呼叫都重讀檔案，所以測試中可以換 STRUCMED_FLAGS
const flagsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-flags-'));
const flagsFile = (value) => {
  const f = path.join(flagsDir, `flags-${value}.json`);
  fs.writeFileSync(f, JSON.stringify({ browserApprove: value }));
  return f;
};

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

test('browserApprove: true（預設）＝一定要在確認頁按，plan 不帶 W_NO_BROWSER_APPROVE', async () => {
  process.env.STRUCMED_FLAGS = flagsFile(true);
  assert.equal(approve.browserApprove(), true);
  const plan = { action: '新增範本', name: 'A', warnings: ['W_X：原本就有的警告'] };
  approve.offer('online_template_create', 'flag-on', '新增範本', plan);
  assert.deepEqual(plan.warnings, ['W_X：原本就有的警告'], 'flag 開著時不加警告');
  const p = await approve.awaitApproval('online_template_create', 'flag-on');
  assert.equal(p.pending, true, '還是要有人按確認頁');
  assert.ok(p.approve_url);
  const u = new URL(p.approve_url);
  await (await fetch(new URL('/decide', u), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ n: u.searchParams.get('n'), d: 'approve' }).toString() })).text();
  assert.deepEqual(await approve.awaitApproval('online_template_create', 'flag-on'), { approved: true });
});

test('browserApprove: false＝第二段呼叫直接寫入、不開頁；plan 帶 W_NO_BROWSER_APPROVE；兩段式與一次性不變', async () => {
  process.env.STRUCMED_FLAGS = flagsFile(false);
  assert.equal(approve.browserApprove(), false);
  // 第一段：警告併進 plan.warnings → 定稿檔的「### 警告」一定看得到
  const plan = { action: '新增範本', name: 'A' };
  approve.offer('online_template_create', 'flag-off', '新增範本', plan);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /^W_NO_BROWSER_APPROVE/);
  assert.match(plan.warnings[0], /沒有任何人在 AI 之外看過這份 plan/, '取捨要誠實寫出來');
  const withWarn = { action: '新增範本', warnings: ['W_X：別的警告'] };
  approve.offer('online_template_create', 'flag-off-2', '新增範本', withWarn);
  assert.equal(withWarn.warnings.length, 2, '原有的警告保留');
  approve.offer('online_template_create', 'flag-off-2', '新增範本', withWarn);
  assert.equal(withWarn.warnings.length, 2, '重複 offer 不重複加');
  // 第二段：不開頁、直接放行，回傳帶同一條警告
  const r = await approve.awaitApproval('online_template_create', 'flag-off');
  assert.deepEqual([r.approved, r.pending, r.browser_approve], [true, undefined, false]);
  assert.match(r.warnings[0], /^W_NO_BROWSER_APPROVE/);
  // 仍然只能用一次，且仍然要先有第一段記下的同一份 plan（兩段式沒有被放寬）
  await assert.rejects(approve.awaitApproval('online_template_create', 'flag-off'), e => e.code === 'E_CONFIRM_MISMATCH');
  await assert.rejects(approve.awaitApproval('online_template_create', 'never-offered-off'), e => e.code === 'E_CONFIRM_MISMATCH');
  delete process.env.STRUCMED_FLAGS;
  fs.rmSync(flagsDir, { recursive: true, force: true });
});
