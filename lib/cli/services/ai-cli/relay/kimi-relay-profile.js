'use strict';

const { isAccountRef } = require('../../../../server/account-ref-store');
const { PINNED_ACCOUNT_HEADER } = require('../claude-account-relay');

// kimi relay 协议形态：config.toml 里 `type = "kimi"` + base_url 指向网关
// `/v1`，OpenAI chat completions 直通，网关零翻译。
// 备选扩展点（当前未启用，切换时只改本模块与 kimi-config.js 的 relay 模板）：
// 1. `type = "anthropic"` 协议路径——kimi CLI 同一 provider 注册了 anthropic
//    trait，base_url 换裸 root 即可对接网关的 Anthropic 端点；
// 2. config.toml 的 `[providers."managed:kimi-code".custom_headers]` 表注入
//    x-account-ref，替代 KIMI_CODE_CUSTOM_HEADERS env 通道（注意 config 值
//    优先级高于 envCustomHeaders，二选一不要并存）。

function hasDirectKimiCredential(accountEnv = {}) {
  return Boolean(String(accountEnv && accountEnv.MOONSHOT_API_KEY || '').trim());
}

// 判定对齐 claude：provider 是 kimi && accountRef 合法 && 非登录 && 非网关
// profile && 账号 env 无 MOONSHOT_API_KEY（API-key 账号维持直连不 relay）。
function shouldRelayKimiAccount(input = {}) {
  return String(input.provider || '').trim().toLowerCase() === 'kimi'
    && isAccountRef(String(input.accountRef || '').trim())
    && input.isLogin !== true
    && input.gateway !== true
    && !hasDirectKimiCredential(input.accountEnv);
}

function buildKimiAccountRelayEnv(gatewayEnv = {}, accountRef) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) {
    throw new Error('invalid_kimi_relay_account_ref');
  }
  // KIMI_CODE_CUSTOM_HEADERS 与 claude 的 ANTHROPIC_CUSTOM_HEADERS 同构：
  // 换行分隔的 `Name: value`，由 CLI 合并进每个请求的 defaultHeaders。
  const existingHeaders = String(gatewayEnv.KIMI_CODE_CUSTOM_HEADERS || '').trim();
  const pinHeader = `${PINNED_ACCOUNT_HEADER}: ${normalizedRef}`;
  return {
    ...gatewayEnv,
    KIMI_CODE_CUSTOM_HEADERS: [existingHeaders, pinHeader].filter(Boolean).join('\n')
  };
}

const kimiRelayProfile = Object.freeze({
  provider: 'kimi',
  shouldRelayAccount: shouldRelayKimiAccount,
  buildAccountRelayEnv: buildKimiAccountRelayEnv,
  // relay 必须保留账号沙箱：CLI 从 KIMI_CODE_HOME/config.toml 读 provider
  // 配置，relay 模板（无 oauth 块、base_url 指网关）要写进隔离沙箱，不能落
  // 宿主真实 ~/.kimi-code。只是不再投影 OAuth 凭据（详见接口契约注释）。
  relayKeepsAccountSandbox: true,
  buildGatewayProfileEnv(urls) {
    // kimi CLI 的 KimiChatProvider 在 config 值为空时回退读进程 env 的
    // KIMI_API_KEY / KIMI_BASE_URL；`type="kimi"` 是 OpenAI 形态，base URL
    // 必须带 /v1（与 claude 的裸 root 不同）。
    return {
      KIMI_API_KEY: urls.apiKey,
      KIMI_BASE_URL: urls.baseUrl
    };
  }
});

module.exports = {
  buildKimiAccountRelayEnv,
  hasDirectKimiCredential,
  kimiRelayProfile,
  shouldRelayKimiAccount
};
