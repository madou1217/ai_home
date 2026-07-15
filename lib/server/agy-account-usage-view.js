'use strict';

const { getMinRemainingPctFromUsageSnapshot } = require('../account/derived-state');
const { normalizeAccountRuntime } = require('./account-runtime-state');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeAgyPlanType(subscriptionTier, fallbackPlanType = '') {
  const tier = normalizeLowerText(subscriptionTier);
  if (tier.includes('ultra')) return 'ultra';
  if (tier.includes('pro')) return 'pro';
  if (tier.includes('starter') || tier.includes('free') || tier.includes('default')) return 'free';

  const fallback = normalizeLowerText(fallbackPlanType);
  if (fallback === 'ultra' || fallback === 'pro' || fallback === 'free') return fallback;
  if (fallback === 'starter' || fallback === 'default') return 'free';
  return normalizeText(fallbackPlanType) || 'oauth';
}

function isFreeAgyPlan(planType) {
  return normalizeLowerText(planType) === 'free';
}

function isAgyUsageSnapshot(snapshot) {
  return Boolean(
    snapshot
    && typeof snapshot === 'object'
    && snapshot.kind === 'agy_code_assist_quota'
    && Array.isArray(snapshot.models)
  );
}

function normalizeRuntimeState(runtimeState) {
  if (!runtimeState || typeof runtimeState !== 'object') return null;
  return normalizeAccountRuntime({ ...runtimeState });
}

function hasQuotaExhaustionSignal(runtimeState) {
  const text = [
    runtimeState && runtimeState.lastFailureKind,
    runtimeState && runtimeState.lastFailureReason,
    runtimeState && runtimeState.lastError
  ].map((value) => normalizeLowerText(value)).filter(Boolean).join('\n');
  return text.includes('model_quota_exhausted')
    || text.includes('resource has been exhausted')
    || text.includes('quota exhausted')
    || text.includes('quota exceeded')
    || (text.includes('resource_exhausted') && (text.includes('quota') || text.includes('check quota')));
}

function buildActiveModelCooldowns(runtimeState, nowMs = Date.now()) {
  const normalized = normalizeRuntimeState(runtimeState);
  const map = normalized && normalized.modelCooldowns;
  if (!map || typeof map !== 'object') return {};
  return Object.keys(map).sort().reduce((acc, model) => {
    const until = Number(map[model]);
    if (Number.isFinite(until) && until > nowMs) acc[model] = until;
    return acc;
  }, {});
}

function cloneAgySnapshotWithPlan(snapshot, planType) {
  if (!isAgyUsageSnapshot(snapshot)) return null;
  return {
    ...snapshot,
    account: {
      ...(snapshot.account && typeof snapshot.account === 'object' ? snapshot.account : {}),
      planType
    },
    models: snapshot.models.map((model) => ({ ...model }))
  };
}

function markAllModelsExhausted(snapshot) {
  if (!isAgyUsageSnapshot(snapshot)) return null;
  return {
    ...snapshot,
    models: snapshot.models.map((model) => ({
      ...model,
      remainingPct: 0
    }))
  };
}

function buildAgyEffectiveUsageView(input = {}) {
  const snapshot = isAgyUsageSnapshot(input.usageSnapshot) ? input.usageSnapshot : null;
  const snapshotAccount = snapshot && snapshot.account && typeof snapshot.account === 'object'
    ? snapshot.account
    : {};
  const account = input.account && typeof input.account === 'object' ? input.account : {};
  const planType = normalizeAgyPlanType(
    snapshotAccount.subscriptionTier || account.subscriptionTier,
    snapshotAccount.planType || account.planType || input.fallbackPlanType || 'oauth'
  );
  const normalizedSnapshot = snapshot ? cloneAgySnapshotWithPlan(snapshot, planType) : null;
  const runtimeState = input.runtimeState && typeof input.runtimeState === 'object'
    ? input.runtimeState
    : account;
  const activeModelCooldowns = buildActiveModelCooldowns(runtimeState, input.nowMs);
  const quotaExhaustionSignal = hasQuotaExhaustionSignal(normalizeRuntimeState(runtimeState));
  const freeQuotaExhausted = isFreeAgyPlan(planType)
    && Object.keys(activeModelCooldowns).length > 0;
  const usageSnapshot = freeQuotaExhausted
    ? markAllModelsExhausted(normalizedSnapshot)
    : normalizedSnapshot;
  const remainingPct = freeQuotaExhausted
    ? 0
    : getMinRemainingPctFromUsageSnapshot(usageSnapshot);

  return {
    planType,
    usageSnapshot,
    remainingPct,
    freeQuotaExhausted,
    quotaExhaustionSignal,
    activeModelCooldowns
  };
}

module.exports = {
  buildAgyEffectiveUsageView,
  normalizeAgyPlanType,
  __private: {
    buildActiveModelCooldowns,
    hasQuotaExhaustionSignal
  }
};
