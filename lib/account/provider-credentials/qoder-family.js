'use strict';

const crypto = require('node:crypto');
const { isPlainObject } = require('./transfer-fields');
const {
  buildQoderIdentitySeed,
  encryptQoderCredentials,
  extractQoderIdentityFields,
  getQoderVariant,
  resolveQoderNativeAuthPayload
} = require('../qoder-auth-metadata');

const IMPORT_ALIASES = Object.freeze({
  qoder: ['qodercli', 'qoder-cli'],
  qodercn: ['qoderclicn', 'qoder-cli-cn', 'qoder_cn', 'qoder-cn']
});

function createQoderFamilyCredentials(id) {
  return Object.freeze({
    id,
    capability: 'provider.credentials',
    dedupeByNativeIdentity: true,
    extractNativeAuth: (source) => resolveQoderNativeAuthPayload(id, source),
    nativeIdentitySeed: (auth) => buildQoderIdentitySeed(id, auth),
    importAliases: IMPORT_ALIASES[id] || [],
    transferIdentitySeed: (auth) => buildQoderIdentitySeed(id, auth.userInfo || auth),
    // 导出记录带 qoder 身份字段。
    // 原生凭据用随记录保存的 salt 加密：导出解密成明文用户信息，导入时用新 salt 重新加密成原生布局。
    // PAT 账号只有 env 令牌，不在导出范围内。
    exportOAuthKind: (auth) => (buildQoderIdentitySeed(id, auth) ? 'oauth' : ''),
    sub2apiCredentials: (auth) => ({ ...auth }),
    normalizeImportedOAuth: (account) => {
      const candidate = isPlainObject(account && account.credentials) ? account.credentials : account;
      const payload = isPlainObject(candidate && candidate.userInfo) ? candidate.userInfo : candidate;
      return isPlainObject(payload) && buildQoderIdentitySeed(id, payload) ? payload : null;
    },
    importNativeAuth: (auth) => {
      const variant = getQoderVariant(id);
      if (!variant) return null;
      const saltB64 = crypto.randomBytes(32).toString('base64');
      return {
        credentials: encryptQoderCredentials(auth, saltB64, variant.credentialPrefix),
        keychainSalt: saltB64,
        userInfo: auth && typeof auth === 'object' ? auth : null
      };
    },
    exportRecord: (nativeAuth) => {
      const auth = resolveQoderNativeAuthPayload(id, nativeAuth) || {};
      const fields = extractQoderIdentityFields(auth);
      return {
        auth,
        meta: { email: fields.email || '', uid: fields.uid || '', authMode: fields.loginMethod || 'oauth' },
        kindMeta: { email: fields.email }
      };
    },
    // 只用 PAT 的 Qoder 账号把令牌放在 env 而非原生凭据里：以 PAT 摘要作 API 密钥类身份。
    fallbackIdentity: (source) => {
      if (!source.pat) return null;
      const digest = crypto.createHash('sha256').update(String(source.pat)).digest('hex').slice(0, 16);
      return { identitySeed: `api_key:${id}:pat:${digest}`, kind: 'api-key' };
    }
  });
}

module.exports = { createQoderFamilyCredentials };
