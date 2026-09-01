'use strict';

// opencode 只有网关 profile 形态（裸 `aih opencode` 经 OPENCODE_CONFIG overlay
// 指到本地网关），没有 env 注入式钉账号 relay。
const opencodeRelayProfile = Object.freeze({
  provider: 'opencode',
  shouldRelayAccount: () => false,
  buildGatewayProfileEnv(urls) {
    // OpenCode routes via a generated OPENCODE_CONFIG overlay pointing the built-in
    // `anthropic` provider at the local gateway (keeping the host config + its
    // session-sync plugin intact). OpenAI-style /v1 base — opencode's anthropic
    // provider posts /v1/messages under it, which the gateway serves.
    return {
      AIH_OPENCODE_GATEWAY_BASE_URL: urls.baseUrl,
      AIH_OPENCODE_GATEWAY_KEY: urls.apiKey
    };
  }
});

module.exports = { opencodeRelayProfile };
