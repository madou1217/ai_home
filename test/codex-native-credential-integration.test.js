'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { resolveNativeAuthIdentitySeed } = require('../lib/account/account-identity');
const store = require('../lib/server/account-credential-store');
const { insertAccountNativeAuthIfMissing } = require('../lib/server/account-credential-store-insert');
const { createCodexNativeCredentialSync } = require('../lib/account/codex-native-credential-sync');
const { createHostConfigSyncer } = require('../lib/account/host-sync');
const { createTokenRefreshDaemon } = require('../lib/server/token-refresh-daemon');
const { refreshCodexAccessToken } = require('../lib/server/codex-token-refresh');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');
const { writeDefaultAccountRef, readDefaultAccountRef } = require('../lib/account/default-account-store');
const { prepareCodexAppServerRuntimeHome } = require('../lib/server/codex-app-server-stdio-proxy-runtime');

const TEST_NOW_SECONDS = Math.floor(Date.now() / 1000);
const jwt = value => `test.${Buffer.from(JSON.stringify(value)).toString('base64url')}.not-a-real-signature`;
function auth(generation, email = 'native@example.invalid') {
  const now = TEST_NOW_SECONDS;
  const iat = now - 3600 + generation * 600;
  return { auth_mode: 'chatgpt', last_refresh: new Date(iat * 1000).toISOString(), tokens: {
    access_token: jwt({ iat, exp: now + 7200, 'https://api.openai.com/profile': { email },
      'https://api.openai.com/auth': { chatgpt_account_id: 'test-workspace' } }),
    id_token: jwt({ email }), refresh_token: `test-refresh-${generation}-${email}`, account_id: 'test-workspace'
  } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-integration-'));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  const codexHome = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function register(value, extra = {}) {
    const identity = resolveNativeAuthIdentitySeed('codex', { auth: value });
    const registration = registerAccountIdentity(fs, aiHomeDir, { provider: 'codex', identitySeed: identity.identitySeed });
    store.writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, { ...extra, auth: value });
    return registration.accountRef;
  }
  function write(value, file = path.join(codexHome, 'auth.json')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  }
  const sync = () => createCodexNativeCredentialSync({ fs, aiHomeDir, hostHomeDir });
  const hostSync = () => createHostConfigSyncer({ fs, fse: { copySync: (a, b) => fs.copyFileSync(a, b) },
    ensureDir: dir => fs.mkdirSync(dir, { recursive: true }), aiHomeDir, hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } }, codexVersion: '0.154.0',
    processObj: { platform: 'linux', env: {}, pid: process.pid, execPath: process.execPath } });
  return { root, aiHomeDir, hostHomeDir, codexHome, register, write, sync, hostSync };
}

test('actual SQLite adopts a newer native generation, preserving metadata and default identity', t => {
  const f = fixture(t), old = auth(1), fresh = auth(2);
  const ref = f.register(old, { preserve: 'metadata' });
  writeDefaultAccountRef(fs, f.aiHomeDir, 'codex', ref);
  const before = store.readAccountCredentialRecord(fs, f.aiHomeDir, ref);
  f.write(fresh);
  const result = f.sync().scan();
  assert.equal(result.updated.length, 1);
  const after = store.readAccountCredentialRecord(fs, f.aiHomeDir, ref);
  assert.deepEqual(after.nativeAuth.auth, fresh);
  assert.equal(after.nativeAuth.preserve, 'metadata');
  assert.ok(after.nativeAuthUpdatedAt > before.nativeAuthUpdatedAt);
  assert.equal(readDefaultAccountRef(fs, f.aiHomeDir, 'codex'), ref);
  assert.equal(f.sync().scan().updated.length, 0);
  assert.equal(store.readAccountCredentialRecord(fs, f.aiHomeDir, ref).nativeAuthUpdatedAt, after.nativeAuthUpdatedAt);
});

