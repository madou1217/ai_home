'use strict';

const { parseProviderRetryHintMs } = require('./retry-hints');
const { ZCODE_QUOTA_BUSINESS_CODE } = require('./zcode-business-error');
const { getCodexQuotaFailure, codexQuotaRetryDelay } = require('./codex-response-recovery');
const { classifyConfiguredUpstreamFailure } = require('./upstream-error-rule-policy');
const { isCustomUpstreamAccount } = require('../account/official-upstream-endpoint');

const { API_KEY_REJECTED_COOLDOWN_MS } = require('./account-runtime-state');
const { MODEL_CAPACITY_COOLDOWN_MS, MODEL_CAPACITY_MAX_COOLDOWN_MS } = require('../cli/config/constants');

const DEFAULT_AUTH_INVALID_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_OVERLOAD_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS = 60 * 1000;
const DEFAULT_SERVER_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
// Transient connectivity blips (fetch failed / socket reset / timeout) are
// almost always client/proxy-side and self-heal in seconds. They must NOT pull
// a healthy account out of the pool on a single occurrence; that lets one
// shared-proxy hiccup empty the whole pool and surface as no_available_account.
// So: require several consecutive failures before cooling, and keep the cooldown
// short so the account re-probes quickly once connectivity returns.
const DEFAULT_TRANSIENT_NETWORK_COOLDOWN_MS = 30 * 1000;
const TRANSIENT_NETWORK_FAILURE_THRESHOLD = 2;
// 空产出（上游流结束或错误信封声明「没有内容」）是请求级瞬态：报错的请求必须记录
// （连击 + 最近失败原因 → 账号页可解释），但只有「无成功间隔的连续 2 次」才升级为
// 30s 短冷却——既不像通用 5xx 那样单次就挂 5 分钟，也不放任重复异常持续打上游。
const EMPTY_MODEL_CONTENT_FAILURE_THRESHOLD = 2;
const DEFAULT_EMPTY_MODEL_CONTENT_COOLDOWN_MS = 30 * 1000;
// 连击窗口必须大于单次请求时长（空产出是整次生成结束后才暴露的失败）；成功会整条
// 清掉连击（clearAccountModelState），所以宽窗口不会把非连续失败累计进来。
const EMPTY_MODEL_CONTENT_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_UNSUPPORTED_LOCATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Plan entitlement is a durable state that only changes when the operator
// upgrades, so re-probing every few minutes is pointless — but it is not
// permanent either, hence a day rather than the auth_invalid year.
const DEFAULT_MODEL_ENTITLEMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MODEL_REGION_RESTRICTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// A monthly usage cap (e.g. opencode GoUsageLimitError "resets in N days") blocks
// the whole workspace/account until reset, so cool the ACCOUNT (all its models),
// not just one (account, model). Floor 24h, cap 30d if the reset hint is huge.
const DEFAULT_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const CLINE_PASS_CAP_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
// 「这个端点没有这个模型」是相对稳定的事实，但中转商随时可能上新模型，
// 所以冷却半小时——足够避免每次请求都去撞同一批不支持的账号，又不至于
// 让新上线的模型半天发现不了。
const DEFAULT_MODEL_NOT_ON_ENDPOINT_COOLDOWN_MS = 30 * 60 * 1000;
// opencode 免费档 429（FreeUsageLimitError）的冷却边界。上游把恢复时刻写在 retry-after 里
// （opencode 2.1.2 的「Free limit reached → Resets at …」渲染的就是这个头），按提示冷却；
// 下限 60s 挡 0/负值，上限 24h 挡离谱值——免费档的日额度窗口最多也就一天，再长就是把
// 这个 (账号,模型) 无理由钉死。没有提示时保持历史的 5 分钟。
const OPENCODE_FREE_LIMIT_MIN_COOLDOWN_MS = 60 * 1000;
const OPENCODE_FREE_LIMIT_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function collectFailureText(options = {}) {
  return [
    options.detail,
    options.body,
    options.error && options.error.body,
    options.error && options.error.upstreamBody,
    describeError(options.error)
  ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean).join('\n');
}

const {
  isEdgeBlockedResponse,
  isEdgeGatewayFormatRejection,
  buildEdgeBlockedPolicy,
  buildEdgeGatewayFormatRejectedPolicy
} = require('./upstream-edge-block');

const SAFETY_REJECTION_CODES = new Set([
  'content_policy_violation',
  'safety_rejected',
  'sensitive_words_detected'
]);

function parseStructuredFailureBody(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  const text = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : normalizeText(value);
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function extractStructuredFailureCode(options = {}) {
  const body = parseStructuredFailureBody(options.body);
  const candidates = [
    body && body.error && body.error.code,
    body && body.response && body.response.error && body.response.error.code,
    body && body.last_error && body.last_error.code,
    body && body.response && body.response.last_error && body.response.last_error.code,
    body && body.code,
    body && body.detail && body.detail.code,
    options.error && options.error.code
  ];
  for (const candidate of candidates) {
    const code = normalizeText(candidate).toLowerCase();
    if (code) return code;
  }
  return '';
}

function isStructuredSafetyRejection(options = {}) {
  return SAFETY_REJECTION_CODES.has(extractStructuredFailureCode(options));
}

// qoder 全球站的服务端资源限流响应形状（2026-10-21 真机取证）：
//   HTTP 403 {"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true,\\\"modelKey\\\":\\\"...\\\",\\\"queueCount\\\":0,\\\"queueType\\\":\\\"p3\\\",\\\"retryAfterSeconds\\\":30,\\\"serviceAvailable\\\":false,\\\"subCode\\\":\\\"RESOURCE_LIMIT\\\",\\\"waitTime\\\":30}\",\"subCode\":\"RESOURCE_LIMIT\"}"}
// 凭据有效，只是当前模型被上游排队/限流，**绝不能**落进通用 403→auth_invalid
//（否则会把健康账号锁一年）。详见 upstream-edge-block 的类比原则：与凭据无关，
// 不记账号失败、不换号、不冷却；只在本次策略失败里标记过载，由 HTTP 策略回落 CLI。
function qoderQueueDetailText(options = {}) {
  // 两个真实调用形状都要覆盖：策略链只传 `error`（message 就是上游 JSON），
  // 单测/探针可能直接传 `detail` / `body`。
  const text = normalizeText(options.detail || options.body)
    || normalizeText(options.error && (
      options.error.upstreamBody || options.error.body || options.error.message
    ))
    || '';
  if (!text) return '';
  // 限流负载可能被套了多层 JSON 字符串（实测三层：外层 code/message →
  // 中间 code 10605/message → 真正的 isQueued/retryAfterSeconds）。
  // 逐层解开并把每层拼起来，正则只需在任意一层命中。
  let joined = text;
  let current = null;
  try { current = JSON.parse(text); } catch (_error) { return text; }
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    joined += `\n${JSON.stringify(current)}`;
    if (typeof current.message !== 'string') break;
    try { current = JSON.parse(current.message); } catch (_error) { break; }
  }
  return joined;
}

function parseQoderRetryAfterMs(options = {}) {
  const text = qoderQueueDetailText(options);
  const m = text.match(/"retryAfterSeconds"\s*:\s*(\d+)/);
  if (m) return Number(m[1]) * 1000;
  const m2 = text.match(/"waitTime"\s*:\s*(\d+)/);
  if (m2) return Number(m2[1]) * 1000;
  return 0;
}

