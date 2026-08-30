'use strict';

const { BaseQuotaResetStrategy } = require('./base-strategy');

// Kimi 官方会员等级：Level 1 (0) < Level 2 (1) < Level 3 (2)
const KIMI_PLAN_TIERS = Object.freeze({
  free: 0,
  level_1: 0,
  level_2: 1,
  level_3: 2
});

class KimiQuotaResetStrategy extends BaseQuotaResetStrategy {
  constructor() {
    super('kimi');
  }

  normalizePlanType(rawPlan) {
    if (!rawPlan) return null;
    const lower = String(rawPlan).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!lower || lower === 'oauth' || lower === 'api-key' || lower === 'apikey' || lower === 'pending' || lower === 'unknown') {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(KIMI_PLAN_TIERS, lower) ? lower : null;
  }

  getPlanTierRank(normalizedPlan) {
    return KIMI_PLAN_TIERS[normalizedPlan];
  }

  extractObservations(snapshot, capturedAt) {
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
}

module.exports = {
  KimiQuotaResetStrategy,
  KIMI_PLAN_TIERS
};
