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
const { decryptQoderCredential } = require('../qoder-credential-decrypt');

const IMPORT_ALIASES = Object.freeze({
  qoder: ['qodercli', 'qoder-cli'],
  qodercn: ['qoderclicn', 'qoder-cli-cn', 'qoder_cn', 'qoder-cn']
});

/**
 * 身份载荷：先用 aih 自己的可读格式（明文 JSON / iv:tag:cipher + salt）解析；
 * 解析不出来说明是 CLI 1.1.x 写的 **opaque blob**（`.auth/user` + `.auth/machine_id`），
 * 这时复用 CLI 自带 WASM 解密拿 uid/token —— 否则身份 seed 推不出来，
 * 「从本机导入」「OAuth 登录任务」「导出」都会以 missing_stable_identity 失败。
 * 解密是 fail-open：拿不到 CLI 二进制就返回 null，行为与从前一致。
 */
function extractQoderNativeAuth(id, source) {
  const payload = resolveQoderNativeAuthPayload(id, source);
  if (payload) return payload;
  const decrypted = decryptQoderCredential(id, source);
  return decrypted ? decrypted.payload : null;
}

function createQoderFamilyCredentials(id) {
  return Object.freeze({
    id,
    capability: 'provider.credentials',
    dedupeByNativeIdentity: true,
    extractNativeAuth: (source) => extractQoderNativeAuth(id, source),
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
    // 展示身份：opaque 凭据（CLI 1.1.x 的 .auth/user）本身没有可读的邮箱/昵称，
    // 账号页会因此显示「账号待识别」。这里把 WASM 解出来的 uid/email/name 作为
    // userInfo 一并落进账号记录（summarizeQoderAuth 读它），只用于展示，不当身份。
    projectionMetadata: (nativeAuth) => {
      const decrypted = decryptQoderCredential(id, nativeAuth);
      if (!decrypted) return null;
      const payload = decrypted.payload || {};
      const userInfo = {};
      if (decrypted.uid) userInfo.uid = decrypted.uid;
      const email = String(payload.email || payload.emailAddress || '').trim().toLowerCase();
      if (email) userInfo.email = email;
      const username = String(payload.name || payload.username || payload.user_name || '').trim();
      if (username) userInfo.username = username;
      return Object.keys(userInfo).length > 0 ? { userInfo } : null;
    },
    fallbackIdentity: (source) => {
      if (!source.pat) return null;
      const digest = crypto.createHash('sha256').update(String(source.pat)).digest('hex').slice(0, 16);
      return { identitySeed: `api_key:${id}:pat:${digest}`, kind: 'api-key' };
    }
  });
}

module.exports = { createQoderFamilyCredentials };
