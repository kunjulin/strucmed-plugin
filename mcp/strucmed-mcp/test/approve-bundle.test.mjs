// 3.11.2：同一個 draft 的多項寫入合併在一頁確認；同內容重取計畫沿用確認
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.STRUCMED_NO_BROWSER = '1';
process.env.STRUCMED_APPROVE_WAIT_MS = '0';
const approve = await import('../src/approve.mjs');

async function decide(url, d) {
  const u = new URL(url);
  const r = await fetch(new URL('/decide', u), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ n: u.searchParams.get('n'), d }).toString() });
  return r.text();
}

test('offers of the same draft share one page and one approval', async () => {
  approve.offer('online_dictionary_batch', 'b1', '批次新增字典', { action: '批次新增字典', rows: [{ name: 'X' }] }, 'd-000000000001');
  approve.offer('online_dictionary_memo_batch', 'b2', '批次更新字典補述（1 本）', { action: '補述' }, 'd-000000000001');
  approve.offer('online_template_create', 'b3', '新增範本', { action: '新增範本', name: '跌倒評估' }, 'd-000000000001');
  approve.offer('online_template_create', 'other', '新增範本', { action: '新增範本', name: '別張' }, 'd-000000000002');
  const p = await approve.awaitApproval('online_dictionary_batch', 'b1');
  assert.equal(p.pending, true);
  assert.equal(p.bundled, 3);
  const html = await (await fetch(p.approve_url)).text();
  assert.ok(html.includes('3 項寫入') && html.includes('跌倒評估') && html.includes('批次新增字典'));
  assert.ok(!html.includes('別張'), 'another draft is not on the page');
  await decide(p.approve_url, 'approve');
  assert.deepEqual(await approve.awaitApproval('online_dictionary_batch', 'b1'), { approved: true });
  assert.deepEqual(await approve.awaitApproval('online_dictionary_memo_batch', 'b2'), { approved: true }, 'no second page');
  assert.deepEqual(await approve.awaitApproval('online_template_create', 'b3'), { approved: true });
  await assert.rejects(approve.awaitApproval('online_template_create', 'b3'), e => e.code === 'E_CONFIRM_MISMATCH', 'each approval used once');
  const q = await approve.awaitApproval('online_template_create', 'other');
  assert.equal(q.pending, true, 'the other draft still needs its own page');
  assert.equal(q.bundled, undefined);
  await decide(q.approve_url, 'reject');
  await assert.rejects(approve.awaitApproval('online_template_create', 'other'), e => e.code === 'E_REJECTED');
});

test('cancel on a bundled page rejects every write on it', async () => {
  approve.offer('online_dictionary_batch', 'r1', '批次新增字典', { action: '批次新增字典' }, 'd-000000000003');
  approve.offer('online_template_create', 'r2', '新增範本', { action: '新增範本' }, 'd-000000000003');
  const p = await approve.awaitApproval('online_template_create', 'r2');
  await decide(p.approve_url, 'reject');
  await assert.rejects(approve.awaitApproval('online_template_create', 'r2'), e => e.code === 'E_REJECTED');
  await assert.rejects(approve.awaitApproval('online_dictionary_batch', 'r1'), e => e.code === 'E_REJECTED');
});

test('a plan offered after the page opened gets its own page', async () => {
  approve.offer('online_dictionary_batch', 'l1', '批次新增字典', { action: '批次新增字典' }, 'd-000000000004');
  const p = await approve.awaitApproval('online_dictionary_batch', 'l1');
  approve.offer('online_template_create', 'l2', '新增範本', { action: '新增範本', name: '後來的' }, 'd-000000000004');
  const html = await (await fetch(p.approve_url)).text();
  assert.ok(!html.includes('後來的'), 'not added to an open page');
  await decide(p.approve_url, 'approve');
  assert.deepEqual(await approve.awaitApproval('online_dictionary_batch', 'l1'), { approved: true });
  const q = await approve.awaitApproval('online_template_create', 'l2');
  assert.equal(q.pending, true);
  await decide(q.approve_url, 'reject');
  await assert.rejects(approve.awaitApproval('online_template_create', 'l2'));
});

test('re-offering the same approved payload keeps the approval; a changed payload does not', async () => {
  approve.offer('online_dictionary_batch', 's1', '批次新增字典', { action: '批次新增字典' }, 'd-000000000005');
  approve.offer('online_template_create', 's2', '新增範本', { action: '新增範本' }, 'd-000000000005');
  const p = await approve.awaitApproval('online_dictionary_batch', 's1');
  await decide(p.approve_url, 'approve');
  assert.deepEqual(await approve.awaitApproval('online_dictionary_batch', 's1'), { approved: true });
  approve.offer('online_template_create', 's2', '新增範本', { action: '新增範本' }, 'd-000000000005');   // token 過期後重取同一份
  assert.deepEqual(await approve.awaitApproval('online_template_create', 's2'), { approved: true });
  approve.offer('online_template_create', 's3', '新增範本', { action: '新增範本', name: '改過' }, 'd-000000000005');
  const q = await approve.awaitApproval('online_template_create', 's3');
  assert.equal(q.pending, true, 'different hash needs a new confirmation');
  await decide(q.approve_url, 'reject');
  await assert.rejects(approve.awaitApproval('online_template_create', 's3'));
  assert.equal(approve.pendingCount(), 0);
});
