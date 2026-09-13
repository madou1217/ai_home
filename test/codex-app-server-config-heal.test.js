'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  healAppServerProviderConfig,
  resolveAppServerCodexHome
} = require('../lib/server/codex-app-server-config-heal');
const { buildCodexProviderArgs } = require('../lib/cli/services/ai-cli/codex-provider-args');

const GATEWAY_ENV = Object.freeze({
  OPENAI_API_KEY: 'aih-local',
  OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1'
});

function makeRuntimeDir(t, configText) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-appserver-heal-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const codexHome = path.join(runtimeDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  if (typeof configText === 'string') {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), configText);
  }
  return { runtimeDir, codexHome, configPath: path.join(codexHome, 'config.toml') };
}

function readConfig(configPath) {
  return fs.readFileSync(configPath, 'utf8');
}

// 线上故障原样复现：账号沙箱只有 personality 一行，-c 注入的 aih_server 表没有 name，
// codex 0.154 报 "provider name must not be empty" 并让 app-server 秒退。
test('app-server 自愈为只含 personality 的沙箱补出带 name 的受管 provider 段', (t) => {
  const { runtimeDir, configPath } = makeRuntimeDir(t, 'personality = "pragmatic"\n');
  const providerArgs = buildCodexProviderArgs(GATEWAY_ENV);
  assert.ok(providerArgs.length > 0, '网关 env 下应注入 provider 参数');

  const result = healAppServerProviderConfig({
    env: { ...GATEWAY_ENV, CODEX_HOME: path.join(runtimeDir, '.codex') },
    providerArgs,
    runtimeDir
  });

  assert.equal(result.healed, true);
  assert.equal(result.configPath, configPath);
  const config = readConfig(configPath);
  assert.match(config, /\[model_providers\.aih_server\]/);
  assert.match(config, /name = "AIH Server"/);
  // 用户原有配置不能被吃掉。
  assert.match(config, /personality = "pragmatic"/);
});

test('自愈后的 provider 表不再出现空 name（回归守卫）', (t) => {
  const { runtimeDir, configPath } = makeRuntimeDir(t, '[model_providers.aih_server]\nname = ""\nwire_api = "responses"\n');

  const result = healAppServerProviderConfig({
    env: { ...GATEWAY_ENV, CODEX_HOME: path.join(runtimeDir, '.codex') },
    providerArgs: buildCodexProviderArgs(GATEWAY_ENV),
    runtimeDir
  });

  assert.equal(result.healed, true);
  const config = readConfig(configPath);
  assert.doesNotMatch(config, /name\s*=\s*""/);
  assert.match(config, /name = "AIH Server"/);
});

test('已有合法 name 时不改写、不产生备份', (t) => {
  const original = '[model_providers.aih_server]\nname = "AIH Server"\nwire_api = "responses"\n';
  const { runtimeDir, codexHome, configPath } = makeRuntimeDir(t, original);

  const result = healAppServerProviderConfig({
    env: { ...GATEWAY_ENV, CODEX_HOME: codexHome },
    providerArgs: buildCodexProviderArgs(GATEWAY_ENV),
    runtimeDir
  });

  assert.equal(result.healed, false);
  assert.equal(readConfig(configPath), original);
  assert.equal(fs.readdirSync(codexHome).filter((name) => name.includes('aih-bak')).length, 0);
});

// 没有注入 -c provider 参数时就不存在裸表，用户配置不该被我们追加内容。
test('未注入 provider 参数时完全不碰 config.toml', (t) => {
  const original = 'personality = "pragmatic"\n';
  const { runtimeDir, codexHome, configPath } = makeRuntimeDir(t, original);

  const result = healAppServerProviderConfig({
    env: { CODEX_HOME: codexHome },
    providerArgs: buildCodexProviderArgs({}),
    runtimeDir
  });

  assert.equal(result.healed, false);
  assert.equal(result.configPath, '');
  assert.equal(readConfig(configPath), original);
});

