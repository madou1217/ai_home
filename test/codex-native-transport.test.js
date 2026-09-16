'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { parse } = require('smol-toml');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
const { writeServerConfig } = require('../lib/server/server-config-store');
const { createHostConfigSyncer } = require('../lib/account/host-sync');
const { readCurrentCodexRuntimeConfig } = require('../lib/server/codex-app-server-stdio-proxy-utils');
const { buildCodexAppServerSpawnEnv, buildCodexAppServerRuntimeConfig } = require('../lib/server/codex-app-server-stdio-proxy-runtime');
const { reconcileSelectedThreadConfig, rewriteThreadResumeRuntimeConfig } = require('../lib/server/codex-app-server-stdio-proxy-resume');
const { runCodexCliResume } = require('../lib/server/codex-app-server-stdio-proxy-cliresume');
const { buildCodexDefaultCliArgs } = require('../lib/server/codex-cli-startup-policy');

const native = 'model_provider = "openai"\npreferred_auth_method = "oauth"\nmodel = "host-model"\n';
const registry = '[model_providers.aih_server]\nname = "AIH Server"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n';
function fixture(t, config = native + registry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-transport-'));
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
  const aiHomeDir = path.join(home, '.ai_home'), cwd = path.join(home, 'project');
  fs.mkdirSync(codexHome, { recursive: true }); fs.mkdirSync(cwd);
  const file = path.join(codexHome, 'config.toml'); fs.writeFileSync(file, config);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processObj = { platform: process.platform, env: { HOME: home, USERPROFILE: home, AIH_HOST_HOME: home, AIH_HOME: aiHomeDir, CODEX_HOME: codexHome } };
  return { root, home, codexHome, aiHomeDir, cwd, file, processObj };
}
function thread(f, provider = 'aih_server') {
  const db = new DatabaseSync(path.join(f.codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, model TEXT, cwd TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('thread-fixture', provider, 'thread-model', f.cwd);
  db.close();
  return { id: 'resume-fixture', method: 'thread/resume', params: { threadId: 'thread-fixture', modelProvider: null, model: null } };
}
function register(f) {
  const result = registerAccountIdentity(fs, f.aiHomeDir, { provider: 'codex', cliAccountId: '36', identitySeed: 'oauth:codex:native-fixture' });
  writeAccountNativeAuth(fs, f.aiHomeDir, result.accountRef, { auth: { auth_mode: 'chatgpt', tokens: { refresh_token: 'fake-native-grant' } } });
  writeDefaultAccountRef(fs, f.aiHomeDir, 'codex', result.accountRef);
  return result.accountRef;
}
function reconcile(f, payload, more = {}) {
  return reconcileSelectedThreadConfig(payload, { fs, processObj: f.processObj, DatabaseSync, ...more });
}

test('OAuth default overrides legacy AIH resume without rewriting the SQLite record or changing its model', t => {
  const f = fixture(t), payload = thread(f);
  const result = reconcile(f, payload);
  assert.equal(result?.currentProvider, 'openai');
  const resumed = rewriteThreadResumeRuntimeConfig(payload, result);
  assert.equal(resumed.params.modelProvider, 'openai');
  assert.equal(resumed.params.model, null);
  assert.equal(payload.params.modelProvider, null);
  const db = new DatabaseSync(path.join(f.codexHome, 'state_5.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT model_provider FROM threads').get().model_provider, 'aih_server'); db.close();
  assert.equal(fs.readFileSync(f.file, 'utf8'), native + registry);
});

test('OAuth default supplies native resume even if the index already says openai but rollout differs', t => {
  const f = fixture(t), payload = thread(f, 'openai');
  assert.equal(rewriteThreadResumeRuntimeConfig(payload, reconcile(f, payload)).params.modelProvider, 'openai');
});

test('OAuth thread/read does not falsely relabel the thread before a successful resume', t => {
  const f = fixture(t), payload = thread(f); payload.method = 'thread/read';
  assert.equal(reconcile(f, payload), null);
});

for (const provider of ['custom-cloud', 'local-llm']) {
  test(`OAuth default leaves third-party thread ${provider} alone`, t => {
    const f = fixture(t), payload = thread(f, provider);
    assert.equal(reconcile(f, payload), null);
  });
}
for (const override of [{ modelProvider: 'custom-cloud' }, { modelProvider: 'aih_server' },
  { config: { model_provider: 'custom-cloud' } }, { config: { profile: 'work' } }]) {
  test(`explicit resume transport wins: ${JSON.stringify(override)}`, t => {
    const f = fixture(t), payload = thread(f); Object.assign(payload.params, override);
    assert.equal(reconcile(f, payload), null);
  });
}
for (const config of ['model_provider = "custom-cloud"\n', 'profile = "custom"\n', 'model_provider = "unterminated']) {
  test(`project route/invalid config is not overridden: ${config.trim()}`, t => {
    const f = fixture(t), payload = thread(f);
    fs.mkdirSync(path.join(f.cwd, '.codex')); fs.writeFileSync(path.join(f.cwd, '.codex/config.toml'), config);
    assert.equal(reconcile(f, payload), null);
  });
}

test('ordinary project preferences do not prevent native takeover', t => {
  const f = fixture(t), payload = thread(f);
  fs.mkdirSync(path.join(f.cwd, '.codex')); fs.writeFileSync(path.join(f.cwd, '.codex/config.toml'), 'model = "project-model"\n');
  assert.equal(reconcile(f, payload).currentProvider, 'openai');
});

test('native App spawn neither reads gateway/DB nor overwrites the host/mobile login', t => {
  const f = fixture(t), authPath = path.join(f.codexHome, 'auth.json');
  const rawAuth = '{"auth_mode":"chatgpt","tokens":{"access_token":"fake-expired","refresh_token":"fake-refresh"}}';
  fs.writeFileSync(authPath, rawAuth);
  const env = { ...f.processObj.env, OPENAI_API_KEY: 'fake-relay-key', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
    AIH_CODEX_GATEWAY_ACCOUNT_REF: 'acct_old', AIH_CODEX_REMOTE_AUTH_TOKEN: 'fake-remote', HTTP_PROXY: 'http://127.0.0.1:9000', KEEP: 'yes' };
  const result = buildCodexAppServerSpawnEnv(fs, { enabled: true, desktopAccountRef: 'acct_11111111111111111111' }, {
    processObj: { ...f.processObj, env },
    readServerConfig() { assert.fail('native mode must not read gateway configuration'); }
  });
  assert.equal(result.runtime, null);
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AIH_CODEX_GATEWAY_ACCOUNT_REF', 'AIH_CODEX_REMOTE_AUTH_TOKEN']) assert.equal(result.env[key], undefined, key);
  assert.equal(result.env.CODEX_HOME, f.codexHome); assert.equal(result.env.HTTP_PROXY, env.HTTP_PROXY);
  assert.equal(result.env.KEEP, 'yes'); assert.equal(env.OPENAI_API_KEY, 'fake-relay-key');
  assert.equal(fs.readFileSync(authPath, 'utf8'), rawAuth); assert.equal(fs.existsSync(f.aiHomeDir), false);
});

test('native runtime config keeps inactive registration and rejects injected gateway/remote-control URLs', t => {
  const f = fixture(t), content = buildCodexAppServerRuntimeConfig(fs, f.codexHome, {
    gatewayBaseUrl: 'http://127.0.0.1:9999/v1', gatewayApiKey: 'fake-key', chatgptBaseUrl: 'http://127.0.0.1:8888/backend-api'
  });
  const doc = parse(content);
  assert.equal(doc.model_provider, 'openai'); assert.equal(doc.preferred_auth_method, 'oauth');
  assert.equal(doc.model_providers.aih_server.base_url, 'http://127.0.0.1:1/v1');
  assert.equal(doc.chatgpt_base_url, undefined); assert.ok(!content.includes('fake-key'));
});

test('real host synchronization switches native mode without removing relay registration', t => {
  const f = fixture(t, 'model_provider = "aih_server"\n' + registry), ref = register(f);
  const sync = createHostConfigSyncer({ fs, fse: { copySync: (source, target) => fs.copyFileSync(source, target) },
    ensureDir: dir => fs.mkdirSync(dir, { recursive: true }), aiHomeDir: f.aiHomeDir, hostHomeDir: f.home,
    cliConfigs: { codex: { globalDir: '.codex' } }, codexVersion: '0.154.0',
    processObj: { ...f.processObj, pid: process.pid, execPath: process.execPath } });
  assert.equal(sync('codex', ref).ok, true);
  const doc = parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(doc.model_provider, 'openai'); assert.equal(doc.model_providers.aih_server.name, 'AIH Server');
  assert.equal(reconcile(f, thread(f)).currentProvider, 'openai');
});

for (const authMode of ['expired', 'missing']) {
  test(`native mode does not depend on a usable login: ${authMode}`, t => {
    const f = fixture(t);
    if (authMode === 'expired') fs.writeFileSync(path.join(f.codexHome, 'auth.json'), '{"tokens":{"access_token":"expired"}}');
    assert.equal(buildCodexAppServerSpawnEnv(fs, { enabled: true }, { processObj: f.processObj }).runtime, null);
    assert.equal(fs.existsSync(f.aiHomeDir), false);
    assert.equal(reconcile(f, thread(f)).currentProvider, 'openai');
  });
}

test('a managed relay runtime stays relay despite the host OAuth choice', t => {
  const f = fixture(t), payload = thread(f);
  const runtime = path.join(f.root, 'relay'); fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'config.toml'), 'model_provider="aih_server"\nmodel="relay-model"\n');
  const processObj = { ...f.processObj, env: { ...f.processObj.env, CODEX_HOME: runtime, CODEX_SQLITE_HOME: f.codexHome } };
  assert.equal(reconcile(f, payload, { processObj }).currentProvider, 'aih_server');
});

