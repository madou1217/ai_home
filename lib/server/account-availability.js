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

function normalizeExcludeIds(input) {
  if (input instanceof Set) return input;
  if (Array.isArray(input)) return new Set(input.map((item) => String(item || '').trim()).filter(Boolean));
  return new Set();
}

function pushReason(map, reason, account) {
  const key = normalizeText(reason, 'unknown');
  const entry = map.get(key) || {
    reason: key,
    count: 0,
    sampleAccountIds: [],
    retryAt: 0
  };
  entry.count += 1;
  const id = normalizeText(account && account.id);
  if (id && entry.sampleAccountIds.length < 5) {
    entry.sampleAccountIds.push(id);
  }
  const cooldownUntil = toFiniteNumber(account && account.cooldownUntil, 0);
  if (cooldownUntil > 0 && (entry.retryAt === 0 || cooldownUntil < entry.retryAt)) {
    entry.retryAt = cooldownUntil;
  }
  map.set(key, entry);
}

function classifyUnavailableAccount(account, now, excludeIds, model = '') {
  const id = normalizeText(account && account.id);
  if (id && excludeIds.has(id)) return 'excluded_for_current_request';

  const schedulableStatus = normalizeText(account && account.schedulableStatus);
  if (schedulableStatus && schedulableStatus !== 'schedulable') {
    const reasonSource = schedulableStatus === 'blocked_by_runtime_status'
      ? (account && (account.runtimeReason || account.lastError || account.schedulableReason))
      : (account && (account.schedulableReason || account.runtimeReason || account.quotaReason || account.lastError));
    const reason = normalizeText(reasonSource, 'unspecified');
    return `${schedulableStatus}:${reason}`;
  }

  if (now < toFiniteNumber(account && account.cooldownUntil, 0)) {
    const lastError = normalizeText(
      account && (account.lastError || account.lastFailureReason || account.runtimeReason)
    );
    return lastError ? `cooldown:${lastError}` : 'cooldown';
  }

  const runtime = deriveAccountRuntimeStatus(account, now);
  if (runtime.status && runtime.status !== 'healthy') {
    return runtime.reason
      ? `runtime:${runtime.status}:${runtime.reason}`
      : `runtime:${runtime.status}`;
  }

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
  const excludeIds = normalizeExcludeIds(options.excludeIds);
  const model = normalizeText(options.model);
  const reasonMap = new Map();
  let available = 0;

  pool.forEach((account) => {
    const reason = classifyUnavailableAccount(account, now, excludeIds, model);
    if (reason) {
      pushReason(reasonMap, reason, account);
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
        sampleAccountIds: entry.sampleAccountIds
      };
      if (entry.retryAt > 0) out.retryAt = entry.retryAt;
      return out;
    });

  const detail = pool.length === 0
    ? `no ${provider} accounts loaded`
    : `no schedulable ${provider} account: ${reasons.map((item) => `${item.reason}=${item.count}`).join(', ') || 'unknown'}`;

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

function classifyNoAvailableAccountResponse(availability) {
  if (allUnavailableReasonsMatch(availability, ['auth_invalid', 'token_expired'])) {
    return {
      statusCode: 401,
      error: 'auth_invalid_reauth_required'
    };
  }
  return {
    statusCode: 503,
    error: 'no_available_account'
  };
}

function buildNoAvailableAccountResponse(provider, accounts, options = {}) {
  const availability = summarizeAccountAvailability(accounts, {
    ...options,
    provider
  });
  const response = classifyNoAvailableAccountResponse(availability);
  return {
    statusCode: response.statusCode,
    payload: {
      ok: false,
      error: response.error,
      detail: availability.detail,
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
    classifyNoAvailableAccountResponse
  }
};
