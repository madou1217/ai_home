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
const {
  resolveCodebuddyFamilyInferenceBaseUrl
} = require('./codebuddy-family-inference');
const { isCodebuddyFamilyProvider } = require('./codebuddy-billing');

const GROK_DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const KIRO_DEFAULT_BASE_URL = 'https://q.us-east-1.amazonaws.com';
// Cline 的 REST 面（Cline Pass 订阅与 API Key 共用同一端点），OpenAI Chat
// Completions 兼容：POST {base}/chat/completions、GET {base}/models。
// 账号级 CLINE_API_BASE_URL 可覆盖（自建/企业代理）。
const CLINE_DEFAULT_BASE_URL = 'https://api.cline.bot/api/v1';
// zcode 原生说 Anthropic 协议；API-key 账号默认走 bigmodel 国内端点，
// 账号级 ZCODE_BASE_URL 可覆盖为 https://api.z.ai/api/anthropic 等端点。
const ZCODE_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
// zcode OAuth 计划账号的余额/额度接口（桌面端同款），Bearer 为 zcodeJwtToken。
// 模型探测（http-utils）与 Remaining 探测（zcode-quota-probe）共用同一端点。
const ZCODE_PLAN_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
// zcode OAuth 计划账号的**推理端点**。
//
// **2026-10-27 真机纠偏**：此前用 `zcode.z.ai/api/v1/zcode-plan/anthropic`，
// 对 `glm-5.3-flash` 稳定返回 405 `code:3012`（unusual activity）——那不是风控、
// 也不是缺参数，而是**端点不对**。真正的端点由上游
// `/api/v1/agent/configs` 的 `proxyEndpoint.mapping` 下发（桌面端
// ProviderEndpointRoutingPort 就用它做路由，日志事件
// `model.provider_endpoint_routing.snapshot_updated` 可证）：
//
//   from https://open.bigmodel.cn/api/anthropic/v1/messages
//     to https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages      (bigmodel 区)
//   from https://api.z.ai/api/anthropic/v1/messages
//     to https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages  (zai 区)
//
// 并且请求要带**两个**鉴权头：`authorization: Bearer <区域 access_token>` 与
// `X-Zcode-Authorization: Bearer <zcodejwttoken>`（mapping 的 zcodeAuthorizationHeader
// 字段指明了后者）。真机验证：带齐两者时上游正常处理（返回 429
// 限流）；缺任一或落到旧端点则 401 / 3012。
const ZCODE_ULTRA_ANTHROPIC_BASE_URL = 'https://zcode.z.ai/api/v1/ultra/anthropic';
const ZCODE_ULTRA_ZAI_ANTHROPIC_BASE_URL = 'https://zcode.z.ai/api/v1/ultra-zai/anthropic';
// 区域 → ultra 推理端点。区域由凭据的 oauth:active_provider 定（见 zcode-region）。
const ZCODE_REGION_INFERENCE_BASE_URLS = Object.freeze({
  zai: ZCODE_ULTRA_ZAI_ANTHROPIC_BASE_URL,
  bigmodel: ZCODE_ULTRA_ANTHROPIC_BASE_URL
});

// 套餐类型 → 推理端点。判定依据是上游给的 plan_id（如 zcode-v3-start-plan-1024），
// **不是**展示名（"ZCode 1024 Dev Day" 这类文案判不出来）。
// 新增套餐 = 加一行表项，不在调用处写 if。
const ZCODE_PLAN_INFERENCE_BASE_URLS = Object.freeze({
  'start-plan': ZCODE_ULTRA_ANTHROPIC_BASE_URL,
  'individual-coding-plan': ZCODE_ULTRA_ANTHROPIC_BASE_URL,
  'team-coding-plan': ZCODE_ULTRA_ANTHROPIC_BASE_URL
});

