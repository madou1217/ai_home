const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { parse: parseJsonc } = require('jsonc-parser');
const { parse: parseToml } = require('smol-toml');
const { createHostConfigSyncer } = require('../lib/account/host-sync');
const { writeServerConfig } = require('../lib/server/server-config-store');
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

function registerClaudeAccount(fixture, cliAccountId, credentials) {
  const registration = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'claude',
    cliAccountId: String(cliAccountId),
    identitySeed: `test:host-sync:claude:${cliAccountId}`
  });
  writeAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef, { credentials });
  return registration.accountRef;
}

function createClaudeSyncer(fixture, options = {}) {
  return createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    cliConfigs: { claude: { globalDir: '.claude' } },
    ...options
  });
}

function createGatewaySyncer(fixture, provider) {
  return createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    cliConfigs: { [provider]: { globalDir: provider === 'opencode' ? '.config/opencode' : '.kimi-code' } }
  });
}

test('syncGlobalConfigToHost selects AIH Server in OpenCode without losing preferences', (t) => {
  const fixture = createFixture(t);
  const configPath = path.join(fixture.hostHomeDir, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ theme: 'system', provider: { other: { name: 'Other' } } }));
  writeServerConfig({ apiKey: 'gateway-key', port: 9544 }, { fs, aiHomeDir: fixture.aiHomeDir });

  const result = createGatewaySyncer(fixture, 'opencode')('opencode', '', { gateway: true });

  assert.equal(result.ok, true);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.$schema, 'https://opencode.ai/config.json');
  assert.equal(config.theme, 'system');
  assert.deepEqual(config.provider.other, { name: 'Other' });
  assert.equal(config.provider.aih.options.baseURL, 'http://127.0.0.1:9544/v1');
  assert.equal(config.provider.aih.options.apiKey, 'gateway-key');
  assert.ok(config.provider.aih.models[config.model.slice('aih/'.length)]);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('syncGlobalConfigToHost preserves OpenCode JSONC comments and restores its original content', (t) => {
  const fixture = createFixture(t);
  const dir = path.join(fixture.hostHomeDir, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const jsoncPath = path.join(dir, 'opencode.jsonc');
  const original = '{ // preserve\n "theme": "system", "model": "anthropic/old"\n}\n';
  fs.writeFileSync(jsoncPath, original);
  const sync = createGatewaySyncer(fixture, 'opencode');

  const result = sync('opencode', '', { gateway: true });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'opencode.json')), false);
  const generated = fs.readFileSync(jsoncPath, 'utf8');
  assert.match(generated, /\/\/ preserve/);
  assert.equal(parseJsonc(generated).$schema, 'https://opencode.ai/config.json');
  assert.equal(parseJsonc(generated).theme, 'system');
  assert.match(parseJsonc(generated).model, /^aih\//);
  assert.ok(parseJsonc(generated).provider.aih);
  fs.appendFileSync(jsoncPath, '// external edit\n');
  assert.equal(sync('opencode', '', { restoreGateway: true }).ok, false);
  fs.writeFileSync(jsoncPath, generated);
  assert.equal(sync('opencode', '', { restoreGateway: true }).ok, true);
  assert.equal(fs.readFileSync(jsoncPath, 'utf8'), original);
});

test('syncGlobalConfigToHost preserves a custom OpenCode schema', (t) => {
  const fixture = createFixture(t);
  const configPath = path.join(fixture.hostHomeDir, '.config', 'opencode', 'opencode.jsonc');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, '{"$schema":"https://example.invalid/custom-schema.json"}\n');

  const result = createGatewaySyncer(fixture, 'opencode')('opencode', '', { gateway: true });

  assert.equal(result.ok, true);
  assert.equal(parseJsonc(fs.readFileSync(configPath, 'utf8')).$schema,
    'https://example.invalid/custom-schema.json');
});

