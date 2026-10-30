// 閘門 G3 hook：Claude 格式（hooks/validate-gate.js，exit code）與 Antigravity 格式（hooks/antigravity/validate-gate.js，stdout JSON）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLAUDE_HOOK = path.join(ROOT, 'hooks', 'validate-gate.js');
const AGY_HOOK = path.join(ROOT, 'hooks', 'antigravity', 'validate-gate.js');
const VERIFY = path.join(ROOT, 'scripts', 'verify-plan.mjs');
const DRAFT = 'd-0123456789ab';

const PLAN = `# 測試表單 上架計畫

## 上架計畫
Status: Ready
Revision: 1

### 建置對照表（builder 回填）
| ID | itemid |
|---|---|

## 核准
Status: Approved
Approved-Revision: 1
`;

// 工作目錄：approved＝已核准；pending＝有計畫沒有 sidecar；none＝沒有計畫
function workspace(state = 'approved') {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-gate-')));
  if (state === 'none') return ws;
  const dir = path.join(ws, '.strucmed', 'plans', DRAFT);
  fs.mkdirSync(dir, { recursive: true });
  const plan = path.join(dir, 'publish-plan.md');
  fs.writeFileSync(plan, PLAN);
  if (state === 'approved') assert.equal(spawnSync(process.execPath, [VERIFY, 'prepare', plan, '--by', 'test']).status, 0);
  return ws;
}

// 隔離 HOME 與 STRUCMED_WORKSPACE，避免讀到本機真正的 ~/.gemini/config/mcp_config.json
function run(hook, payload, { cwd, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-home-'));
  const base = { ...process.env, HOME: home, USERPROFILE: home };
  delete base.STRUCMED_WORKSPACE;
  return spawnSync(process.execPath, [hook], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), cwd: cwd || home, env: { ...base, ...env }, encoding: 'utf8' });
}

// 與 Antigravity IDE 2.5.5 實際送出的 PreToolUse 內容同形（2026-10-26 記錄）
const agy = (ToolName, Arguments) => ({
  conversationId: '00000000-0000-0000-0000-000000000000', modelName: 'gemini-3.8-flash-high', stepIdx: 7, workspacePaths: [],
  toolCall: { name: 'call_mcp_tool', args: { ServerName: 'strucmed', ToolName, Arguments } }
});
const decision = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

test('claude hook: 第一段放行、未核准阻擋、核准後放行、改過計畫阻擋', () => {
  const claude = (ws, tool_input) => run(CLAUDE_HOOK, { tool_name: 'mcp__plugin_strucmed_strucmed__online_template_create', tool_input, cwd: ws });
  assert.equal(claude(workspace('none'), { draft_id: DRAFT }).status, 0, '沒有 confirm_token＝第一段');
  assert.equal(claude(workspace('none'), { draft_id: DRAFT, confirm_token: 't' }).status, 2);
  assert.equal(claude(workspace('pending'), { draft_id: DRAFT, confirm_token: 't' }).status, 2);
  const ws = workspace('approved');
  assert.equal(claude(ws, { draft_id: DRAFT, confirm_token: 't' }).status, 0);
  fs.appendFileSync(path.join(ws, '.strucmed', 'plans', DRAFT, 'publish-plan.md'), '\n補一行\n');
  const r = claude(ws, { draft_id: DRAFT, confirm_token: 't' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /核准後被修改/);
  assert.equal(run(CLAUDE_HOOK, 'not json').status, 2, '讀不到輸入＝阻擋');
});

test('antigravity hook: 非寫入 tool 與第一段照原流程（ask），不額外放行', () => {
  const env = { STRUCMED_WORKSPACE: workspace('none') };
  assert.deepEqual(decision(run(AGY_HOOK, agy('form_create', { name: 'x', dept_no: '1234' }), { env })), { decision: 'ask' });
  assert.deepEqual(decision(run(AGY_HOOK, agy('online_template_create', { draft_id: DRAFT, folder_type: 'usr' }), { env })), { decision: 'ask' });
  assert.deepEqual(decision(run(AGY_HOOK, { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }, { env })), { decision: 'ask' });
});

test('antigravity hook: 有計畫但未核准、改過計畫都阻擋；核准後回 ask；沒有計畫交給 MCP 的瀏覽器確認（ask）', () => {
  for (const tool of ['online_template_create', 'online_template_update', 'online_dictionary_create', 'online_dictionary_batch', 'online_dictionary_memo_set']) {
    const d = decision(run(AGY_HOOK, agy(tool, { draft_id: DRAFT, confirm_token: 't' }), { env: { STRUCMED_WORKSPACE: workspace('pending') } }));
    assert.equal(d.decision, 'deny', tool);
    assert.match(d.reason, /尚未核准/);
  }
  const noPlan = decision(run(AGY_HOOK, agy('online_template_create', { draft_id: DRAFT, confirm_token: 't' }), { env: { STRUCMED_WORKSPACE: workspace('none') } }));
  assert.equal(noPlan.decision, 'ask');
  assert.match(noPlan.reason, /瀏覽器確認頁/);
  const ws = workspace('approved');
  const call = agy('online_template_create', { draft_id: DRAFT, folder_type: 'usr', confirm_token: 't' });
  assert.deepEqual(decision(run(AGY_HOOK, call, { env: { STRUCMED_WORKSPACE: ws } })), { decision: 'ask' });
  fs.appendFileSync(path.join(ws, '.strucmed', 'plans', DRAFT, 'publish-plan.md'), '\n補一行\n');
  assert.equal(decision(run(AGY_HOOK, call, { env: { STRUCMED_WORKSPACE: ws } })).decision, 'deny');
});

test('antigravity hook: 工作目錄取自 mcp_config.json 的 STRUCMED_WORKSPACE；找不到時交給瀏覽器確認', () => {
  const ws = workspace('approved');
  const call = agy('online_template_create', { draft_id: DRAFT, confirm_token: 't' });
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-cfg-'));
  fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { strucmed: { command: 'node', args: ['/x/mcp/strucmed-mcp/src/server.mjs'], env: { STRUCMED_WORKSPACE: ws } } } }));
  assert.deepEqual(decision(run(AGY_HOOK, call, { cwd: cfgDir })), { decision: 'ask' }, 'hook 的 cwd 是 hooks.json 所在目錄（與 mcp_config.json 同一層）');
  const d = decision(run(AGY_HOOK, call));
  assert.equal(d.decision, 'ask');
  assert.match(d.reason, /瀏覽器確認頁/);
});