test('independent new identity uses canonical registration and does not replace the old default', t => {
  const f = fixture(t), ref = f.register(auth(1));
  writeDefaultAccountRef(fs, f.aiHomeDir, 'codex', ref);
  const fresh = auth(2, 'other@example.invalid'); f.write(fresh);
  const result = f.sync().scan();
  assert.equal(result.updated[0].created, true);
  assert.notEqual(result.updated[0].accountRef, ref);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, result.updated[0].accountRef).auth, fresh);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth, auth(1));
  assert.equal(readDefaultAccountRef(fs, f.aiHomeDir, 'codex'), ref);
});

test('initial insertion never overwrites a credential published after registration', t => {
  const f = fixture(t), value = auth(2), ref = f.register(value);
  assert.equal(insertAccountNativeAuthIfMissing(fs, f.aiHomeDir, ref, { auth: auth(1) }), false);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth, value);
});

test('actual CAS rejects a stale DB snapshot after an independent adoption', t => {
  const f = fixture(t), ref = f.register(auth(1)), fresh = auth(2);
  const before = store.readAccountCredentialRecord(fs, f.aiHomeDir, ref);
  f.write(fresh); f.sync().scan();
  assert.equal(store.compareAndSwapAccountNativeAuth(fs, f.aiHomeDir, ref, before, { auth: auth(1) }), false);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth, fresh);
});

test('set-default preflight adopts fresh host OAuth before forward projection', t => {
  const f = fixture(t), ref = f.register(auth(1)), fresh = auth(2); f.write(fresh);
  const result = f.hostSync()('codex', ref);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'))), fresh);
  const config = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  assert.match(config, /^model_provider = "openai"$/m);
  assert.doesNotMatch(config, /model_providers\.aih_server/);
});

test('automatic projection cannot replace a different independent native login', t => {
  const f = fixture(t), ref = f.register(auth(1)), fresh = auth(2, 'other@example.invalid');
  f.write(fresh);
  const result = f.hostSync()('codex', ref, { preserveNativeLogin: true });
  assert.equal(result.reason, 'native_login_preserved');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'))), fresh);
  assert.equal(store.listAccountCredentialRecords(fs, f.aiHomeDir, 'codex').length, 2);
});

test('automatic projection respects a native logout, explicit set-default remains possible', t => {
  const f = fixture(t), old = auth(1), ref = f.register(old);
  assert.equal(f.hostSync()('codex', ref, { preserveNativeLogin: true }).reason, 'native_login_unavailable');
  assert.equal(fs.existsSync(path.join(f.codexHome, 'auth.json')), false);
  assert.equal(f.hostSync()('codex', ref).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'))), old);
});

test('managed runtime preflight captures its fresh login before recreating the projection', t => {
  const f = fixture(t), ref = f.register(auth(1)), fresh = auth(2);
  const runtimeFile = path.join(f.aiHomeDir, 'run', 'codex-desktop', ref, 'auth.json');
  f.write(fresh, runtimeFile);
  const runtime = prepareCodexAppServerRuntimeHome(fs, { desktopAccountRef: ref }, { processObj: {
    platform: 'linux', env: { HOME: f.hostHomeDir, AIH_HOST_HOME: f.hostHomeDir, AI_HOME_DIR: f.aiHomeDir,
      CODEX_HOME: f.codexHome, CODEX_SQLITE_HOME: f.codexHome }
  } });
  assert.ok(runtime);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtimeFile)), fresh);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth, fresh);
});

