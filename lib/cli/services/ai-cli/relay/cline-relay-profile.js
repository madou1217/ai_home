'use strict';

const { CLINE_GATEWAY_ENV, serializeClineGateway } = require('../cline-gateway-context');

// cline 只有网关 profile 形态，没有 env 注入式钉账号 relay：
// Cline 的推理端点来自 providers.json 槽位而不是 env，所以这里只把
// 网关连接参数交给启动策略（launch-profile/cline-strategy 落盘 + `-P` 推导）。
const clineRelayProfile = Object.freeze({
  provider: 'cline',
  shouldRelayAccount: () => false,
  buildGatewayProfileEnv(urls) {
    return {
      [CLINE_GATEWAY_ENV]: serializeClineGateway({
        baseUrl: urls.baseUrl,
        apiKey: urls.apiKey
      })
    };
  }
});

module.exports = { clineRelayProfile };
