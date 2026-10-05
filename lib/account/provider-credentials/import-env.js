'use strict';

const { getProviderCredentialFacts } = require('../../provider-catalog');

// 标准格式导入 API 密钥账号：写入合同里该 provider 的首选密钥变量与基础地址变量。
function apiKeyEnvFromFacts(provider, config) {
  const facts = getProviderCredentialFacts(provider);
  const env = { [facts.apiKeyEnv[0]]: config.apiKey };
  if (config.baseUrl) env[facts.baseUrlEnv[0]] = config.baseUrl;
  return env;
}

module.exports = { apiKeyEnvFromFacts };