/**
 * 由 plan_id / 套餐标识判定推理端点。
 * plan_id 形如 `zcode-v3-start-plan-1024`、`zcode-v3-individual-coding-plan-0817`。
 *
 * **未知/缺失时回落到 start-plan 端点而不是 coding-plan**（2026-10-26 真机取证）：
 * 额度探测的「0 套餐」是**已知的失败模式**（bigmodel 区账号在 zcode.z.ai 的
 * billing/balance 稳定返回 `{code:0, data:{plans:[], balances:[]}}`），它不构成
 * 「这是 coding-plan 账号」的证据。此时若回落到 coding-plan（api.z.ai），
 * 真机表现是 **401 / 405 code:3012**——该端点不认这类 OAuth 账号的 jwt
 * （两个账号实测都是 401）。而 start-plan 端，会接受它们：要么正常服务，
 * 要么给出干净的业务码（1005 等），不会伪装成风控拦截。
 */
function resolveZcodeInferenceBaseUrl(planId, region) {
  // **区域优先**：ultra 端点分两个（zai -> ultra-zai、bigmodel -> ultra），
  // 区域由凭据的 oauth:active_provider 定，是最可靠的输入。
  const regionKey = String(region || '').trim().toLowerCase();
  if (regionKey && ZCODE_REGION_INFERENCE_BASE_URLS[regionKey]) {
    return ZCODE_REGION_INFERENCE_BASE_URLS[regionKey];
  }
  const text = String(planId || '').trim().toLowerCase();
  if (!text) return ZCODE_ULTRA_ANTHROPIC_BASE_URL;
  for (const [kind, url] of Object.entries(ZCODE_PLAN_INFERENCE_BASE_URLS)) {
    if (text.includes(kind)) return url;
  }
  return ZCODE_ULTRA_ANTHROPIC_BASE_URL;
}
// zcode OAuth 计划账号的模型探测回退端点（Bearer 为 zai accessToken，会过期）。
const ZCODE_OAUTH_MODELS_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
// zcode 桌面端验证码/功能配置接口（无鉴权，桌面端缓存 1 小时）。
const ZCODE_CLIENT_CONFIGS_URL = 'https://zcode.z.ai/api/v1/client/configs';
// zcode 周末活动/试用套餐（Start Plan）：预览可领取套餐 + 领取。
// 领取前必须先通过阿里云无痕验证（configs.captcha），并带
// X-Aliyun-Captcha-Verify-Param / X-Aliyun-Captcha-Verify-Region 两个头。
const ZCODE_PLAN_PREVIEW_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/preview';
const ZCODE_PLAN_CLAIM_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/claim';

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
  if (normalized === 'cline') {
    return stripTrailingSlashes(fromAccount || CLINE_DEFAULT_BASE_URL);
  }
  // CodeBuddy / WorkBuddy 家族的推理端点按站点分流（国际站各用自己的域名，国内站两支
  // 共用 copilot.tencent.com），规则在家族内完全一致，所以归到这里统一解析。
  if (isCodebuddyFamilyProvider(normalized)) {
    return stripTrailingSlashes(resolveCodebuddyFamilyInferenceBaseUrl(normalized, account));
  }
  return '';
}

function ownsProviderApiBaseUrl(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return normalized === 'grok' || normalized === 'kimi' || normalized === 'kiro' || normalized === 'zcode'
    || normalized === 'cline'
    || isCodebuddyFamilyProvider(normalized);
}

module.exports = {
  GROK_DEFAULT_BASE_URL,
  KIRO_DEFAULT_BASE_URL,
  CLINE_DEFAULT_BASE_URL,
  ZCODE_DEFAULT_BASE_URL,
  ZCODE_PLAN_BALANCE_URL,
  ZCODE_PLAN_INFERENCE_BASE_URLS,
  ZCODE_REGION_INFERENCE_BASE_URLS,
  ZCODE_ULTRA_ANTHROPIC_BASE_URL,
  ZCODE_ULTRA_ZAI_ANTHROPIC_BASE_URL,
  resolveZcodeInferenceBaseUrl,
  ZCODE_OAUTH_MODELS_BASE_URL,
  ZCODE_CLIENT_CONFIGS_URL,
  ZCODE_PLAN_PREVIEW_URL,
  ZCODE_PLAN_CLAIM_URL,
  resolveProviderApiBaseUrl,
  ownsProviderApiBaseUrl
};
