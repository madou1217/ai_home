const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  DEFAULT_SERVER_CONFIG,
  mergeServerConfigPatch,
  readServerConfig,
  writeServerConfig,
  buildServerArgsFromConfig
} = require('../lib/server/server-config-store');

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
    modelsProbeAccounts: 5
  });

  const loaded = readServerConfig({ fs, aiHomeDir });
  assert.deepEqual(loaded, saved);
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
    modelsProbeAccounts: 4
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
    modelsProbeAccounts: 2
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
    modelsProbeAccounts: 6
  });
});
