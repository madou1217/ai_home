'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../contracts/providers/manifest.json');
const legacyCatalog = require('../lib/provider-catalog-data.json');
const {
  PROVIDER_CONTRACT,
  PROVIDER_IDS,
  listProviderDefinitions
} = require('../lib/provider-catalog');
const { AI_CLI_CONFIGS } = require('../lib/cli/services/ai-cli/provider-registry');
const { PROVIDER_NATIVE_CAPABILITIES } = require('../lib/provider-native-capability-registry');

// omitOrder 将完整合同的 CLI 声明转换成现有 Node 调用方使用的兼容形状。
function omitOrder(cli) {
  const projected = JSON.parse(JSON.stringify(cli));
  delete projected.order;
  return projected;
}

test('Node Provider 兼容层完整消费规范合同', () => {
  const definitions = listProviderDefinitions();

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.generatedFrom, 'core/providers/builtins.go');
  assert.deepEqual(PROVIDER_IDS, manifest.providers.map((provider) => provider.id));
  assert.deepEqual(PROVIDER_CONTRACT.providers, definitions);
  assert.deepEqual(PROVIDER_CONTRACT.fallback, manifest.fallback);
});

test('旧版展示目录由规范合同派生且保持扁平结构', () => {
  assert.deepEqual(
    legacyCatalog.providers,
    manifest.providers.map((provider) => provider.presentation)
  );
  assert.deepEqual(legacyCatalog.fallback, manifest.fallback);
  assert.deepEqual(
    legacyCatalog.deprecatedGatewayProviders,
    manifest.providers
      .filter((provider) => provider.gateway === 'deprecated')
      .map((provider) => provider.id)
  );
});

test('CLI 和原生能力注册表都从同一合同派生', () => {
  const cliDefinitions = manifest.providers
    .filter((provider) => provider.cli)
    .sort((left, right) => left.cli.order - right.cli.order);
  const nativeDefinitions = manifest.providers.filter((provider) => provider.nativeBoundary);

  assert.deepEqual(Object.keys(AI_CLI_CONFIGS), cliDefinitions.map((provider) => provider.id));
  for (const definition of cliDefinitions) {
    assert.deepEqual(AI_CLI_CONFIGS[definition.id], omitOrder(definition.cli));
  }

  assert.deepEqual(
    Object.keys(PROVIDER_NATIVE_CAPABILITIES),
    nativeDefinitions.map((provider) => provider.id)
  );
  for (const definition of nativeDefinitions) {
    assert.deepEqual(PROVIDER_NATIVE_CAPABILITIES[definition.id], {
      provider: definition.id,
      ...definition.nativeBoundary
    });
  }
});

test('Qoder 桌面进程识别不会把命令行进程当作桌面客户端', () => {
  const qoder = AI_CLI_CONFIGS.qoder;

  assert.deepEqual(qoder.desktopClient.windows.processNames, ['Qoder.exe']);
  assert.deepEqual(qoder.desktopClient.windows.execNames, ['Qoder.exe', 'qodercli.exe']);
});

test('Codex Desktop contract recognizes the merged ChatGPT executable on Windows and Linux', () => {
  const codex = AI_CLI_CONFIGS.codex;

  assert.equal(codex.desktopClient.macos.clientName, 'ChatGPT');
  assert.equal(codex.desktopClient.userDataEnvKey, 'CODEX_ELECTRON_USER_DATA_PATH');
  assert.ok(codex.desktopClient.windows.processNames.includes('ChatGPT.exe'));
  assert.ok(codex.desktopClient.windows.execNames.includes('ChatGPT.exe'));
  assert.ok(codex.desktopClient.linux.execNames.includes('ChatGPT'));
  assert.ok(codex.desktopClient.linux.execNames.includes('chatgpt'));
});
