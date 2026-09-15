'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parse } = require('smol-toml');
const {
  buildCodexHostProviderBlock,
  createCodexHostProviderReconciler,
  startCodexHostProviderSelfHeal
} = require('../lib/account/codex-host-provider');
const {
  getManagedAihProviderBlock,
  mergeConfigs
} = require('../lib/cli/services/pty/codex-config-sync');

const connection = {
  baseUrl: 'http://127.0.0.1:19527/v1',
  apiKey: 'test-gateway-secret-never-serialize',
  httpHeaders: { 'X-Account-Ref': 'acct_test_selected' }
};
const oauth = 'model_provider = "openai"\npreferred_auth_method = "oauth"\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-lifecycle-'));
  const hostHomeDir = path.join(root, 'host');
  const codexHome = path.join(hostHomeDir, '.codex');
  const aiHomeDir = path.join(root, 'aih');
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, 'config.toml');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, hostHomeDir, aiHomeDir, codexHome, configPath, fs };
}
function reconciler(f, overrides = {}) {
  return createCodexHostProviderReconciler({ ...f, getConnection: () => connection, ...overrides });
}
function assertRegistration(text) {
  const doc = parse(text);
  const provider = doc.model_providers.aih_server;
  assert.equal(provider.name, 'AIH Server');
  assert.equal(provider.base_url, connection.baseUrl);
  assert.equal(provider.wire_api, 'responses');
  assert.equal(provider.supports_websockets, true);
  assert.equal(provider.env_key, undefined);
  assert.equal(provider.bearer_token, undefined);
  assert.ok(provider.auth.args.includes('--gateway'));
  assert.ok(provider.auth.args.includes('--ai-home'));
  assert.ok(!text.includes(connection.apiKey));
  return doc;
}

test('host registration does not need an upstream or gateway key at generation time', () => {
  assertRegistration(buildCodexHostProviderBlock({ ...connection, apiKey: '' }, { aiHomeDir: '/test/aih' }));
});

test('command paths with apostrophes, backslashes and controls remain valid TOML', () => {
  const command = "C:\\Users\\O'Brien\\node.exe";
  const root = "C:\\Users\\O'Brien\\aih\nfolder";
  const text = buildCodexHostProviderBlock(connection, { nodeExecPath: command, aiHomeDir: root });
  const doc = assertRegistration(text);
  assert.equal(doc.model_providers.aih_server.auth.command, command);
  assert.equal(doc.model_providers.aih_server.auth.args.at(-1), root);
});

test('repair restores old-thread registration without changing OAuth, auth files or other tables', t => {
  const f = fixture(t);
  const original = oauth + '[desktop]\nkeep = true\n[model_providers.custom]\nname = "Custom"\n';
  fs.writeFileSync(f.configPath, original);
  const authPath = path.join(f.codexHome, 'auth.json');
  const auth = '{"auth_mode":"chatgpt","tokens":{"access_token":"test-native"}}\n';
  fs.writeFileSync(authPath, auth);
  const result = reconciler(f)();
  assert.equal(result.repaired, true);
  const content = fs.readFileSync(f.configPath, 'utf8');
  assert.ok(content.startsWith(original));
  const doc = assertRegistration(content);
  assert.equal(doc.model_provider, 'openai');
  assert.equal(doc.preferred_auth_method, 'oauth');
  assert.equal(doc.desktop.keep, true);
  assert.equal(doc.model_providers.custom.name, 'Custom');
  assert.equal(fs.readFileSync(authPath, 'utf8'), auth);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o600);
});

test('repair works without a selected account or auth.json and does not invent a login', t => {
  const f = fixture(t);
  fs.writeFileSync(f.configPath, oauth);
  const result = createCodexHostProviderReconciler(f)();
  assert.equal(result.repaired, true);
  const provider = parse(fs.readFileSync(f.configPath, 'utf8')).model_providers.aih_server;
  assert.equal(provider.base_url, 'http://127.0.0.1:9527/v1');
  assert.equal(provider.http_headers, undefined);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'auth.json')), false);
});

test('an existing provider is preserved byte-for-byte, without DB or key lookup', t => {
  const f = fixture(t);
  const original = oauth + '[model_providers."aih_server"] # keep comment\nname="My gateway"\nbase_url="https://custom.example/v1"\n';
  fs.writeFileSync(f.configPath, original);
  const run = reconciler(f, { getConnection: () => { throw new Error('must_not_read_credentials'); } });
  for (let i = 0; i < 5; i += 1) assert.equal(run().reason, 'provider_present');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
});