function isQoderResourceLimitDetail(options = {}) {
  const lower = qoderQueueDetailText(options).toLowerCase();
  if (!lower) return false;
  return (
    lower.includes('"10605"') ||
    lower.includes('"resource_limit"') ||
    /"isqueued"\s*:\s*true/.test(lower)
  );
}

function buildSafetyRejectedPolicy() {
  return {
    kind: 'safety_rejected',
    retryable: false,
    shouldMarkFailure: false,
    // Safety decisions are request-scoped. Rotating credentials here would
    // both misdiagnose account health and turn routing into policy evasion.
    shouldRetryAnotherAccount: false,
    shouldPassthroughToClient: false,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: 403,
    failureReason: 'safety_rejected',
    detail: 'upstream_safety_rejected',
    scope: 'none',
    shouldUnbindSession: false
  };
}

function isCapacityOverloadDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('selected model is at capacity. please try a different model.')
    || detail.includes('selected model is at capacity');
}

function isModelCapacityUnavailableDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('no capacity available for model');
}

function isAccountModelQuotaExhaustedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('exhausted your capacity on this model');
}

function isProviderQuotaExhaustedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('resource has been exhausted')
    || detail.includes('quota exhausted')
    || detail.includes('quota exceeded')
    || (detail.includes('resource_exhausted') && (detail.includes('quota') || detail.includes('check quota')));
}

// zcode（智谱/Z.ai）用 HTTP 200 + {"code":1005,"msg":"exceed quota limit"} 表达
// 配额拒绝，状态码永远是 200，因此必须按结构化业务码判定、与传输层状态无关。
// 只认 code，不匹配 msg 文案：同一份 detail 里 "exceed quota limit" 与
// isProviderQuotaExhaustedDetail 的 "quota exceeded" 词序不同，靠文案匹配既漏判
// 又容易误伤别的 provider。
function isZcodeQuotaBusinessRejection(options = {}) {
  if (normalizeText(options.provider).toLowerCase() !== 'zcode') return false;
  return extractStructuredFailureCode(options) === String(ZCODE_QUOTA_BUSINESS_CODE);
}

// A hard, workspace-wide usage cap (not a transient rate limit): opencode-go
// returns `GoUsageLimitError` / "Monthly usage limit reached. Resets in N days".
// It must NOT be treated as a 5-minute rate limit that last-resort keeps re-hitting.
function isProviderUsageLimitReachedDetail(options = {}) {
  const detail = collectFailureText(options);
  // Both markers are opencode-specific (GoUsageLimitError is its error class;
  // "monthly usage limit" is its wording). Kept narrow on purpose: this runs in
  // the shared classifier, so a looser substring like "usage limit reached"
  // would mis-scope an unrelated provider's 429 into a 24h account-wide cooldown.
  return detail.includes('gousagelimiterror')
    || detail.includes('monthly usage limit');
}

// Parse a reset hint like "resets in 13 days" / "resets in 5 hours" / "resets in 6d 8h" /
// "resets in 2h 15m" into ms (the units are summed). Returns 0 when no hint is present so the
// caller can fall back to a default.
const RESET_UNIT_MS = Object.freeze({ d: 86400000, h: 3600000, m: 60000 });
function parseUsageLimitResetCooldownMs(detail) {
  const hint = /resets?\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*(?:and\s+)?)+)/i
    .exec(String(detail || ''));
  if (!hint) return 0;
  let total = 0;
  const partRe = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi;
  let part;
  while ((part = partRe.exec(hint[1])) !== null) {
    const amount = Number(part[1]);
    if (Number.isFinite(amount) && amount > 0) total += amount * RESET_UNIT_MS[part[2][0].toLowerCase()];
  }
  return total > 0 ? Math.min(total, MAX_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS) : 0;
}

// Cline Pass usage caps: `INFERENCE_CAP_ERROR` "You have reached your weekly / 5-hour Clinepass
// limit. The limit resets in 6d 8h". This is the account's plan window, not a transient rate
// limit: with the generic 5-minute model cooldown the gateway re-hit the exhausted account 132
// times in a day (2026-10-18), failing every turn routed to it. Cool the account until the reset.
function isClinePassUsageCapDetail(options = {}) {
  if (extractStructuredFailureCode(options) === 'inference_cap_error') return true;
  const detail = collectFailureText(options);
  return detail.includes('inference_cap_error') || detail.includes('clinepass limit');
}

function isStreamDisconnectedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('stream disconnected before completion');
}

// Code Assist (AGY/Gemini) reports an overlong prompt as a plain HTTP 400
// string instead of the OpenAI-compatible `context_length_exceeded` code.
// Keep this matcher deliberately narrow: this is a request-scoped condition
// and must reach Codex so its native compaction/retry path can handle it.
function isContextLengthExceededDetail(options = {}) {
  const structuredCode = extractStructuredFailureCode(options);
  if (structuredCode === 'context_length_exceeded'
      || structuredCode === 'context_window_exceeded') {
    return true;
  }
  const detail = collectFailureText(options);
  return detail.includes('input token count exceeds')
    || detail.includes('maximum number of tokens allowed')
    || detail.includes('prompt is too long')
    || detail.includes('context length exceeded')
    || detail.includes('context_length_exceeded');
}

function buildContextLengthExceededPolicy(detail, clientStatusCode = 400) {
  return {
    kind: 'context_length_exceeded',
    retryable: false,
    shouldMarkFailure: false,
    shouldRetryAnotherAccount: false,
    shouldPassthroughToClient: true,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode,
    failureReason: 'context_length_exceeded',
    detail,
    scope: 'none',
    shouldUnbindSession: false
  };
}

// A relay can accept the credential and still refuse ONE model because the
// plan does not include it (ollama cloud answers 403 "this model requires a
// subscription, upgrade for access"). The credential is valid, so classifying
// it as auth_invalid would cool the entire account for a year — and take the
// account's entitled models down with it — over a model the caller merely is
// not subscribed to. Markers stay narrow: both are entitlement wording, never
// emitted for an actually rejected credential.
function isModelEntitlementDeniedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('requires a subscription')
    || detail.includes('upgrade for access')
    || (normalizeText(options.provider).toLowerCase() === 'opencode'
      && detail.includes('an active opencode go subscription is required to use go models'));
}

function isOpenCodeFreeUsageLimitDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('freeusagelimiterror')
    || detail.includes('free usage limit reached')
    || detail.includes('free model rate limit');
}

// Zen 免费档的**客户端门禁**（2026-10-15 实测）：与凭据完全无关——匿名、伪造 key、
// 账号真 key，甚至逐字节复刻 opencode CLI 的请求头/UA，直打 /zen/v1/* 一律
// 403 FreeTierError("OpenCode's free tier can only be used from within OpenCode")；
// 只有真实 opencode 二进制能过。免费模型因此改由 opencode-free-cli-transport 走原生
// CLI 桥接。这条判定兜住「CLI 通道也吃到门禁」与「有人直接打 HTTP 通道」两种情况：
// 它不是凭据失效，落进通用 401/403 分支会把整个账号锁 1 年（实测 cooldown 31536000000ms），
// 换账号/换出口也都不解决，所以必须单独分类。
function isOpenCodeFreeTierBlockedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('freetiererror')
    || detail.includes('free tier can only be used from within opencode');
}

