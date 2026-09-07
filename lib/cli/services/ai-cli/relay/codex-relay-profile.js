'use strict';

// API-key 账号经本机网关，URL/key/pin 同时切换；OAuth 和登录保留原生路径。
const { isAccountRef } = require('../../../../server/account-ref-store');
const {
  buildCodexProviderArgs,
  hasCodexModelProviderArg,
  injectCodexProviderArgs
} = require('../codex-provider-args');

const codexRelayProfile = Object.freeze({
  provider: 'codex',
  shouldRelayAccount(input = {}) {
    return input.provider === 'codex' && isAccountRef(input.accountRef)
      && input.isLogin !== true && input.gateway !== true
      && !hasCodexModelProviderArg(input.args || [])
      && Boolean(String(input.accountEnv?.OPENAI_API_KEY || '').trim());
  },
  buildAccountRelayEnv(gatewayEnv, accountRef) {
    if (!isAccountRef(accountRef)) throw new Error('invalid_codex_relay_account_ref');
    return { ...gatewayEnv, AIH_CODEX_GATEWAY_ACCOUNT_REF: accountRef };
  },
  buildGatewayProfileEnv(urls) {
    return {
      OPENAI_API_KEY: urls.apiKey,
      OPENAI_BASE_URL: urls.baseUrl
    };
  },
  // input: { args, accountEnv, isLogin, gateway }；返回 { args } 或 null。
  buildRelayLaunch(input = {}) {
    if (input.isLogin === true) return null;
    const args = Array.isArray(input.args) ? input.args : [];
    if (hasCodexModelProviderArg(args)) return null;
    return {
      args: injectCodexProviderArgs(
        args,
        buildCodexProviderArgs(input.accountEnv, { force: input.gateway === true })
      )
    };
  }
});

module.exports = { codexRelayProfile };
