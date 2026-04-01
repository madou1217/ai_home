const DEFAULT_THRESHOLD_PCT = 90;
const MIN_THRESHOLD_PCT = 1;
const MAX_THRESHOLD_PCT = 100;

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function normalizeThresholdPct(value) {
  return clampInt(value, MIN_THRESHOLD_PCT, MAX_THRESHOLD_PCT, DEFAULT_THRESHOLD_PCT);
}

function normalizeUsagePct(value) {
  return clampInt(value, 0, 100, 0);
}

function normalizeAccount(account = {}) {
  const id = account.accountId != null ? String(account.accountId).trim() : '';
  return {
    accountId: id,
    usagePct: normalizeUsagePct(account.usagePct),
    exhausted: Boolean(account.exhausted),
    available: account.available !== false,
    source: account.source || 'snapshot'
  };
}

function buildCandidateList(accounts, currentAccountId) {
  return (Array.isArray(accounts) ? accounts : [])
    .map(normalizeAccount)
    .filter((entry) => entry.accountId && entry.accountId !== String(currentAccountId))
    .filter((entry) => entry.available && !entry.exhausted)
    .sort((a, b) => {
      if (a.usagePct !== b.usagePct) return a.usagePct - b.usagePct;
      return a.accountId.localeCompare(b.accountId);
    });
}

function evaluateThresholdSwitch(input = {}) {
  const fromAccountId = input.currentAccountId != null ? String(input.currentAccountId).trim() : '';
  const thresholdPct = normalizeThresholdPct(input.thresholdPct);
  const currentUsagePct = normalizeUsagePct(input.currentUsagePct);

  if (!fromAccountId) {
    return {
      shouldSwitch: false,
      reason: 'missing_current_account',
      fromAccountId,
      toAccountId: '',
      thresholdPct,
      currentUsagePct,
      candidates: []
    };
  }

  if (currentUsagePct < thresholdPct) {
    return {
      shouldSwitch: false,
      reason: 'below_threshold',
      fromAccountId,
      toAccountId: '',
      thresholdPct,
      currentUsagePct,
      candidates: []
    };
  }

  const candidates = buildCandidateList(input.accounts, fromAccountId);
  const target = candidates[0] || null;

  if (!target) {
    return {
      shouldSwitch: false,
      reason: 'no_eligible_target',
      fromAccountId,
      toAccountId: '',
      thresholdPct,
      currentUsagePct,
      candidates
    };
  }

  return {
    shouldSwitch: true,
    reason: 'threshold_crossed',
    fromAccountId,
    toAccountId: target.accountId,
    thresholdPct,
    currentUsagePct,
    candidates
  };
}

module.exports = {
  DEFAULT_THRESHOLD_PCT,
  MIN_THRESHOLD_PCT,
  MAX_THRESHOLD_PCT,
  normalizeThresholdPct,
  normalizeUsagePct,
  evaluateThresholdSwitch
};
