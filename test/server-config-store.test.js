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

test('server config store persists and normalizes server config', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-config-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const saved = writeServerConfig({
    host: '0.0.0.0',
    port: 11435,
    apiKey: 'abc123',
    managementKey: 'mgmt456',
    openNetwork: true
  }, { fs, aiHomeDir });

  assert.deepEqual(saved, {
    host: '0.0.0.0',
    port: 11435,
    apiKey: 'abc123',
    managementKey: 'mgmt456',
    openNetwork: true
  });

  const loaded = readServerConfig({ fs, aiHomeDir });
  assert.deepEqual(loaded, saved);
  assert.deepEqual(buildServerArgsFromConfig(loaded), [
    '--host', '0.0.0.0',
    '--port', '11435',
    '--api-key', 'abc123',
    '--management-key', 'mgmt456'
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
    openNetwork: true
  }, { fs, aiHomeDir });

  const saved = writeServerConfig({
    apiKey: '',
    managementKey: '',
    host: null,
    port: null,
    openNetwork: null
  }, { fs, aiHomeDir });

  assert.deepEqual(saved, {
    host: '0.0.0.0',
    port: 8317,
    apiKey: '',
    managementKey: '',
    openNetwork: true
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
    openNetwork: true
  });
});

test('mergeServerConfigPatch ignores null updates and preserves explicit boolean false', () => {
  const merged = mergeServerConfigPatch({
    host: '0.0.0.0',
    port: 8317,
    apiKey: 'a',
    managementKey: 'b',
    openNetwork: true
  }, {
    host: null,
    port: undefined,
    apiKey: '',
    openNetwork: false
  });

  assert.deepEqual(merged, {
    host: DEFAULT_SERVER_CONFIG.host,
    port: 8317,
    apiKey: '',
    managementKey: 'b',
    openNetwork: false
  });
});
