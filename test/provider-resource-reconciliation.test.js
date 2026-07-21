'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
