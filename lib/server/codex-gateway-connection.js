'use strict';

const { buildServerBaseUrl, DEFAULT_SERVER_API_KEY } = require('./server-defaults');
const { readServerConfig } = require('./server-config-store');

// URL、网关认证和账号绑定是同一个连接契约，不能分别从宿主 env 与账号取值。
function buildCodexGatewayConnection(config = {}, accountRef = '') {
  const baseUrl = buildServerBaseUrl(config);
  const apiKey = String(config.apiKey || '').trim() || DEFAULT_SERVER_API_KEY;
  const ref = String(accountRef || '').trim();
  return {
    baseUrl,
    apiKey,
    httpHeaders: ref ? { 'X-Account-Ref': ref } : {},
    env: {
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: apiKey,
      AIH_CODEX_GATEWAY_ACCOUNT_REF: ref
    }
  };
}

function readCodexGatewayConnection(fs, aiHomeDir, accountRef = '') {
  return buildCodexGatewayConnection(readServerConfig({ fs, aiHomeDir }), accountRef);
}

module.exports = { buildCodexGatewayConnection, readCodexGatewayConnection };
