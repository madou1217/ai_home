'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PROVIDER_IDS } = require('../lib/provider-catalog');
const { CREDENTIAL_STRATEGIES, getProviderCredentialStrategy } = require('../lib/account/provider-credentials');

test('凭据端口：每个合同里的 provider 都有凭据模块，契约字段齐全', () => {
  assert.deepEqual(CREDENTIAL_STRATEGIES.map((strategy) => strategy.id).sort(), [...PROVIDER_IDS].sort());
  for (const id of PROVIDER_IDS) {
    const strategy = getProviderCredentialStrategy(id);
    assert.equal(strategy.id, id);
    assert.equal(strategy.capability, 'provider.credentials');
    assert.equal(typeof strategy.extractNativeAuth, 'function');
    assert.equal(typeof strategy.nativeIdentitySeed, 'function');
    assert.equal(typeof strategy.dedupeByNativeIdentity, 'boolean');
    assert.equal(typeof strategy.emailIsIdentity, 'boolean');
  }
});

test('凭据端口：原生身份去重与邮箱身份只对声明的 provider 生效；未知 provider 走中性默认', () => {
  const flagged = (flag) => PROVIDER_IDS.filter((id) => getProviderCredentialStrategy(id)[flag]).sort();
  assert.deepEqual(flagged('dedupeByNativeIdentity'), ['grok', 'kimi', 'kiro', 'opencode', 'qoder', 'qodercn', 'zcode']);
  assert.deepEqual(flagged('emailIsIdentity'), ['agy', 'gemini']);
  const fallback = getProviderCredentialStrategy('nope');
  assert.equal(fallback.extractNativeAuth({ auth: {} }), null);
  assert.equal(fallback.nativeIdentitySeed({}), '');
  assert.equal(getProviderCredentialStrategy(' KIMI ').id, 'kimi');
});

test('凭据端口：导入别名、可导入与可按 OAuth 导出的 provider 集合与现状一致（缺口见方案文档批 2）', () => {
  const { normalizeImportProviderAlias } = require('../lib/account/transfer-core');
  assert.equal(normalizeImportProviderAlias(' OpenAI '), 'codex');
  assert.equal(normalizeImportProviderAlias('moonshot-ai'), 'kimi');
  assert.equal(normalizeImportProviderAlias('qoder_cn'), 'qodercn');
  const importable = PROVIDER_IDS.filter((id) => normalizeImportProviderAlias(id) === id).sort();
  assert.deepEqual(importable, ['agy', 'claude', 'codex', 'gemini', 'grok', 'kimi', 'kiro', 'opencode', 'qoder', 'qodercn']);
  const oauthExportable = PROVIDER_IDS.filter((id) => typeof getProviderCredentialStrategy(id).exportOAuthKind === 'function').sort();
  assert.deepEqual(oauthExportable, ['agy', 'claude', 'codex', 'gemini', 'kimi', 'opencode']);
});
