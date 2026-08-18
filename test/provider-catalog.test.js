'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PROVIDER_IDS,
  ProviderCatalog,
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
    ['codex', 'gemini', 'claude', 'grok', 'kimi', 'zcode']
  );
  assert.deepEqual(listProvidersByCapability('unknownCapability'), []);
  assert.deepEqual(
    listProvidersByCapability('modelCatalog'),
    ['codex', 'gemini', 'claude', 'agy', 'opencode', 'grok', 'qoder', 'qodercn', 'kimi', 'kiro', 'zcode']
  );
  assert.deepEqual(
    listProvidersByCapability('quotaUsage'),
    ['codex', 'gemini', 'claude', 'agy', 'kimi', 'zcode']
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
    ['codex', 'claude', 'opencode']
  );
  assert.deepEqual(
    listProvidersByCapability('accountSessionStore'),
    ['grok', 'qoder', 'qodercn', 'kiro']
  );
  assert.deepEqual(
    listProvidersByCapability('sessionHistory'),
    ['codex', 'gemini', 'claude', 'agy', 'opencode', 'grok', 'qoder', 'qodercn', 'kiro', 'zcode']
  );
  assert.deepEqual(
    listProvidersByCapability('usageScan'),
    ['codex', 'gemini', 'claude', 'agy', 'opencode', 'kimi']
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
