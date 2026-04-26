'use strict';

const CODEX_FREE_SERVER_MIN_REMAINING_PCT = 20;

function normalizeLowerText(value) {
  return String(value || '').trim().toLowerCase();
}

function readOptionalNumber(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function getUsageRemainingPctValues(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  if (snapshot.kind === 'codex_oauth_status' && Array.isArray(snapshot.entries)) {
    return snapshot.entries
      .map((entry) => readOptionalNumber(entry && entry.remainingPct))
      .filter((value) => Number.isFinite(value));
  }
  if (snapshot.kind === 'gemini_oauth_stats' && Array.isArray(snapshot.models)) {
    return snapshot.models
      .map((model) => readOptionalNumber(model && model.remainingPct))
      .filter((value) => Number.isFinite(value));
  }
  if (snapshot.kind === 'claude_oauth_usage' && Array.isArray(snapshot.entries)) {
    return snapshot.entries
      .map((entry) => readOptionalNumber(entry && entry.remainingPct))
      .filter((value) => Number.isFinite(value));
  }
  return [];
}

function hasNumericUsageSnapshot(snapshot) {
  return getUsageRemainingPctValues(snapshot).length > 0;
}

function getMinRemainingPctFromUsageSnapshot(snapshot) {
  const values = getUsageRemainingPctValues(snapshot);
  if (values.length === 0) return null;
  return Math.max(0, Math.min(100, Math.min(...values)));
}

function resolvePreferredRemainingPct(usageSnapshot, ...fallbackValues) {
  const snapshotRemaining = getMinRemainingPctFromUsageSnapshot(usageSnapshot);
  if (Number.isFinite(snapshotRemaining)) {
    return Math.max(0, Math.min(100, Number(snapshotRemaining)));
  }
  const fallbackRemaining = readOptionalNumber(...fallbackValues);
  if (!Number.isFinite(fallbackRemaining)) return null;
  return Math.max(0, Math.min(100, Number(fallbackRemaining)));
}

function deriveQuotaState(options = {}) {
  const configured = Boolean(options.configured);
  const apiKeyMode = Boolean(options.apiKeyMode);
  const provider = normalizeLowerText(options.provider);
  const usageSnapshot = options.usageSnapshot && typeof options.usageSnapshot === 'object'
    ? options.usageSnapshot
    : null;
  const probeError = String(options.probeError || '').trim().slice(0, 500);
  const remainingPct = resolvePreferredRemainingPct(
    usageSnapshot,
    options.remainingPct
  );
  const planType = normalizeLowerText(options.planType);

  if (!configured || apiKeyMode) {
    return {
      status: 'not_applicable',
      reason: '',
      remainingPct: null,
      hasNumericRemaining: false
    };
  }

  if (Number.isFinite(remainingPct)) {
    return {
      status: remainingPct <= 0 ? 'exhausted' : 'available',
      reason: '',
      remainingPct,
      hasNumericRemaining: true
    };
  }

  if (probeError) {
    return {
      status: 'probe_failed',
      reason: probeError,
      remainingPct: null,
      hasNumericRemaining: false
    };
  }

  if (usageSnapshot) {
    const fallbackSource = String(usageSnapshot.fallbackSource || '').trim();
    if (provider === 'codex' && usageSnapshot.kind === 'codex_oauth_status' && fallbackSource === 'auth_json') {
      return {
        status: 'pending',
        reason: 'auth_metadata_only',
        remainingPct: null,
        hasNumericRemaining: false
      };
    }
    if (provider === 'codex' && usageSnapshot.kind === 'codex_oauth_status' && fallbackSource === 'account_read') {
      // Team/Free 账号没有额度数据时，标记为 pending 而不是 provider_unavailable
      // 这样账号可以进入账号池，等待后续刷新获取额度数据
      if (planType === 'team') {
        return {
          status: 'pending',
          reason: 'codex_team_plan_pending_rate_limits',
          remainingPct: null,
          hasNumericRemaining: false
        };
      }
      if (planType === 'free') {
        return {
          status: 'pending',
          reason: 'codex_free_plan_pending_rate_limits',
          remainingPct: null,
          hasNumericRemaining: false
        };
      }
    }
    return {
      status: 'pending',
      reason: 'provider_returned_no_numeric_usage',
      remainingPct: null,
      hasNumericRemaining: false
    };
  }

  return {
    status: 'pending',
    reason: '',
    remainingPct: null,
    hasNumericRemaining: false
  };
}

function deriveSchedulableState(options = {}) {
  const configured = Boolean(options.configured);
  const apiKeyMode = Boolean(options.apiKeyMode);
  const provider = normalizeLowerText(options.provider);
  const accountStatus = normalizeLowerText(options.accountStatus || options.status || 'up');
  const runtimeStatus = normalizeLowerText(options.runtimeStatus);
  const planType = normalizeLowerText(options.planType);
  const usageSnapshot = options.usageSnapshot && typeof options.usageSnapshot === 'object'
    ? options.usageSnapshot
    : null;
  const quotaState = options.quotaState && typeof options.quotaState === 'object'
    ? options.quotaState
    : deriveQuotaState(options);
  const remainingPct = readOptionalNumber(options.remainingPct, quotaState.remainingPct);

  if (!configured) {
    return {
      status: 'blocked_by_account_status',
      reason: 'account_unconfigured'
    };
  }
  if (accountStatus === 'down' || accountStatus === 'disabled') {
    return {
      status: 'blocked_by_account_status',
      reason: 'account_disabled'
    };
  }
  if (apiKeyMode) {
    return {
      status: 'schedulable',
      reason: ''
    };
  }
  if (runtimeStatus && runtimeStatus !== 'healthy' && runtimeStatus !== 'unknown') {
    return {
      status: 'blocked_by_runtime_status',
      reason: runtimeStatus
    };
  }
  if (quotaState.status === 'exhausted') {
    return {
      status: 'blocked_by_quota',
      reason: 'usage_exhausted'
    };
  }
  if (
    provider === 'codex'
    && planType === 'free'
    && Number.isFinite(remainingPct)
    && remainingPct > 0
    && remainingPct < CODEX_FREE_SERVER_MIN_REMAINING_PCT
  ) {
    return {
      status: 'blocked_by_policy',
      reason: 'codex_free_plan_below_server_min_remaining'
    };
  }
  if (
    provider === 'codex'
    && usageSnapshot
    && usageSnapshot.kind === 'codex_oauth_status'
    && String(usageSnapshot.fallbackSource || '').trim() === 'account_read'
    && !hasNumericUsageSnapshot(usageSnapshot)
    && (quotaState.reason === 'codex_team_plan_missing_rate_limits' || quotaState.reason === 'codex_free_plan_missing_rate_limits')
  ) {
    // 旧版本逻辑保留：如果 quotaState 仍然是旧的 provider_unavailable 状态
    // 但现在这些状态已被改为 pending，所以这个分支不会再触发
    return {
      status: 'blocked_by_policy',
      reason: quotaState.reason
    };
  }
  return {
    status: 'schedulable',
    reason: ''
  };
}

module.exports = {
  CODEX_FREE_SERVER_MIN_REMAINING_PCT,
  readOptionalNumber,
  getUsageRemainingPctValues,
  hasNumericUsageSnapshot,
  getMinRemainingPctFromUsageSnapshot,
  resolvePreferredRemainingPct,
  deriveQuotaState,
  deriveSchedulableState
};