// FreeTierError 的另一层含义（2026-10-19 实测）：「detected abusive traffic from this IP address」——
// 出口 IP 被拉黑。它不是请求形状问题（换形状 / 交给 CLI 都没用，CLI 走同一个出口），也不会几分钟内
// 翻转；只有换到别的出口才行。出口池据此把该节点长时间冷却（见 egress-pool-node-health）。
function isOpenCodeFreeTierIpBlockedDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('abusive traffic from this ip')
    || detail.includes("aren't available from your current network");
}

// 免费档门禁的处置：不锁账号、不换号重试、不冷却，把可读原因透出。
// 免费模型的正规通道是 opencode-free-cli-transport（原生 CLI）；这条兜住
// 「CLI 也被门禁」与「HTTP 通道被直打」，避免落进 auth_invalid 的 1 年锁号。
function buildOpenCodeFreeTierBlockedPolicy(options = {}) {
  return {
    kind: 'model_entitlement_required',
    retryable: false,
    shouldMarkFailure: false,
    shouldRetryAnotherAccount: false,
    shouldPassthroughToClient: true,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: Number(options.statusCode) || 403,
    failureReason: 'opencode_free_tier_client_gated',
    detail: isOpenCodeFreeTierIpBlockedDetail(options)
      ? 'OpenCode 免费模型拒绝了当前出口 IP（检测到滥用流量，与账号无关）：换一个出口即可；'
        + '绑定出口池的账号会自动换节点，并把这个节点长时间冷却'
      : 'OpenCode 免费模型只允许 opencode 官方客户端调用（FreeTierError）：'
        + '请确认本机已安装 opencode CLI 并保持账号有效；免费模型经原生 CLI 通道转发，'
        + '直连 HTTP 端点会被上游拒绝',
    // 结构化标记：出口 IP 被拉黑（不是请求形状问题）。出口池据此长时间冷却该节点。
    ...(isOpenCodeFreeTierIpBlockedDetail(options) ? { openCodeFreeIpBlocked: true } : {}),
    scope: 'none',
    shouldUnbindSession: false
  };
}

function isOpenCodeMissingPaidCredentialDetail(options = {}) {
  const code = String(options.error && options.error.code || '').trim().toLowerCase();
  if (code === 'invalid_opencode_go_api_key') return true;
  return collectFailureText(options).includes('invalid_opencode_go_api_key');
}

function buildOpenCodeMissingPaidCredentialPolicy(options = {}) {
  return {
    kind: 'model_entitlement_required',
    retryable: false,
    shouldMarkFailure: false,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: 403,
    failureReason: 'opencode_paid_credential_missing',
    detail: 'opencode_paid_credential_missing: 这个 OpenCode 账号没有付费 API Key（Zen/Go），'
      + '付费模型无法使用；请在账号里配置付费 Key，或改用免费模型（-free / 价格为 0）',
    scope: 'none',
    shouldUnbindSession: false
  };
}

function isOpenCodeCreditsErrorDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('creditserror')
    || detail.includes('opencode.ai/workspace/wrk_')
    || (detail.includes('credits') && detail.includes('add credits'));
}

// 出口代理协议不被该传输支持。两种已知形态：
//   - opencode 免费档的 CLI 通道显式抛出的 opencode_free_cli_proxy_unsupported（Bun 只认 HTTP 代理）
//   - Bun 自己抛的 UnsupportedProxyProtocol
function isUnsupportedProxyProtocolDetail(options = {}) {
  const detail = collectFailureText(options);
  const code = String(options.error && options.error.code || '').trim().toLowerCase();
  if (code === 'opencode_free_cli_proxy_unsupported') return true;
  return detail.includes('opencode_free_cli_proxy_unsupported')
    || detail.includes('unsupportedproxyprotocol');
}

// 代理协议不支持的处置：不锁账号、不冷却、不换号重试（换号仍是同一个出口，必然再失败），
// 把可读原因透出给用户，让界面指向「出口配置」而不是「账号」。
function buildUnsupportedProxyProtocolPolicy(options = {}) {
  return {
    kind: 'proxy_protocol_unsupported',
    retryable: false,
    shouldMarkFailure: false,
    shouldRetryAnotherAccount: false,
    shouldPassthroughToClient: true,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: 502,
    failureReason: 'proxy_protocol_unsupported',
    detail: '该 provider 的原生客户端不支持这个出口代理协议（opencode 的 Bun 运行时只认 '
      + 'HTTP(S) 代理）：请把出口改为 http(s):// 地址，或改用系统代理 / 外部 TUN',
    scope: 'none',
    shouldUnbindSession: false
  };
}

function isOpenCodeModelRegionRestrictedDetail(options = {}) {
  if (normalizeText(options.provider).toLowerCase() !== 'opencode') return false;
  const detail = collectFailureText(options);
  return detail.includes('regionerror')
    && (detail.includes('only available hosted in china')
      || detail.includes('requires explicit opt in'));
}

// 「这个账号/端点根本没有这个模型」——中转商、官方 ChatGPT 账号都会以 400/404 这样答。
// 与 invalid_request 的区别：错误是绑在 (账号, 模型) 上的，换个账号很可能就能服务，
// 所以必须换号重试并给这对组合打冷却，而不是把 400 直接甩给客户端。
function isItemNotFoundOrEncryptedContentDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('invalid_encrypted_content')
    || detail.includes('could not be decrypted or parsed')
    || (detail.includes('item with id') && detail.includes('not found'))
    || detail.includes('items are not persisted');
}

function isModelNotAvailableOnEndpointDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('invalid model name')
    || detail.includes('model_not_found')
    || detail.includes('is not supported by any configured account')
    || detail.includes('unknown provider for model')
    || detail.includes('is not supported when using codex with a chatgpt account')
    || /the model .* does not exist/.test(detail)
    || (detail.includes('model') && detail.includes('does not exist or you do not have access'));
}

// 「这个**账号的档位**不支持该模型」—— 与「模型在端点不存在」语义不同，但对路由的含义
// 一样：**换个账号**（另一个可能是 pro 档）就能用，所以必须换号，而不是把 400 原样透给客户端。
//
// 2026-10-22 真机：CodeBuddy/WorkBuddy 家族对免费档返回
//   {"code":11158,"msg":"model [gemini-3.5-flash] is not allowed for user type [personal_free_user]"}
// 此前这条没有登记，落进通用 400 分支（invalid_request / shouldRetryAnotherAccount:false），
// 于是 free 账号把请求直接打死，**同池的 pro 账号从未被尝试**。
//
// 判据按**结构化错误码**（11158），不从人类可读文本猜 —— 文本随语言/版本变（中英繁三语
// displayMsg），码是稳定契约。文本只作补充，覆盖上游换码但保留措辞的情况。
const ACCOUNT_TIER_MODEL_DENIED_CODES = new Set(['11158']);

function isAccountTierModelDeniedDetail(options = {}) {
  if (ACCOUNT_TIER_MODEL_DENIED_CODES.has(extractStructuredFailureCode(options))) return true;
  return collectFailureText(options).includes('is not allowed for user type');
}

