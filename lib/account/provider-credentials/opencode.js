'use strict';

const { buildOpenCodeIdentitySeed } = require('../opencode-identity');
const { hasNonEmptyObject, objectOrEmpty } = require('./transfer-fields');

module.exports = Object.freeze({
  id: 'opencode',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.auth || null,
  nativeIdentitySeed: (auth) => buildOpenCodeIdentitySeed(auth),
  importAliases: [],
  transferIdentitySeed: (auth) => buildOpenCodeIdentitySeed(auth.auth || auth),
  exportRecord: (nativeAuth) => ({ auth: objectOrEmpty(nativeAuth.auth), meta: {} }),
  exportOAuthKind: (auth) => (hasNonEmptyObject(auth) ? 'oauth' : ''),
  sub2apiCredentials: (auth) => auth,
  importNativeAuth: (auth) => ({ auth }),
  normalizeImportedOAuth: (account) => {
    const credentials = account && account.credentials && typeof account.credentials === 'object' ? account.credentials : null;
    if (credentials && Object.keys(credentials).length > 0) return credentials;
    const auth = account && account.auth && typeof account.auth === 'object' ? account.auth : null;
    if (auth && Object.keys(auth).length > 0) return auth;
    return account && typeof account === 'object' ? account : null;
  }
});
