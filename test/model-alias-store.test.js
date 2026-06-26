const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  generateAliasId,
  getModelAliasDbPath,
  loadAliases,
  saveAliases,
  resolveAlias,
  resolveAliasCandidates
} = require('../lib/server/model-alias-store');

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

test('model-alias-store: resolveAliasCandidates orders same alias by priority desc', () => {
  const aliases = [
    { id: '1', alias: 'claude-*', target: 'gemini-3.5-flash-low', provider: 'all', priority: 0, enabled: true },
    { id: '2', alias: 'claude-*', target: 'claude-opus-4-6-thinking', provider: 'all', priority: 10, enabled: true }
  ];
  const candidates = resolveAliasCandidates(aliases, 'claude-opus-4-6', 'claude');
  assert.deepStrictEqual(candidates.map((c) => c.id), ['2', '1']);
  assert.deepStrictEqual(candidates.map((c) => c.priority), [10, 0]);
  assert.deepStrictEqual(candidates.map((c) => c.matchType), ['wildcard', 'wildcard']);
  // resolveAlias 取候选首位
  assert.equal(resolveAlias(aliases, 'claude-opus-4-6', 'claude').id, '2');
});

test('model-alias-store: resolveAliasCandidates same priority keeps insertion order', () => {
  const aliases = [
    { id: '1', alias: 'gpt-4o', target: 'target-a', provider: 'all', priority: 5, enabled: true },
    { id: '2', alias: 'gpt-4o', target: 'target-b', provider: 'all', priority: 5, enabled: true }
  ];
  const candidates = resolveAliasCandidates(aliases, 'gpt-4o', 'codex');
  assert.deepStrictEqual(candidates.map((c) => c.id), ['1', '2']);
});

test('model-alias-store: resolveAliasCandidates exact group precedes wildcard group', () => {
  const aliases = [
    { id: '1', alias: 'claude-*', target: 'wildcard-target', provider: 'all', priority: 99, enabled: true },
    { id: '2', alias: 'claude-opus-3', target: 'exact-target', provider: 'all', priority: 0, enabled: true }
  ];
  const candidates = resolveAliasCandidates(aliases, 'claude-opus-3', 'claude');
  assert.deepStrictEqual(candidates.map((c) => c.id), ['2', '1']);
  assert.deepStrictEqual(candidates.map((c) => c.matchType), ['exact', 'wildcard']);
});

test('model-alias-store: resolveAliasCandidates longest wildcard prefix precedes priority', () => {
  const aliases = [
    { id: '1', alias: 'claude-*', target: 'short-prefix', provider: 'all', priority: 99, enabled: true },
    { id: '2', alias: 'claude-opus-*', target: 'long-prefix', provider: 'all', priority: 0, enabled: true }
  ];
  const candidates = resolveAliasCandidates(aliases, 'claude-opus-3', 'claude');
  assert.deepStrictEqual(candidates.map((c) => c.id), ['2', '1']);
});

test('model-alias-store: priority survives sqlite save/load and defaults to 0', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-alias-priority-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  await saveAliases(fs, aiHomeDir, {
    aliases: [
      { id: 'p10', alias: 'claude-*', target: 'a', provider: 'all', priority: 10, enabled: true },
      { id: 'p-none', alias: 'claude-*', target: 'b', provider: 'all', enabled: true }
    ]
  });

  const loaded = await loadAliases(fs, aiHomeDir);
  assert.deepStrictEqual(
    loaded.aliases.map((alias) => [alias.id, alias.priority]),
    [['p10', 10], ['p-none', 0]]
  );
});

test('model-alias-store: sqlite store remains the only truth source over stale json', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-alias-db-truth-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const firstLoad = await loadAliases(fs, aiHomeDir);
  assert.deepStrictEqual(firstLoad.aliases, []);
  assert.equal(fs.existsSync(getModelAliasDbPath(aiHomeDir)), true);

  fs.writeFileSync(path.join(aiHomeDir, 'model-aliases.json'), JSON.stringify({
    aliases: [{
      id: 'stale-json',
      alias: 'claude-*',
      target: 'gpt-5.5',
      provider: 'all',
      targetProvider: 'auto',
      enabled: true
    }]
  }), 'utf8');

  const secondLoad = await loadAliases(fs, aiHomeDir);
  assert.deepStrictEqual(secondLoad.aliases, []);
});

test('model-alias-store: saveAliases writes sqlite truth source only', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-alias-save-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  await saveAliases(fs, aiHomeDir, {
    aliases: [{
      id: 'saved-1',
      alias: 'claude-haiku-*',
      target: 'gpt-5.5',
      provider: 'all',
      targetProvider: 'auto',
      enabled: true
    }]
  });

  const loaded = await loadAliases(fs, aiHomeDir);
  assert.deepStrictEqual(loaded.aliases.map((alias) => alias.id), ['saved-1']);
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'model-aliases.json')), false);
});
