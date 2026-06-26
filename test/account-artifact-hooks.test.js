const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAccountArtifactHookService,
  createDefaultProviderArtifactHookRegistry
} = require('../lib/account/artifact-hooks');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-hooks-'));
}

test('account artifact hooks dispatch default auth updates through provider strategy', () => {
  const root = mkTmpDir();
  const profilesDir = path.join(root, 'profiles');
  const accountDir = path.join(profilesDir, 'codex', '1', '.codex');
  const events = [];
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'codex', '.aih_default'), '1', 'utf8');
  fs.writeFileSync(path.join(accountDir, 'auth.json'), '{"token":"old"}\n', 'utf8');

  const hooks = createAccountArtifactHookService({
    fs,
    path,
    profilesDir,
    getProfileDir: (provider, accountId) => path.join(profilesDir, provider, accountId),
    providerHookRegistry: createDefaultProviderArtifactHookRegistry({
      providerOptions: {
        codex: {
          onDefaultAccountAuthUpdated: (event) => events.push(event)
        }
      }
    })
  });

  const before = hooks.snapshotAccountAuthArtifacts('codex', '1');
  fs.writeFileSync(path.join(accountDir, 'auth.json'), '{"token":"new"}\n', 'utf8');
  const result = hooks.notifyDefaultAccountAuthUpdatedIfChanged({
    provider: 'codex',
    accountId: '1',
    before,
    source: 'test',
    reason: 'auth_changed'
  });

  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'default_account_auth_updated');
  assert.equal(events[0].provider, 'codex');
  assert.equal(events[0].accountId, '1');
  assert.equal(events[0].source, 'test');
  assert.equal(events[0].reason, 'auth_changed');
  assert.deepEqual(events[0].changedPaths, [path.join(accountDir, 'auth.json')]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('account artifact hooks ignore auth changes for non-default accounts', () => {
  const root = mkTmpDir();
  const profilesDir = path.join(root, 'profiles');
  const accountDir = path.join(profilesDir, 'codex', '2', '.codex');
  const events = [];
  fs.mkdirSync(accountDir, { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'codex', '.aih_default'), '1', 'utf8');
  fs.writeFileSync(path.join(accountDir, 'auth.json'), '{"token":"old"}\n', 'utf8');

  const hooks = createAccountArtifactHookService({
    fs,
    path,
    profilesDir,
    getProfileDir: (provider, accountId) => path.join(profilesDir, provider, accountId),
    providerHookRegistry: createDefaultProviderArtifactHookRegistry({
      providerOptions: {
        codex: {
          onDefaultAccountAuthUpdated: (event) => events.push(event)
        }
      }
    })
  });

  const before = hooks.snapshotAccountAuthArtifacts('codex', '2');
  fs.writeFileSync(path.join(accountDir, 'auth.json'), '{"token":"new"}\n', 'utf8');
  const result = hooks.notifyDefaultAccountAuthUpdatedIfChanged({
    provider: 'codex',
    accountId: '2',
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
  const profilesDir = path.join(root, 'profiles');
  const accountDir = path.join(profilesDir, 'codex', '7', '.codex');
  const events = [];
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(accountDir, 'config.toml'), 'model = "old"\n', 'utf8');

  const hooks = createAccountArtifactHookService({
    fs,
    path,
    profilesDir,
    getProfileDir: (provider, accountId) => path.join(profilesDir, provider, accountId),
    providerHookRegistry: createDefaultProviderArtifactHookRegistry({
      providerOptions: {
        codex: {
          onAccountConfigUpdated: (event) => events.push(event)
        }
      }
    })
  });

  const before = hooks.snapshotAccountConfigArtifacts('codex', '7');
  fs.writeFileSync(path.join(accountDir, 'config.toml'), 'model = "new"\n', 'utf8');
  const result = hooks.notifyAccountConfigUpdatedIfChanged({
    provider: 'codex',
    accountId: '7',
    before,
    source: 'test',
    reason: 'config_changed'
  });

  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'account_config_updated');
  assert.equal(events[0].provider, 'codex');
  assert.equal(events[0].accountId, '7');
  assert.deepEqual(events[0].changedPaths, [path.join(accountDir, 'config.toml')]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('default artifact hook registry routes shared auth handlers through provider strategies', () => {
  const root = mkTmpDir();
  const profilesDir = path.join(root, 'profiles');
  const events = [];
  const cases = [
    {
      provider: 'claude',
      accountId: '3',
      relativePath: path.join('.claude', '.credentials.json')
    },
    {
      provider: 'gemini',
      accountId: '4',
      relativePath: path.join('.gemini', 'oauth_creds.json')
    }
  ];

  const hooks = createAccountArtifactHookService({
    fs,
    path,
    profilesDir,
    getProfileDir: (provider, accountId) => path.join(profilesDir, provider, accountId),
    onDefaultAccountAuthUpdated: (event) => events.push(event)
  });

  cases.forEach(({ provider, accountId, relativePath }) => {
    const profileDir = path.join(profilesDir, provider, accountId);
    const authPath = path.join(profileDir, relativePath);
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.mkdirSync(path.join(profilesDir, provider), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, provider, '.aih_default'), accountId, 'utf8');
    fs.writeFileSync(authPath, '{"token":"old"}\n', 'utf8');

    const before = hooks.snapshotAccountAuthArtifacts(provider, accountId);
    fs.writeFileSync(authPath, '{"token":"new"}\n', 'utf8');
    const result = hooks.notifyDefaultAccountAuthUpdatedIfChanged({
      provider,
      accountId,
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
  const profilesDir = path.join(root, 'profiles');
  const events = [];
  const cases = [
    {
      provider: 'claude',
      accountId: '8',
      relativePath: path.join('.claude', 'settings.json')
    },
    {
      provider: 'gemini',
      accountId: '9',
      relativePath: path.join('.gemini', 'settings.json')
    }
  ];

  const hooks = createAccountArtifactHookService({
    fs,
    path,
    profilesDir,
    getProfileDir: (provider, accountId) => path.join(profilesDir, provider, accountId),
    onAccountConfigUpdated: (event) => events.push(event)
  });

  cases.forEach(({ provider, accountId, relativePath }) => {
    const profileDir = path.join(profilesDir, provider, accountId);
    const configPath = path.join(profileDir, relativePath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"theme":"old"}\n', 'utf8');

    const before = hooks.snapshotAccountConfigArtifacts(provider, accountId);
    fs.writeFileSync(configPath, '{"theme":"new"}\n', 'utf8');
    const result = hooks.notifyAccountConfigUpdatedIfChanged({
      provider,
      accountId,
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
