'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const {
  discoverNativeCliModels,
  parseNativeCliModelList,
  supportsNativeCliModelDiscovery
} = require('../lib/server/native-cli-model-discovery');

test('native CLI discovery supports both Qoder regions', () => {
  assert.equal(supportsNativeCliModelDiscovery('qoder'), true);
  assert.equal(supportsNativeCliModelDiscovery('qodercn'), true);
  assert.equal(supportsNativeCliModelDiscovery('kiro'), true);
  assert.equal(supportsNativeCliModelDiscovery('claude'), false);
});

test('parseNativeCliModelList removes the table header and duplicates', () => {
  assert.deepEqual(
    parseNativeCliModelList('MODEL\r\nAuto\r\nQwen3.7-Max\r\nAuto\r\n'),
    ['Auto', 'Qwen3.7-Max']
  );
});

test('parseNativeCliModelList reads Kiro JSON model ids', () => {
  assert.deepEqual(
    parseNativeCliModelList(JSON.stringify({
      models: [
        { model_id: 'deepseek-3.2' },
        { model_name: 'glm-5' },
        { model_id: 'deepseek-3.2' }
      ]
    }), 'kiro-json'),
    ['deepseek-3.2', 'glm-5']
  );
});
test('Qoder model discovery materializes account auth and invokes list-models', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-models-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'qodercn',
    cliAccountId: '1',
    identitySeed: 'oauth:qodercn:user@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    credentials: 'opaque-credential',
    machineId: 'machine-id'
  });
  let invocation = null;

  const models = await discoverNativeCliModels({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: 'C:\\Users\\test',
    platform: 'win32',
    resolveProviderCliPath: () => 'C:\\tools\\qoderclicn.exe',
    execFile: async (cliPath, args, options) => {
      invocation = { cliPath, args, options };
      return { stdout: 'MODEL\nAuto\nDeepSeek-V4-Pro\n' };
    }
  }, { provider: 'qodercn', accountRef }, 4321);

  assert.deepEqual(models, ['Auto', 'DeepSeek-V4-Pro']);
  assert.equal(invocation.cliPath, 'C:\\tools\\qoderclicn.exe');
  assert.deepEqual(invocation.args.slice(0, 1), ['--list-models']);
  assert.equal(invocation.args[1], '--config-dir');
  assert.equal(invocation.options.timeout, 20000);
  assert.equal(invocation.options.env.HOME, 'C:\\Users\\test');
  assert.equal(invocation.options.env.USERPROFILE, 'C:\\Users\\test');
  assert.equal(fs.existsSync(path.join(invocation.args[2], '.auth', 'user')), true);
});
