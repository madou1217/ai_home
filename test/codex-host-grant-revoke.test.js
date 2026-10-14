const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const {
  detectCodexHostGrant,
  revokeCodexHostGrant
} = require('../lib/account/codex-host-grant-revoke');
const { createHostConfigSyncer } = require('../lib/account/host-sync');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const {
  readDefaultAccountRef,
  readDefaultProviderProfile,
  writeDefaultAccountRef
} = require('../lib/account/default-account-store');
const { AIH_SERVER_PROFILE_ID } = require('../lib/account/provider-profile-id');
const { NATIVE_API_BASE_URL_MARKER } = require('../lib/cli/services/pty/codex-config-sync');

const GATEWAY_BASE_URL = 'http://127.0.0.1:9543/v1';
const DIRECT_BASE_URL = 'https://4router.net/v1';

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-host-grant-'));
  const fixture = {
    root,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: path.join(root, 'home')
  };
  fixture.hostCodexDir = path.join(fixture.hostHomeDir, '.codex');
  fixture.configPath = path.join(fixture.hostCodexDir, 'config.toml');
  fs.mkdirSync(fixture.hostCodexDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fixture;
}

function registerCodexAccount(fixture, cliAccountId, env = {}) {
  const registration = registerAccountIdentity(fs, fixture.aiHomeDir, {
    provider: 'codex',
    cliAccountId: String(cliAccountId),
    identitySeed: `test:codex-host-grant:codex:${cliAccountId}`
  });
  if (Object.keys(env).length) {
    writeAccountCredentials(fs, fixture.aiHomeDir, registration.accountRef, env);
  }
  return registration.accountRef;
}

function createSyncer(fixture) {
  return createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    readServerConfig: () => ({ host: '127.0.0.1', port: 9543, apiKey: 'gateway-key' })
  });
}

// 复刻 set-default 写入宿主直连授权后的形态：根级受管端点 + provider 段钉选。
function writeDirectHostGrant(fixture, accountRef) {
  fs.writeFileSync(fixture.configPath, [
    'preferred_auth_method = "apikey"',
    'model_provider = "openai"',
    NATIVE_API_BASE_URL_MARKER,
    `openai_base_url = "${DIRECT_BASE_URL}"`,
    '',
    '[model_providers.aih_server]',
    'name = "AIH Server"',
    `base_url = "${GATEWAY_BASE_URL}"`,
    'wire_api = "responses"',
    `http_headers = { "X-Account-Ref" = "${accountRef}" }`,
    ''
  ].join('\n'), 'utf8');
}

function createRevoker(fixture, options = {}) {
  const sync = options.sync || createSyncer(fixture);
  return (accountRef, extra = {}) => revokeCodexHostGrant({
    fs,
    path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    accountRef,
    accountBaseUrl: DIRECT_BASE_URL,
    syncGlobalConfigToHost: sync,
    ...extra
  });
}

test('revokeCodexHostGrant rewrites a disabled account direct grant to the gateway profile', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '61', {
    OPENAI_API_KEY: 'router-key',
    OPENAI_BASE_URL: DIRECT_BASE_URL
  });
  writeDirectHostGrant(fixture, accountRef);
  writeDefaultAccountRef(fs, fixture.aiHomeDir, 'codex', accountRef);

  const result = createRevoker(fixture)(accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.revoked, true);
  assert.deepEqual(result.reasons, ['default_account', 'pinned_account_ref', 'native_base_url']);
  const config = fs.readFileSync(fixture.configPath, 'utf8');
  assert.doesNotMatch(config, /4router\.net/, 'the account upstream endpoint must be gone');
  assert.doesNotMatch(config, /X-Account-Ref/, 'the account pin must be gone');
  assert.match(config, /^model_provider = "aih_server"$/m);
  assert.match(config, /^openai_base_url = "http:\/\/127\.0\.0\.1:9543\/v1"$/m);
  assert.equal(readDefaultAccountRef(fs, fixture.aiHomeDir, 'codex'), '');
  assert.equal(readDefaultProviderProfile(fs, fixture.aiHomeDir, 'codex'), AIH_SERVER_PROFILE_ID);
});

