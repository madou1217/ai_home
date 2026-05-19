const { test } = require('node:test');
const assert = require('node:assert');
const { generateAliasId, loadAliases, saveAliases, resolveAlias } = require('../lib/server/model-alias-store');

test('model-alias-store: resolveAlias exact match', () => {
  const aliases = [
    { id: '1', alias: 'gpt-4o', target: 'gemini-1.5-pro', provider: 'codex', enabled: true }
  ];
  const result = resolveAlias(aliases, 'gpt-4o', 'codex');
  assert.deepStrictEqual(result, { target: 'gemini-1.5-pro', id: '1', provider: 'codex', targetProvider: 'auto' });
});

test('model-alias-store: resolveAlias wildcard match', () => {
  const aliases = [
    { id: '1', alias: 'claude-*', target: 'qwen-32b', provider: 'all', enabled: true }
  ];
  const result = resolveAlias(aliases, 'claude-opus-3', 'claude');
  assert.deepStrictEqual(result, { target: 'qwen-32b', id: '1', provider: 'all', targetProvider: 'auto' });
});

test('model-alias-store: resolveAlias exact match prioritizes over wildcard', () => {
  const aliases = [
    { id: '1', alias: 'claude-*', target: 'qwen-32b', provider: 'all', enabled: true },
    { id: '2', alias: 'claude-opus-3', target: 'deepseek-coder', provider: 'all', enabled: true }
  ];
  const result = resolveAlias(aliases, 'claude-opus-3', 'claude');
  assert.deepStrictEqual(result, { target: 'deepseek-coder', id: '2', provider: 'all', targetProvider: 'auto' });
});

test('model-alias-store: resolveAlias longest prefix wildcard wins', () => {
  const aliases = [
    { id: '1', alias: 'claude-*', target: 'qwen-32b', provider: 'all', enabled: true },
    { id: '2', alias: 'claude-opus-*', target: 'deepseek-coder', provider: 'all', enabled: true }
  ];
  const result = resolveAlias(aliases, 'claude-opus-3', 'claude');
  assert.deepStrictEqual(result, { target: 'deepseek-coder', id: '2', provider: 'all', targetProvider: 'auto' });
});

test('model-alias-store: resolveAlias provider isolation', () => {
  const aliases = [
    { id: '1', alias: 'gpt-4o', target: 'gemini-1.5-pro', provider: 'codex', enabled: true }
  ];
  // Provider mismatch
  const resultMiss = resolveAlias(aliases, 'gpt-4o', 'claude');
  assert.strictEqual(resultMiss, null);

  // Provider match
  const resultMatch = resolveAlias(aliases, 'gpt-4o', 'codex');
  assert.ok(resultMatch);
});

test('model-alias-store: resolveAlias disabled aliases ignored', () => {
  const aliases = [
    { id: '1', alias: 'gpt-4o', target: 'gemini-1.5-pro', provider: 'codex', enabled: false }
  ];
  const result = resolveAlias(aliases, 'gpt-4o', 'codex');
  assert.strictEqual(result, null);
});

test('model-alias-store: loadAliases handles ENOENT', async () => {
  const mockFs = {
    promises: {
      readFile: async () => {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
    }
  };
  const result = await loadAliases(mockFs, '/mock/dir');
  assert.deepStrictEqual(result, { aliases: [] });
});

test('model-alias-store: resolveAlias keeps request scope separate from target provider', () => {
  const aliases = [
    {
      id: '1',
      alias: 'gpt-5.5',
      target: 'gpt-5.5',
      provider: 'claude',
      targetProvider: 'codex',
      enabled: true
    }
  ];
  const result = resolveAlias(aliases, 'gpt-5.5', 'claude');
  assert.deepStrictEqual(result, {
    target: 'gpt-5.5',
    id: '1',
    provider: 'claude',
    targetProvider: 'codex'
  });
  assert.equal(resolveAlias(aliases, 'gpt-5.5', 'gemini'), null);
});
