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
    capturedAt
  } = obs;

  const prevState = getDetectorState(db, accountRef, quotaKey);
  const now = capturedAt || Date.now();

  // Baseline initialization: if no prior state, record baseline and return
  if (!prevState) {
    const isArmed = remainingPct !== null && remainingPct <= ARMED_THRESHOLD_PCT;
    const isExhausted = remainingPct !== null && remainingPct <= EXHAUSTED_THRESHOLD_PCT;
    upsertDetectorState(db, {
      accountRef,
      provider,
      quotaKey,
      lastRemainingPct: remainingPct,
      lastExpectedResetAtMs: expectedResetAtMs,
      lastCapturedAtMs: now,
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

  // Track when quota gets exhausted
  if (remainingPct !== null && remainingPct <= EXHAUSTED_THRESHOLD_PCT) {
    if (!nextExhaustedAt) nextExhaustedAt = now;
  }

  // Signal 1: Cycle Rollover (natural cycle advanced)
  const isCycleRollover = prevResetAt !== null
    && expectedResetAtMs !== null
    && expectedResetAtMs > prevResetAt + TOLERANCE_WINDOW_MS
    && now >= prevResetAt - TOLERANCE_WINDOW_MS;

  if (isCycleRollover) {
    const eventKey = sha256Key(
      `${accountRef}:${provider}:${quotaKey}:cycle:${prevResetAt}:${expectedResetAtMs}`
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
      detectedAtMs: now,
      earlyDurationMs: 0
    };
    // Arm & exhausted state resets on new cycle
    nextArmed = remainingPct !== null && remainingPct <= ARMED_THRESHOLD_PCT;
    if (nextArmed) nextGeneration += 1;
    nextExhaustedAt = (remainingPct !== null && remainingPct <= EXHAUSTED_THRESHOLD_PCT) ? now : null;
  } else {
    // Signal 2: Early Replenishment (Quota jumping back to ~100% before scheduled reset)
    const isReplenishing = prevState.isArmed
      && prevRemaining !== null
      && remainingPct !== null
      && remainingPct >= REPLENISHED_THRESHOLD_PCT
      && (remainingPct - prevRemaining >= MIN_JUMP_PCT || prevRemaining <= ARMED_THRESHOLD_PCT);

    const isEarly = prevResetAt !== null && now < (prevResetAt - TOLERANCE_WINDOW_MS);

    if (isReplenishing) {
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
        classification: isEarly ? 'early_inferred' : 'natural',
        cause: isEarly ? 'unknown' : 'scheduled',
        previousRemainingPct: prevRemaining,
        currentRemainingPct: remainingPct,
        previousExpectedResetAtMs: prevResetAt,
        exhaustedAtMs: prevState.exhaustedAtMs || null,
        detectedAtMs: now,
        earlyDurationMs
      };
      // Quota is now full, disarm and clear exhausted state
      nextArmed = false;
      nextExhaustedAt = null;
    } else if (remainingPct !== null && remainingPct <= ARMED_THRESHOLD_PCT) {
      // Re-arm when quota drops below threshold
      if (!nextArmed) {
        nextArmed = true;
        nextGeneration += 1;
      }
    }
  }

  if (generatedEvent) {
    insertResetEvent(db, generatedEvent);
  }

  upsertDetectorState(db, {
    accountRef,
    provider,
    quotaKey,
    lastRemainingPct: remainingPct,
    lastExpectedResetAtMs: expectedResetAtMs,
    lastCapturedAtMs: now,
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
