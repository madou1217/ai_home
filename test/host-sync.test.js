const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createHostConfigSyncer } = require('../lib/account/host-sync');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  AIH_CODEX_PROVIDER_BASE_URL,
  getAihProviderKey
} = require('../lib/cli/services/pty/codex-config-sync');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-host-sync-'));
  const fixture = {
    root,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: path.join(root, 'home')
  };
  fixture.hostCodexDir = path.join(fixture.hostHomeDir, '.codex');
  fs.mkdirSync(fixture.hostCodexDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fixture;
}

function registerCodexAccount(fixture, cliAccountId, options = {}) {
  const registration = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'codex',
    cliAccountId: String(cliAccountId),
    identitySeed: `test:host-sync:codex:${cliAccountId}`
  });
  if (options.auth) {
    writeAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef, { auth: options.auth });
  }
  if (options.env) {
    writeAccountCredentials(fs, fixture.aiHomeDir, registration.accountRef, options.env);
  }
  return registration.accountRef;
}

function createCodexSyncer(fixture, options = {}) {
  return createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    ...options
  });
}

test('syncGlobalConfigToHost writes codex auth from DB as an independent global snapshot', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '1', { auth: { token: 'database' } });
  fs.writeFileSync(path.join(fixture.hostCodexDir, 'auth.json'), '{"token":"host"}\n');

  const result = createCodexSyncer(fixture, { codexVersion: '0.114.0' })('codex', accountRef);

  assert.equal(result.ok, true);
  const hostAuthPath = path.join(fixture.hostCodexDir, 'auth.json');
  assert.equal(fs.lstatSync(hostAuthPath).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(hostAuthPath, 'utf8')), { token: 'database' });
  writeAccountNativeAuth(fs, fixture.aiHomeDir, accountRef, { auth: { token: 'changed' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(hostAuthPath, 'utf8')), { token: 'database' });
  const hostConfig = fs.readFileSync(path.join(fixture.hostCodexDir, 'config.toml'), 'utf8');
  assert.match(hostConfig, /^preferred_auth_method = "oauth"$/m);
  assert.match(hostConfig, /^model_provider = "openai"$/m);
  assert.equal(fs.existsSync(path.join(fixture.hostCodexDir, 'hooks.json')), false);
});

test('syncGlobalConfigToHost replaces a host auth symlink without writing through it', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '1', { auth: { token: 'database' } });
  const legacyTarget = path.join(fixture.root, 'legacy-auth.json');
  const hostAuthPath = path.join(fixture.hostCodexDir, 'auth.json');
  fs.writeFileSync(legacyTarget, '{"token":"legacy"}\n');
  fs.symlinkSync(legacyTarget, hostAuthPath);

  const result = createCodexSyncer(fixture)('codex', accountRef);

  assert.equal(result.ok, true);
  assert.equal(fs.lstatSync(hostAuthPath).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(hostAuthPath, 'utf8')), { token: 'database' });
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyTarget, 'utf8')), { token: 'legacy' });
});

test('syncGlobalConfigToHost replaces AGY auth and email symlinks without writing through them', (t) => {
  const fixture = createFixture(t);
  const registration = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'agy',
    cliAccountId: '1',
    identitySeed: 'test:host-sync:agy:1'
  });
  writeAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef, {
    oauthToken: { token: { refresh_token: 'database-refresh' } },
    email: 'database@example.com'
  });
  const authDir = path.join(fixture.hostHomeDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(authDir, { recursive: true });
  const legacyAuthTarget = path.join(fixture.root, 'legacy-agy-auth.json');
  const legacyEmailTarget = path.join(fixture.root, 'legacy-agy-email.txt');
  const hostAuthPath = path.join(authDir, 'antigravity-oauth-token');
  const hostEmailPath = path.join(authDir, 'email.cache');
  fs.writeFileSync(legacyAuthTarget, '{"token":{"refresh_token":"legacy-refresh"}}\n');
  fs.writeFileSync(legacyEmailTarget, 'legacy@example.com');
  fs.symlinkSync(legacyAuthTarget, hostAuthPath);
  fs.symlinkSync(legacyEmailTarget, hostEmailPath);

  const sync = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini' } }
  });
  const result = sync('agy', registration.accountRef);

  assert.equal(result.ok, true);
  assert.equal(fs.lstatSync(hostAuthPath).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(hostEmailPath).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(hostAuthPath, 'utf8')), {
    token: { refresh_token: 'database-refresh' }
  });
  assert.equal(fs.readFileSync(hostEmailPath, 'utf8'), 'database@example.com');
  assert.match(fs.readFileSync(legacyAuthTarget, 'utf8'), /legacy-refresh/);
  assert.equal(fs.readFileSync(legacyEmailTarget, 'utf8'), 'legacy@example.com');
});

