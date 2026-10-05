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
  exportOAuthKind: (auth) => (hasNonEmptyObject(auth) ? 'oauth' : '')
});