function buildModelNotAvailableOnEndpointPolicy(detail, clientStatusCode) {
  return {
    kind: 'model_not_available_on_endpoint',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: DEFAULT_MODEL_NOT_ON_ENDPOINT_COOLDOWN_MS,
    clientStatusCode,
    failureReason: 'model_not_available_on_endpoint',
    detail,
    scope: 'model',
    shouldUnbindSession: true,
    // 上游说的是「这个**端点**没有这个模型」（端点即 provider 的上游接入点），是 provider 级
    // 事实而非账号属性：同 provider 换账号也救不回来。调用方据此登记 provider 级负面事实，
    // 让后续路由不再把同一模型送回同一个 provider（见 provider-model-availability）。
    // 与 11158 的区别正在这里 —— 那条是账号档位属性，所以**不**标这个。
    providerModelUnavailable: true
  };
}

function isDeactivatedWorkspaceDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('deactivated_workspace');
}

function isUnsupportedLocationDetail(options = {}) {
  const detail = collectFailureText(options);
  return detail.includes('user location is not supported for the api use')
    || (detail.includes('failed_precondition') && detail.includes('location is not supported'));
}

function buildOverloadPolicy(detail, defaultCooldownMs, clientStatusCode = 503) {
  return {
    kind: 'overloaded',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(defaultCooldownMs, DEFAULT_OVERLOAD_COOLDOWN_MS),
    clientStatusCode,
    failureReason: detail,
    detail,
    scope: 'account',
    shouldUnbindSession: false
  };
}

