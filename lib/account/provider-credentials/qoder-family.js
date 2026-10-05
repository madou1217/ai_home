'use strict';

const crypto = require('node:crypto');
const { resolveQoderNativeAuthPayload, buildQoderIdentitySeed } = require('../qoder-auth-metadata');

function createQoderFamilyCredentials(id) {
  return Object.freeze({
    id,
    capability: 'provider.credentials',
    dedupeByNativeIdentity: true,
    extractNativeAuth: (source) => resolveQoderNativeAuthPayload(id, source),
    nativeIdentitySeed: (auth) => buildQoderIdentitySeed(id, auth),
    // 只用 PAT 的 Qoder 账号把令牌放在 env 而非原生凭据里：以 PAT 摘要作 API 密钥类身份。
    fallbackIdentity: (source) => {
      if (!source.pat) return null;
      const digest = crypto.createHash('sha256').update(String(source.pat)).digest('hex').slice(0, 16);
      return { identitySeed: `api_key:${id}:pat:${digest}`, kind: 'api-key' };
    }
  });
}

module.exports = { createQoderFamilyCredentials };
