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
  assert.deepEqual(importable, ['agy', 'claude', 'codex', 'gemini', 'grok', 'kimi', 'kiro', 'opencode', 'qoder', 'qodercn', 'zcode']);
  const oauthExportable = PROVIDER_IDS.filter((id) => typeof getProviderCredentialStrategy(id).exportOAuthKind === 'function').sort();
  assert.deepEqual(oauthExportable, ['agy', 'claude', 'codex', 'gemini', 'kimi', 'opencode', 'zcode']);
});

test('凭据端口：标准格式导入导出的各项钩子覆盖范围与现状一致', () => {
  const declaring = (hook) => PROVIDER_IDS.filter((id) => typeof getProviderCredentialStrategy(id)[hook] === 'function').sort();
  assert.deepEqual(declaring('sub2apiCredentials'), ['agy', 'claude', 'codex', 'gemini', 'kimi', 'opencode', 'zcode']);
  assert.deepEqual(declaring('normalizeImportedOAuth'), ['agy', 'claude', 'codex', 'gemini', 'kimi', 'opencode', 'zcode']);
  assert.deepEqual(declaring('importNativeAuth'), ['agy', 'claude', 'codex', 'gemini', 'kimi', 'opencode', 'qoder', 'qodercn', 'zcode']);
  assert.deepEqual(declaring('importApiKeyEnv'), ['claude', 'codex', 'gemini', 'kimi', 'zcode']);
  assert.deepEqual(getProviderCredentialStrategy('kimi').importApiKeyEnv({ apiKey: 'k', baseUrl: 'https://b' }), {
    MOONSHOT_API_KEY: 'k',
    KIMI_BASE_URL: 'https://b'
  });
});

test('zcode 导入导出：导出解密成明文，导入用目标机密钥重新加密，身份种子不变', () => {
  const zcode = getProviderCredentialStrategy('zcode');
  const { encryptZcodeCredentialValue, isEncryptedZcodeCredentialValue } = require('../lib/account/zcode-credential');
  const userInfo = JSON.stringify({ user_id: 'zcode-user-1' });
  const plain = { 'oauth:active_provider': 'zai', 'oauth:zai:access_token': 'at', zcodejwttoken: 'a.b.c', 'oauth:zai:user_info': userInfo };
  const native = { credentials: Object.fromEntries(Object.entries(plain).map(([key, value]) => [key, encryptZcodeCredentialValue(value)])) };
  const exported = zcode.exportRecord(native);
  assert.deepEqual(exported.auth, plain, '导出为明文');
  assert.equal(zcode.exportOAuthKind(exported.auth), 'oauth');
  const normalized = zcode.normalizeImportedOAuth({ credentials: zcode.sub2apiCredentials(exported.auth) });
  assert.deepEqual(normalized, plain);
  const reimported = zcode.importNativeAuth(normalized);
  assert.ok(Object.values(reimported.credentials).every(isEncryptedZcodeCredentialValue), '导入时重新加密');
  assert.equal(zcode.nativeIdentitySeed(reimported.credentials), zcode.nativeIdentitySeed(native.credentials));
  assert.equal(zcode.transferIdentitySeed(exported.auth), zcode.nativeIdentitySeed(native.credentials));
  assert.equal(zcode.normalizeImportedOAuth({ credentials: { 'oauth:active_provider': 'zai' } }), null, '没有令牌不导入');
  assert.deepEqual(zcode.importApiKeyEnv({ apiKey: 'k', baseUrl: 'https://z' }), { ZCODE_API_KEY: 'k', ZCODE_BASE_URL: 'https://z' });
});
