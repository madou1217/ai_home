'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProviderNativeCapabilityMap,
  getProviderNativeCapability,
  listProviderNativeCapabilities
} = require('../lib/cli/services/ai-cli/native-capability-registry');

test('native capability registry declares all AIH providers', () => {
  assert.deepEqual(
    listProviderNativeCapabilities().map((item) => item.provider),
    // 06d9eb6f 给 qoder/qodercn 补了 --continue/--resume/--fork-session，合同从此有 nativeBoundary。
    ['agy', 'claude', 'cline', 'codebuddy', 'codebuddycn', 'codex', 'gemini', 'grok', 'kimi', 'kiro', 'opencode', 'qoder', 'qodercn', 'workbuddy', 'workbuddycn']
  );
});

test('native capability registry exposes provider native boundaries', () => {
  const claude = getProviderNativeCapability('Claude');
  assert.equal(claude.provider, 'claude');
  assert.ok(claude.config.envHomeKeys.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(claude.mcp.configFiles.includes('.mcp.json'));
  assert.equal(claude.hooks.stopRequiresJsonStdout, true);

  const agy = getProviderNativeCapability('agy');
  assert.ok(agy.config.userSettings.includes('.gemini/antigravity-cli/settings.json'));
  assert.ok(agy.mcp.configFiles.includes('.agents/mcp_config.json'));
  assert.ok(agy.hooks.files.includes('.gemini/config/hooks.json'));
  assert.ok(agy.hooks.files.includes('.agents/hooks.json'));
  assert.ok(agy.hooks.files.includes('.gemini/antigravity-cli/plugins/*/hooks.json'));

  // cline 的会话恢复入口是 `--id <session-id>`（重启恢复用），历史在 sessions.db。
  const cline = getProviderNativeCapability('cline');
  assert.deepEqual(cline.sessions.flags, ['--id']);
  assert.equal(cline.sessions.nativeStore, 'data/db/sessions.db');
  assert.deepEqual(cline.config.envHomeKeys, ['CLINE_DIR', 'CLINE_DATA_DIR']);
});

test('native capability registry returns defensive copies', () => {
  const first = getProviderNativeCapability('codex');
  first.config.envHomeKeys.push('MUTATED');

  const second = getProviderNativeCapability('codex');
  assert.equal(second.config.envHomeKeys.includes('MUTATED'), false);
});

test('native capability registry builds provider keyed maps', () => {
  const map = buildProviderNativeCapabilityMap(['claude', 'unknown', 'agy']);

  assert.deepEqual(Object.keys(map).sort(), ['agy', 'claude']);
  assert.equal(map.claude.sessions.nativeStore, 'projects/<project>/<session-id>.jsonl');
  assert.equal(map.agy.provider, 'agy');
});