test('syncGlobalConfigToHost installs codex stop hook only when explicitly enabled', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '1', { auth: { token: 'database' } });

  const result = createCodexSyncer(fixture, {
    codexVersion: '0.114.0',
    enableCodexStopHook: true,
    processObj: { platform: 'linux', env: {}, pid: process.pid }
  })('codex', accountRef);

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(fixture.hostCodexDir, 'hooks.json')), true);
  assert.equal(fs.existsSync(path.join(fixture.hostCodexDir, 'hooks', 'aih-stop-notify.js')), true);
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(fixture.hostCodexDir, 'hooks.json'), 'utf8'));
  const managedHook = hooksConfig.hooks.Stop
    .flatMap((group) => Array.isArray(group && group.hooks) ? group.hooks : [])
    .find((hook) => String(hook && hook.command || '').includes('aih-stop-notify.js'));
  assert.ok(managedHook);
  assert.equal(managedHook.statusMessage, undefined);
});

test('syncGlobalConfigToHost normalizes old managed codex stop hook schema', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '1', { auth: { token: 'database' } });
  fs.mkdirSync(path.join(fixture.hostCodexDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(fixture.hostCodexDir, 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [{
        hooks: [{
          type: 'command',
          command: `/usr/bin/env node "${path.join(fixture.hostCodexDir, 'hooks', 'aih-stop-notify.js')}"`,
          timeout: 10,
          statusMessage: 'AI Home completion notification'
        }]
      }]
    }
  }, null, 2) + '\n', 'utf8');

  const result = createCodexSyncer(fixture, {
    codexVersion: '0.130.0',
    enableCodexStopHook: true,
    processObj: { platform: 'linux', env: {}, pid: process.pid }
  })('codex', accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.codexHook.reason, 'normalized_existing');
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(fixture.hostCodexDir, 'hooks.json'), 'utf8'));
  assert.equal(hooksConfig.hooks.Stop[0].hooks[0].statusMessage, undefined);
});

test('syncGlobalConfigToHost removes only its managed codex stop hook by default', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '1', { auth: { token: 'database' } });
  fs.mkdirSync(path.join(fixture.hostCodexDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(fixture.hostCodexDir, 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [{
        hooks: [
          {
            type: 'command',
            command: `/usr/bin/env node "${path.join(fixture.hostCodexDir, 'hooks', 'aih-stop-notify.js')}"`,
            timeout: 10
          },
          {
            type: 'command',
            command: '/usr/bin/env node "/tmp/keep.js"',
            timeout: 10
          }
        ]
      }]
    }
  }, null, 2) + '\n', 'utf8');

  const result = createCodexSyncer(fixture, {
    codexVersion: '0.130.0',
    processObj: { platform: 'linux', env: {}, pid: process.pid }
  })('codex', accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.codexHook.reason, 'stop_hook_disabled');
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(fixture.hostCodexDir, 'hooks.json'), 'utf8'));
  assert.deepEqual(hooksConfig.hooks.Stop[0].hooks.map((hook) => hook.command), [
    '/usr/bin/env node "/tmp/keep.js"'
  ]);
});