function buildModelCapacityPolicy(detail, clientStatusCode = 429, options = {}) {
  return {
    kind: 'model_capacity_unavailable',
    retryable: true,
    // Cool ONLY this (account, model) tuple so the scheduler stops hammering an
    // exhausted model but keeps the account's other models in rotation, and so
    // alias fallback can switch to a different model once all accounts for this
    // one are cooling down.
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: options.shouldRetryAnotherAccount !== false,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(1000, Number(options.cooldownMs) || DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS),
    failureWindowMs: MODEL_CAPACITY_MAX_COOLDOWN_MS * 2,
    // Only hint-free capacity failures use exponential local backoff.
    capacityBackoff: options.capacityBackoff === true,
    clientStatusCode,
    failureReason: detail,
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

function buildModelQuotaExhaustedPolicy(detail, clientStatusCode = 429, options = {}) {
  return {
    kind: 'model_quota_exhausted',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: options.shouldRetryAnotherAccount !== false,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(1000, Number(options.cooldownMs) || DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS),
    clientStatusCode,
    failureReason: detail,
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

// 额度窗口驱动的冷却时长：调用方（知道账号与模型的传输层）把「该模型窗口何时恢复」
// 作为 options.modelWindowResetAtMs 传进来；没有/已过期 → 0（沿用常规冷却）。
const MAX_MODEL_WINDOW_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function modelWindowCooldownMs(options = {}) {
  const resetAtMs = Number(options.modelWindowResetAtMs);
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) return 0;
  const now = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  if (resetAtMs <= now) return 0;
  return Math.min(resetAtMs - now, MAX_MODEL_WINDOW_COOLDOWN_MS);
}

function buildRateLimitedPolicy(detail, cooldownMs) {
  return {
    kind: 'rate_limited',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(1000, Number(cooldownMs) || DEFAULT_RATE_LIMIT_COOLDOWN_MS),
    clientStatusCode: 429,
    failureReason: detail,
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

// Model-scope entitlement refusal: cool only this (account, model) so the
// account keeps serving the models its plan does include, and alias fallback can
// move on. Not `auth_invalid` — the credential is fine, so no re-login is
// triggered and the account stays schedulable.
function buildModelEntitlementDeniedPolicy(detail, clientStatusCode = 403, options = {}) {
  return {
    kind: 'model_entitlement_required',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: options.shouldRetryAnotherAccount !== false,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(1000, Number(options.cooldownMs) || DEFAULT_MODEL_ENTITLEMENT_COOLDOWN_MS),
    clientStatusCode,
    failureReason: 'model_requires_subscription',
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

function buildModelRegionRestrictedPolicy(detail, clientStatusCode = 403) {
  return {
    kind: 'model_region_restricted',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: DEFAULT_MODEL_REGION_RESTRICTION_COOLDOWN_MS,
    clientStatusCode,
    failureReason: 'model_region_restricted',
    detail,
    scope: 'model',
    shouldUnbindSession: true
  };
}

// Account-scope hard exhaustion: cool the whole account for the reset window so
// account-selector skips it even under the last-resort override (which only
// bypasses the SOFT per-model cooldown), and alias fallback moves to the next
// provider immediately instead of burning retries re-hitting the exhausted one.
// Not `auth_invalid` — the credential is fine, so no re-login is triggered.
function buildAccountUsageExhaustedPolicy(detail, cooldownMs, { floorMs = DEFAULT_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS } = {}) {
  return {
    kind: 'account_usage_exhausted',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.min(
      MAX_ACCOUNT_USAGE_LIMIT_COOLDOWN_MS,
      Math.max(floorMs, Number(cooldownMs) || 0)
    ),
    clientStatusCode: 429,
    failureReason: 'account_usage_limit_reached',
    detail,
    scope: 'account',
    shouldUnbindSession: true
  };
}

function buildStreamDisconnectedPolicy(detail, defaultCooldownMs) {
  return {
    kind: 'service_unavailable',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    // A single interrupted stream is a transport blip, not evidence that this
    // (account, model) is unavailable. Match network/timeout semantics: only a
    // repeated short-window streak earns a brief cooldown.
    failureThreshold: TRANSIENT_NETWORK_FAILURE_THRESHOLD,
    cooldownMs: DEFAULT_TRANSIENT_NETWORK_COOLDOWN_MS,
    clientStatusCode: 503,
    failureReason: 'stream_disconnected_before_completion',
    detail,
    // Server/transport-side, not a credential problem: cool only this
    // (account, model) so the account's other models keep serving. Falls back to
    // account scope when the request has no model (see applyAccountFailurePolicy).
    scope: 'model',
    shouldUnbindSession: false
  };
}

function buildUnsupportedLocationPolicy(detail, defaultCooldownMs, signature = '') {
  return {
    kind: 'location_unsupported',
    // 出口所在地区被上游拒绝：账号本身没问题，问题在出口。走出口池车道的账号由
    // egress-traffic-evidence 记成「该节点 × 该上游 被拒」并换节点（不再给账号挂冷却）；
    // 其它出口的账号仍按账号冷却（它们的出口换不了），界面引导去设置出口。
    egressRegionDenied: true,
    regionSignature: signature || 'location_unsupported',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: Math.max(defaultCooldownMs, DEFAULT_UNSUPPORTED_LOCATION_COOLDOWN_MS),
    clientStatusCode: 503,
    failureReason: 'location_unsupported',
    detail,
    scope: 'account',
    shouldUnbindSession: true
  };
}

function describeError(error) {
  const message = normalizeText(error && error.message || error || 'unknown_error');
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  );
  if (!code || message.includes(code)) return message;
  return `${message} [${code}]`;
}

function isTimeoutError(error) {
  const message = describeError(error).toLowerCase();
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).toUpperCase();
  return code === 'ETIMEDOUT'
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || message.includes('timeout');
}

function isAbortError(error) {
  const name = normalizeText(error && error.name).toLowerCase();
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).toUpperCase();
  if (name === 'aborterror' || code === 'ABORT_ERR') return true;
  const message = describeError(error).toLowerCase();
  return message.includes('operation was aborted')
    || message.includes('this operation was aborted');
}

function isNetworkError(error) {
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).toUpperCase();
  if (['ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  const message = describeError(error).toLowerCase();
  return message.includes('fetch failed')
    || message.includes('und_err_socket')
    || message.includes('network socket disconnected')
    || message.includes('secure tls connection');
}

function isEmptyModelResponseError(error) {
  const code = normalizeText(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).toUpperCase();
  return code === 'EMPTY_UPSTREAM_RESPONSE';
}

// 同一空产出语义的「错误信封」入口：上游把「这次产出为空」包成 HTTP 错误返回
// （实测 cline 500：`{"error":"empty response content","success":false}`）。
// SSE 路径由 upstream-endpoints-sse.js 自产 EMPTY_UPSTREAM_RESPONSE 错误码，
// 信封路径只能从文本识别；不识别就会落进通用 5xx——单次就挂 5 分钟冷却，
// 把一次空产出放大成整模型 5 分钟不可用。两条路径共用 buildEmptyModelResponsePolicy：
// 记录连击、连续 2 次才升级 30s 短冷却、可试别的号。
const EMPTY_MODEL_CONTENT_PATTERN = new RegExp([
  'empty\\s+response\\s+content',
  'response\\s+content\\s+(?:is|was)\\s+empty',
  '(?:model|completion|output)\\s+(?:returned|produced|generated)\\s+(?:an?\\s+)?empty'
].join('|'), 'i');

function isEmptyModelContentEnvelope(options = {}) {
  const statusCode = Number(options.statusCode) || 0;
  // 4xx 的请求形态错误另走既定分类（400/404 透传、上下文超限等），不在本判定范围。
  if (statusCode > 0 && statusCode < 500) return false;
  return EMPTY_MODEL_CONTENT_PATTERN.test(collectFailureText(options));
}

function buildEmptyModelResponsePolicy(detail) {
  return {
    kind: 'empty_model_response',
    retryable: true,
    // 报错的请求必须记录：failCount / lastFailureReason / 连击都进账号状态，
    // 否则失败被静默吞掉，只剩一个 502 给客户端（信封与 SSE 两条路径共用本策略）。
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: EMPTY_MODEL_CONTENT_FAILURE_THRESHOLD,
    cooldownMs: DEFAULT_EMPTY_MODEL_CONTENT_COOLDOWN_MS,
    failureWindowMs: EMPTY_MODEL_CONTENT_FAILURE_WINDOW_MS,
    clientStatusCode: 502,
    failureReason: detail,
    detail,
    scope: 'model',
    shouldUnbindSession: false
  };
}

function buildStatusPolicy(options = {}) {
  const provider = normalizeText(options.provider).toLowerCase();
  const statusCode = Number(options.statusCode) || 0;
  const detail = normalizeText(options.detail || describeError(options.error) || `upstream_${statusCode}`);
  const retryHintMs = parseProviderRetryHintMs({
    provider,
    headers: options.headers,
    body: options.body,
    nowMs: options.nowMs
  });
  const defaultCooldownMs = Math.max(1000, Number(options.defaultCooldownMs) || 60000);

  if (isContextLengthExceededDetail(options)) {
    return buildContextLengthExceededPolicy(detail, statusCode || 400);
  }

  if (isOpenCodeFreeTierBlockedDetail(options)) {
    return buildOpenCodeFreeTierBlockedPolicy(options);
  }

  if (statusCode === 429 && isOpenCodeFreeUsageLimitDetail(options)) {
    // OpenCode free models (hy3-free, deepseek-v4-flash-free, etc.) rate limit by egress IP.
    // Never lock the entire account or trigger a 24h account cooldown.
    //
    // 但「按出口 IP 限」只是其中一种：端点日额度用尽时 retry-after 指向同一个 UTC 零点，
    // 与出口无关（换几十个 IP 都一样）。固定 5 分钟冷却对后者是错的——每 5 分钟再撞一次，
    // 每次都白耗 6 跳出口轮换、顺手给 6 个节点各挂一段 free_limit 冷却。有提示就按提示冷却，
    // 该 (账号,模型) 在这段时间里被路由摘出去，重撞与节点churn 一起消失。
    const freeLimitCooldownMs = retryHintMs > 0
      ? Math.min(Math.max(retryHintMs, OPENCODE_FREE_LIMIT_MIN_COOLDOWN_MS), OPENCODE_FREE_LIMIT_MAX_COOLDOWN_MS)
      : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    return {
      ...buildRateLimitedPolicy(detail, freeLimitCooldownMs),
      scope: 'model',
      shouldRetryAnotherAccount: true,
      // 结构化标记：这个 429 是「出口 IP 的免费额度用完」，换个出口即可继续。
      // transport 据此轮换出口池节点重试，而不是把 429 直接抛给用户
      // （用户不该为「某个 IP 被限」做任何操作）。
      openCodeFreeEgressLimited: true,
      // 交给客户端退避的时刻，与实际冷却**同源**：不同源会出现「网关 5 分钟就重试、
      // 却告诉客户端等 6 小时」这类不自洽。0 = 上游没给提示（客户端按自己的策略退避）。
      retryHintMs: retryHintMs > 0 ? freeLimitCooldownMs : 0
    };
  }

  if (statusCode === 429 && isProviderUsageLimitReachedDetail(options)) {
    return buildAccountUsageExhaustedPolicy(
      detail,
      // 恢复提示在响应正文里（detail 只是错误摘要）：从完整失败文本解析。
      parseUsageLimitResetCooldownMs(collectFailureText(options)) || retryHintMs
    );
  }

  // Cline Pass 的 5 小时 / 每周额度：冷却到上游给出的恢复时刻（不套 24h 下限 —— 5 小时窗口
  // 剩 40 分钟时不能把账号封一天）；没有恢复提示时按 1 小时退避，而不是 5 分钟就回来重撞。
  if (statusCode === 429 && isClinePassUsageCapDetail(options)) {
    return buildAccountUsageExhaustedPolicy(
      detail,
      parseUsageLimitResetCooldownMs(collectFailureText(options)) || retryHintMs || CLINE_PASS_CAP_DEFAULT_COOLDOWN_MS,
      { floorMs: 60 * 1000 }
    );
  }

  if (statusCode === 429 && isProviderQuotaExhaustedDetail(options)) {
    // agy/gemini uses RESOURCE_EXHAUSTED for both minute-level rate limits and
    // true quota exhaustion. When the response carries no retryDelay hint, this
    // is almost certainly a transient rate limit — not a 24h quota block. Fall
    // back to the standard 5-minute rate-limit cooldown instead of 24h.
    //
    // 但若调用方给出了**该模型额度窗口的恢复时刻**（provider 额度快照的 resetAtMs，
    // 见 model-window-gates），那就不是瞬时：窗口确实耗尽了，冷却直接对齐到重置时刻，
    // 免得整个窗口期内每 5 分钟再撞一次墙（每次都换号、每次都记一次失败）。
    const windowCooldownMs = modelWindowCooldownMs(options);
    if (windowCooldownMs > 0) {
      return buildModelQuotaExhaustedPolicy(detail, 429, {
        shouldRetryAnotherAccount: true,
        cooldownMs: windowCooldownMs
      });
    }
    const isTransientAgyRateLimit = (provider === 'agy' || provider === 'gemini') && retryHintMs <= 0;
    if (isTransientAgyRateLimit) {
      return {
        ...buildRateLimitedPolicy(detail, DEFAULT_RATE_LIMIT_COOLDOWN_MS),
        // A generic RESOURCE_EXHAUSTED without a reset hint can describe the
        // current request shape rather than this credential. Delay account
        // bookkeeping until sibling attempts reveal which scope is supported.
        deferAccountFailureUntilRequestOutcome: true
      };
    }
    return buildModelQuotaExhaustedPolicy(detail, 429, {
      shouldRetryAnotherAccount: true,
      cooldownMs: retryHintMs > 0
        ? retryHintMs
        : DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS
    });
  }

  if (isAccountModelQuotaExhaustedDetail(options)) {
    // Quota exhausted for this model: cool the model for the full rate window.
    return buildModelCapacityPolicy(detail, statusCode || 429, {
      shouldRetryAnotherAccount: true,
      cooldownMs: retryHintMs > 0 ? retryHintMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS
    });
  }

  if (isModelCapacityUnavailableDetail(options)) {
    // Server has no capacity for this model right now: short, transient cooldown.
    const policy = buildModelCapacityPolicy(detail, statusCode || 429, {
      shouldRetryAnotherAccount: true,
      cooldownMs: retryHintMs > 0 ? retryHintMs : DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS
    });
    if ((provider === 'agy' || provider === 'gemini') && retryHintMs <= 0) {
      // Code Assist can report provider-wide instantaneous model capacity as if
      // it belonged to each credential. Defer state mutation until sibling
      // attempts establish whether the failure is account-local or pool-wide.
      policy.deferAccountFailureUntilRequestOutcome = true;
    }
    return policy;
  }

  if (statusCode === 400 && isCapacityOverloadDetail(options)) {
    return buildModelCapacityPolicy(detail, 503, {
      shouldRetryAnotherAccount: true,
      cooldownMs: retryHintMs || MODEL_CAPACITY_COOLDOWN_MS,
      capacityBackoff: !retryHintMs
    });
  }

  if (statusCode === 400 && isUnsupportedLocationDetail(options)) {
    return buildUnsupportedLocationPolicy(detail, defaultCooldownMs);
  }

  if (isStreamDisconnectedDetail(options)) {
    return buildStreamDisconnectedPolicy(detail, defaultCooldownMs);
  }

  if ((statusCode === 400 || statusCode === 404) && isItemNotFoundOrEncryptedContentDetail(options)) {
    return {
      kind: 'item_not_persisted_or_encrypted_incompatible',
      retryable: true,
      shouldMarkFailure: false,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: 0,
      clientStatusCode: statusCode,
      failureReason: 'item_not_persisted_or_encrypted_incompatible',
      detail,
      scope: 'none',
      shouldUnbindSession: true
    };
  }

  if ((statusCode === 400 || statusCode === 404) && isModelNotAvailableOnEndpointDetail(options)) {
    return buildModelNotAvailableOnEndpointPolicy(detail, statusCode);
  }

  // 账号档位不支持该模型（CodeBuddy 家族 11158）：换号，不是把 400 透给客户端。
  // 放在通用 400 分支**之前** —— 否则 free 账号会直接把请求打死，同池的 pro 账号从未被尝试。
  if (statusCode === 400 && isAccountTierModelDeniedDetail(options)) {
    return {
      ...buildModelNotAvailableOnEndpointPolicy(detail, statusCode),
      kind: 'account_tier_model_denied',
      failureReason: 'account_tier_model_denied'
      // 刻意**不**标 providerModelUnavailable：11158 说的是「这个**账号档位**用不了这个模型」，
      // 是账号属性 —— 同 provider 的 pro 账号可能就能用。标成 provider 级会把 pro 账号一起封掉。
      // 正确的粒度是既有的 (账号, 模型) 冷却 + 换号重试（见本文件顶部的 11158 分支注释）。
    };
  }

  if (statusCode === 400 || statusCode === 404) {
    return {
      kind: statusCode === 400 ? 'invalid_request' : 'not_found',
      retryable: false,
      shouldMarkFailure: false,
      shouldRetryAnotherAccount: false,
      shouldPassthroughToClient: true,
      failureThreshold: 0,
      cooldownMs: 0,
      clientStatusCode: statusCode,
      failureReason: detail,
      detail,
      scope: 'none',
      shouldUnbindSession: false
    };
  }

  if (statusCode === 403 && isOpenCodeModelRegionRestrictedDetail(options)) {
    return buildModelRegionRestrictedPolicy(detail, statusCode);
  }

  if ((statusCode === 401 || statusCode === 403 || statusCode === 402) && (isModelEntitlementDeniedDetail(options) || isOpenCodeCreditsErrorDetail(options))) {
    return buildModelEntitlementDeniedPolicy(detail, statusCode);
  }

  // qoder 服务端资源限流（code 10605 / subCode RESOURCE_LIMIT / isQueued）：
  // 凭据有效，只是当前模型被排队，不记账号失败、不锁号、不换号；
  // 客户端可见 429 + retryHintMs，由 HTTP 策略层回落到 CLI 兜底。
  if (statusCode === 403 && isQoderResourceLimitDetail(options)) {
    return {
      kind: 'overloaded',
      retryable: true,
      shouldMarkFailure: false,
      shouldRetryAnotherAccount: false,
      shouldPassthroughToClient: false,
      failureThreshold: 0,
      cooldownMs: 0,
      clientStatusCode: 429,
      failureReason: 'qoder_resource_limit',
      detail,
      scope: 'none',
      shouldUnbindSession: false,
      retryHintMs: parseQoderRetryAfterMs(options)
    };
  }

  // WAF/CDN 拦截页（HTML / cf-mitigated）与账号无关，不能当成凭据失效锁号。
  if ((statusCode === 401 || statusCode === 403) && isEdgeBlockedResponse(options)) {
    return buildEdgeBlockedPolicy(detail, statusCode);
  }

  // 站点边缘网关（APISIX）的**请求格式**拒绝：401/403 + `{"message":"invalid_format"}`。
  // 同上，与账号凭据无关（同一 token 换请求形态即 200），不能锁号一年。
  if ((statusCode === 401 || statusCode === 403) && isEdgeGatewayFormatRejection(options)) {
    const upstreamBody = String(options.body || '').trim().slice(0, 200);
    return buildEdgeGatewayFormatRejectedPolicy(
      `${detail} | 站点边缘网关按请求格式拒绝（非凭据问题）：${upstreamBody}`,
      statusCode
    );
  }

  if (statusCode === 401 || statusCode === 403) {
    // OAuth 凭证（ChatGPT 登录态）失效时，同池的 api-key 账号不共享该凭证形态，
    // 重试应定向偏好 api-key 账号；仅作为选号排序偏好由选择器消费，不做硬过滤。
    const failedAccountIsApiKey = Boolean(options.account)
      && Boolean(options.account.apiKeyMode || options.account.authType === 'api-key');
    const failedAccountIsOAuth = Boolean(options.account) && !failedAccountIsApiKey;
    return {
      kind: 'auth_invalid',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: failedAccountIsApiKey
        ? API_KEY_REJECTED_COOLDOWN_MS
        : Math.max(defaultCooldownMs, DEFAULT_AUTH_INVALID_COOLDOWN_MS),
      clientStatusCode: statusCode,
      failureReason: failedAccountIsApiKey ? 'api_key_rejected' : 'auth_invalid_reauth_required',
      detail,
      scope: 'account',
      shouldUnbindSession: true,
      preferRetryAuthType: failedAccountIsOAuth ? 'api-key' : ''
    };
  }

  if (statusCode === 402 && isDeactivatedWorkspaceDetail(options)) {
    return {
      kind: 'auth_invalid',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_AUTH_INVALID_COOLDOWN_MS),
      clientStatusCode: statusCode,
      failureReason: 'deactivated_workspace',
      detail,
      scope: 'account',
      shouldUnbindSession: true
    };
  }

  if (statusCode === 402) {
    // Payment Required: upstream rejects the request because the account has
    // no credits (e.g. grok spending-limit). Credentials are fine and the
    // account itself is healthy, so never mark failure or cool the account;
    // the weighted selector already avoids empty accounts, so retrying
    // another account adds nothing. Surface the upstream error as-is.
    return {
      kind: 'payment_required',
      retryable: false,
      shouldMarkFailure: false,
      shouldRetryAnotherAccount: false,
      shouldPassthroughToClient: true,
      failureThreshold: 0,
      cooldownMs: 0,
      clientStatusCode: 402,
      failureReason: detail,
      detail,
      scope: 'none',
      shouldUnbindSession: false
    };
  }

  if (statusCode === 429) {
    // A 429 is bound to (provider, account, model): the same account's other
    // models often still have quota (e.g. agy claude 429 while gemini-3.5-flash
    // is fine). Cool only this model so the account stays usable elsewhere and
    // alias fallback can switch models.
    //
    // 若调用方给出了该模型**额度窗口的恢复时刻**（provider 的额度快照带 resetAtMs，
    // 见 model-window-gates），冷却就设到那一刻：固定 5 分钟会在整个窗口期内反复撞墙
    // （每次都可能再记一次失败、再换一次账号），对齐窗口才是一次就停。
    const windowCooldownMs = modelWindowCooldownMs(options);
    if (windowCooldownMs > 0) {
      return buildModelQuotaExhaustedPolicy(detail, 429, {
        shouldRetryAnotherAccount: true,
        cooldownMs: windowCooldownMs
      });
    }
    return buildRateLimitedPolicy(
      detail,
      retryHintMs > 0 ? retryHintMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS
    );
  }

  if (statusCode === 529) {
    return {
      kind: 'overloaded',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_OVERLOAD_COOLDOWN_MS),
      clientStatusCode: 529,
      failureReason: detail,
      detail,
      // Overload is an upstream/model condition, not a dead account: cool only
      // this (account, model) so other models on the account stay routable.
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  if (statusCode === 503) {
    return {
      kind: 'service_unavailable',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: retryHintMs > 0 ? retryHintMs : DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS,
      clientStatusCode: 503,
      failureReason: detail,
      detail,
      // Transient upstream unavailability for this model/request, not a credential
      // failure: cool only (account, model) so siblings keep serving.
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  if (statusCode >= 500) {
    return {
      kind: 'upstream_server_error',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: 1,
      cooldownMs: Math.max(defaultCooldownMs, DEFAULT_SERVER_ERROR_COOLDOWN_MS),
      clientStatusCode: statusCode,
      failureReason: detail,
      detail,
      // Upstream 5xx for one model rarely means the account is dead — its other
      // models usually still work. Cool only (account, model).
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  return {
    kind: 'unknown_status',
    retryable: false,
    shouldMarkFailure: false,
    shouldRetryAnotherAccount: false,
    shouldPassthroughToClient: false,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: statusCode || 502,
    failureReason: detail,
    detail,
    scope: 'none',
    shouldUnbindSession: false
  };
}

function buildErrorPolicy(options = {}) {
  const detail = describeError(options.error);
  const defaultCooldownMs = Math.max(1000, Number(options.defaultCooldownMs) || 60000);
  const timeoutError = isTimeoutError(options.error) || isAbortError(options.error);
  const networkError = isNetworkError(options.error);

  if (isEmptyModelResponseError(options.error)) {
    return buildEmptyModelResponsePolicy(detail);
  }

  if (isModelCapacityUnavailableDetail({ ...options, detail })) {
    return buildModelCapacityPolicy(detail, 429);
  }

  if (isCapacityOverloadDetail({ ...options, detail })) {
    return buildModelCapacityPolicy(detail, 503, {
      shouldRetryAnotherAccount: true,
      cooldownMs: parseProviderRetryHintMs(options) || MODEL_CAPACITY_COOLDOWN_MS,
      capacityBackoff: !parseProviderRetryHintMs(options)
    });
  }

  if (isUnsupportedLocationDetail({ ...options, detail })) {
    return buildUnsupportedLocationPolicy(detail, defaultCooldownMs);
  }

  if (isStreamDisconnectedDetail({ ...options, detail })) {
    return buildStreamDisconnectedPolicy(detail, defaultCooldownMs);
  }

  if (timeoutError) {
    return {
      kind: 'timeout',
      retryable: true,
      shouldMarkFailure: true,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      // Require consecutive failures + a short cooldown so a single transient
      // timeout never removes a healthy (account, model) from rotation. Scoped to
      // the model: connectivity/upstream blips are not credential failures, so the
      // account's other models stay routable (falls back to account when no model).
      failureThreshold: TRANSIENT_NETWORK_FAILURE_THRESHOLD,
      cooldownMs: DEFAULT_TRANSIENT_NETWORK_COOLDOWN_MS,
      clientStatusCode: 504,
      failureReason: detail,
      detail,
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  if (networkError) {
    return {
      kind: 'network_error',
      retryable: true,
      // A transport refusal describes endpoint/network reachability, not the
      // credential or the requested model. Keep it observable and retryable,
      // but never poison account schedulability with endpoint health.
      shouldMarkFailure: false,
      shouldRetryAnotherAccount: true,
      shouldPassthroughToClient: false,
      failureThreshold: TRANSIENT_NETWORK_FAILURE_THRESHOLD,
      cooldownMs: 0,
      clientStatusCode: 502,
      failureReason: detail,
      detail,
      scope: 'model',
      shouldUnbindSession: false
    };
  }

  return {
    kind: 'unknown_error',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: false,
    failureThreshold: 1,
    cooldownMs: defaultCooldownMs,
    clientStatusCode: 502,
    failureReason: detail,
    detail,
    // Unclassified, but not provably account-wide: default to the smaller blast
    // radius (account, model); credential/identity failures are handled above and
    // stay account-scoped. No model context → falls back to account cooling.
    scope: 'model',
    shouldUnbindSession: false
  };
}

function classifyUpstreamFailure(options = {}) {
  // A structured policy decision has request scope regardless of whether the
  // transport used an HTTP error status or a successful SSE envelope carrying
  // response.failed. Never infer this classification from human-readable text.
  if (isStructuredSafetyRejection(options)) {
    return buildSafetyRejectedPolicy();
  }
  const configured = classifyConfiguredUpstreamFailure(options);
  if (configured) return configured;
  // Capacity can arrive as HTTP 200 SSE or a status-less WebSocket error.
  // Read only the error envelope; quoted text in successful output is not evidence.
  const failureBody = parseStructuredFailureBody(options.body);
  const envelopeError = failureBody && (failureBody.error || failureBody.response?.error);
  if (envelopeError && typeof envelopeError === 'object') {
    const code = normalizeText(envelopeError.code).toLowerCase();
    if (code === 'model_at_capacity' || code === 'server_is_overloaded'
        || isCapacityOverloadDetail({ detail: envelopeError.message })) {
      const retryHintMs = parseProviderRetryHintMs(options);
      return buildModelCapacityPolicy(normalizeText(envelopeError.message || code), 503, {
        cooldownMs: retryHintMs || MODEL_CAPACITY_COOLDOWN_MS,
        capacityBackoff: !retryHintMs
      });
    }
  }
  // Codex can report quota in HTTP 200 SSE or WebSocket error envelopes.
  // Do not infer it from free-form text, classify it as expired authentication,
  // or impose a guessed account-wide day-long block.
  const codexQuota = normalizeText(options.provider).toLowerCase() === 'codex'
    ? getCodexQuotaFailure(parseStructuredFailureBody(options.body)) : null;
  if (codexQuota) {
    const cooldownMs = Math.max(codexQuotaRetryDelay(codexQuota, options.nowMs),
      parseProviderRetryHintMs(options)) || DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    // Plan usage is shared across Codex requests. A plain rate_limit_exceeded
    // remains model-scoped; only an explicit model scope narrows a quota block.
    const quotaScope = normalizeText(codexQuota.error.limit_scope || codexQuota.error.scope).toLowerCase();
    const account = options.account;
    if (codexQuota.code !== 'rate_limit_exceeded' && isCustomUpstreamAccount({
      provider: options.provider, apiKeyMode: account?.apiKeyMode,
      baseUrl: account?.openaiBaseUrl || account?.baseUrl
    })) {
      // This key addresses another pool, not the exhausted OAuth account behind
      // it. The remote gateway owns plan resets; briefly back off this model so
      // a recovered remote pool is reachable without waiting one member's reset.
      return {
        ...buildRateLimitedPolicy(codexQuota.code, Math.min(cooldownMs, DEFAULT_SERVICE_UNAVAILABLE_COOLDOWN_MS)),
        failureReason: 'upstream_pool_usage_exhausted'
      };
    }
    if (codexQuota.code !== 'rate_limit_exceeded' && quotaScope !== 'model') {
      return {
        ...buildAccountUsageExhaustedPolicy(codexQuota.code, cooldownMs, { floorMs: 1000 }),
        kind: 'quota_exhausted',
        failureReason: codexQuota.code
      };
    }
    return {
      ...buildRateLimitedPolicy(codexQuota.code, cooldownMs),
      failureReason: codexQuota.code
    };
  }
  // Some Code Assist failures arrive in an SSE/JSON envelope without an HTTP
  // status. Classify them before the status/error split for the same reason.
  if (isContextLengthExceededDetail(options)) {
    return buildContextLengthExceededPolicy(
      normalizeText(options.detail || describeError(options.error) || 'context_length_exceeded'),
      Number(options.statusCode) || 400
    );
  }
  // 同理：opencode 免费档的客户端门禁（FreeTierError）也可能不带 HTTP 状态——
  // CLI 通道把它作为事件文本透出（statusCode 0），必须在 status/error 分流之前判定，
  // 否则会落进 buildErrorPolicy 的 unknown_error，账号照样被按通用错误记账。
  if (isOpenCodeFreeTierBlockedDetail(options)) {
    return buildOpenCodeFreeTierBlockedPolicy(options);
  }
  // 出口代理协议不被该传输支持（opencode 是 Bun 运行时，只认 HTTP 代理；见
  // opencode-free-cli-transport 的 opencode_free_cli_proxy_unsupported）。
  // 这是**配置问题而不是账号故障**：不记账、不冷却、不换号重试 —— 换号只会用同一个
  // 出口再失败一次，而且会让界面把原因指向账号，与真实原因（出口配错）无关。
  if (isUnsupportedProxyProtocolDetail(options)) {
    return buildUnsupportedProxyProtocolPolicy(options);
  }
  // opencode 账号没有付费凭据（Zen/Go API Key）却被请求付费模型：这是**账号能力**问题，
  // 不是故障 —— 不记失败、不冷却（此前落进 unknown_error：一天 97 次假失败 + 1 分钟模型冷却），
  // 换一个有付费 key 的账号可以服务；都没有时给客户端可读的原因。
  if (isOpenCodeMissingPaidCredentialDetail(options)) {
    return buildOpenCodeMissingPaidCredentialPolicy(options);
  }
  // 同理：zcode 的配额拒绝走 200 信封，statusCode 分支永远看不到它。
  if (isZcodeQuotaBusinessRejection(options)) {
    const zcodeQuotaResetHintMs = parseProviderRetryHintMs(options);
    // 只有上游明确给出 reset 提示，才敢认定这是「要等到下个周期」的硬配额。
    if (zcodeQuotaResetHintMs > 0) {
      return buildModelQuotaExhaustedPolicy(normalizeText(options.detail), 429, {
        shouldRetryAnotherAccount: true,
        cooldownMs: zcodeQuotaResetHintMs
      });
    }
    // 没有 reset 提示时不能按 24h 封锁：实测（2026-08-22 requestId b4fc7d4e…）
    // 该账号 billing/balance 仍报 remaining_units=74,081,782/100,000,000 且
    // period=one_time——套餐里根本没有「今日额度」这个桶。也就是说 1005 用的是
    // balance 未暴露的另一维度（速率/并发/单请求），这类通常是瞬时的。
    // 对一个还剩 74% 额度的账号开 24h 冷却等于自伤，沿用 agy/gemini 的同款判断：
    // 退到标准限流冷却，并把账号级记账推迟到本次请求的最终结果揭晓之后。
    return {
      ...buildRateLimitedPolicy(normalizeText(options.detail), DEFAULT_RATE_LIMIT_COOLDOWN_MS),
      deferAccountFailureUntilRequestOutcome: true
    };
  }
  // 同理：上游把「本次产出为空」包成错误信封时（实测 cline 500），也必须先于 status 分流判定，
  // 否则会落进 buildStatusPolicy 的通用 5xx——给健康账号的该模型挂 5 分钟冷却。
  if (isEmptyModelContentEnvelope(options)) {
    return buildEmptyModelResponsePolicy(
      normalizeText(options.detail || describeError(options.error) || 'empty_model_response')
    );
  }
  // 地区拒绝（HTTP 451 / 上游声明的拒绝特征，见 egress-upstream 的 isRegionDenied）：先于 status 分流，
  // 否则 anthropic 的 403「Request not allowed」会落进通用 401/403 分支被当成凭据失效锁号。
  const regionSignature = detectRegionDenied(options);
  if (regionSignature) {
    return buildUnsupportedLocationPolicy(
      normalizeText(options.detail || describeError(options.error) || regionSignature),
      Math.max(0, Number(options.defaultCooldownMs) || 0),
      regionSignature
    );
  }
  if (Number(options.statusCode) > 0) {
    return buildStatusPolicy(options);
  }
  return buildErrorPolicy(options);
}

function detectRegionDenied(options = {}) {
  const statusCode = Number(options.statusCode) || 0;
  if (statusCode && ![400, 403, 451].includes(statusCode)) return '';
  // 延迟加载：egress-upstream 会拉起 provider 门面。
  // eslint-disable-next-line global-require
  const { isRegionDenied } = require('./egress-upstream');
  return isRegionDenied(
    { provider: normalizeText(options.provider).toLowerCase(), official: options.officialUpstream !== false },
    { statusCode, text: collectFailureText(options) }
  );
}

module.exports = {
  classifyUpstreamFailure,
  describeError,
  isContextLengthExceededDetail
};
