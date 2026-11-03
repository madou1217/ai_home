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
  const accountRef = account.accountRef != null ? String(account.accountRef).trim() : '';
  return {
    accountRef,
    usagePct: normalizeUsagePct(account.usagePct),
    quotaBlocked: Boolean(account.quotaBlocked),
    available: account.available !== false,
    source: account.source || 'snapshot'
  };
}

function buildCandidateList(accounts, currentAccountRef) {
  return (Array.isArray(accounts) ? accounts : [])
    .map(normalizeAccount)
    .filter((entry) => entry.accountRef && entry.accountRef !== String(currentAccountRef))
    .filter((entry) => entry.available && !entry.quotaBlocked)
    .sort((a, b) => {
      if (a.usagePct !== b.usagePct) return a.usagePct - b.usagePct;
      return a.accountRef.localeCompare(b.accountRef);
    });
}

function evaluateThresholdSwitch(input = {}) {
  const fromAccountRef = input.currentAccountRef != null ? String(input.currentAccountRef).trim() : '';
  const thresholdPct = normalizeThresholdPct(input.thresholdPct);
  const currentUsagePct = normalizeUsagePct(input.currentUsagePct);

  if (!fromAccountRef) {
    return {
      shouldSwitch: false,
      reason: 'missing_current_account',
      fromAccountRef,
      toAccountRef: '',
      thresholdPct,
      currentUsagePct,
      candidates: []
    };
  }

  if (currentUsagePct < thresholdPct) {
    return {
      shouldSwitch: false,
      reason: 'below_threshold',
      fromAccountRef,
      toAccountRef: '',
      thresholdPct,
      currentUsagePct,
      candidates: []
    };
  }

  const candidates = buildCandidateList(input.accounts, fromAccountRef);
  const target = candidates[0] || null;

  if (!target) {
    return {
      shouldSwitch: false,
      reason: 'no_eligible_target',
      fromAccountRef,
      toAccountRef: '',
      thresholdPct,
      currentUsagePct,
      candidates
    };
  }

  return {
    shouldSwitch: true,
    reason: 'threshold_crossed',
    fromAccountRef,
    toAccountRef: target.accountRef,
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
