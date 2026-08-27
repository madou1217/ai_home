'use strict';

const crypto = require('node:crypto');
const {
  withDatabase,
  withImmediateTransaction,
  getDetectorState,
  upsertDetectorState,
  insertResetEvent
} = require('./quota-reset-store');

const TOLERANCE_WINDOW_MS = 3 * 60 * 1000; // 3 minutes tolerance for clock skew / probe interval
const ARMED_THRESHOLD_PCT = 95.0; // Must drop to <= 95% to arm replenishment detection
const EXHAUSTED_THRESHOLD_PCT = 5.0; // <= 5% (or 0%) is considered depleted/exhausted
const REPLENISHED_THRESHOLD_PCT = 99.5; // Must reach >= 99.5% to trigger replenishment
const MIN_JUMP_PCT = 25.0; // Or jump up by at least 25% to reach near 100%

function sha256Key(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 32);
}

function extractQuotaObservations(provider, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const capturedAt = Number(snapshot.capturedAt) || Date.now();
  const planType = String((snapshot.account && snapshot.account.planType) || snapshot.planType || '').trim().toLowerCase() || null;
  const observations = [];

  if (Array.isArray(snapshot.entries)) {
    snapshot.entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const bucket = String(entry.bucket || '').trim();
      const windowMinutes = Number(entry.windowMinutes) || null;
      const windowLabel = String(entry.window || bucket || '').trim();
      const quotaKey = `rate_limit:${bucket || windowLabel || 'default'}`;
      const remainingPct = typeof entry.remainingPct === 'number' && Number.isFinite(entry.remainingPct)
        ? Math.max(0, Math.min(100, entry.remainingPct))
        : null;
      const expectedResetAtMs = Number(entry.resetAtMs) > 0 ? Number(entry.resetAtMs) : null;

      if (remainingPct !== null || expectedResetAtMs !== null) {
        observations.push({
          quotaKey,
          windowLabel,
          windowMinutes,
          remainingPct,
          expectedResetAtMs,
          planType,
          capturedAt
        });
      }
    });
  } else if (Array.isArray(snapshot.models)) {
    snapshot.models.forEach((model) => {
      if (!model || typeof model !== 'object') return;
      const modelId = String(model.model || '').trim();
      if (!modelId) return;
      const quotaKey = `model:${modelId}`;
      const windowLabel = String(model.displayName || modelId).trim();
      const remainingPct = typeof model.remainingPct === 'number' && Number.isFinite(model.remainingPct)
        ? Math.max(0, Math.min(100, model.remainingPct))
        : null;
      const expectedResetAtMs = Number(model.resetAtMs) > 0 ? Number(model.resetAtMs) : null;

      if (remainingPct !== null || expectedResetAtMs !== null) {
        observations.push({
          quotaKey,
          windowLabel,
          windowMinutes: null,
          remainingPct,
          expectedResetAtMs,
          planType,
          capturedAt
        });
      }
    });
  }

  return observations;
}

