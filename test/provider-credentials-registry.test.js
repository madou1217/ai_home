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
  assert.deepEqual(importable, ['agy', 'claude', 'codebuddy', 'codebuddycn', 'codex', 'gemini', 'grok', 'kimi', 'kiro', 'opencode', 'qoder', 'qodercn', 'workbuddy', 'workbuddycn', 'zcode']);
  const oauthExportable = PROVIDER_IDS.filter((id) => typeof getProviderCredentialStrategy(id).exportOAuthKind === 'function').sort();
  assert.deepEqual(oauthExportable, ['agy', 'claude', 'codebuddy', 'codebuddycn', 'codex', 'gemini', 'grok', 'kimi', 'opencode', 'workbuddy', 'workbuddycn', 'zcode']);
});

test('凭据端口：标准格式导入导出的各项钩子覆盖范围与现状一致', () => {
  const declaring = (hook) => PROVIDER_IDS.filter((id) => typeof getProviderCredentialStrategy(id)[hook] === 'function').sort();
  assert.deepEqual(declaring('sub2apiCredentials'), ['agy', 'claude', 'codebuddy', 'codebuddycn', 'codex', 'gemini', 'grok', 'kimi', 'opencode', 'workbuddy', 'workbuddycn', 'zcode']);
  assert.deepEqual(declaring('normalizeImportedOAuth'), ['agy', 'claude', 'codebuddy', 'codebuddycn', 'codex', 'gemini', 'grok', 'kimi', 'opencode', 'workbuddy', 'workbuddycn', 'zcode']);
  assert.deepEqual(declaring('importNativeAuth'), ['agy', 'claude', 'codebuddy', 'codebuddycn', 'codex', 'gemini', 'grok', 'kimi', 'opencode', 'qoder', 'qodercn', 'workbuddy', 'workbuddycn', 'zcode']);
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

test('CodeBuddy 家族导入导出：只搬可移植的 credentials，不带本机绑定字段', () => {
  const workbuddy = getProviderCredentialStrategy('workbuddy');
  const credentials = { account: { uid: 'wb-uid-1' }, auth: { accessToken: 'at', refreshToken: 'rt', uid: 'wb-uid-1' } };
  const exported = workbuddy.exportRecord({ credentials, codebuddyCredentialHostId: 'host-1', codebuddyNativeObservation: { at: 1 } });
  assert.deepEqual(exported.auth, credentials);
  assert.deepEqual(workbuddy.importNativeAuth(workbuddy.normalizeImportedOAuth({ credentials: exported.auth })), { credentials });
  assert.equal(workbuddy.transferIdentitySeed(exported.auth), workbuddy.nativeIdentitySeed(credentials));
  assert.equal(workbuddy.normalizeImportedOAuth({ credentials: { account: {} } }), null);
});

test('没有声明 API 密钥写法的 provider：导入 API 密钥账号被拒绝，而不是建出空账号', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { importStandardAccountRecords } = require('../lib/account/standard-transfer');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-apikey-reject-'));
  const result = importStandardAccountRecords({ fs, path, aiHomeDir: home, records: [{ provider: 'workbuddy', api_key: 'k' }] });
  assert.equal(result.imported, 0);
  assert.equal(result.accounts[0].reason, 'unsupported_api_key_provider');
  fs.rmSync(home, { recursive: true, force: true });
});

test('grok 导入导出：登录档案表原样往返，身份种子不变', () => {
  const grok = getProviderCredentialStrategy('grok');
  const auth = { 'https://auth.x.ai::client-1': { user_id: 'grok-user-1', principal_id: 'p-1', key: 'k', refresh_token: 'rt' } };
  const exported = grok.exportRecord({ auth });
  assert.equal(grok.exportOAuthKind(exported.auth), 'oauth');
  const normalized = grok.normalizeImportedOAuth({ credentials: grok.sub2apiCredentials(exported.auth) });
  assert.deepEqual(grok.importNativeAuth(normalized), { auth });
  assert.equal(grok.transferIdentitySeed(exported.auth), grok.nativeIdentitySeed(auth));
  assert.equal(grok.normalizeImportedOAuth({ credentials: {} }), null);
});
