'use strict';

const {
  deriveAccountRuntimeStatus,
  getAccountModelCooldownUntil
} = require('./account-runtime-state');

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeText(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function normalizeExcludedAccountRefs(input) {
  if (input instanceof Set) return input;
  if (Array.isArray(input)) return new Set(input.map((item) => String(item || '').trim()).filter(Boolean));
  return new Set();
}

function pushReason(map, reason, account, extraRetryAt = 0) {
  const key = normalizeText(reason, 'unknown');
  const entry = map.get(key) || {
    reason: key,
    count: 0,
    sampleAccountRefs: [],
    retryAt: 0
  };
  entry.count += 1;
  const accountRef = normalizeText(account && account.accountRef);
  if (accountRef && entry.sampleAccountRefs.length < 5) {
    entry.sampleAccountRefs.push(accountRef);
  }
  // 账号级冷却和模型级冷却都能给出「什么时候可以再试」；取其中最早的那个。
  [
    toFiniteNumber(account && account.cooldownUntil, 0),
    toFiniteNumber(extraRetryAt, 0)
  ].forEach((until) => {
    if (until > 0 && (entry.retryAt === 0 || until < entry.retryAt)) {
      entry.retryAt = until;
    }
  });
  map.set(key, entry);
}

function formatRuntimeReason(runtime) {
  const status = normalizeText(runtime && runtime.status);
  if (!status || status === 'healthy') return '';
  const reason = normalizeText(runtime && runtime.reason);
  return reason ? `runtime:${status}:${reason}` : `runtime:${status}`;
}

function isTypedBlockingRuntime(runtime) {
  const status = normalizeText(runtime && runtime.status);
  return Boolean(status && status !== 'healthy' && status !== 'cooling_down');
}

function classifyUnavailableAccount(account, now, excludedAccountRefs, model = '') {
  const accountRef = normalizeText(account && account.accountRef);
  if (accountRef && excludedAccountRefs.has(accountRef)) return 'excluded_for_current_request';

  const schedulableStatus = normalizeText(account && account.schedulableStatus);
  if (schedulableStatus && schedulableStatus !== 'schedulable') {
    const reasonSource = schedulableStatus === 'blocked_by_runtime_status'
      ? (account && (account.runtimeReason || account.lastError || account.schedulableReason))
      : (account && (account.schedulableReason || account.runtimeReason || account.quotaReason || account.lastError));
    const reason = normalizeText(reasonSource, 'unspecified');
    return `${schedulableStatus}:${reason}`;
  }

  const runtime = deriveAccountRuntimeStatus(account, now);
  if (isTypedBlockingRuntime(runtime)) {
    return formatRuntimeReason(runtime);
  }

  if (now < toFiniteNumber(account && account.cooldownUntil, 0)) {
    const lastError = normalizeText(
      account && (account.lastError || account.lastFailureReason || account.runtimeReason)
    );
    return lastError ? `cooldown:${lastError}` : 'cooldown';
  }

  const runtimeReason = formatRuntimeReason(runtime);
  if (runtimeReason) return runtimeReason;

  const requestedModel = normalizeText(model);
  const modelCooldownUntil = requestedModel
    ? getAccountModelCooldownUntil(account, requestedModel, now)
    : 0;
  if (modelCooldownUntil > now) {
    const lastError = normalizeText(
      account && (account.lastError || account.lastFailureReason || account.runtimeReason)
    );
    return lastError
      ? `model_cooldown:${requestedModel}:${lastError}`
      : `model_cooldown:${requestedModel}`;
  }

  if (account && !account.apiKeyMode) {
    const remainingPct = account.remainingPct;
    if (
      remainingPct !== null
      && remainingPct !== undefined
      && remainingPct !== ''
      && Number.isFinite(Number(remainingPct))
      && Number(remainingPct) <= 0
    ) {
      return 'quota_exhausted';
    }
  }

  return '';
}

function summarizeAccountAvailability(accounts, options = {}) {
  const pool = Array.isArray(accounts) ? accounts : [];
  const provider = normalizeText(options.provider, 'account');
  const now = toFiniteNumber(options.now, Date.now());
  const excludedAccountRefs = normalizeExcludedAccountRefs(options.excludeAccountRefs);
  const model = normalizeText(options.model);
  const reasonMap = new Map();
  let available = 0;

  pool.forEach((account) => {
    const reason = classifyUnavailableAccount(account, now, excludedAccountRefs, model);
    if (reason) {
      pushReason(
        reasonMap,
        reason,
        account,
        model ? getAccountModelCooldownUntil(account, model, now) : 0
      );
      return;
    }
    available += 1;
  });

  const reasons = Array.from(reasonMap.values())
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .map((entry) => {
      const out = {
        reason: entry.reason,
        count: entry.count,
        sampleAccountRefs: entry.sampleAccountRefs
      };
      if (entry.retryAt > 0) out.retryAt = entry.retryAt;
      return out;
    });

  // 账号本身个个健康、却一个都没被选中，只可能是「按模型选账号」把它们全滤掉了
  // ——账号选择器按模型能力过滤，而这份摘要不过滤，两边口径不一致时旧文案会输出
  // 「no schedulable X account: unknown」，把「没人支持这个模型」说成「没有可调度账号」，
  // 排障时会一路往账号健康度上找，完全找错方向。
  const detail = pool.length === 0
    ? `no ${provider} accounts loaded`
    : (reasons.length === 0 && available > 0
      ? (model
        ? `no ${provider} account can serve model ${model} (${available} account(s) healthy but none lists it)`
        : `no ${provider} account matched this request (${available} account(s) healthy)`)
      : `no schedulable ${provider} account: ${reasons.map((item) => `${item.reason}=${item.count}`).join(', ') || 'unknown'}`);

  return {
    provider,
    total: pool.length,
    available,
    unavailable: Math.max(0, pool.length - available),
    reasons,
    detail
  };
}

function buildNoAvailableAccountPayload(provider, accounts, options = {}) {
  const availability = summarizeAccountAvailability(accounts, {
    ...options,
    provider
  });
  const response = classifyNoAvailableAccountResponse(availability);
  return {
    ok: false,
    error: response.error,
    detail: availability.detail,
    availability
  };
}

function isReasonMatch(reason, values) {
  const text = normalizeText(reason).toLowerCase();
  return values.some((value) => text.includes(value));
}

function allUnavailableReasonsMatch(availability, values) {
  if (!availability || Number(availability.total) <= 0 || Number(availability.available) > 0) return false;
  const reasons = Array.isArray(availability.reasons) ? availability.reasons : [];
  return reasons.length > 0 && reasons.every((item) => isReasonMatch(item && item.reason, values));
}

// 冷却原因里能证明「这是上游限流」的标记。只认这几个，别把网络抖动、5xx 造成的
// 普通冷却也说成限流。
const RATE_LIMIT_REASON_MARKERS = [
  'rate_limit',
  'rate limit',
  'rate limited',
  'upstream_429',
  'http_429',
  'too_many_requests'
];

/**
 * 取所有原因里最早的可重试时间，用于 Retry-After。
 */
function resolveRetryAfterSeconds(availability, nowMs = Date.now()) {
  const reasons = Array.isArray(availability && availability.reasons) ? availability.reasons : [];
  let earliest = 0;
  reasons.forEach((item) => {
    const retryAt = toFiniteNumber(item && item.retryAt, 0);
    if (retryAt > nowMs && (earliest === 0 || retryAt < earliest)) earliest = retryAt;
  });
  if (earliest === 0) return 0;
  return Math.max(1, Math.ceil((earliest - nowMs) / 1000));
}

function classifyNoAvailableAccountResponse(availability) {
  if (allUnavailableReasonsMatch(availability, ['auth_invalid', 'token_expired'])) {
    return {
      statusCode: 401,
      error: 'auth_invalid_reauth_required'
    };
  }
  // 全部账号都只是被上游限流冷却时，真相是 429，不是「网关没有可调度账号」。
  // 报 503 会让客户端以为网关坏了；报 429 + Retry-After 才是它能正确退避的语义。
  if (allUnavailableReasonsMatch(availability, RATE_LIMIT_REASON_MARKERS)) {
    return {
      statusCode: 429,
      error: 'upstream_rate_limited'
    };
  }
  return {
    statusCode: 503,
    error: 'no_available_account'
  };
}

function buildNoAvailableAccountResponse(provider, accounts, options = {}) {
  const now = toFiniteNumber(options.now, Date.now());
  const availability = summarizeAccountAvailability(accounts, {
    ...options,
    provider
  });
  const response = classifyNoAvailableAccountResponse(availability);
  const retryAfterSeconds = resolveRetryAfterSeconds(availability, now);
  return {
    statusCode: response.statusCode,
    retryAfterSeconds,
    payload: {
      ok: false,
      error: response.error,
      detail: availability.detail,
      retryAfterSeconds: retryAfterSeconds || undefined,
      availability
    }
  };
}

function hasUnavailableReason(accounts, reason) {
  const expected = normalizeText(reason);
  if (!expected || !Array.isArray(accounts)) return false;
  return accounts.some((account) => {
    const values = [
      account && account.lastError,
      account && account.lastFailureReason,
      account && account.runtimeReason
    ];
    return values.some((value) => normalizeText(value) === expected);
  });
}

module.exports = {
  summarizeAccountAvailability,
  buildNoAvailableAccountPayload,
  buildNoAvailableAccountResponse,
  hasUnavailableReason,
  __private: {
    classifyUnavailableAccount,
    classifyNoAvailableAccountResponse,
    resolveRetryAfterSeconds
  }
};
