'use strict';

// Upstream base URL for the API-key/OAuth style providers whose endpoint is a
// plain HTTPS host (grok / kimi / kiro / zcode), kept in ONE place.
//
// The four core providers (codex / claude / gemini / agy) deliberately resolve
// their base URL differently on each path — Code Assist needs a default that the
// chat path must not apply, and claude honours an account-level override — so
// they stay with their callers. This module owns only the providers whose rule
// is identical everywhere, which is exactly the set that used to be missing:
// `resolveProviderUpstream` (chat) knew about them while
// `resolveProviderBaseUrl` (model probe / usage) silently fell through to
// `codexBaseUrl`, i.e. probed a kimi account against chatgpt.com.
//
// Returning '' means "not owned here" — the caller must NOT substitute another
// provider's endpoint for it. A wrong-but-plausible base URL is worse than an
// empty one: it fails as an auth error against someone else's host instead of a
// clear misconfiguration.

const { resolveKimiBaseUrl } = require('./kimi-endpoints');

const GROK_DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const KIRO_DEFAULT_BASE_URL = 'https://q.us-east-1.amazonaws.com';
// zcode 原生说 Anthropic 协议；API-key 账号默认走 bigmodel 国内端点，
// 账号级 ZCODE_BASE_URL 可覆盖为 https://api.z.ai/api/anthropic 等端点。
const ZCODE_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
// zcode OAuth 计划账号的余额/额度接口（桌面端同款），Bearer 为 zcodeJwtToken。
// 模型探测（http-utils）与 Remaining 探测（zcode-quota-probe）共用同一端点。
const ZCODE_PLAN_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
// zcode OAuth 计划账号的推理端点（Anthropic 协议，桌面端同款）。凭据是
// zcodeJwtToken（Bearer + x-api-key 双头）；每请求强制阿里云 Captcha 2.0
// 验证码（X-Aliyun-Captcha-Verify-Param），由 lib/server/zcode-captcha-bridge.js
// 经 WebUI 桥接求解。
const ZCODE_PLAN_ANTHROPIC_BASE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic';
// zcode OAuth 计划账号的模型探测回退端点（Bearer 为 zai accessToken，会过期）。
const ZCODE_OAUTH_MODELS_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
// zcode 桌面端验证码/功能配置接口（无鉴权，桌面端缓存 1 小时）。
const ZCODE_CLIENT_CONFIGS_URL = 'https://zcode.z.ai/api/v1/client/configs';

function stripTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function readAccountOpenAiBaseUrl(account) {
  return String(account && account.openaiBaseUrl || '').trim();
}

// '' when the provider is not one of grok/kimi/kiro/zcode.
function resolveProviderApiBaseUrl(provider, account) {
  const normalized = String(provider || '').trim().toLowerCase();
  const fromAccount = readAccountOpenAiBaseUrl(account);

  if (normalized === 'grok') {
    return stripTrailingSlashes(fromAccount || GROK_DEFAULT_BASE_URL);
  }
  if (normalized === 'kimi') {
    // kimi splits by credential kind: the coding endpoint for OAuth logins,
    // the public API host for raw API keys.
    return stripTrailingSlashes(resolveKimiBaseUrl({
      baseUrl: fromAccount,
      apiKeyMode: Boolean(account && account.apiKeyMode)
    }));
  }
  if (normalized === 'kiro') {
    return stripTrailingSlashes(fromAccount || KIRO_DEFAULT_BASE_URL);
  }
  if (normalized === 'zcode') {
    return stripTrailingSlashes(fromAccount || ZCODE_DEFAULT_BASE_URL);
  }
  return '';
}

function ownsProviderApiBaseUrl(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return normalized === 'grok' || normalized === 'kimi' || normalized === 'kiro' || normalized === 'zcode';
}

module.exports = {
  GROK_DEFAULT_BASE_URL,
  KIRO_DEFAULT_BASE_URL,
  ZCODE_DEFAULT_BASE_URL,
  ZCODE_PLAN_BALANCE_URL,
  ZCODE_PLAN_ANTHROPIC_BASE_URL,
  ZCODE_OAUTH_MODELS_BASE_URL,
  ZCODE_CLIENT_CONFIGS_URL,
  resolveProviderApiBaseUrl,
  ownsProviderApiBaseUrl
};
