'use strict';

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
   * Extract standardized quota observations from a provider-specific usage snapshot.
   * @param {object} _snapshot
   * @param {number} _capturedAt
   * @returns {Array<object>}
   */
  extractObservations(_snapshot, _capturedAt) {
    return [];
  }
}

module.exports = {
  BaseQuotaResetStrategy
};
