'use strict';

const { buildCodebuddyIdentitySeed } = require('../subject-oauth-identity');
const { isPlainObject } = require('./transfer-fields');

// CodeBuddy 家族（国际站 / 国内站 / WorkBuddy 国际站 / WorkBuddy 国内站）原生凭据形状相同，
// 但站点与产品各不相同、账号体系互不相通，身份种子前缀由 buildCodebuddyIdentitySeed 按 provider 区分。
function createCodebuddyFamilyCredentials(id) {
  return Object.freeze({
    id,
    capability: 'provider.credentials',
    extractNativeAuth: (source) => source.credentials || null,
    nativeIdentitySeed: (auth) => buildCodebuddyIdentitySeed(id, auth),
    sub2apiCredentials: (auth) => ({ ...auth }),
    normalizeImportedOAuth: (account) => {
      const candidate = isPlainObject(account && account.credentials) ? account.credentials : account;
      return isPlainObject(candidate) && buildCodebuddyIdentitySeed(id, candidate) ? candidate : null;
    }
  });
}

module.exports = { createCodebuddyFamilyCredentials };