test('a provider-like example in a multiline string is not a registration', t => {
  const f = fixture(t);
  const text = oauth + 'developer_instructions = """\n[model_providers.aih_server]\nname = "example"\n"""\n';
  fs.writeFileSync(f.configPath, text);
  assert.equal(reconciler(f)().repaired, true);
  const doc = assertRegistration(fs.readFileSync(f.configPath, 'utf8'));
  assert.ok(doc.developer_instructions.includes('name = "example"'));
});

test('CRLF and a trailing comment are preserved', t => {
  const f = fixture(t);
  const text = oauth.replace(/\n/g, '\r\n') + '# keep';
  fs.writeFileSync(f.configPath, text);
  assert.equal(reconciler(f)().repaired, true);
  const content = fs.readFileSync(f.configPath, 'utf8');
  assert.ok(content.startsWith(text));
  assert.equal(content.replace(/\r\n/g, '').includes('\n'), false);
  assertRegistration(content);
});

for (const text of ['model = "unterminated', 'model = "a"\nmodel = "b"', 'instructions = """\n']) {
  test(`invalid TOML is not rewritten: ${JSON.stringify(text)}`, t => {
    const f = fixture(t);
    fs.writeFileSync(f.configPath, text);
    const result = reconciler(f)();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_host_toml');
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), text);
  });
}

test('a sealed inline provider map is deferred rather than generating invalid TOML', t => {
  const f = fixture(t);
  const text = oauth + 'model_providers = { custom = { name = "Custom" } }\n';
  fs.writeFileSync(f.configPath, text);
  const result = reconciler(f)();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported_host_provider_layout');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), text);
});

test('missing config is created without selecting a provider or writing auth.json', t => {
  const f = fixture(t);
  assert.equal(reconciler(f)().repaired, true);
  assert.equal(assertRegistration(fs.readFileSync(f.configPath, 'utf8')).model_provider, undefined);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'auth.json')), false);
});

test('absent Codex home is not created by the background service', t => {
  const f = fixture(t);
  fs.rmdirSync(f.codexHome);
  assert.equal(reconciler(f)().reason, 'codex_home_absent');
  assert.equal(fs.existsSync(f.codexHome), false);
});

test('redirected config is not modified', t => {
  const f = fixture(t);
  const target = path.join(f.root, 'elsewhere.toml');
  fs.writeFileSync(target, oauth);
  fs.symlinkSync(target, f.configPath);
  assert.equal(reconciler(f)().reason, 'host_config_not_regular');
  assert.equal(fs.readFileSync(target, 'utf8'), oauth);
});

test('a concurrent App write wins over the inspected snapshot', t => {
  const f = fixture(t);
  fs.writeFileSync(f.configPath, oauth);
  const replacement = oauth + 'model = "test-new-choice"\n';
  assert.equal(reconciler(f, { getConnection: () => {
    fs.writeFileSync(f.configPath, replacement);
    return connection;
  } })().reason, 'host_config_changed_during_repair');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), replacement);
  assert.equal(reconciler(f)().repaired, true);
  assert.equal(parse(fs.readFileSync(f.configPath, 'utf8')).model, 'test-new-choice');
  assert.equal(fs.readdirSync(f.codexHome).filter(name => name.endsWith('.tmp')).length, 0);
});

test('a config created concurrently is never overwritten by initial repair', t => {
  const f = fixture(t);
  const result = reconciler(f, { getConnection: () => {
    fs.writeFileSync(f.configPath, oauth);
    return connection;
  } })();
  assert.equal(result.reason, 'host_config_changed_during_repair');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), oauth);
});

test('write failure leaves config intact, cleans temporary files, and does not expose credentials', t => {
  const f = fixture(t);
  fs.writeFileSync(f.configPath, oauth);
  const brokenFs = Object.create(fs);
  brokenFs.renameSync = () => { throw new Error('test-sensitive-value'); };
  const result = reconciler(f, { fs: brokenFs })();
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('test-sensitive-value'));
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), oauth);
  assert.equal(fs.readdirSync(f.codexHome).filter(name => name.endsWith('.tmp')).length, 0);
});