test('switching from AIH Server to an OpenCode account restores its previous host config', (t) => {
  const fixture = createFixture(t);
  const configPath = path.join(fixture.hostHomeDir, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const original = '{"theme":"system"}\n';
  fs.writeFileSync(configPath, original);
  const registration = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'opencode', cliAccountId: '1', identitySeed: 'test:host-sync:opencode:1'
  });
  writeAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef, {
    auth: { anthropic: { type: 'api', key: 'account-key' } }
  });
  const sync = createGatewaySyncer(fixture, 'opencode');

  assert.equal(sync('opencode', '', { gateway: true }).ok, true);
  const result = sync('opencode', registration.accountRef, { restoreGateway: true });

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.hostHomeDir, '.local', 'share', 'opencode', 'auth.json'), 'utf8')),
    { anthropic: { type: 'api', key: 'account-key' } });
});

test('a changed OpenCode gateway config blocks account projection before writing credentials', (t) => {
  const fixture = createFixture(t);
  const configPath = path.join(fixture.hostHomeDir, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, '{"theme":"system"}\n');
  const registration = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'opencode', cliAccountId: '1', identitySeed: 'test:host-sync:opencode:conflict'
  });
  writeAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef, {
    auth: { anthropic: { type: 'api', key: 'account-key' } }
  });
  const sync = createGatewaySyncer(fixture, 'opencode');
  assert.equal(sync('opencode', '', { gateway: true }).ok, true);
  fs.appendFileSync(configPath, '\n "external": true\n');

  const result = sync('opencode', registration.accountRef, { restoreGateway: true });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gateway_default_restore_failed');
  assert.equal(fs.existsSync(path.join(fixture.hostHomeDir, '.local', 'share', 'opencode', 'auth.json')), false);
});

test('a gateway state journal with the original config still present can be restored', (t) => {
  const fixture = createFixture(t);
  const configPath = path.join(fixture.hostHomeDir, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const original = '{"theme":"system"}\n';
  fs.writeFileSync(configPath, original);
  const sync = createGatewaySyncer(fixture, 'opencode');
  assert.equal(sync('opencode', '', { gateway: true }).ok, true);
  fs.writeFileSync(configPath, original);

  assert.equal(sync('opencode', '', { restoreGateway: true }).ok, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('syncGlobalConfigToHost selects AIH Server in Kimi and preserves other sections on resync', (t) => {
  const fixture = createFixture(t);
  const configPath = path.join(fixture.hostHomeDir, '.kimi-code', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'default_model = "custom/model"\n\n[thinking]\nenabled = false\n');
  writeServerConfig({ apiKey: 'gateway-key', port: 9545 }, { fs, aiHomeDir: fixture.aiHomeDir });
  const sync = createGatewaySyncer(fixture, 'kimi');

  assert.equal(sync('kimi', '', { gateway: true }).ok, true);
  assert.equal(sync('kimi', '', { gateway: true }).ok, true);

  const content = fs.readFileSync(configPath, 'utf8');
  const config = parseToml(content);
  assert.equal(config.default_model, 'aih-server/kimi-for-coding');
  assert.deepEqual(config.thinking, { enabled: false });
  assert.equal(config.providers['aih-server'].base_url, 'http://127.0.0.1:9545/v1');
  assert.equal(config.providers['aih-server'].api_key, 'gateway-key');
  assert.equal(config.models['aih-server/kimi-for-coding'].model, 'kimi-for-coding');
  assert.equal(content.match(/\[providers\."aih-server"\]/g).length, 1);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

for (const [provider, globalDir, fileName, original] of [
  ['claude', '.claude', 'settings.json', '{"env":{"CUSTOM_SETTING":"keep"}}\n'],
  ['opencode', '.config/opencode', 'opencode.json', '{"theme":"system"}\n'],
  ['kimi', '.kimi-code', 'config.toml', 'default_model = "custom/model"\n']
]) {
  test(`syncGlobalConfigToHost restores the original ${provider} config after selecting AIH Server`, (t) => {
    const fixture = createFixture(t);
    const configPath = path.join(fixture.hostHomeDir, globalDir, fileName);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original);
    const sync = createHostConfigSyncer({
      fs, fse,
      ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
      aiHomeDir: fixture.aiHomeDir,
      hostHomeDir: fixture.hostHomeDir,
      cliConfigs: { [provider]: { globalDir } }
    });

    assert.equal(sync(provider, '', { gateway: true }).ok, true);
    assert.equal(sync(provider, '', { restoreGateway: true }).ok, true);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  });

  test(`syncGlobalConfigToHost detects external edits to ${provider} gateway config`, (t) => {
    const fixture = createFixture(t);
    const configPath = path.join(fixture.hostHomeDir, globalDir, fileName);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original);
    const sync = createHostConfigSyncer({
      fs, fse,
      ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
      aiHomeDir: fixture.aiHomeDir,
      hostHomeDir: fixture.hostHomeDir,
      cliConfigs: { [provider]: { globalDir } }
    });

    assert.equal(sync(provider, '', { gateway: true }).ok, true);
    fs.appendFileSync(configPath, '\n# external edit\n');
    assert.equal(sync(provider, '', { restoreGateway: true }).ok, false);
    assert.match(fs.readFileSync(configPath, 'utf8'), /external edit/);
  });
}

test('syncGlobalConfigToHost selects AIH Server in Claude settings without replacing unrelated preferences', (t) => {
  const fixture = createFixture(t);
  const settingsPath = path.join(fixture.hostHomeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Read'] },
    env: { ANTHROPIC_AUTH_TOKEN: 'old-token', CUSTOM_SETTING: 'keep' }
  }));
  writeServerConfig({ apiKey: 'gateway-key', port: 9543 }, { fs, aiHomeDir: fixture.aiHomeDir });

  const result = createClaudeSyncer(fixture)('claude', '', { gateway: true });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
    permissions: { allow: ['Read'] },
    env: {
      CUSTOM_SETTING: 'keep',
      ANTHROPIC_AUTH_TOKEN: 'gateway-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9543'
    }
  });
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
});

