'use strict';

const { buildZcodeIdentitySeed } = require('../subject-oauth-identity');

module.exports = Object.freeze({
  id: 'zcode',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.credentials || null,
  nativeIdentitySeed: (auth) => buildZcodeIdentitySeed(auth),
  // 未声明 importAliases：标准格式 / sub2api 导入暂不支持 zcode（现状保留，见方案文档批 2）。
  transferIdentitySeed: (auth) => buildZcodeIdentitySeed(auth.credentials || auth)
});
