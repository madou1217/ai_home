const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAccountArtifactHookService,
  createDefaultProviderArtifactHookRegistry
} = require('../lib/account/artifact-hooks');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-hooks-'));
}

function registerRuntimeAccount(aiHomeDir, provider, cliAccountId) {
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `test:artifact-hook:${provider}:${cliAccountId}`
  }).accountRef;
  return {
    accountRef,
    runtimeDir: path.join(aiHomeDir, 'run', 'auth-projections', provider, accountRef)
  };
}

function createHooks(aiHomeDir, options = {}) {
  return createAccountArtifactHookService({
    fs,
    path,
    aiHomeDir,
    getProfileDir: (provider, accountRef) => path.join(
      aiHomeDir,
      'run',
      'auth-projections',
      provider,
      accountRef
    ),
    ...options
  });
}

test('account artifact hooks dispatch default auth updates through provider strategy', () => {
  const root = mkTmpDir();
  const account = registerRuntimeAccount(root, 'codex', '1');
  const accountDir = path.join(account.runtimeDir, '.codex');
  const events = [];
  fs.mkdirSync(accountDir, { recursive: true });
  writeDefaultAccountRef(fs, root, 'codex', account.accountRef);
  fs.writeFileSync(path.join(accountDir, 'auth.json'), '{"token":"old"}\n', 'utf8');

  const hooks = createHooks(root, {
    providerHookRegistry: createDefaultProviderArtifactHookRegistry({
      providerOptions: {
        codex: {
          onDefaultAccountAuthUpdated: (event) => events.push(event)
        }
      }
    })
  });

  const before = hooks.snapshotAccountAuthArtifacts('codex', account.accountRef);
  fs.writeFileSync(path.join(accountDir, 'auth.json'), '{"token":"new"}\n', 'utf8');
  const result = hooks.notifyDefaultAccountAuthUpdatedIfChanged({
    provider: 'codex',
    accountRef: account.accountRef,
    before,
    source: 'test',
    reason: 'auth_changed'
  });

  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'default_account_auth_updated');
  assert.equal(events[0].provider, 'codex');
  assert.equal(events[0].accountRef, account.accountRef);
  assert.equal(events[0].source, 'test');
  assert.equal(events[0].reason, 'auth_changed');
  assert.deepEqual(events[0].changedPaths, [path.join(accountDir, 'auth.json')]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('account artifact hooks ignore auth changes for non-default accounts', () => {
  const root = mkTmpDir();
  const defaultAccount = registerRuntimeAccount(root, 'codex', '1');
  const account = registerRuntimeAccount(root, 'codex', '2');
  const accountDir = path.join(account.runtimeDir, '.codex');
  const events = [];
  fs.mkdirSync(accountDir, { recursive: true });
  writeDefaultAccountRef(fs, root, 'codex', defaultAccount.accountRef);
  fs.writeFileSync(path.join(accountDir, 'auth.json'), '{"token":"old"}\n', 'utf8');

  const hooks = createHooks(root, {
    providerHookRegistry: createDefaultProviderArtifactHookRegistry({
      providerOptions: {
        codex: {
          onDefaultAccountAuthUpdated: (event) => events.push(event)
        }
      }
    })
  });

  const before = hooks.snapshotAccountAuthArtifacts('codex', account.accountRef);
  fs.writeFileSync(path.join(accountDir, 'auth.json'), '{"token":"new"}\n', 'utf8');
  const result = hooks.notifyDefaultAccountAuthUpdatedIfChanged({
    provider: 'codex',
    accountRef: account.accountRef,
    before,
    source: 'test',
    reason: 'auth_changed'
  });

  assert.equal(result.ok, true);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'not_default_account');
  assert.equal(events.length, 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('account config hooks dispatch provider-owned config updates without default gating', () => {
  const root = mkTmpDir();
  const account = registerRuntimeAccount(root, 'codex', '7');
  const accountDir = path.join(account.runtimeDir, '.codex');
  const events = [];
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(accountDir, 'config.toml'), 'model = "old"\n', 'utf8');

  const hooks = createHooks(root, {
    providerHookRegistry: createDefaultProviderArtifactHookRegistry({
      providerOptions: {
        codex: {
          onAccountConfigUpdated: (event) => events.push(event)
        }
      }
    })
  });

  const before = hooks.snapshotAccountConfigArtifacts('codex', account.accountRef);
  fs.writeFileSync(path.join(accountDir, 'config.toml'), 'model = "new"\n', 'utf8');
  const result = hooks.notifyAccountConfigUpdatedIfChanged({
    provider: 'codex',
    accountRef: account.accountRef,
    before,
    source: 'test',
    reason: 'config_changed'
  });

  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'account_config_updated');
  assert.equal(events[0].provider, 'codex');
  assert.equal(events[0].accountRef, account.accountRef);
  assert.deepEqual(events[0].changedPaths, [path.join(accountDir, 'config.toml')]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('default artifact hook registry routes shared auth handlers through provider strategies', () => {
  const root = mkTmpDir();
  const events = [];
  const cases = [
    {
      provider: 'claude',
      cliAccountId: '3',
      relativePath: path.join('.claude', '.credentials.json')
    },
    {
      provider: 'gemini',
      cliAccountId: '4',
      relativePath: path.join('.gemini', 'oauth_creds.json')
    }
  ];

  const hooks = createHooks(root, {
    onDefaultAccountAuthUpdated: (event) => events.push(event)
  });

  cases.forEach(({ provider, cliAccountId, relativePath }) => {
    const account = registerRuntimeAccount(root, provider, cliAccountId);
    const authPath = path.join(account.runtimeDir, relativePath);
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    writeDefaultAccountRef(fs, root, provider, account.accountRef);
    fs.writeFileSync(authPath, '{"token":"old"}\n', 'utf8');

    const before = hooks.snapshotAccountAuthArtifacts(provider, account.accountRef);
    fs.writeFileSync(authPath, '{"token":"new"}\n', 'utf8');
    const result = hooks.notifyDefaultAccountAuthUpdatedIfChanged({
      provider,
      accountRef: account.accountRef,
      before,
      source: 'test',
      reason: 'provider_auth_changed'
    });

    assert.equal(result.ok, true);
    assert.equal(result.dispatched, true);
  });

  assert.deepEqual(events.map((event) => event.provider), ['claude', 'gemini']);
  assert.deepEqual(events.map((event) => event.type), [
    'default_account_auth_updated',
    'default_account_auth_updated'
  ]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('account config hooks use provider-owned config artifact paths', () => {
  const root = mkTmpDir();
  const events = [];
  const cases = [
    {
      provider: 'claude',
      cliAccountId: '8',
      relativePath: path.join('.claude', 'settings.json')
    },
    {
      provider: 'gemini',
      cliAccountId: '9',
      relativePath: path.join('.gemini', 'settings.json')
    }
  ];

  const hooks = createHooks(root, {
    onAccountConfigUpdated: (event) => events.push(event)
  });

  cases.forEach(({ provider, cliAccountId, relativePath }) => {
    const account = registerRuntimeAccount(root, provider, cliAccountId);
    const configPath = path.join(account.runtimeDir, relativePath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"theme":"old"}\n', 'utf8');

    const before = hooks.snapshotAccountConfigArtifacts(provider, account.accountRef);
    fs.writeFileSync(configPath, '{"theme":"new"}\n', 'utf8');
    const result = hooks.notifyAccountConfigUpdatedIfChanged({
      provider,
      accountRef: account.accountRef,
      before,
      source: 'test',
      reason: 'provider_config_changed'
    });

    assert.equal(result.ok, true);
    assert.equal(result.dispatched, true);
    assert.deepEqual(result.event.changedPaths, [configPath]);
  });

  assert.deepEqual(events.map((event) => event.provider), ['claude', 'gemini']);
  assert.deepEqual(events.map((event) => event.type), [
    'account_config_updated',
    'account_config_updated'
  ]);

  fs.rmSync(root, { recursive: true, force: true });
});
