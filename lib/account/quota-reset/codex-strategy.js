'use strict';

const { BaseQuotaResetStrategy } = require('./base-strategy');

// Codex 官方套餐等级层次：Free (0) < Go / Plus / Pro Lite (1) < Pro (2) < Team (3) < Business (4) < Enterprise / Edu (5)
const CODEX_PLAN_TIERS = Object.freeze({
  free: 0,
  go: 1,
  plus: 1,
  prolite: 1,
  pro_lite: 1,
  pro: 2,
  team: 3,
  self_serve_business_usage_based: 4,
  business: 4,
  enterprise_cbp_usage_based: 5,
  enterprise: 5,
  hc: 5,
  edu: 5,
  education: 5
});

class CodexQuotaResetStrategy extends BaseQuotaResetStrategy {
  constructor() {
    super('codex');
  }

  normalizePlanType(rawPlan) {
    if (!rawPlan) return null;
    const normalized = String(rawPlan).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!normalized || normalized === 'oauth' || normalized === 'api_key' || normalized === 'apikey' || normalized === 'pending' || normalized === 'unknown') {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(CODEX_PLAN_TIERS, normalized) ? normalized : null;
  }

  getPlanTierRank(normalizedPlan) {
    return CODEX_PLAN_TIERS[normalizedPlan];
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
  CodexQuotaResetStrategy,
  CODEX_PLAN_TIERS
};
