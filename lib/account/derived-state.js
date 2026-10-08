'use strict';

const { providerSupports } = require('../provider-catalog');
// Remaining 提取的单一事实来源在 usage-remaining.js（kind 注册表见该文件）；
// 这里仅做委托转发，保留既有导入路径兼容。
const {
  isUsageRemainingSnapshot,
  getUsageRemainingPctValues,
  getMinRemainingPctFromUsageSnapshot
} = require('./usage-remaining');

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

function resolveMinimumRemainingPct(usageThresholdPct) {
  const thresholdPct = readOptionalNumber(usageThresholdPct);
  if (!Number.isFinite(thresholdPct)) return null;
  const normalizedThresholdPct = Math.max(0, Math.min(100, thresholdPct));
  return Math.max(0, Math.min(100, 100 - normalizedThresholdPct));
}

function hasNumericUsageSnapshot(snapshot) {
  return getUsageRemainingPctValues(snapshot).length > 0;
}

function resolvePreferredRemainingPct(usageSnapshot, ...fallbackValues) {
  const snapshotRemaining = getMinRemainingPctFromUsageSnapshot(usageSnapshot);
  if (Number.isFinite(snapshotRemaining)) {
    return Math.max(0, Math.min(100, Number(snapshotRemaining)));
  }
  // 当前快照中的未知额度同样是权威值，不能用旧余额将遥测缺失
  // 误判成耗尽或触发账号切换阈值。
  if (isUsageRemainingSnapshot(usageSnapshot)) return null;
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
  if (!providerSupports(provider, 'quotaUsage')) {
    return {
      status: 'not_applicable',
      reason: '',
      remainingPct: null,
      hasNumericRemaining: false
    };
  }
  const hasNumericRemaining = Number.isFinite(remainingPct);
  // 最近一次探测失败时，正数缓存只是历史额度，不能掩盖失败状态。
  // 已知耗尽仍然从严保留，防止网络错误重新放行耗尽账号。
  if (probeError && (!hasNumericRemaining || remainingPct > 0)) {
    return {
      status: 'probe_failed',
      reason: probeError,
      remainingPct: hasNumericRemaining ? remainingPct : null,
      hasNumericRemaining
    };
  }
  if (hasNumericRemaining) {
    return {
      status: remainingPct <= 0 ? 'exhausted' : 'available',
      reason: '',
      remainingPct,
      hasNumericRemaining: true
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
  const minimumRemainingPct = resolveMinimumRemainingPct(options.usageThresholdPct);
  const usageSnapshot = options.usageSnapshot && typeof options.usageSnapshot === 'object'
    ? options.usageSnapshot
    : null;
  const quotaState = options.quotaState && typeof options.quotaState === 'object'
    ? options.quotaState
    : deriveQuotaState(options);
  const remainingPct = resolvePreferredRemainingPct(usageSnapshot, quotaState.remainingPct, options.remainingPct);

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
  if (runtimeStatus && runtimeStatus !== 'healthy' && runtimeStatus !== 'unknown') {
    return {
      status: 'blocked_by_runtime_status',
      reason: runtimeStatus
    };
  }
  if (options.relayDisabled) {
    return {
      status: 'blocked_by_policy',
      reason: String(options.relayDisabledReason || 'relay_disabled').trim()
    };
  }
  if (apiKeyMode) {
    return {
      status: 'schedulable',
      reason: ''
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
    && Number.isFinite(remainingPct)
    && Number.isFinite(minimumRemainingPct)
    && remainingPct > 0
    && remainingPct <= minimumRemainingPct
  ) {
    return {
      status: 'blocked_by_policy',
      reason: planType === 'free'
        ? 'codex_free_plan_below_server_min_remaining'
        : 'codex_usage_below_server_threshold'
    };
  }
  return {
    status: 'schedulable',
    reason: ''
  };
}

module.exports = {
  readOptionalNumber,
  getUsageRemainingPctValues,
  hasNumericUsageSnapshot,
  getMinRemainingPctFromUsageSnapshot,
  resolveMinimumRemainingPct,
  resolvePreferredRemainingPct,
  deriveQuotaState,
  deriveSchedulableState
};
