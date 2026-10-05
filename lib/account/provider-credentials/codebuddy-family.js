'use strict';

const { buildCodebuddyIdentitySeed } = require('../subject-oauth-identity');

// CodeBuddy 家族（国际站 / 国内站 / WorkBuddy 国际站 / WorkBuddy 国内站）原生凭据形状相同，
// 但站点与产品各不相同、账号体系互不相通，身份种子前缀由 buildCodebuddyIdentitySeed 按 provider 区分。
function createCodebuddyFamilyCredentials(id) {
  return Object.freeze({
    id,
    capability: 'provider.credentials',
    extractNativeAuth: (source) => source.credentials || null,
    nativeIdentitySeed: (auth) => buildCodebuddyIdentitySeed(id, auth),
    // 未声明 importAliases：标准格式 / sub2api 导入暂不支持 CodeBuddy 家族（现状保留，见方案文档批 2）。
    transferIdentitySeed: (auth) => buildCodebuddyIdentitySeed(id, auth.credentials || auth)
  });
}

module.exports = { createCodebuddyFamilyCredentials };
