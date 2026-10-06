'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PROVIDER_IDS,
  ProviderCatalog,
  getProviderCredentialFacts,
  listProvidersByCapability,
  providerCatalog,
  providerSupports
} = require('../lib/provider-catalog');

test('ProviderCatalog is the immutable provider identity source', () => {
  assert.ok(providerCatalog instanceof ProviderCatalog);
  assert.deepEqual(providerCatalog.listIds(), PROVIDER_IDS);
  assert.equal(providerCatalog.normalize(' QoderCN '), 'qodercn');
  assert.equal(providerCatalog.normalize('missing-provider'), '');
  assert.equal(Object.isFrozen(providerCatalog), true);
  assert.equal(Object.isFrozen(providerCatalog.ids), true);
});

test('ProviderCatalog exposes provider capabilities centrally', () => {
  assert.equal(providerSupports('grok', 'apiKeyAccount'), true);
  assert.equal(providerSupports('qoder', 'apiKeyAccount'), false);
  assert.deepEqual(
    listProvidersByCapability('apiKeyAccount'),
    ['codex', 'gemini', 'claude', 'opencode', 'grok', 'kimi', 'zcode',
      'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']
  );
  assert.deepEqual(listProvidersByCapability('unknownCapability'), []);
  assert.deepEqual(
    listProvidersByCapability('modelCatalog'),
    ['codex', 'gemini', 'claude', 'agy', 'opencode', 'grok', 'qoder', 'qodercn', 'kimi', 'kiro', 'zcode',
      'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']
  );
  assert.deepEqual(
    listProvidersByCapability('quotaUsage'),
    ['codex', 'gemini', 'claude', 'agy', 'kimi', 'zcode',
      'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']
  );
  assert.deepEqual(
    listProvidersByCapability('sessionRuntime'),
    ['codex', 'claude', 'agy', 'opencode']
  );
  assert.deepEqual(
    listProvidersByCapability('fabricRuntime'),
    ['codex', 'gemini', 'claude', 'agy', 'opencode']
  );
  assert.deepEqual(
    listProvidersByCapability('gatewayProfile'),
    ['codex', 'claude', 'opencode', 'kimi']
  );
  assert.deepEqual(
    listProvidersByCapability('accountSessionStore'),
    ['grok', 'qoder', 'qodercn', 'kiro']
  );
  assert.deepEqual(
    listProvidersByCapability('sessionHistory'),
    ['codex', 'gemini', 'claude', 'agy', 'opencode', 'grok', 'qoder', 'qodercn', 'kiro', 'zcode',
      'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']
  );
  assert.deepEqual(
    listProvidersByCapability('usageScan'),
    ['codex', 'gemini', 'claude', 'agy', 'opencode', 'kimi', 'zcode']
  );
});

test('core account modules do not duplicate the complete provider list', () => {
  const sourceRoot = path.join(__dirname, '..', 'lib');
  const files = [
    'account/account-registration.js',
    'account/account-id-allocator.js',
    'account/default-account-store.js',
    'account/runtime-projection-pruner.js',
    'account/standard-transfer.js',
    'runtime/aih-storage-layout.js',
    'server/account-credential-store.js',
    'server/account-ref-store.js',
    'cli/commands/backup/router.js'
  ];
  const duplicatedCatalog = new RegExp(
    PROVIDER_IDS.map((provider) => '[\"\']' + provider + '[\"\']').join('[\\s\\S]*')
  );

  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');
    assert.equal(
      duplicatedCatalog.test(source),
      false,
      relativePath + ' must query provider-catalog instead of copying all provider ids'
    );
  }
});

test('凭据事实：按优先级保留环境变量顺序，返回防御性副本，未知 Provider 为空', () => {
  assert.deepEqual(getProviderCredentialFacts('claude'), {
    vendorId: 'anthropic',
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    authTokenEnv: ['ANTHROPIC_AUTH_TOKEN'],
    baseUrlEnv: ['ANTHROPIC_BASE_URL'],
    cliRequiresAuthFile: false
  });
  assert.deepEqual(getProviderCredentialFacts(' GEMINI ').baseUrlEnv, ['GEMINI_BASE_URL', 'GOOGLE_BASE_URL']);
  assert.deepEqual(getProviderCredentialFacts('agy').apiKeyEnv, [], 'agy 没有 API 密钥凭据');
  const copy = getProviderCredentialFacts('codex');
  copy.apiKeyEnv.push('MUTATED');
  assert.deepEqual(getProviderCredentialFacts('codex').apiKeyEnv, ['OPENAI_API_KEY']);
  assert.deepEqual(getProviderCredentialFacts('nope'), {
    vendorId: '', apiKeyEnv: [], authTokenEnv: [], baseUrlEnv: [], cliRequiresAuthFile: false
  });
  assert.deepEqual(PROVIDER_IDS.filter((id) => getProviderCredentialFacts(id).cliRequiresAuthFile), ['opencode', 'grok'],
    '只有原生 CLI 只认凭据文件的 provider 声明 cliRequiresAuthFile');
});
