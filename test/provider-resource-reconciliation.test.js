'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertProviderResourcesReconciled,
  reconcileProviderResources
} = require('../lib/runtime/provider-resource-reconciliation');
const { spawnNativeSessionStream } = require('../lib/server/native-session-chat');

test('provider resource reconciliation returns a complete result unchanged', () => {
  const result = { migrated: 2, linked: 3 };
  assert.equal(assertProviderResourcesReconciled(result), result);
});

test('provider resource reconciliation rejects unresolved projection entries', () => {
  assert.throws(
    () => reconcileProviderResources(
      () => ({ migrated: 1, unresolved: ['brain', 'brain', 'Library/Caches'] }),
      'agy',
      'acct_0123456789abcdef0123'
    ),
    (error) => (
      error
      && error.code === 'provider_resource_reconcile_incomplete'
      && error.provider === 'agy'
      && error.accountRef === 'acct_0123456789abcdef0123'
      && error.unresolved.join(',') === 'brain,Library/Caches'
    )
  );
});

test('provider resource reconciliation rejects a missing required reconciler', () => {
  assert.throws(
    () => reconcileProviderResources(null, 'codex', 'acct_0123456789abcdef0123'),
    (error) => error && error.code === 'provider_resource_reconcile_unavailable'
  );
});

test('native session launch stops before spawning when reconciliation is incomplete', () => {
  const accountRef = 'acct_0123456789abcdef0123';
  assert.throws(
    () => spawnNativeSessionStream({
      provider: 'agy',
      accountRef,
      projectPath: '/tmp/project',
      prompt: 'hello',
      aiHomeDir: '/Users/tester/.ai_home',
      env: { HOME: '/Users/tester' },
      getProfileDir: () => `/Users/tester/.ai_home/run/auth-projections/agy/${accountRef}`,
      ensureSessionStoreLinks: () => ({ unresolved: ['Library/Caches'] })
    }),
    (error) => error && error.code === 'provider_resource_reconcile_incomplete'
  );
});

test('Codex native session rejects incomplete reconciliation without leaving account projection garbage', (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-codex-reconcile-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  const accountRef = 'acct_0123456789abcdef0123';
  const canonicalRuntimeDir = path.join(
    aiHomeDir,
    'run',
    'auth-projections',
    'codex',
    accountRef
  );
  let transientRuntimeDir = '';

  assert.throws(
    () => spawnNativeSessionStream({
      provider: 'codex',
      accountRef,
      projectPath: hostHomeDir,
      prompt: 'hello',
      aiHomeDir,
      env: { HOME: hostHomeDir },
      getProfileDir: () => canonicalRuntimeDir,
      ensureSessionStoreLinks: (_provider, _accountRef, options = {}) => {
        transientRuntimeDir = String(options.projectionRoot || '');
        return { unresolved: ['sessions'] };
      }
    }),
    (error) => error && error.code === 'provider_resource_reconcile_incomplete'
  );

  assert.notEqual(transientRuntimeDir, canonicalRuntimeDir);
  assert.equal(fs.existsSync(transientRuntimeDir), false);
  assert.equal(fs.existsSync(canonicalRuntimeDir), false);
});
