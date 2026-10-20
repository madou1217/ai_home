'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveHarnessLaunchModel,
  rewriteModelFlagInArgs
} = require('../lib/harness/alias');
const { saveAliases } = require('../lib/server/model-alias-store');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function seedAliases(aiHomeDir, aliases) {
  await saveAliases(fs, aiHomeDir, { aliases });
}

test('harness alias: exact alias resolves to the real model', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-harness-alias-');
  await seedAliases(aiHomeDir, [{
    id: 'a1',
    alias: 'fast',
    target: 'gpt-5.6-luna',
    provider: 'codex',
    targetProvider: 'codex',
    enabled: true
  }]);
  const result = resolveHarnessLaunchModel({
    fs,
    aiHomeDir,
    provider: 'codex',
    model: 'fast'
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(result.requested, 'fast');
  assert.equal(result.alias.alias, 'fast');
});

test('harness alias: wildcard alias matches provider scope', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-harness-alias-wild-');
  await seedAliases(aiHomeDir, [{
    id: 'a1',
    alias: 'gpt-*',
    target: 'gpt-5.6-luna',
    provider: 'all',
    targetProvider: 'auto',
    enabled: true
  }]);
  const result = resolveHarnessLaunchModel({
    fs,
    aiHomeDir,
    provider: 'codex',
    model: 'gpt-anything'
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-5.6-luna');
});

test('harness alias: disabled aliases are ignored', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-harness-alias-off-');
  await seedAliases(aiHomeDir, [{
    id: 'a1',
    alias: 'fast',
    target: 'gpt-5.6-luna',
    provider: 'codex',
    enabled: false
  }]);
  const result = resolveHarnessLaunchModel({
    fs,
    aiHomeDir,
    provider: 'codex',
    model: 'fast'
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'fast');
  assert.equal(result.alias, null);
});

test('harness alias: explicit target provider must match the pinned account provider', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-harness-alias-mismatch-');
  await seedAliases(aiHomeDir, [{
    id: 'a1',
    alias: 'fast',
    target: 'claude-sonnet-4-5',
    provider: 'all',
    targetProvider: 'claude',
    enabled: true
  }]);
  const result = resolveHarnessLaunchModel({
    fs,
    aiHomeDir,
    provider: 'codex',
    model: 'fast'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'model_alias_target_provider_mismatch');
  assert.equal(result.model, '');
});

test('harness alias: non-alias model passes through unchanged', async (t) => {
  const aiHomeDir = tempDir(t, 'aih-harness-alias-pass-');
  await seedAliases(aiHomeDir, [{
    id: 'a1',
    alias: 'fast',
    target: 'gpt-5.6-luna',
    provider: 'codex',
    enabled: true
  }]);
  const result = resolveHarnessLaunchModel({
    fs,
    aiHomeDir,
    provider: 'codex',
    model: 'gpt-5.6-luna'
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(result.alias, null);
});

test('harness alias: empty request or provider never touches the alias table', () => {
  const result = resolveHarnessLaunchModel({ fs, aiHomeDir: '/does/not/exist', provider: '', model: 'fast' });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'fast');
  const noModel = resolveHarnessLaunchModel({ fs, aiHomeDir: '/does/not/exist', provider: 'codex', model: '' });
  assert.equal(noModel.ok, true);
  assert.equal(noModel.model, '');
});

test('harness alias: lookup failure is reported instead of silently passing through', () => {
  const brokenFs = {
    ...fs,
    existsSync() {
      return true;
    },
    mkdirSync() {
      throw new Error('permission denied');
    }
  };
  const result = resolveHarnessLaunchModel({
    fs: brokenFs,
    aiHomeDir: '/tmp/aih-harness-alias-broken',
    provider: 'codex',
    model: 'fast'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'model_alias_lookup_failed');
  assert.match(result.message, /permission denied/);
});

test('harness alias: a missing alias database is not a lookup failure', (t) => {
  const aiHomeDir = tempDir(t, 'aih-harness-alias-absent-');
  const result = resolveHarnessLaunchModel({
    fs,
    aiHomeDir,
    provider: 'codex',
    model: 'fast'
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'fast');
  assert.equal(result.alias, null);
});

test('harness alias: rewriteModelFlagInArgs leaves escaped native arguments untouched', () => {
  const resolveModel = (value) => (value === 'fast' ? 'gpt-5.6-luna' : value);
  assert.deepEqual(
    rewriteModelFlagInArgs(['--model', 'fast', '--verbose'], resolveModel),
    ['--model', 'gpt-5.6-luna', '--verbose']
  );
  assert.deepEqual(
    rewriteModelFlagInArgs(['--model=fast'], resolveModel),
    ['--model=gpt-5.6-luna']
  );
  assert.deepEqual(
    rewriteModelFlagInArgs(['--', '--model', 'fast'], resolveModel),
    ['--', '--model', 'fast']
  );
  assert.deepEqual(
    rewriteModelFlagInArgs(['--model'], resolveModel),
    ['--model']
  );
});