for (const status of ['success', 'rejected', 'network_error']) {
  test(`late OAuth refresh ${status} cannot replace or invalidate a newer App login`, async t => {
    const f = fixture(t), old = auth(1), fresh = auth(2), ref = f.register(old);
    const account = { provider: 'codex', accountRef: ref, accessToken: old.tokens.access_token,
      refreshToken: old.tokens.refresh_token, upstreamAccountId: 'test-workspace' };
    let callbacks = 0;
    const result = await refreshCodexAccessToken(account, { force: true }, {
      fs, aiHomeDir: f.aiHomeDir,
      resolveAccountEgressRequestOptions: async input => ({ ok: true, options: input.options }),
      fetchWithTimeout: async () => {
        f.write(fresh); assert.equal(f.sync().scan().updated.length, 1);
        if (status === 'network_error') throw new Error('test-network-error');
        return { ok: status === 'success', status: status === 'success' ? 200 : 401,
          text: async () => JSON.stringify({ access_token: 'test-late-access', refresh_token: 'test-late-refresh' }) };
      },
      accountArtifactHooks: { notifyDefaultAccountAuthUpdated: () => { callbacks += 1; } },
      invalidateCodexAppServerEndpoint: () => { callbacks += 1; }
    });
    assert.equal(result.ok, true); assert.equal(result.reason, 'superseded_by_new_credentials');
    assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth, fresh);
    assert.equal(account.accessToken, fresh.tokens.access_token);
    assert.equal(callbacks, 0);
  });
}

test('a changed snapshot while resolving egress cancels the stale refresh before network I/O', async t => {
  const f = fixture(t), old = auth(1), fresh = auth(2), ref = f.register(old);
  const result = await refreshCodexAccessToken({ provider: 'codex', accountRef: ref,
    accessToken: old.tokens.access_token, refreshToken: old.tokens.refresh_token }, { force: true }, {
    fs, aiHomeDir: f.aiHomeDir,
    resolveAccountEgressRequestOptions: async input => { f.write(fresh); f.sync().scan(); return { ok: true, options: input.options }; },
    fetchWithTimeout: async () => assert.fail('stale grant must not be submitted')
  });
  assert.equal(result.reason, 'superseded_by_new_credentials');
});

test('live native observer updates the actual DB and pool without restart or an AIH-launched App', async t => {
  const f = fixture(t), ref = f.register(auth(1));
  const state = { accounts: {} }; let reloads = 0;
  const daemon = createTokenRefreshDaemon(state, { nativeCredentialSyncIntervalMs: 1000 }, {
    fs, aiHomeDir: f.aiHomeDir, hostHomeDir: f.hostHomeDir,
    reloadRuntimePool() {
      reloads += 1;
      state.accounts.codex = store.listAccountCredentialRecords(fs, f.aiHomeDir, 'codex').map(record => ({
        provider: 'codex', accountRef: record.accountRef, accessToken: record.nativeAuth.auth.tokens.access_token,
        refreshToken: record.nativeAuth.auth.tokens.refresh_token
      }));
    },
    fetchWithTimeout: async () => assert.fail('new native credentials are not due for rotation')
  });
  t.after(() => daemon.stop());
  const fresh = auth(2); f.write(fresh);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth.tokens.refresh_token !== fresh.tokens.refresh_token) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state.accounts.codex[0].accessToken, fresh.tokens.access_token);
  assert.ok(reloads >= 2);
  daemon.stop();
  const next = auth(3); f.write(next);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth.tokens.refresh_token, fresh.tokens.refresh_token);
});

test('clearing old credential failure preserves model and other account cooldowns', t => {
  const f = fixture(t), ref = f.register(auth(1)), now = Date.now();
  const index = createAccountStateIndex({ fs, aiHomeDir: f.aiHomeDir });
  const service = createAccountStateService({ fs, accountStateIndex: index });
  index.upsertRuntimeState(ref, 'codex', { authInvalidUntil: now + 100000,
    cooldownUntil: now + 100000, rateLimitUntil: now + 50000, networkUntil: now + 30000,
    lastFailureKind: 'auth_invalid', lastFailureAt: now - 1000, lastError: 'test-old-auth-failure',
    modelCooldowns: { 'test-model': now + 200000 } }, { configured: true, status: 'up', apiKeyMode: false });
  assert.equal(service.clearRuntimeBlock(ref, 'codex', { evidence: 'credential_update_after_failure' }), true);
  const runtime = service.getAccountState(ref).runtimeState;
  assert.equal(runtime.authInvalidUntil, 0);
  assert.equal(runtime.rateLimitUntil, now + 50000);
  assert.equal(runtime.networkUntil, now + 30000);
  assert.equal(runtime.modelCooldowns['test-model'], now + 200000);
});

