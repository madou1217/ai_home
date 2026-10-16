const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  DEFAULT_SERVER_CONFIG,
  SERVER_CONFIG_KEY,
  mergeServerConfigPatch,
  readServerConfig,
  writeServerConfig,
  buildServerArgsFromConfig
} = require('../lib/server/server-config-store');
const { readJsonValue } = require('../lib/server/app-state-store');

test('server config store defaults to AIH provider port 9527', () => {
  assert.equal(DEFAULT_SERVER_CONFIG.port, 9527);
  assert.equal(readServerConfig({ fs, aiHomeDir: path.join(os.tmpdir(), 'aih-missing-config') }).port, 9527);
});

test('server config store persists and normalizes server config', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-config-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const saved = writeServerConfig({
    host: '0.0.0.0',
    port: 11435,
    apiKey: 'abc123',
    managementKey: 'mgmt456',
    openNetwork: true,
    proxyUrl: 'http://127.0.0.1:6152',
    noProxy: 'localhost,127.0.0.1',
    modelsProbeAccounts: 5
  }, { fs, aiHomeDir });

  assert.deepEqual(saved, {
    host: '0.0.0.0',
    port: 11435,
    apiKey: 'abc123',
    managementKey: 'mgmt456',
    openNetwork: true,
    proxyUrl: 'http://127.0.0.1:6152',
    noProxy: 'localhost,127.0.0.1',
    modelsProbeAccounts: 5,
    windowActivation: false,
    windowActivationDefaultIntervalMs: 60 * 60 * 1000,
    windowActivationMinIntervalMs: 60 * 60 * 1000,
    goCoreEnabled: false,
    goCoreRoutes: [],
    upstreamErrorRuleProviders: []
  });

  const loaded = readServerConfig({ fs, aiHomeDir });
  assert.deepEqual(loaded, saved);
  assert.deepEqual(readJsonValue(fs, aiHomeDir, SERVER_CONFIG_KEY), saved);
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'server-config.json')), false);
  assert.deepEqual(buildServerArgsFromConfig(loaded), [
    '--host', '0.0.0.0',
    '--port', '11435',
    '--proxy-url', 'http://127.0.0.1:6152',
    '--no-proxy', 'localhost,127.0.0.1',
    '--models-probe-accounts', '5'
  ]);
});

test('server config store supports partial update semantics and empty string clearing', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-config-partial-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  writeServerConfig({
    host: '0.0.0.0',
    port: 8317,
    apiKey: 'secret-a',
    managementKey: 'secret-b',
    openNetwork: true,
    proxyUrl: 'http://proxy-a:9000',
    noProxy: 'localhost',
    modelsProbeAccounts: 4
  }, { fs, aiHomeDir });

  const saved = writeServerConfig({
    apiKey: '',
    managementKey: '',
    proxyUrl: '',
    noProxy: '',
    host: null,
    port: null,
    modelsProbeAccounts: null,
    openNetwork: null
  }, { fs, aiHomeDir });

  assert.deepEqual(saved, {
    host: '0.0.0.0',
    port: 8317,
    apiKey: '',
    managementKey: '',
    openNetwork: true,
    proxyUrl: '',
    noProxy: '',
    modelsProbeAccounts: 4,
    windowActivation: false,
    windowActivationDefaultIntervalMs: 60 * 60 * 1000,
    windowActivationMinIntervalMs: 60 * 60 * 1000,
    goCoreEnabled: false,
    goCoreRoutes: [],
    upstreamErrorRuleProviders: []
  });
});

test('server config store works when fs only exposes mkdirSync for directory creation', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-config-fs-compat-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const compatFs = {
    ...fs,
    ensureDirSync: undefined,
    mkdirpSync: undefined,
    mkdirSync: fs.mkdirSync.bind(fs)
  };

  const saved = writeServerConfig({
    host: '0.0.0.0',
    port: 9000,
    apiKey: '',
    managementKey: '',
    openNetwork: true
  }, { fs: compatFs, aiHomeDir });

  assert.deepEqual(saved, {
    host: '0.0.0.0',
    port: 9000,
    apiKey: '',
    managementKey: '',
    openNetwork: true,
    proxyUrl: '',
    noProxy: '',
    modelsProbeAccounts: 2,
    windowActivation: false,
    windowActivationDefaultIntervalMs: 60 * 60 * 1000,
    windowActivationMinIntervalMs: 60 * 60 * 1000,
    goCoreEnabled: false,
    goCoreRoutes: [],
    upstreamErrorRuleProviders: []
  });
});

