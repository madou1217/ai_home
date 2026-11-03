'use strict';

const { getProviderCredentialFacts } = require('../provider-catalog');

// 按 provider 合同里的凭据事实读取账号环境变量：列表即优先级，取第一个非空值。
// 调用方据此判断 API 密钥模式、读取基础地址，不再各自维护一张 provider → 变量名的表。

function firstEnvValue(env, keys) {
  const source = env && typeof env === 'object' ? env : {};
  for (const key of keys) {
    const value = String(source[key] || '').trim();
    if (value) return value;
  }
  return '';
}

/** API 密钥或鉴权令牌（密钥优先）；空串表示该账号不是密钥类凭据。 */
function readProviderApiCredential(provider, env) {
  const facts = getProviderCredentialFacts(provider);
  return firstEnvValue(env, [...facts.apiKeyEnv, ...facts.authTokenEnv]);
}

/** 账号环境变量里配置的 API 基础地址；没有配置时为空串。 */
function readProviderBaseUrl(provider, env) {
  return firstEnvValue(env, getProviderCredentialFacts(provider).baseUrlEnv);
}

module.exports = {
  firstEnvValue,
  readProviderApiCredential,
  readProviderBaseUrl
};