test('revokeCodexHostGrant leaves a host without a grant untouched', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '62', {
    OPENAI_API_KEY: 'router-key',
    OPENAI_BASE_URL: DIRECT_BASE_URL
  });
  const original = 'model_provider = "aih_server"\npreferred_auth_method = "apikey"\n';
  fs.writeFileSync(fixture.configPath, original, 'utf8');
  let syncCalls = 0;

  const result = createRevoker(fixture, {
    sync: () => {
      syncCalls += 1;
      return { ok: true };
    }
  })(accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.revoked, false);
  assert.deepEqual(result.reasons, []);
  assert.equal(syncCalls, 0, 'a gateway-profile account must not rewrite the host config');
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original);
});

test('detectCodexHostGrant ignores an unmanaged root openai_base_url', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '63', {
    OPENAI_API_KEY: 'router-key',
    OPENAI_BASE_URL: DIRECT_BASE_URL
  });
  // 用户自设（没有 aih 派发标记）：不是 aih 授权，不得被当成停用回收目标。
  fs.writeFileSync(fixture.configPath, `openai_base_url = "${DIRECT_BASE_URL}"\n`, 'utf8');

  const detection = detectCodexHostGrant({
    fs,
    path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    accountRef,
    accountBaseUrl: DIRECT_BASE_URL
  });

  assert.equal(detection.granted, false);
  assert.deepEqual(detection.reasons, []);
});

test('detectCodexHostGrant finds a stale pin after the default was cleared', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '64', {
    OPENAI_API_KEY: 'router-key',
    OPENAI_BASE_URL: DIRECT_BASE_URL
  });
  writeDirectHostGrant(fixture, accountRef);

  const detection = detectCodexHostGrant({
    fs,
    path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    accountRef,
    accountBaseUrl: DIRECT_BASE_URL
  });

  assert.equal(detection.granted, true);
  assert.deepEqual(detection.reasons, ['pinned_account_ref', 'native_base_url']);

  const result = createRevoker(fixture)(accountRef);
  assert.equal(result.revoked, true);
  assert.equal(readDefaultProviderProfile(fs, fixture.aiHomeDir, 'codex'), AIH_SERVER_PROFILE_ID);
  assert.doesNotMatch(fs.readFileSync(fixture.configPath, 'utf8'), /X-Account-Ref/);
});

test('revokeCodexHostGrant reports host_scope_unavailable without a host home', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '65');
  let syncCalls = 0;

  const result = createRevoker(fixture, {
    sync: () => {
      syncCalls += 1;
      return { ok: true };
    }
  })(accountRef, { hostHomeDir: '' });

  assert.equal(result.ok, true);
  assert.equal(result.revoked, false);
  assert.equal(result.detection.scope, 'host_scope_unavailable');
  assert.equal(syncCalls, 0);
});

test('revokeCodexHostGrant keeps the grant and default when the host sync fails', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '66', {
    OPENAI_API_KEY: 'router-key',
    OPENAI_BASE_URL: DIRECT_BASE_URL
  });
  writeDirectHostGrant(fixture, accountRef);
  writeDefaultAccountRef(fs, fixture.aiHomeDir, 'codex', accountRef);
  const original = fs.readFileSync(fixture.configPath, 'utf8');

  const result = createRevoker(fixture, {
    sync: () => ({ ok: false, reason: 'codex_config_sync_failed' })
  })(accountRef);

  assert.equal(result.ok, false);
  assert.equal(result.revoked, false);
  assert.equal(result.reason, 'codex_config_sync_failed');
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original);
  assert.equal(readDefaultAccountRef(fs, fixture.aiHomeDir, 'codex'), accountRef);
  assert.equal(readDefaultProviderProfile(fs, fixture.aiHomeDir, 'codex'), '');
});

test('revokeCodexHostGrant reports host_sync_unavailable without a syncer', (t) => {
  const fixture = createFixture(t);
  const accountRef = registerCodexAccount(fixture, '67', {
    OPENAI_API_KEY: 'router-key',
    OPENAI_BASE_URL: DIRECT_BASE_URL
  });
  writeDirectHostGrant(fixture, accountRef);

  const result = revokeCodexHostGrant({
    fs,
    path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir,
    accountRef,
    accountBaseUrl: DIRECT_BASE_URL,
    syncGlobalConfigToHost: null
  });

  assert.equal(result.ok, false);
  assert.equal(result.revoked, false);
  assert.equal(result.reason, 'host_sync_unavailable');
  assert.match(fs.readFileSync(fixture.configPath, 'utf8'), /X-Account-Ref/);
});
