'use strict';

const crypto = require('node:crypto');
const { resolveQoderNativeAuthPayload, buildQoderIdentitySeed, extractQoderIdentityFields } = require('../qoder-auth-metadata');

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
    // 导出记录带 qoder 身份字段；未声明 exportOAuthKind，即 OAuth 账号暂不可导出（现状保留，见方案文档批 2）。
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
