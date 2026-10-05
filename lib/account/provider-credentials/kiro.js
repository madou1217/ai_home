'use strict';

const { buildKiroIdentitySeed } = require('../kiro-identity');

module.exports = Object.freeze({
  id: 'kiro',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.auth || null,
  // kiro 的身份证据分散在整份原生凭据里（不只 auth），种子从完整 source 计算。
  nativeIdentitySeed: (_auth, { source }) => buildKiroIdentitySeed(source)
});
