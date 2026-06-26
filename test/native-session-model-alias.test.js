'use strict';

// 验证 native 路径的模型别名解析（resolveNativeAliasModel）：
// 用户在原生会话里选的【同 provider】别名必须被换成真实目标模型再交给 CLI；
// 跨 provider 别名（native 无法换号）保持原样；无匹配/读不到别名库时回退原模型。
// 这是 "claude/codex 自己 alias 在 nativesession 里成功" 的闭环回归。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveNativeAliasModel } = require('../lib/server/webui-chat-routes');
const { saveAliases } = require('../lib/server/model-alias-store');

async function makeAiHomeWithAliases(aliases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-alias-test-'));
  await saveAliases(fs, dir, { aliases });
  return dir;
}

function ctxFor(aiHomeDir) {
  return { fs, aiHomeDir };
}

test('same-provider codex alias resolves to target model', async () => {
  const aiHomeDir = await makeAiHomeWithAliases([
    { id: 'c1', alias: 'mycodex', target: 'gpt-5-codex', provider: 'codex', targetProvider: 'codex', enabled: true, priority: 0 }
  ]);
  const out = await resolveNativeAliasModel(ctxFor(aiHomeDir), 'codex', 'mycodex');
  assert.strictEqual(out, 'gpt-5-codex');
});

test('same-provider claude wildcard alias resolves to target model', async () => {
  const aiHomeDir = await makeAiHomeWithAliases([
    { id: 'c2', alias: 'fast-*', target: 'claude-haiku-4-5-20251001', provider: 'claude', targetProvider: 'claude', enabled: true, priority: 0 }
  ]);
  const out = await resolveNativeAliasModel(ctxFor(aiHomeDir), 'claude', 'fast-thing');
  assert.strictEqual(out, 'claude-haiku-4-5-20251001');
});

test('cross-provider alias (claude->agy) passes through unchanged in native', async () => {
  // native 绑定 provider+account，无法换到 agy → 必须保持原样（交由上层/用户处理），不能错塞别名目标。
  const aiHomeDir = await makeAiHomeWithAliases([
    { id: 'x1', alias: 'claude-*', target: 'gemini-3.5-flash-low', provider: 'claude', targetProvider: 'agy', enabled: true, priority: 0 }
  ]);
  const out = await resolveNativeAliasModel(ctxFor(aiHomeDir), 'claude', 'claude-opus-4-8');
  assert.strictEqual(out, 'claude-opus-4-8');
});

test('no matching alias returns the original model', async () => {
  const aiHomeDir = await makeAiHomeWithAliases([
    { id: 'n1', alias: 'other', target: 'x', provider: 'codex', targetProvider: 'codex', enabled: true, priority: 0 }
  ]);
  const out = await resolveNativeAliasModel(ctxFor(aiHomeDir), 'codex', 'gpt-5-codex');
  assert.strictEqual(out, 'gpt-5-codex');
});

test('disabled alias is ignored', async () => {
  const aiHomeDir = await makeAiHomeWithAliases([
    { id: 'd1', alias: 'mycodex', target: 'gpt-5-codex', provider: 'codex', targetProvider: 'codex', enabled: false, priority: 0 }
  ]);
  const out = await resolveNativeAliasModel(ctxFor(aiHomeDir), 'codex', 'mycodex');
  assert.strictEqual(out, 'mycodex');
});

test('empty model is returned as-is', async () => {
  const aiHomeDir = await makeAiHomeWithAliases([]);
  const out = await resolveNativeAliasModel(ctxFor(aiHomeDir), 'codex', '');
  assert.strictEqual(out, '');
});

test('unreadable alias store falls back to original model (never throws)', async () => {
  const out = await resolveNativeAliasModel(ctxFor('/nonexistent/aih-home-xyz'), 'codex', 'mycodex');
  assert.strictEqual(out, 'mycodex');
});

test('provider:all alias applies to native', async () => {
  const aiHomeDir = await makeAiHomeWithAliases([
    { id: 'a1', alias: 'universal', target: 'gpt-5-codex', provider: 'all', targetProvider: 'codex', enabled: true, priority: 0 }
  ]);
  const out = await resolveNativeAliasModel(ctxFor(aiHomeDir), 'codex', 'universal');
  assert.strictEqual(out, 'gpt-5-codex');
});