test('startup and periodic repair are idempotent; stop cancels the lifecycle', t => {
  const f = fixture(t);
  fs.writeFileSync(f.configPath, oauth);
  let callback;
  let cleared = false;
  let repaired = 0;
  const timer = { unref() {} };
  const loop = startCodexHostProviderSelfHeal({
    ...f, getConnection: () => connection,
    setInterval(fn, ms) { assert.equal(ms, 15000); callback = fn; return timer; },
    clearInterval(value) { assert.equal(value, timer); cleared = true; },
    onRepaired() { repaired += 1; }
  });
  assert.equal(repaired, 1);
  const content = fs.readFileSync(f.configPath, 'utf8');
  callback();
  assert.equal(repaired, 1);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), content);
  fs.writeFileSync(f.configPath, oauth);
  callback();
  assert.equal(repaired, 2);
  loop.stop();
  assert.equal(cleared, true);
  fs.writeFileSync(f.configPath, oauth);
  callback();
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), oauth);
});

test('host persistence does not remove sandbox-only OAuth isolation', () => {
  const block = getManagedAihProviderBlock({ openaiApiKey: 'test-only' });
  const sandbox = mergeConfigs(block, {}, { isApiKeyMode: false, codexVersion: '0.154.0' });
  assert.ok(!sandbox.includes('[model_providers.aih_server]'));
  assert.equal(parse(sandbox).model_provider, 'openai');
});

// Exercise the real host sync / SQLite / daemon wiring with synthetic accounts.
for (const expiry of ['2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
  test(`API-key -> OAuth retains registration regardless of credential expiry: ${expiry}`, t => {
    const f = fixture(t);
    const { createHostConfigSyncer } = require('../lib/account/host-sync');
    const { registerAccountIdentity } = require('../lib/account/account-registration');
    const { writeAccountCredentials, writeAccountNativeAuth } = require('../lib/server/account-credential-store');
    const api = registerAccountIdentity(fs, f.aiHomeDir, { provider: 'codex', identitySeed: 'test:registry:api' });
    const native = registerAccountIdentity(fs, f.aiHomeDir, { provider: 'codex', identitySeed: 'test:registry:oauth' });
    writeAccountCredentials(fs, f.aiHomeDir, api.accountRef, { OPENAI_API_KEY: 'test-api-secret' });
    const auth = { auth_mode: 'chatgpt', expired: expiry, tokens: { access_token: 'test-access', refresh_token: 'test-refresh' } };
    writeAccountNativeAuth(fs, f.aiHomeDir, native.accountRef, { auth });
    const sync = createHostConfigSyncer({
      ...f, fse: require('fs-extra'), ensureDir: dir => fs.mkdirSync(dir, { recursive: true }),
      cliConfigs: { codex: { globalDir: '.codex' } },
      readServerConfig: () => ({ host: '127.0.0.1', port: 19527, apiKey: connection.apiKey })
    });
    assert.equal(sync('codex', api.accountRef).ok, true);
    assert.equal(sync('codex', native.accountRef).ok, true);
    let text = fs.readFileSync(f.configPath, 'utf8');
    const doc = assertRegistration(text);
    assert.equal(doc.model_provider, 'openai');
    assert.equal(doc.preferred_auth_method, 'oauth');
    assert.equal(doc.openai_base_url, undefined);
    assert.equal(doc.model_providers.aih_server.http_headers['X-Account-Ref'], native.accountRef);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8')), auth);
    assert.equal(sync('codex', native.accountRef).ok, true);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), text);
    assert.equal(sync('codex', api.accountRef).ok, true);
    text = fs.readFileSync(f.configPath, 'utf8');
    assert.equal(assertRegistration(text).model_provider, 'aih_server');
  });
}

test('server daemon lifecycle repairs the host before any token refresh and stops repair', t => {
  const f = fixture(t);
  fs.writeFileSync(f.configPath, oauth);
  const { createTokenRefreshDaemon } = require('../lib/server/token-refresh-daemon');
  const daemon = createTokenRefreshDaemon({ accounts: {} }, {}, { ...f });
  t.after(() => daemon.stop());
  assert.equal(parse(fs.readFileSync(f.configPath, 'utf8')).model_providers.aih_server.name, 'AIH Server');
  assert.equal(parse(fs.readFileSync(f.configPath, 'utf8')).model_provider, 'openai');
  daemon.stop();
  assert.equal(daemon.getStats().hostProviderHeal.stopped, true);
});
