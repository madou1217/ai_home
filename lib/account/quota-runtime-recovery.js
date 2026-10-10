'use strict';

// 额度真相只撤销被新快照推翻的额度失败；不清凭据、权限、账单或网络状态。
const QUOTA_REASONS = new Set(['usage_limit_reached', 'insufficient_quota', 'quota_exceeded', 'quota_exhausted', 'model_quota_exhausted']);

function isQuotaFailure(failure) {
  return Boolean(failure && (QUOTA_REASONS.has(failure.kind) || QUOTA_REASONS.has(failure.reason)));
}

function trustedCodexSnapshot(snapshot) {
  return Boolean(snapshot && snapshot.schemaVersion === 2 && snapshot.kind === 'codex_oauth_status'
    && snapshot.source === 'codex_app_server' && !snapshot.fallbackSource
    && Number.isFinite(Number(snapshot.capturedAt)) && Number(snapshot.capturedAt) > 0
    && Array.isArray(snapshot.entries) && snapshot.entries.length);
}

function trustedAvailableCodexSnapshot(snapshot) {
  return Boolean(trustedCodexSnapshot(snapshot)
    && snapshot.entries.every(entry => entry && entry.remainingPct != null && entry.remainingPct !== ''
      && Number.isFinite(Number(entry.remainingPct)) && Number(entry.remainingPct) > 0));
}

function recoverQuotaRuntimeState(provider, runtimeState, snapshot) {
  if (provider !== 'codex' || !runtimeState || !trustedAvailableCodexSnapshot(snapshot)) return runtimeState;
  const capturedAt = Number(snapshot.capturedAt);
  const next = {
    ...runtimeState,
    modelCooldowns: { ...runtimeState.modelCooldowns },
    modelFailureStreaks: { ...runtimeState.modelFailureStreaks }
  };
  let changed = false;
  for (const [model, failure] of Object.entries(next.modelFailureStreaks)) {
    const failedAt = Number(failure.observedAt) || Number(runtimeState.lastFailureAt);
    if (!isQuotaFailure(failure) || !(failedAt > 0 && capturedAt > failedAt)) continue;
    delete next.modelCooldowns[model];
    delete next.modelFailureStreaks[model];
    changed = true;
  }
  const block = next.routingBlock;
  if (block && block.kind === 'quota_exhausted' && block.observedAt > 0 && capturedAt > block.observedAt) {
    next.routingBlock = null;
    changed = true;
  }
  const hasNewerQuotaFailure = Object.values(next.modelFailureStreaks).some(isQuotaFailure);
  if (!hasNewerQuotaFailure && isQuotaFailure({ kind: next.lastFailureKind, reason: next.lastFailureReason })
    && Number(next.lastFailureAt) > 0 && capturedAt > Number(next.lastFailureAt)) {
    next.rateLimitUntil = 0;
    next.cooldownUntil = Math.max(0, ...['authInvalidUntil', 'overloadUntil', 'networkUntil', 'serviceUnavailableUntil', 'upstreamErrorUntil']
      .map(key => Number(next[key]) || 0));
    next.lastFailureKind = '';
    next.lastFailureReason = '';
    next.lastError = '';
    next.lastFailureAt = 0;
    next.consecutiveFailures = 0;
    changed = true;
  }
  return changed ? next : runtimeState;
}

module.exports = { isQuotaFailure, trustedCodexSnapshot, trustedAvailableCodexSnapshot, recoverQuotaRuntimeState };
