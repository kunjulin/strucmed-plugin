// 跨工具（Claude Code／Copilot CLI／Codex）啟動環境：未展開的 ${...}、Copilot 與 Codex 以 plugin 根目錄為 cwd
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from '../src/store.mjs';
import { flagsFile } from '../src/flags.mjs';

const PLUGIN_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const KEYS = ['STRUCMED_WORKSPACE', 'PWD', 'PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'STRUCMED_FLAGS', 'HOME', 'USERPROFILE'];

function withEnv(env, cwd, fn) {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const savedCwd = process.cwd();
  try {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    process.chdir(cwd);
    return fn();
  } finally {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-host-')));

test('workspace: STRUCMED_WORKSPACE wins; an unexpanded placeholder is ignored', () => {
  assert.equal(withEnv({ STRUCMED_WORKSPACE: tmp }, PLUGIN_ROOT, workspaceRoot), tmp);
  assert.equal(withEnv({ STRUCMED_WORKSPACE: '${user_config.workspace}' }, tmp, workspaceRoot), tmp);
});

test('workspace: cwd = plugin root (Copilot CLI) falls back to PWD', () => {
  assert.equal(withEnv({ PWD: tmp, PLUGIN_ROOT }, PLUGIN_ROOT, workspaceRoot), tmp);
  assert.equal(withEnv({ PWD: tmp }, PLUGIN_ROOT, workspaceRoot), tmp);
});

test('workspace: ordinary cwd is kept even when PWD differs (Claude Code)', () => {
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-other-')));
  assert.equal(withEnv({ PWD: other, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }, tmp, workspaceRoot), tmp);
});

test('workspace: never the plugin root; without a usable PWD (Codex app, Windows) use ~/Documents/StrucMed', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'strucmed-home-')));
  const env = { HOME: home, USERPROFILE: home };
  assert.equal(withEnv(env, PLUGIN_ROOT, workspaceRoot), path.join(home, 'StrucMed'), '沒有 Documents 時用家目錄');
  fs.mkdirSync(path.join(home, 'Documents'));
  const want = path.join(home, 'Documents', 'StrucMed');
  assert.equal(withEnv(env, PLUGIN_ROOT, workspaceRoot), want, '沒有 PWD');
  assert.equal(withEnv({ ...env, PWD: path.join(tmp, 'nope') }, PLUGIN_ROOT, workspaceRoot), want, 'PWD 不存在');
  assert.equal(withEnv({ ...env, PWD: PLUGIN_ROOT }, PLUGIN_ROOT, workspaceRoot), want, 'PWD 就是 plugin 目錄');
  assert.equal(withEnv({ ...env, PWD: path.parse(tmp).root }, PLUGIN_ROOT, workspaceRoot), want, 'PWD 是磁碟根目錄（從 Finder／Dock 啟動）');
});

test('flags: an unexpanded STRUCMED_FLAGS falls back to the bundled feature-flags.json', () => {
  const p = withEnv({ STRUCMED_FLAGS: '${CLAUDE_PLUGIN_ROOT}/feature-flags.json' }, tmp, flagsFile);
  assert.equal(p, path.join(PLUGIN_ROOT, 'feature-flags.json'));
});

test('codex manifest: same plugin as .claude-plugin, paths resolve from the plugin root', () => {
  const read = p => JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, p), 'utf8'));
  const claude = read('.claude-plugin/plugin.json'), codex = read('.codex-plugin/plugin.json');
  assert.equal(codex.name, claude.name);
  assert.equal(codex.version, claude.version, '兩份 manifest 的版本要一起改');
  // Codex 的 manifest 路徑必須以 ./ 開頭且在 plugin 根目錄內，且不展開 ${...}
  for (const p of [codex.skills, codex.hooks]) {
    assert.match(p, /^\.\/[^.]/);
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, p)), p);
  }
  const mcp = codex.mcpServers.strucmed;
  assert.equal(mcp.cwd, '.', 'cwd＝plugin 根目錄，args 才能用相對路徑');
  assert.ok(!JSON.stringify(mcp).includes('${'), 'Codex 不展開 ${...}');
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, mcp.args[0])), mcp.args[0]);
  assert.deepEqual(claude.mcpServers.strucmed.args.map(a => a.replace('${CLAUDE_PLUGIN_ROOT}/', './')), mcp.args);
  for (const k of ['PWD', 'STRUCMED_WORKSPACE', 'LLMGW_API_KEY', 'FMAPI_API_KEY', 'STRUCMED_EXTERNAL_URL', 'STRUCMED_RUNTIME_WEB']) assert.ok(mcp.env_vars.includes(k), k);
  assert.ok(mcp.tool_timeout_sec > 120, 'online_login 預設最多等 120 秒');
});
