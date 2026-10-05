'use strict';

const { emailIdentitySeed } = require('./email-identity');

module.exports = Object.freeze({
  id: 'agy',
  capability: 'provider.credentials',
  // 原生凭据里没有比邮箱更稳定的字段：邮箱即身份（账号描述对象也可据邮箱出种子）。
  emailIsIdentity: true,
  extractNativeAuth: (source) => {
    const email = String(source.email || '').trim();
    return source.oauthToken ? { ...source.oauthToken, ...(email ? { email } : {}) } : null;
  },
  // AGY 的原生 oauthToken 没有比邮箱更稳定的字段，邮箱是它唯一可用的身份（见 ADR「未覆盖项」）。
  nativeIdentitySeed: (auth) => emailIdentitySeed('agy', auth)
});
