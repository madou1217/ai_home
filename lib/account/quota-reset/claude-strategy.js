'use strict';

const { BaseQuotaResetStrategy } = require('./base-strategy');

// Claude 官方订阅等级：Free (0) < Pro (1) < Team (2) < Business (3) < Enterprise (4) < Max (5)
const CLAUDE_PLAN_TIERS = Object.freeze({
  free: 0,
  pro: 1,
  team: 2,
  business: 3,
  enterprise: 4,
  max: 5
});

class ClaudeQuotaResetStrategy extends BaseQuotaResetStrategy {
  constructor() {
    super('claude');
  }

  normalizePlanType(rawPlan) {
    if (!rawPlan) return null;
    const normalized = String(rawPlan).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!normalized || normalized === 'oauth' || normalized === 'api_key' || normalized === 'apikey' || normalized === 'pending' || normalized === 'unknown') {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(CLAUDE_PLAN_TIERS, normalized) ? normalized : null;
  }

  getPlanTierRank(normalizedPlan) {
    return CLAUDE_PLAN_TIERS[normalizedPlan];
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
  ClaudeQuotaResetStrategy,
  CLAUDE_PLAN_TIERS
};
