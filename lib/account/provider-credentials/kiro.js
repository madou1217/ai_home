'use strict';

const { buildKiroIdentitySeed } = require('../kiro-identity');
const { isPlainObject } = require('./transfer-fields');

module.exports = Object.freeze({
  id: 'kiro',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.auth || null,
  // kiro 的身份证据分散在整份原生凭据里（不只 auth），种子从完整 source 计算。
  nativeIdentitySeed: (_auth, { source }) => buildKiroIdentitySeed(source),
  importAliases: [],
  transferIdentitySeed: (auth) => buildKiroIdentitySeed(auth),
  // 导入导出只搬 OAuth 授权与登录时观测到的身份证据（identityEvidence，与当前令牌绑定），
  // 不带本机的 database 路径。没有身份证据的账号算不出身份，不导出，避免导入后无法去重。
  exportRecord: (nativeAuth) => (isPlainObject(nativeAuth.auth)
    ? {
      auth: {
        auth: nativeAuth.auth,
        ...(isPlainObject(nativeAuth.identityEvidence) ? { identityEvidence: nativeAuth.identityEvidence } : {})
      },
      meta: {}
    }
    : { auth: {}, meta: {} }),
  exportOAuthKind: (auth) => (buildKiroIdentitySeed(auth) ? 'oauth' : ''),
  sub2apiCredentials: (auth) => ({ ...auth }),
  normalizeImportedOAuth: (account) => {
    const candidate = isPlainObject(account && account.credentials) ? account.credentials : account;
    return isPlainObject(candidate) && buildKiroIdentitySeed(candidate)
      ? { auth: candidate.auth, identityEvidence: candidate.identityEvidence }
      : null;
  },
  importNativeAuth: (auth) => ({ auth: auth.auth, identityEvidence: auth.identityEvidence })
});
