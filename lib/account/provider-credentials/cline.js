'use strict';

const { hasUsableClineCredential, sanitizeClineProvidersDocument, selectClineOAuthCredential } = require('../cline-credentials');
const { buildClineIdentitySeed } = require('../subject-oauth-identity');
const { isPlainObject } = require('./transfer-fields');

// 原生 auth 是一份**整库**文档：`<CLINE_DIR>/data/settings/providers.json` 里通常还装着
// 别的 provider（anthropic / openrouter / gemini …）的明文密钥，所以：
//   - 入库与投影前先按 cline 槽位收窄（sanitizeClineProvidersDocument）；
//   - 身份种子只认 cline 自己的 auth 记录（`cline` / `cline-pass` 两个槽位取新的那条）。
function normalizeClineDocument(value) {
  if (!isPlainObject(value)) return null;
  return hasUsableClineCredential(value) ? value : null;
}

function clineIdentitySeed(doc) {
  const credential = selectClineOAuthCredential(doc);
  return credential ? buildClineIdentitySeed(credential.raw) : '';
}

module.exports = Object.freeze({
  id: 'cline',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => normalizeClineDocument(source && source.auth),
  nativeIdentitySeed: (doc) => clineIdentitySeed(doc),
  importCredentialEnv: Object.freeze({
    keys: ['CLINE_API_KEY'],
    baseUrlKeys: ['CLINE_API_BASE_URL'],
    credentialType: 'api-key'
  }),
  normalizeImportedOAuth: (account) => {
    const candidate = isPlainObject(account && account.credentials) ? account.credentials : account;
    const doc = isPlainObject(candidate) && isPlainObject(candidate.auth) ? candidate.auth : candidate;
    return normalizeClineDocument(doc);
  }
});
