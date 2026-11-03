'use strict';

// API-key 账号经本机网关，URL/key/pin 同时切换；OAuth 和登录保留原生路径。
const { isAccountRef } = require('../../../../server/account-ref-store');
const { setCodexFlag } = require('../../../../runtime/codex-flags');
const {
  buildCodexProviderArgs,
  hasCodexModelProviderArg,
  injectCodexProviderArgs
} = require('../codex-provider-args');

const codexRelayProfile = Object.freeze({
  provider: 'codex',
  // 会话键送达：单个 env 变量承载，由 codex-provider-args 翻译成
  // `-c model_providers.aih_server.http_headers.X-Session-Id=`（与账号钉选头同一条路径）。
  sessionKeyTransport: Object.freeze({ kind: 'env-value', envKey: 'AIH_CODEX_GATEWAY_SESSION_KEY' }),
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
  // 跨 Provider harness：身份账号的模型不属于 Codex 的协议族，Go Core 上同一入口的
  // 协议桥尚未对齐，因此显式要求 Node 完整实现这条请求（由 codex-provider-args 翻译成
  // `-c model_providers.aih_server.http_headers.X-Aih-Route-Owner=node`）。
  buildCrossProviderEnv(gatewayEnv, accountRef) {
    if (!isAccountRef(accountRef)) throw new Error('invalid_codex_relay_account_ref');
    // 路由归属并进已有的 AIH_CODEX_FLAGS 上下文（AGENTS.md：已合并的上下文变量只许继续合并，
    // 不许为单个字段再开一个 AIH_*）。
    return setCodexFlag({
      ...gatewayEnv,
      AIH_CODEX_GATEWAY_ACCOUNT_REF: accountRef
    }, 'routeOwner', 'node');
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