function processQuotaObservation(db, accountRef, provider, obs) {
  const {
    quotaKey,
    windowLabel,
    windowMinutes,
    remainingPct,
    expectedResetAtMs,
    planType,
    capturedAt
  } = obs;

  const prevState = getDetectorState(db, accountRef, quotaKey);
  const now = capturedAt || Date.now();

  // Baseline initialization: if no prior state, record baseline and return
  if (!prevState) {
    // 只要消耗了（< 100%），就进入武装监控状态，等待重置恢复
    const isArmed = remainingPct !== null && remainingPct < 100.0;
    const isExhausted = remainingPct !== null && remainingPct <= EXHAUSTED_THRESHOLD_PCT;
    upsertDetectorState(db, {
      accountRef,
      provider,
      quotaKey,
      lastRemainingPct: remainingPct,
      lastExpectedResetAtMs: expectedResetAtMs,
      lastCapturedAtMs: now,
      lastPlanType: planType,
      isArmed: isArmed ? 1 : 0,
      rearmGeneration: isArmed ? 1 : 0,
      exhaustedAtMs: isExhausted ? now : null,
      updatedAtMs: now
    });
    return null;
  }

  // Discard out-of-order or duplicate timestamp observations
  if (now <= prevState.lastCapturedAtMs) {
    return null;
  }

  let generatedEvent = null;
  let nextArmed = prevState.isArmed;
  let nextGeneration = prevState.rearmGeneration;
  let nextExhaustedAt = prevState.exhaustedAtMs;

  const prevResetAt = prevState.lastExpectedResetAtMs;
  const prevRemaining = prevState.lastRemainingPct;

  // Track when quota gets exhausted (<= 5% or 0%)
  if (remainingPct !== null && remainingPct <= EXHAUSTED_THRESHOLD_PCT) {
    if (!nextExhaustedAt) nextExhaustedAt = now;
  }

  // 严格的重置判定铁律：
  // 必须是此前存在消耗（prevRemaining < 100%），并且当前观察值出现了回升（remainingPct > prevRemaining 或达到 100%）。
  // 决不能把「100% -> 42%」这种用量消耗事件、或者「100% -> 100%」无消耗空转误记为重置事件！
  const prevPlan = prevState.lastPlanType;
  const currentPlan = planType;
  const PLAN_TIER_RANK = { free: 0, oauth: 0, plus: 1, pro: 2, team: 3, enterprise: 4, max: 5 };
  const prevTier = prevPlan ? PLAN_TIER_RANK[prevPlan.toLowerCase()] : undefined;
  const currentTier = currentPlan ? PLAN_TIER_RANK[currentPlan.toLowerCase()] : undefined;
  const isPlanUpgraded = Boolean(
    prevPlan && currentPlan && prevPlan !== currentPlan &&
    prevTier !== undefined && currentTier !== undefined && currentTier > prevTier
  );

  const hadConsumption = prevRemaining !== null && prevRemaining < 100.0;
  const isUpwardRecovery = hadConsumption && remainingPct !== null && remainingPct > prevRemaining;

  // Signal 1: Cycle Rollover (自然周期滚动重置)
  // 条件：此前有消耗，且当前周期时间已推进 (resetTimestampAdvanced) 或到达原定重置时间后配额恢复
  const resetTimestampAdvanced = prevResetAt !== null
    && expectedResetAtMs !== null
    && expectedResetAtMs > prevResetAt + TOLERANCE_WINDOW_MS;

  const naturalResetTimePassed = prevResetAt !== null
    && now >= prevResetAt - TOLERANCE_WINDOW_MS
    && remainingPct !== null
    && remainingPct >= REPLENISHED_THRESHOLD_PCT;

  const isCycleRollover = isUpwardRecovery && (
    (resetTimestampAdvanced && now >= prevResetAt - TOLERANCE_WINDOW_MS) || naturalResetTimePassed
  );

  if (isCycleRollover) {
    // 物理重置时间为原定预期的 previousExpectedResetAtMs
    const occurredAtMs = prevResetAt || now;
    const eventKey = sha256Key(
      `${accountRef}:${provider}:${quotaKey}:cycle:${prevResetAt}:${expectedResetAtMs || occurredAtMs}`
    );
    generatedEvent = {
      eventKey,
      accountRef,
      provider,
      quotaKey,
      windowLabel,
      windowMinutes,
      eventKind: 'cycle_rollover',
      classification: 'natural',
      cause: 'scheduled',
      previousRemainingPct: prevRemaining,
      currentRemainingPct: remainingPct,
      previousExpectedResetAtMs: prevResetAt,
      exhaustedAtMs: prevState.exhaustedAtMs || null,
      occurredAtMs,
      detectedAtMs: now,
      earlyDurationMs: 0,
      previousPlanType: prevPlan,
      currentPlanType: currentPlan
    };
    // 新周期开始，若当前不满 100% 则继续 arm
    nextArmed = remainingPct !== null && remainingPct < 100.0;
    if (nextArmed) nextGeneration += 1;
    nextExhaustedAt = (remainingPct !== null && remainingPct <= EXHAUSTED_THRESHOLD_PCT) ? now : null;
  } else if (isUpwardRecovery) {
    // Signal 2: Early Replenishment (提前回血 / 周期未到但额度回升)
    const isEarly = prevResetAt !== null && now < (prevResetAt - TOLERANCE_WINDOW_MS);
    const earlyDurationMs = isEarly && prevResetAt ? Math.max(0, prevResetAt - now) : 0;
    const eventKey = sha256Key(
      `${accountRef}:${provider}:${quotaKey}:rearm:${prevState.rearmGeneration}:${Math.floor(now / 60000)}`
    );
    generatedEvent = {
      eventKey,
      accountRef,
      provider,
      quotaKey,
      windowLabel,
      windowMinutes,
      eventKind: 'replenishment',
      classification: isPlanUpgraded ? 'plan_upgrade' : (isEarly ? 'early_inferred' : 'natural'),
      cause: isPlanUpgraded ? `upgrade:${prevPlan}->${currentPlan}` : (isEarly ? 'unknown' : 'scheduled'),
      previousRemainingPct: prevRemaining,
      currentRemainingPct: remainingPct,
      previousExpectedResetAtMs: prevResetAt,
      exhaustedAtMs: prevState.exhaustedAtMs || null,
      occurredAtMs: now,
      detectedAtMs: now,
      earlyDurationMs: isPlanUpgraded ? 0 : earlyDurationMs,
      previousPlanType: prevPlan,
      currentPlanType: currentPlan
    };
    nextArmed = remainingPct !== null && remainingPct < 100.0;
    if (remainingPct >= 100.0) nextExhaustedAt = null;
  } else {
    // 纯消耗分支（例如 100% -> 99% 或 99% -> 42%）：武装监控，不触发重置事件
    if (remainingPct !== null && remainingPct < 100.0) {
      if (!nextArmed) {
        nextArmed = true;
        nextGeneration += 1;
      }
    }
  }

  if (generatedEvent) {
    insertResetEvent(db, generatedEvent);
  }

  // Update latest baseline state for this dimension
  upsertDetectorState(db, {
    accountRef,
    provider,
    quotaKey,
    lastRemainingPct: remainingPct,
    lastExpectedResetAtMs: expectedResetAtMs,
    lastCapturedAtMs: now,
    lastPlanType: planType || prevState.lastPlanType || null,
    isArmed: nextArmed ? 1 : 0,
    rearmGeneration: nextGeneration,
    exhaustedAtMs: nextExhaustedAt,
    updatedAtMs: now
  });

  return generatedEvent;
}

function detectAndRecordQuotaResets(fs, aiHomeDir, accountRef, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const provider = String(snapshot.provider || (snapshot.account && snapshot.account.provider) || '').trim().toLowerCase();
  const observations = extractQuotaObservations(provider, snapshot);
  if (observations.length === 0) return [];

  return withDatabase(fs, aiHomeDir, (db) => withImmediateTransaction(db, () => {
    const recordedEvents = [];
    for (const obs of observations) {
      const event = processQuotaObservation(db, accountRef, provider, obs);
      if (event) recordedEvents.push(event);
    }
    return recordedEvents;
  })) || [];
}

module.exports = {
  extractQuotaObservations,
  processQuotaObservation,
  detectAndRecordQuotaResets,
  __private: {
    ARMED_THRESHOLD_PCT,
    EXHAUSTED_THRESHOLD_PCT,
    REPLENISHED_THRESHOLD_PCT,
    TOLERANCE_WINDOW_MS
  }
};