for (const args of [['app-server', '-c', 'model_provider=aih_server'], ['app-server', '--config=model_provider="aih_server"'], ['app-server', '--profile', 'relay']]) {
  test(`explicit relay launch wins over native host: ${args.join(' ')}`, t => {
    const f = fixture(t, native + registry + '[profiles.relay]\nmodel_provider="aih_server"\n');
    const config = readCurrentCodexRuntimeConfig(fs, f.codexHome, { processObj: f.processObj, forwardArgs: args });
    assert.equal(config.modelProvider, 'aih_server');
    assert.equal(reconcile(f, thread(f), { forwardArgs: args }).currentProvider, 'aih_server');
  });
}

test('TOML reader respects literal strings, inline comments, root scope and profile override', t => {
  const f = fixture(t, "model_provider = 'openai' # native\npreferred_auth_method = 'oauth'\n[profiles.relay]\nmodel_provider = 'aih_server'\n");
  assert.equal(readCurrentCodexRuntimeConfig(fs, f.codexHome, { processObj: f.processObj }).modelProvider, 'openai');
});

test('OAuth CLI resume never probes or auto-attaches to an available gateway', async t => {
  const f = fixture(t); register(f);
  writeServerConfig({ host: '127.0.0.1', port: 9527, apiKey: 'fake-gateway' }, { fs, aiHomeDir: f.aiHomeDir });
  const spawns = [], child = new EventEmitter();
  await runCodexCliResume(['--upstream', '/test/native-codex', '--run-cli-resume', '--', 'resume', '--all'], {
    fs, processObj: { ...f.processObj, cwd: () => f.cwd, stderr: { write() {} }, exit() {} },
    spawn: (command, args, options) => { spawns.push({ command, args, options }); return child; },
    canConnectToTcpEndpoint() { assert.fail('native OAuth must not probe the gateway'); }
  });
  assert.equal(spawns.length, 1); assert.ok(!spawns[0].args.includes('--remote'));
  assert.ok(spawns[0].args.includes('model_provider=openai'));
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, undefined);
  child.emit('exit', 0);
});

test('native CLI launch override does not replace explicit remote or provider requests', t => {
  const f = fixture(t);
  for (const args of [['resume', '--remote', 'ws://127.0.0.1:4444'], ['exec', '-c', 'model_provider=custom'], ['resume', '--profile', 'relay'], ['exec', '--oss'], ['resume', '-cmodel_provider=custom']]) {
    const out = buildCodexDefaultCliArgs(fs, f.processObj.env, args, 'oauth');
    assert.ok(!out.includes('model_provider=openai'));
    for (const arg of args) assert.ok(out.includes(arg));
  }
});
