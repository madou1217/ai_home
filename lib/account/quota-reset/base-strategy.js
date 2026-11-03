'use strict';

/**
 * Common set of auth modes and placeholder strings that must never be treated as subscription plan tiers.
 */
const NON_PLAN_AUTH_MODES = new Set([
  '',
  'oauth',
  'oauth-browser',
  'oauth-device',
  'api-key',
  'api_key',
  'apikey',
  'pending',
  'unknown'
]);

function isNonPlanAuthMode(value) {
  if (!value) return true;
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return NON_PLAN_AUTH_MODES.has(normalized) || NON_PLAN_AUTH_MODES.has(String(value).trim().toLowerCase());
}

/**
 * Provider-agnostic strategy interface for extracting quota observations
 * and evaluating plan tiers.
 */
class BaseQuotaResetStrategy {
  constructor(providerName) {
    this.providerName = String(providerName || '').trim().toLowerCase();
  }

  /**
   * Normalize and validate a raw plan string into a strongly-typed level.
   * Returns null if the value is empty, an auth-mode (e.g. 'oauth', 'api-key'),
   * or an unresolvable string.
   * @param {string|null} _rawPlan
   * @returns {string|null}
   */
  normalizePlanType(_rawPlan) {
    return null;
  }

  /**
   * Get the numeric rank for a normalized plan type.
   * Higher rank represents higher subscription tier.
   * @param {string|null} _normalizedPlan
   * @returns {number|undefined}
   */
  getPlanTierRank(_normalizedPlan) {
    return undefined;
  }

  /**
   * Compare two plan types to determine if an upgrade occurred.
   * @param {string|null} prevPlan
   * @param {string|null} currentPlan
   * @returns {boolean}
   */
  isPlanUpgrade(prevPlan, currentPlan) {
    const prev = this.normalizePlanType(prevPlan);
    const curr = this.normalizePlanType(currentPlan);
    if (!prev || !curr || prev === curr) return false;
    const prevRank = this.getPlanTierRank(prev);
    const currRank = this.getPlanTierRank(curr);
    return prevRank !== undefined && currRank !== undefined && currRank > prevRank;
  }

  /**
   * Standard helper to extract observations from `snapshot.entries` for providers that speak standard entry schema.
   * @param {object} snapshot
   * @param {number} capturedAt
   * @returns {Array<object>}
   */
  extractStandardEntriesObservations(snapshot, capturedAt) {
    if (!snapshot || typeof snapshot !== 'object') return [];
    const planType = this.normalizePlanType(
      (snapshot.account && snapshot.account.planType) || snapshot.planType
    );
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
    }

    return observations;
  }

  /**
   * Extract standardized quota observations from a provider-specific usage snapshot.
   * @param {object} snapshot
   * @param {number} capturedAt
   * @returns {Array<object>}
   */
  extractObservations(snapshot, capturedAt) {
    return this.extractStandardEntriesObservations(snapshot, capturedAt);
  }
}

module.exports = {
  BaseQuotaResetStrategy,
  isNonPlanAuthMode
};
