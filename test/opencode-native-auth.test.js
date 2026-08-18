'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readAccountNativeAuth,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { materializeProviderAuth } = require('../lib/account/native-auth-projection');
const {
  buildOpenCodeNativeAuth,
  hasUsableOpenCodeAuth,
  mergeOpenCodeNativeAuth,
  reconcileOpenCodeNativeAuth
} = require('../lib/account/opencode-native-auth');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-native-auth-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'opencode',
    cliAccountId: 1,
    identitySeed: 'api_key:opencode:key:fixture'
  });
  assert.ok(accountRef, 'fixture must register an opencode account');
  return { aiHomeDir, accountRef };
}

test('buildOpenCodeNativeAuth writes the official Zen + Go auth shape', () => {
  assert.deepEqual(buildOpenCodeNativeAuth('sk-test'), {
    auth: {
      'opencode-go': { type: 'api', key: 'sk-test' },
      opencode: { type: 'api', key: 'sk-test' }
    }
  });
  assert.equal(buildOpenCodeNativeAuth('   '), null);
});

test('mergeOpenCodeNativeAuth keeps unrelated providers intact', () => {
  const merged = mergeOpenCodeNativeAuth({
    auth: {
      openai: { type: 'api', key: 'sk-openai' },
      opencode: { type: 'api', key: 'sk-old' }
    }
  }, 'sk-new');
  assert.deepEqual(merged.auth.openai, { type: 'api', key: 'sk-openai' });
  assert.equal(merged.auth.opencode.key, 'sk-new');
  assert.equal(merged.auth['opencode-go'].key, 'sk-new');
});

test('hasUsableOpenCodeAuth only accepts a non-empty opencode key', () => {
  assert.equal(hasUsableOpenCodeAuth({ auth: { openai: { type: 'api', key: 'sk-openai' } } }), false);
  assert.equal(hasUsableOpenCodeAuth({ auth: { opencode: { type: 'api', key: '' } } }), false);
  assert.equal(hasUsableOpenCodeAuth({ auth: { 'opencode-go': { type: 'api', key: 'sk-go' } } }), true);
  assert.equal(hasUsableOpenCodeAuth(null), false);
});

test('reconcile derives native auth from an env-only api key and stays idempotent', (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  writeAccountCredentials(fs, aiHomeDir, accountRef, { OPENCODE_API_KEY: 'sk-env-key' });

  const first = reconcileOpenCodeNativeAuth({ fs, aiHomeDir, accountRef });
  assert.deepEqual(first, { ok: true, changed: true, reason: 'derived_from_env_api_key' });
  assert.equal(readAccountNativeAuth(fs, aiHomeDir, accountRef).auth['opencode-go'].key, 'sk-env-key');

  const second = reconcileOpenCodeNativeAuth({ fs, aiHomeDir, accountRef });
  assert.deepEqual(second, { ok: true, changed: false, reason: 'native_auth_present' });
});

test('reconcile never overwrites credentials captured from a native login', (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  writeAccountCredentials(fs, aiHomeDir, accountRef, { OPENCODE_API_KEY: 'sk-env-key' });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    auth: { 'opencode-go': { type: 'api', key: 'sk-native-key' } }
  });

  const result = reconcileOpenCodeNativeAuth({ fs, aiHomeDir, accountRef });
  assert.equal(result.changed, false);
  assert.equal(readAccountNativeAuth(fs, aiHomeDir, accountRef).auth['opencode-go'].key, 'sk-native-key');
});

test('reconcile reports missing credentials instead of writing an empty auth file', (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  writeAccountCredentials(fs, aiHomeDir, accountRef, { UNRELATED: 'value' });

  const result = reconcileOpenCodeNativeAuth({ fs, aiHomeDir, accountRef });
  assert.deepEqual(result, { ok: false, changed: false, reason: 'missing_credentials' });
  assert.deepEqual(readAccountNativeAuth(fs, aiHomeDir, accountRef), {});
});

test('reconciled credentials materialize into the sandbox auth.json opencode reads', (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  const runtimeDir = path.join(aiHomeDir, 'run', 'auth-projections', 'opencode', accountRef);
  writeAccountCredentials(fs, aiHomeDir, accountRef, { OPENCODE_API_KEY: 'sk-env-key' });

  const before = materializeProviderAuth(fs, runtimeDir, 'opencode', { aiHomeDir, accountRef });
  assert.equal(before.missing, true);

  reconcileOpenCodeNativeAuth({ fs, aiHomeDir, accountRef });
  const after = materializeProviderAuth(fs, runtimeDir, 'opencode', { aiHomeDir, accountRef });
  assert.equal(after.missing, false);

  const authPath = path.join(runtimeDir, '.local', 'share', 'opencode', 'auth.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), {
    'opencode-go': { type: 'api', key: 'sk-env-key' },
    opencode: { type: 'api', key: 'sk-env-key' }
  });
});
