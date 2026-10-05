'use strict';

const { emailIdentitySeed } = require('./email-identity');

module.exports = Object.freeze({
  id: 'gemini',
  capability: 'provider.credentials',
  // 原生凭据里没有比邮箱更稳定的字段：邮箱即身份（账号描述对象也可据邮箱出种子）。
  emailIsIdentity: true,
  extractNativeAuth: (source) => {
    const email = String(source.googleAccounts && source.googleAccounts.active || '').trim();
    return source.oauthCreds ? { ...source.oauthCreds, ...(email ? { email } : {}) } : null;
  },
  nativeIdentitySeed: (auth) => emailIdentitySeed('gemini', auth)
});