test('syncGlobalConfigToHost does not overwrite invalid Claude settings for AIH Server', (t) => {
  const fixture = createFixture(t);
  const settingsPath = path.join(fixture.hostHomeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{invalid');

  const result = createClaudeSyncer(fixture)('claude', '', { gateway: true });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'claude_gateway_config_sync_failed');
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{invalid');
});

test('syncGlobalConfigToHost refuses a symlinked gateway host config', (t) => {
  const fixture = createFixture(t);
  const settingsPath = path.join(fixture.hostHomeDir, '.claude', 'settings.json');
  const outsidePath = path.join(fixture.root, 'outside.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(outsidePath, '{"env":{"CUSTOM_SETTING":"untouched"}}\n');
  fs.symlinkSync(outsidePath, settingsPath);

  const result = createClaudeSyncer(fixture)('claude', '', { gateway: true });

  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), '{"env":{"CUSTOM_SETTING":"untouched"}}\n');
  assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
});

test('syncGlobalConfigToHost writes the reconciled Claude credentials snapshot', (t) => {
  const fixture = createFixture(t);
  const databaseCredentials = { claudeAiOauth: { accessToken: 'database' } };
  const reconciledCredentials = { claudeAiOauth: { accessToken: 'keychain' } };
  const accountRef = registerClaudeAccount(fixture, '1', databaseCredentials);
  const sync = createClaudeSyncer(fixture, {
    reconcileClaudeHostCredentials: () => ({
      ok: true,
      credentials: reconciledCredentials,
      source: 'keychain'
    })
  });

  const result = sync('claude', accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.authSync.source, 'keychain');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(fixture.hostHomeDir, '.claude', '.credentials.json'), 'utf8')),
    reconciledCredentials
  );
});

