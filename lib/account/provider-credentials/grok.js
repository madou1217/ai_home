'use strict';

const { buildGrokIdentitySeed } = require('../grok-identity');
const { isPlainObject } = require('./transfer-fields');

module.exports = Object.freeze({
  id: 'grok',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.auth || null,
  nativeIdentitySeed: (auth) => buildGrokIdentitySeed(auth),
  importAliases: ['xai'],
  transferIdentitySeed: (auth) => buildGrokIdentitySeed(auth.auth || auth),
  importCredentialEnv: Object.freeze({ keys: ['XAI_API_KEY'], credentialType: 'api-key' }),
  // 导入导出只支持 OAuth：原生 auth 是以「签发方::用户」为键的登录档案表，明文可移植，原样搬运。
  // 未声明 importApiKeyEnv：API 密钥账号的导入暂不支持（注册身份与导出身份一致性未经真实账号验证）。
  exportRecord: (nativeAuth) => ({ auth: isPlainObject(nativeAuth.auth) ? nativeAuth.auth : {}, meta: {} }),
  exportOAuthKind: (auth) => (buildGrokIdentitySeed(auth) ? 'oauth' : ''),
  sub2apiCredentials: (auth) => ({ ...auth }),
  normalizeImportedOAuth: (account) => {
    const candidate = isPlainObject(account && account.credentials) ? account.credentials : account;
    return isPlainObject(candidate) && buildGrokIdentitySeed(candidate) ? candidate : null;
  },
  importNativeAuth: (auth) => ({ auth })
});
