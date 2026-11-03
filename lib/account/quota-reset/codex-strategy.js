'use strict';

const { BaseQuotaResetStrategy, isNonPlanAuthMode } = require('./base-strategy');

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
    if (!rawPlan || isNonPlanAuthMode(rawPlan)) return null;
    const normalized = String(rawPlan).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!normalized || isNonPlanAuthMode(normalized)) return null;
    return Object.prototype.hasOwnProperty.call(CODEX_PLAN_TIERS, normalized) ? normalized : null;
  }

  getPlanTierRank(normalizedPlan) {
    return CODEX_PLAN_TIERS[normalizedPlan];
  }
}

module.exports = {
  CodexQuotaResetStrategy,
  CODEX_PLAN_TIERS
};