test('CODEX_HOME 缺失时回退到 <runtimeDir>/.codex', (t) => {
  const { runtimeDir, configPath } = makeRuntimeDir(t, 'personality = "pragmatic"\n');

  const result = healAppServerProviderConfig({
    env: GATEWAY_ENV,
    providerArgs: buildCodexProviderArgs(GATEWAY_ENV),
    runtimeDir
  });

  assert.equal(result.configPath, configPath);
  assert.match(readConfig(configPath), /name = "AIH Server"/);
});

test('CODEX_HOME 优先于 runtimeDir 推导', () => {
  const pathImpl = path.posix;
  assert.equal(
    resolveAppServerCodexHome({ CODEX_HOME: '/explicit/home' }, '/runtime', pathImpl),
    '/explicit/home'
  );
  assert.equal(resolveAppServerCodexHome({}, '/runtime', pathImpl), '/runtime/.codex');
  assert.equal(resolveAppServerCodexHome({}, '', pathImpl), '');
});

test('自愈不会因不可写目录抛错而阻断 app-server 启动', (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-appserver-heal-ro-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));

  const failingFs = {
    existsSync() { throw new Error('permission denied'); }
  };
  const logs = [];
  const result = healAppServerProviderConfig({
    env: GATEWAY_ENV,
    providerArgs: buildCodexProviderArgs(GATEWAY_ENV),
    runtimeDir,
    fs: failingFs,
    log: (message) => logs.push(message)
  });

  assert.equal(result.healed, false);
  assert.equal(logs.some((message) => message.includes('[codex-heal] skipped')), true);
});

test('app-server 启动路径在 spawn 前调用自愈', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'server', 'codex-app-server-endpoint.js'),
    'utf8'
  );

  assert.match(source, /require\('\.\/codex-app-server-config-heal'\)/);
  const healIndex = source.indexOf('healAppServerProviderConfig({');
  const spawnIndex = source.indexOf('spawnDetachedTmuxRun({');
  assert.ok(healIndex > 0, 'endpoint 必须调用 healAppServerProviderConfig');
  assert.ok(spawnIndex > healIndex, '自愈必须发生在 spawn 之前');
});

// CODEX_HOME 被 codex-strategy 指向宿主 <hostHome>/.codex 时（API-key 账号共享
// SQLite 会话库），那份配置归 codex-config-sync / host-sync 管，我们只修不补。
test('宿主 CODEX_HOME 不被追加受管 provider 段', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-appserver-heal-host-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  const hostCodexHome = path.join(hostHome, '.codex');
  fs.mkdirSync(hostCodexHome, { recursive: true });
  const original = 'personality = "pragmatic"\n';
  fs.writeFileSync(path.join(hostCodexHome, 'config.toml'), original);
  const { runtimeDir } = makeRuntimeDir(t, 'personality = "pragmatic"\n');

  const result = healAppServerProviderConfig({
    env: { ...GATEWAY_ENV, CODEX_HOME: hostCodexHome },
    providerArgs: buildCodexProviderArgs(GATEWAY_ENV),
    runtimeDir
  });

  assert.equal(result.insertedBlock, false);
  assert.equal(result.healed, false);
  assert.equal(readConfig(path.join(hostCodexHome, 'config.toml')), original);
});

test('宿主 CODEX_HOME 里的空 name 仍然被修正', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-appserver-heal-host2-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  const hostCodexHome = path.join(hostHome, '.codex');
  fs.mkdirSync(hostCodexHome, { recursive: true });
  const configPath = path.join(hostCodexHome, 'config.toml');
  fs.writeFileSync(configPath, '[model_providers.aih_server]\nname = ""\nwire_api = "responses"\n');
  const { runtimeDir } = makeRuntimeDir(t, 'personality = "pragmatic"\n');

  const result = healAppServerProviderConfig({
    env: { ...GATEWAY_ENV, CODEX_HOME: hostCodexHome },
    providerArgs: buildCodexProviderArgs(GATEWAY_ENV),
    runtimeDir
  });

  assert.equal(result.insertedBlock, false);
  assert.equal(result.healed, true);
  assert.match(readConfig(configPath), /name = "AIH Server"/);
});
