// 跨工具（Claude Code／Copilot CLI）啟動環境：未展開的 ${...}、Copilot 以 plugin 根目錄為 cwd
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from '../src/store.mjs';
import { flagsFile } from '../src/flags.mjs';

const PLUGIN_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const KEYS = ['STRUCMED_WORKSPACE', 'PWD', 'PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'STRUCMED_FLAGS'];

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

test('workspace: plugin root stays when PWD is missing or does not exist', () => {
  assert.equal(withEnv({}, PLUGIN_ROOT, workspaceRoot), PLUGIN_ROOT);
  assert.equal(withEnv({ PWD: path.join(tmp, 'nope') }, PLUGIN_ROOT, workspaceRoot), PLUGIN_ROOT);
});

test('flags: an unexpanded STRUCMED_FLAGS falls back to the bundled feature-flags.json', () => {
  const p = withEnv({ STRUCMED_FLAGS: '${CLAUDE_PLUGIN_ROOT}/feature-flags.json' }, tmp, flagsFile);
  assert.equal(p, path.join(PLUGIN_ROOT, 'feature-flags.json'));
});