test('mergeServerConfigPatch ignores null updates and preserves explicit boolean false', () => {
  const merged = mergeServerConfigPatch({
    host: '0.0.0.0',
    port: 8317,
    apiKey: 'a',
    managementKey: 'b',
    openNetwork: true,
    proxyUrl: 'http://proxy-a:9000',
    noProxy: 'localhost',
    modelsProbeAccounts: 6
  }, {
    host: null,
    port: undefined,
    apiKey: '',
    proxyUrl: '',
    openNetwork: false
  });

  assert.deepEqual(merged, {
    host: DEFAULT_SERVER_CONFIG.host,
    port: 8317,
    apiKey: '',
    managementKey: 'b',
    openNetwork: false,
    proxyUrl: '',
    noProxy: 'localhost',
    modelsProbeAccounts: 6,
    windowActivation: false,
    windowActivationDefaultIntervalMs: 60 * 60 * 1000,
    windowActivationMinIntervalMs: 60 * 60 * 1000,
    goCoreEnabled: false,
    goCoreRoutes: [],
    upstreamErrorRuleProviders: []
  });
});

test('server config store persists Go Core opt-in and normalizes route entry ids', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-config-go-core-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const saved = writeServerConfig({
    goCoreEnabled: true,
    goCoreRoutes: ' gateway.models.list, gateway.models.list,gateway.props ,'
  }, { fs, aiHomeDir });

  assert.equal(saved.goCoreEnabled, true);
  assert.deepEqual(saved.goCoreRoutes, ['gateway.models.list', 'gateway.props']);
  assert.deepEqual(readServerConfig({ fs, aiHomeDir }), saved);
  assert.equal(buildServerArgsFromConfig(saved).includes('--go-core'), false);

  const disabled = writeServerConfig({ goCoreEnabled: false, goCoreRoutes: [] }, { fs, aiHomeDir });
  assert.equal(disabled.goCoreEnabled, false);
  assert.deepEqual(disabled.goCoreRoutes, []);
});

test('server config store persists the window activation opt-in and passes it to serve args', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-config-window-activation-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  // 默认关：窗口激活的每次探测都是一次真实上游请求，必须显式 opt-in。
  assert.equal(DEFAULT_SERVER_CONFIG.windowActivation, false);
  assert.equal(buildServerArgsFromConfig({}).includes('--window-activation'), false);

  const saved = writeServerConfig({ windowActivation: true }, { fs, aiHomeDir });
  assert.equal(saved.windowActivation, true);
  assert.equal(readServerConfig({ fs, aiHomeDir }).windowActivation, true);
  // 关键接线：`aih server restart` 只吃保存配置，args 里没有这个 flag 就等于「存了不生效」。
  assert.equal(buildServerArgsFromConfig(saved).includes('--window-activation'), true);

  const disabled = writeServerConfig({ windowActivation: false }, { fs, aiHomeDir });
  assert.equal(disabled.windowActivation, false);
  assert.equal(buildServerArgsFromConfig(disabled).includes('--window-activation'), false);
  // 非布尔真值不得被当成开启（表单/JSON 传来的 "true" 字符串不算）。
  assert.equal(writeServerConfig({ windowActivation: 'true' }, { fs, aiHomeDir }).windowActivation, false);
});

test('server config store normalizes the Go upstream error rule provider list', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-config-rules-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  // Go 侧把空项与重复项当硬错误（声明写错会让 Go 拒绝启动），因此写入门必须归一化。
  const saved = writeServerConfig({
    upstreamErrorRuleProviders: ' Codex , claude ,Codex,  '
  }, { fs, aiHomeDir });

  assert.deepEqual(saved.upstreamErrorRuleProviders, ['codex', 'claude']);
  assert.deepEqual(readServerConfig({ fs, aiHomeDir }).upstreamErrorRuleProviders, ['codex', 'claude']);

  // 未声明（默认）表示 Go 不承接任何账号，Node 继续自己执行规则。
  assert.deepEqual(DEFAULT_SERVER_CONFIG.upstreamErrorRuleProviders, []);
  const cleared = writeServerConfig({ upstreamErrorRuleProviders: [] }, { fs, aiHomeDir });
  assert.deepEqual(cleared.upstreamErrorRuleProviders, []);
  assert.equal(buildServerArgsFromConfig(cleared).includes('--upstream-error-rules'), false);
});