test('antigravity hook: Arguments 是字串、缺 draft_id、輸入壞掉都不會放行', () => {
  const env = { STRUCMED_WORKSPACE: workspace('approved') };
  assert.deepEqual(decision(run(AGY_HOOK, agy('online_template_create', JSON.stringify({ draft_id: DRAFT, confirm_token: 't' })), { env })), { decision: 'ask' });
  assert.equal(decision(run(AGY_HOOK, agy('online_template_create', { confirm_token: 't' }), { env })).decision, 'deny');
  assert.equal(decision(run(AGY_HOOK, agy('online_template_create', '{bad'), { env })).decision, 'deny');
  assert.equal(decision(run(AGY_HOOK, 'not json', { env })).decision, 'deny');
});

test('antigravity hook: 找不到設定時用 MCP 的預設工作目錄（~/Documents/StrucMed）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-home-'));
  const ws = path.join(home, 'Documents', 'StrucMed');
  const dir = path.join(ws, '.strucmed', 'plans', DRAFT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'publish-plan.md'), PLAN);    // 有計畫但未核准
  const r = spawnSync(process.execPath, [AGY_HOOK], { input: JSON.stringify(agy('online_template_create', { draft_id: DRAFT, confirm_token: 't' })),
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, STRUCMED_WORKSPACE: '' }, encoding: 'utf8' });
  const d = JSON.parse(r.stdout);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /尚未核准/);
});

test('gate: dictionary memo without draft_id goes to the browser confirmation; with draft_id it needs G3 approval', () => {
  for (const tool of ['online_dictionary_memo_set']) {
    const pending = workspace('pending');
    assert.equal(run(CLAUDE_HOOK, { tool_name: 'mcp__plugin_strucmed_strucmed__' + tool, tool_input: { dic_id: 'D1', confirm_token: 't' }, cwd: pending }).status, 0, tool + ' standalone');
    assert.equal(run(CLAUDE_HOOK, { tool_name: 'mcp__plugin_strucmed_strucmed__' + tool, tool_input: { dic_id: 'D1', draft_id: DRAFT, confirm_token: 't' }, cwd: pending }).status, 2, tool + ' in G3 but not approved');
    assert.equal(run(CLAUDE_HOOK, { tool_name: 'mcp__plugin_strucmed_strucmed__' + tool, tool_input: { dic_id: 'D1', draft_id: DRAFT, confirm_token: 't' }, cwd: workspace('approved') }).status, 0, tool + ' in G3 approved');
  }
  // 範本與字典新建仍然一定要 draft_id
  assert.equal(run(CLAUDE_HOOK, { tool_name: 'mcp__plugin_strucmed_strucmed__online_dictionary_create', tool_input: { confirm_token: 't' }, cwd: workspace('approved') }).status, 2);
});

// 字典助手（3.7.0）：補述批次也是 DRAFT_OPTIONAL；帶 draft_id 時優先檢查 memo-plan.md（dictionary-assist 的補述計畫）
test('gate: online_dictionary_memo_batch checks memo-plan.md when present, otherwise the publish plan', () => {
  const tool = 'mcp__plugin_strucmed_strucmed__online_dictionary_memo_batch';
  const input = extra => ({ tool_name: tool, tool_input: { items: [{ dic_id: 'D1', memo: {} }], confirm_token: 't', ...extra } });
  assert.equal(run(CLAUDE_HOOK, { ...input({}), cwd: workspace('none') }).status, 0, 'standalone → browser confirmation');
  assert.equal(run(CLAUDE_HOOK, { ...input({ draft_id: DRAFT }), cwd: workspace('approved') }).status, 0, 'publish plan approved');
  // memo-plan.md 存在但未核准：即使上架計畫已核准也阻擋
  const ws = workspace('approved');
  const memoPlan = path.join(ws, '.strucmed', 'plans', DRAFT, 'memo-plan.md');
  fs.writeFileSync(memoPlan, PLAN.replace('上架計畫', '補述計畫'));
  const blocked = run(CLAUDE_HOOK, { ...input({ draft_id: DRAFT }), cwd: ws });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /memo-plan\.md/);
  assert.equal(spawnSync(process.execPath, [VERIFY, 'prepare', memoPlan, '--by', 'test']).status, 0);
  assert.equal(run(CLAUDE_HOOK, { ...input({ draft_id: DRAFT }), cwd: ws }).status, 0, 'memo plan approved');
  // Antigravity 格式也涵蓋
  assert.equal(decision(run(AGY_HOOK, agy('online_dictionary_memo_batch', { items: [], confirm_token: 't', draft_id: DRAFT }), { env: { STRUCMED_WORKSPACE: workspace('pending') } })).decision, 'deny');
});