test('metadata changes during OAuth refresh are merged without losing a rotated grant', async t => {
  const f = fixture(t), old = auth(1), ref = f.register(old, { meta: 'before' });
  const result = await refreshCodexAccessToken({ provider: 'codex', accountRef: ref,
    accessToken: old.tokens.access_token, refreshToken: old.tokens.refresh_token }, { force: true }, {
    fs, aiHomeDir: f.aiHomeDir,
    resolveAccountEgressRequestOptions: async input => ({ ok: true, options: input.options }),
    fetchWithTimeout: async () => {
      store.writeAccountNativeAuth(fs, f.aiHomeDir, ref, { auth: old, meta: 'concurrent' });
      return { ok: true, text: async () => JSON.stringify({ access_token: 'test-renewed', refresh_token: 'test-renewed-grant', expires_in: 3600 }) };
    },
    invalidateCodexAppServerEndpoint: () => ({ invalidated: false })
  });
  assert.equal(result.persisted, true);
  const saved = store.readAccountNativeAuth(fs, f.aiHomeDir, ref);
  assert.equal(saved.meta, 'concurrent');
  assert.equal(saved.auth.tokens.refresh_token, 'test-renewed-grant');
});


for (const provider of ['claude', 'grok']) {
  test(`Codex credential recovery does not change ${provider} runtime cleanup`, t => {
    const f = fixture(t);
    const ref = registerAccountIdentity(fs, f.aiHomeDir, {
      provider, identitySeed: `test-native-recovery-scope:${provider}`
    }).accountRef;
    const index = createAccountStateIndex({ fs, aiHomeDir: f.aiHomeDir });
    const service = createAccountStateService({ fs, accountStateIndex: index });
    index.upsertRuntimeState(ref, provider, {
      authInvalidUntil: Date.now() + 100000, lastFailureKind: 'auth_invalid',
      lastFailureAt: Date.now() - 1000, lastError: 'test-auth-rejection'
    }, { configured: true, status: 'up', apiKeyMode: false });
    assert.equal(service.clearRuntimeBlock(ref, provider, {
      evidence: 'credential_update_after_failure'
    }), true);
    assert.equal(service.getAccountState(ref).runtimeState, null);
  });
}


test('independent native files cannot resurrect a manually deleted account across observer restarts', t => {
  const f = fixture(t), old = auth(1), ref = f.register(old);
  f.write(auth(2));
  assert.equal(f.sync().scan().updated.length, 1);
  const { deleteAccountRef, resolveAccountRef } = require('../lib/server/account-ref-store');
  assert.equal(deleteAccountRef(fs, f.aiHomeDir, ref), true);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = f.sync().scan();
    assert.equal(result.updated.length, 0);
    assert.ok(result.skipped.some(item => item.reason === 'account_deleted_by_user'));
    assert.equal(resolveAccountRef(fs, f.aiHomeDir, ref), null);
  }
  f.register(old); // Explicit re-add is a new user decision, unlike observation.
  assert.equal(f.sync().scan().updated.length, 1);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth, auth(2));
});


test('managed projection preserves a different native grant when generation clocks cannot order it', t => {
  const f = fixture(t), old = auth(1), ref = f.register(old), candidate = auth(1);
  candidate.tokens.refresh_token = 'test-unordered-new-native-refresh';
  const runtimeFile = path.join(f.aiHomeDir, 'run', 'codex-desktop', ref, 'auth.json');
  f.write(candidate, runtimeFile);
  const runtime = prepareCodexAppServerRuntimeHome(fs, { desktopAccountRef: ref }, { processObj: {
    platform: 'linux', env: { HOME: f.hostHomeDir, AIH_HOST_HOME: f.hostHomeDir, AI_HOME_DIR: f.aiHomeDir,
      CODEX_HOME: f.codexHome, CODEX_SQLITE_HOME: f.codexHome }
  } });
  assert.equal(runtime, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtimeFile)), candidate);
  assert.deepEqual(store.readAccountNativeAuth(fs, f.aiHomeDir, ref).auth, old);
});