test('syncGlobalConfigToHost writes the canonical codex API-key provider block from DB', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '10', {
    auth: { OPENAI_API_KEY: 'upstream-metadata' },
    env: { OPENAI_API_KEY: 'dummy' }
  });

  const result = createCodexSyncer(fixture)('codex', accountRef);

  assert.equal(result.ok, true);
  const hostConfig = fs.readFileSync(path.join(fixture.hostCodexDir, 'config.toml'), 'utf8');
  const providerKey = getAihProviderKey();
  assert.match(hostConfig, /^preferred_auth_method = "apikey"$/m);
  assert.match(hostConfig, /^suppress_unstable_features_warning = true$/m);
  assert.match(hostConfig, new RegExp(`^model_provider = "${providerKey}"$`, 'm'));
  assert.match(hostConfig, new RegExp(`^\\[model_providers\\.${providerKey}\\]$`, 'm'));
  assert.match(hostConfig, new RegExp(`^base_url = "${AIH_CODEX_PROVIDER_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.match(hostConfig, /^bearer_token = "dummy"$/m);
  assert.match(hostConfig, /^hooks = true$/m);
  assert.doesNotMatch(hostConfig, /aih_10/);
});

test('syncGlobalConfigToHost switches host config to oauth mode when DB has no API key', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '20', {
    auth: { tokens: { access_token: 'oauth-access-token' } }
  });

  const result = createCodexSyncer(fixture)('codex', accountRef);

  assert.equal(result.ok, true);
  const hostConfig = fs.readFileSync(path.join(fixture.hostCodexDir, 'config.toml'), 'utf8');
  assert.match(hostConfig, /^preferred_auth_method = "oauth"$/m);
  assert.match(hostConfig, /^model_provider = "openai"$/m);
  assert.doesNotMatch(hostConfig, /^\[model_providers\.aih_20\]$/m);
});

test('syncGlobalConfigToHost keeps legacy codex hook flag for older codex versions', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '9', {
    auth: { OPENAI_API_KEY: 'upstream-metadata' },
    env: { OPENAI_API_KEY: 'dummy' }
  });

  const result = createCodexSyncer(fixture, { codexVersion: '0.113.0' })('codex', accountRef);

  assert.equal(result.ok, true);
  const hostConfig = fs.readFileSync(path.join(fixture.hostCodexDir, 'config.toml'), 'utf8');
  assert.match(hostConfig, /^codex_hooks = true$/m);
  assert.doesNotMatch(hostConfig, /^hooks\s*=/m);
});

test('syncGlobalConfigToHost replaces the single provider block without encoding CLI aliases', (t) => {
  const fixture = createFixture(t);
  const firstRef = registerCodexAccount(fixture, '10', {
    auth: { OPENAI_API_KEY: 'first-auth' },
    env: { OPENAI_API_KEY: 'dummy-10' }
  });
  const secondRef = registerCodexAccount(fixture, '11', {
    auth: { OPENAI_API_KEY: 'second-auth' },
    env: {
      OPENAI_API_KEY: 'dummy-11',
      OPENAI_BASE_URL: 'https://b.example.com/v1'
    }
  });
  const syncGlobalConfigToHost = createCodexSyncer(fixture);

  assert.equal(syncGlobalConfigToHost('codex', firstRef).ok, true);
  assert.equal(syncGlobalConfigToHost('codex', secondRef).ok, true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(fixture.hostCodexDir, 'auth.json'), 'utf8')),
    { OPENAI_API_KEY: 'second-auth' }
  );

  const hostConfig = fs.readFileSync(path.join(fixture.hostCodexDir, 'config.toml'), 'utf8');
  const providerKey = getAihProviderKey();
  const providerHeaders = hostConfig.match(new RegExp(`^\\[model_providers\\.${providerKey}\\]$`, 'gm')) || [];
  assert.equal(providerHeaders.length, 1);
  assert.match(hostConfig, new RegExp(`^model_provider = "${providerKey}"$`, 'm'));
  assert.match(hostConfig, /^base_url = "https:\/\/b\.example\.com\/v1"$/m);
  assert.match(hostConfig, /^env_key = "OPENAI_API_KEY"$/m);
  assert.doesNotMatch(hostConfig, /dummy-(10|11)/);
  assert.equal(hostConfig.includes(firstRef), false);
  assert.equal(hostConfig.includes(secondRef), false);
  assert.doesNotMatch(hostConfig, /aih_(10|11)/);
});

test('syncGlobalConfigToHost never projects host files back into an account runtime directory', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '12', { auth: { token: 'database' } });
  const runtimeCodexDir = path.join(
    fixture.aiHomeDir,
    'run',
    'accounts',
    'codex',
    accountRef,
    '.codex'
  );
  fs.mkdirSync(runtimeCodexDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeCodexDir, 'config.toml'), 'model = "account"\n');
  fs.writeFileSync(path.join(fixture.hostCodexDir, 'custom-state.json'), '{"shared":true}\n');

  const result = createCodexSyncer(fixture)('codex', accountRef);

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(runtimeCodexDir, 'custom-state.json')), false);
  assert.equal(fs.lstatSync(path.join(runtimeCodexDir, 'config.toml')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(runtimeCodexDir, 'config.toml'), 'utf8'), 'model = "account"\n');
});
