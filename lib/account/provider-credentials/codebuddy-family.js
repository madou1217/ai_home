'use strict';

const { buildCodebuddyIdentitySeed } = require('../subject-oauth-identity');
const { isPlainObject } = require('./transfer-fields');

// CodeBuddy 家族（国际站 / 国内站 / WorkBuddy 国际站 / WorkBuddy 国内站）原生凭据形状相同，
// 但站点与产品各不相同、账号体系互不相通，身份种子前缀由 buildCodebuddyIdentitySeed 按 provider 区分。
function createCodebuddyFamilyCredentials(id) {
  return Object.freeze({
    id,
    capability: 'provider.credentials',
    extractNativeAuth: (source) => source.credentials || null,
    nativeIdentitySeed: (auth) => buildCodebuddyIdentitySeed(id, auth),
    transferIdentitySeed: (auth) => buildCodebuddyIdentitySeed(id, auth.credentials || auth),
    // 导入导出只支持 OAuth：只搬可移植的 credentials（account / auth / accounts），
    // 不带本机绑定的 codebuddyCredentialHostId / codebuddyNativeObservation。
    // 未声明 importApiKeyEnv：API 密钥账号的导入暂不支持（注册身份与导出身份一致性未经真实账号验证）。
    importAliases: [],
    exportRecord: (nativeAuth) => ({ auth: isPlainObject(nativeAuth.credentials) ? nativeAuth.credentials : {}, meta: {} }),
    exportOAuthKind: (auth) => (buildCodebuddyIdentitySeed(id, auth) ? 'oauth' : ''),
    sub2apiCredentials: (auth) => ({ ...auth }),
    normalizeImportedOAuth: (account) => {
      const candidate = isPlainObject(account && account.credentials) ? account.credentials : account;
      return isPlainObject(candidate) && buildCodebuddyIdentitySeed(id, candidate) ? candidate : null;
    },
    importNativeAuth: (auth) => ({ credentials: auth })
  });
}

module.exports = { createCodebuddyFamilyCredentials };