test('syncGlobalConfigToHost does not write Claude files when keychain reconciliation fails', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerClaudeAccount(fixture, '1', {
    claudeAiOauth: { accessToken: 'database' }
  });
  const sync = createClaudeSyncer(fixture, {
    reconcileClaudeHostCredentials: () => ({
      ok: false,
      reason: 'keychain_write_failed'
    })
  });

  const result = sync('claude', accountRef);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'keychain_write_failed');
  assert.equal(fs.existsSync(path.join(fixture.hostHomeDir, '.claude', '.credentials.json')), false);
});

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
  assert.match(hostConfig, /^check_for_update_on_startup = false$/m);
  assert.match(hostConfig, new RegExp(`^model_provider = "${providerKey}"$`, 'm'));
  assert.match(hostConfig, new RegExp(`^\\[model_providers\\.${providerKey}\\]$`, 'm'));
  assert.match(hostConfig, new RegExp(`^base_url = "${AIH_CODEX_PROVIDER_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.match(hostConfig, /'--gateway'/);
  assert.match(hostConfig, /model_providers\.aih_server\.auth/);
  assert.match(hostConfig, /^hooks = true$/m);
  assert.doesNotMatch(hostConfig, /aih_10/);
});

test('syncGlobalConfigToHost selects the unpinned AIH Server profile without rewriting auth.json', (t) => {
  const fixture = createFixture(t);
  const authPath = path.join(fixture.hostCodexDir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'oauth' } }), 'utf8');
  const sync = createCodexSyncer(fixture, {
    readServerConfig: () => ({ host: '127.0.0.1', port: 9543, apiKey: 'gateway-key' })
  });

  const result = sync('codex', '', { gateway: true });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), {
    auth_mode: 'chatgpt',
    tokens: { access_token: 'oauth' }
  });
  const hostConfig = fs.readFileSync(path.join(fixture.hostCodexDir, 'config.toml'), 'utf8');
  assert.match(hostConfig, /^preferred_auth_method = "apikey"$/m);
  assert.match(hostConfig, /^model_provider = "aih_server"$/m);
  assert.match(hostConfig, /^base_url = "http:\/\/127\.0\.0\.1:9543\/v1"$/m);
  assert.doesNotMatch(hostConfig, /X-Account-Ref/);
});

test('host API-key sync pairs endpoints and removes only native override on OAuth switch', (t) => {
  const fixture = createFixture(t);
  const custom = registerCodexAccount(fixture, '31', {
    env: { OPENAI_API_KEY: 'custom-test-key', OPENAI_BASE_URL: 'https://custom.example/v1' }
  });
  const oauth = registerCodexAccount(fixture, '32', {
    auth: { auth_mode: 'chatgpt', tokens: { access_token: 'oauth-test' } }
  });
  const sync = createCodexSyncer(fixture);
  assert.equal(sync('codex', custom).ok, true);
  const configPath = path.join(fixture.hostCodexDir, 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  assert.match(config, /^openai_base_url = "http:\/\/127.0.0.1:9527\/v1"$/m);
  assert.match(config, /^base_url = "http:\/\/127.0.0.1:9527\/v1"$/m);
  assert.ok(config.includes(custom));
  assert.doesNotMatch(config, /custom-test-key/);
  sync('codex', custom);
  assert.equal(fs.readFileSync(configPath, 'utf8'), config);
  assert.equal(sync('codex', oauth).ok, true);
  assert.doesNotMatch(fs.readFileSync(configPath, 'utf8'), /openai_base_url|custom\.example/);
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

test('syncGlobalConfigToHost upgrades stale AIH auth command and retains registration on OAuth', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '21', {
    auth: { tokens: { access_token: 'oauth-access-token' } }
  });
  fs.writeFileSync(path.join(fixture.hostCodexDir, 'config.toml'), [
    'preferred_auth_method = "apikey"',
    'model_provider = "aih_server"',
    '',
    '[model_providers.aih_server]',
    'name = "AIH Server"',
    'base_url = "http://127.0.0.1:9527/v1"',
    '',
    '[model_providers.aih_server.auth]',
    "command = '/usr/bin/node'",
    "args = ['/tmp/aih-codex-provider-auth.js']",
    ''
  ].join('\n'), 'utf8');

  const result = createCodexSyncer(fixture)('codex', accountRef);

  assert.equal(result.ok, true);
  const hostConfig = fs.readFileSync(path.join(fixture.hostCodexDir, 'config.toml'), 'utf8');
  assert.match(hostConfig, /^preferred_auth_method = "oauth"$/m);
  assert.match(hostConfig, /^model_provider = "openai"$/m);
  assert.match(hostConfig, /^\[model_providers\.aih_server\]/m);
  assert.match(hostConfig, /aih-codex-provider-auth/);
  assert.match(hostConfig, /'--gateway'/);
  assert.doesNotMatch(hostConfig, /env_key|bearer_token/);
  assert.doesNotMatch(hostConfig, /\/tmp\/aih-codex-provider-auth/);
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
    { OPENAI_API_KEY: 'dummy', auth_mode: 'apikey', tokens: null, last_refresh: null }
  );

  const hostConfig = fs.readFileSync(path.join(fixture.hostCodexDir, 'config.toml'), 'utf8');
  const providerKey = getAihProviderKey();
  const providerHeaders = hostConfig.match(new RegExp(`^\\[model_providers\\.${providerKey}\\]$`, 'gm')) || [];
  assert.equal(providerHeaders.length, 1);
  assert.match(hostConfig, new RegExp(`^model_provider = "${providerKey}"$`, 'm'));
  assert.match(hostConfig, /^base_url = "http:\/\/127.0.0.1:9527\/v1"$/m);
  // codex 0.149：auth 命令表与 env_key 互斥；受管块走 auth 表（脚本三级取 key）
  assert.doesNotMatch(hostConfig, /env_key/);
  assert.match(hostConfig, /model_providers\.aih_server\.auth\]/);
  assert.match(hostConfig, /aih-codex-provider-auth\.js/);
  assert.match(hostConfig, /refresh_interval_ms = 300000/);
  assert.doesNotMatch(hostConfig, /dummy-(10|11)/);
  assert.equal(hostConfig.includes(firstRef), false);
  assert.equal(hostConfig.includes(secondRef), true);
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

for (const [provider, globalDir] of [['qoder', '.qoder'], ['qodercn', '.qoder-cn']]) {
  test(`syncGlobalConfigToHost projects ${provider} policy auth artifacts`, (t) => {
    const fixture = createFixture(t);
    const registration = registerAccountIdentity(fs, fixture.aiHomeDir, {
      provider,
      cliAccountId: '1',
      identitySeed: `test:host-sync:${provider}:1`
    });
    writeAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef, {
      credentials: `encrypted-${provider}-credentials`,
      machineId: `${provider}-machine`,
      dnsCache: { endpoint: `${provider}.example.com` }
    });
    const sync = createHostConfigSyncer({
      fs,
      fse,
      ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
      aiHomeDir: fixture.aiHomeDir,
      hostHomeDir: fixture.hostHomeDir,
      cliConfigs: { [provider]: { globalDir } }
    });

    const result = sync(provider, registration.accountRef);
    const hostDir = path.join(fixture.hostHomeDir, globalDir);

    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(hostDir, '.auth', 'user'), 'utf8'), `encrypted-${provider}-credentials`);
    assert.equal(fs.readFileSync(path.join(hostDir, '.auth', 'machine_id'), 'utf8'), `${provider}-machine`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hostDir, '.cache', 'dns-cache.json'), 'utf8')), {
      endpoint: `${provider}.example.com`
    });
  });
}

test('syncGlobalConfigToHost projects Grok auth through its host policy root', (t) => {
  const fixture = createFixture(t);
  const registration = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'grok',
    cliAccountId: '1',
    identitySeed: 'test:host-sync:grok:1'
  });
  writeAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef, {
    auth: { access_token: 'grok-access', refresh_token: 'grok-refresh' }
  });
  const sync = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    cliConfigs: { grok: { globalDir: '.grok' } }
  });

  const result = sync('grok', registration.accountRef);

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.hostHomeDir, '.grok', 'auth.json'), 'utf8')), {
    access_token: 'grok-access',
    refresh_token: 'grok-refresh'
  });
});

test('syncGlobalConfigToHost preserves a newer standalone Kimi OAuth snapshot', (t) => {
  const fixture = createFixture(t);
  const makeJwt = (payload) => [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
  const account = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'kimi',
    cliAccountId: '1',
    identitySeed: 'test:host-sync:kimi:1'
  });
  const dbCredentials = {
    access_token: makeJwt({ user_id: 'kimi-host-user', sub: 'kimi-host-user' }),
    refresh_token: makeJwt({ user_id: 'kimi-host-user', sub: 'kimi-host-user' }),
    expires_at: 1000,
    token_type: 'Bearer'
  };
  const hostCredentials = {
    access_token: makeJwt({ user_id: 'kimi-host-user', sub: 'kimi-host-user' }),
    refresh_token: makeJwt({ user_id: 'kimi-host-user', sub: 'kimi-host-user' }),
    expires_at: 2000,
    token_type: 'Bearer'
  };
  writeAccountNativeAuth(fs, fixture.aiHomeDir, account.accountRef, {
    credentials: dbCredentials,
    deviceId: 'db-device'
  });
  const hostCredentialsPath = path.join(
    fixture.hostHomeDir,
    '.kimi-code',
    'credentials',
    'kimi-code.json'
  );
  fs.mkdirSync(path.dirname(hostCredentialsPath), { recursive: true });
  fs.writeFileSync(hostCredentialsPath, JSON.stringify(hostCredentials), 'utf8');
  fs.writeFileSync(path.join(fixture.hostHomeDir, '.kimi-code', 'device_id'), 'host-device\n', 'utf8');

  const sync = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    cliConfigs: { kimi: { globalDir: '.kimi-code' } }
  });

  const result = sync('kimi', account.accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.authSync.skipped, true);
  assert.equal(result.authSync.reason, 'host_auth_newer');
  assert.deepEqual(JSON.parse(fs.readFileSync(hostCredentialsPath, 'utf8')), hostCredentials);
  assert.equal(fs.readFileSync(path.join(fixture.hostHomeDir, '.kimi-code', 'device_id'), 'utf8'), 'host-device\n');
});

test('syncGlobalConfigToHost projects a newer legacy Kimi snapshot behind an empty canonical shell', (t) => {
  const fixture = createFixture(t);
  const makeJwt = (payload) => [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
  const account = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'kimi',
    cliAccountId: '2',
    identitySeed: 'test:host-sync:kimi:legacy'
  });
  const legacyCredentials = {
    access_token: makeJwt({ user_id: 'kimi-legacy-host-user' }),
    refresh_token: makeJwt({ sub: 'kimi-legacy-host-user' }),
    expires_at: 3000,
    token_type: 'Bearer'
  };
  const olderHostCredentials = {
    access_token: makeJwt({ user_id: 'kimi-legacy-host-user' }),
    refresh_token: makeJwt({ sub: 'kimi-legacy-host-user' }),
    expires_at: 2000,
    token_type: 'Bearer'
  };
  writeAccountNativeAuth(fs, fixture.aiHomeDir, account.accountRef, {
    credentials: {},
    auth: legacyCredentials,
    deviceId: 'legacy-db-device'
  });
  const hostCredentialsPath = path.join(
    fixture.hostHomeDir,
    '.kimi-code',
    'credentials',
    'kimi-code.json'
  );
  fs.mkdirSync(path.dirname(hostCredentialsPath), { recursive: true });
  fs.writeFileSync(hostCredentialsPath, JSON.stringify(olderHostCredentials), 'utf8');
  fs.writeFileSync(path.join(fixture.hostHomeDir, '.kimi-code', 'device_id'), 'legacy-host-device\n', 'utf8');

  const sync = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    cliConfigs: { kimi: { globalDir: '.kimi-code' } }
  });
  const result = sync('kimi', account.accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.authSync.updated, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(hostCredentialsPath, 'utf8')), legacyCredentials);
  assert.equal(
    fs.readFileSync(path.join(fixture.hostHomeDir, '.kimi-code', 'device_id'), 'utf8'),
    'legacy-db-device'
  );
});

test('syncGlobalConfigToHost decodes Kiro database into its native host data root', (t) => {
  const fixture = createFixture(t);
  const registration = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'kiro',
    cliAccountId: '1',
    identitySeed: 'test:host-sync:kiro:1'
  });
  const databaseBytes = Buffer.from('sqlite-kiro-account');
  writeAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef, {
    database: databaseBytes.toString('base64')
  });
  const sync = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    cliConfigs: { kiro: { globalDir: '.kiro' } }
  });

  const result = sync('kiro', registration.accountRef);

  assert.equal(result.ok, true);
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.hostHomeDir, '.local', 'share', 'kiro-cli', 'data.sqlite3')),
    databaseBytes
  );
});
