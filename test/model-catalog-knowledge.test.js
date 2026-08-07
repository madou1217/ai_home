const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildModelCapabilityIndex } = require('../lib/server/model-capability-index');
const {
  aliasTargetCatalogIsUnknown,
  providerCatalogIsUnknown,
  providerHasAccounts
} = require('../lib/server/model-catalog-knowledge');

const CLAUDE_ACCOUNT_REF = 'acct_0123456789abcdefabcd';
const CODEX_ACCOUNT_REF = 'acct_11111111111111111111';

function buildState(accounts, webUiModelsCache = {}) {
  return {
    accounts,
    webUiModelsCache
  };
}

test('provider catalog is unknown when an account exists but no model is known', () => {
  const state = buildState({
    claude: [{ accountRef: CLAUDE_ACCOUNT_REF, provider: 'claude', accessToken: 'claude-token' }]
  });
  const index = buildModelCapabilityIndex(state, {});
  assert.equal(providerHasAccounts(index, state, 'claude'), true);
  assert.equal(providerCatalogIsUnknown(index, state, 'claude'), true);
});

test('provider catalog is known once any model is materialized for that provider', () => {
  const state = buildState({
    claude: [{
      accountRef: CLAUDE_ACCOUNT_REF,
      provider: 'claude',
      accessToken: 'claude-token',
      availableModels: ['claude-sonnet-4-6']
    }]
  });
  const index = buildModelCapabilityIndex(state, {});
  // 目录里确实有 claude 的模型，只是没有 claude-opus-5——这才是可以否定别名目标的事实。
  assert.equal(providerCatalogIsUnknown(index, state, 'claude'), false);
  assert.equal(aliasTargetCatalogIsUnknown(index, state, ['claude']), false);
});

test('provider without accounts is not treated as unknown catalog', () => {
  const state = buildState({ claude: [], codex: [] });
  const index = buildModelCapabilityIndex(state, {});
  assert.equal(providerHasAccounts(index, state, 'claude'), false);
  assert.equal(providerCatalogIsUnknown(index, state, 'claude'), false);
  assert.equal(aliasTargetCatalogIsUnknown(index, state, ['claude', 'codex']), false);
});

test('alias target catalog is unknown when any involved provider has no catalog', () => {
  const state = buildState({
    claude: [{ accountRef: CLAUDE_ACCOUNT_REF, provider: 'claude', accessToken: 'claude-token' }],
    codex: [{
      accountRef: CODEX_ACCOUNT_REF,
      provider: 'codex',
      accessToken: 'codex-token',
      availableModels: ['gpt-5.5']
    }]
  });
  const index = buildModelCapabilityIndex(state, {});
  // codex 目录是全的，claude 目录是空的：目标可能就属于 claude，不能否定。
  assert.equal(aliasTargetCatalogIsUnknown(index, state, ['codex', 'claude']), true);
  assert.equal(aliasTargetCatalogIsUnknown(index, state, ['codex']), false);
});

test('empty provider list is never treated as unknown catalog', () => {
  const state = buildState({
    claude: [{ accountRef: CLAUDE_ACCOUNT_REF, provider: 'claude', accessToken: 'claude-token' }]
  });
  const index = buildModelCapabilityIndex(state, {});
  assert.equal(aliasTargetCatalogIsUnknown(index, state, []), false);
});
