'use strict';

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

function classifyUnavailableAccount(account, now, excludeIds) {
  const id = normalizeText(account && account.id);
  if (id && excludeIds.has(id)) return 'excluded_for_current_request';

  const schedulableStatus = normalizeText(account && account.schedulableStatus);
  if (schedulableStatus && schedulableStatus !== 'schedulable') {
    const reason = normalizeText(
      account && (
        account.schedulableReason
        || account.runtimeReason
        || account.quotaReason
        || account.lastError
      ),
      'unspecified'
    );
    return `${schedulableStatus}:${reason}`;
  }

  if (now < toFiniteNumber(account && account.cooldownUntil, 0)) {
    const lastError = normalizeText(account && account.lastError);
    return lastError ? `cooldown:${lastError}` : 'cooldown';
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
  const reasonMap = new Map();
  let available = 0;

  pool.forEach((account) => {
    const reason = classifyUnavailableAccount(account, now, excludeIds);
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
  return {
    ok: false,
    error: 'no_available_account',
    detail: availability.detail,
    availability
  };
}

module.exports = {
  summarizeAccountAvailability,
  buildNoAvailableAccountPayload,
  __private: {
    classifyUnavailableAccount
  }
};
