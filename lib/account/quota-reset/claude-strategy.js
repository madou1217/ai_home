'use strict';

const { BaseQuotaResetStrategy, isNonPlanAuthMode } = require('./base-strategy');

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
    if (!rawPlan || isNonPlanAuthMode(rawPlan)) return null;
    const normalized = String(rawPlan).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!normalized || isNonPlanAuthMode(normalized)) return null;
    return Object.prototype.hasOwnProperty.call(CLAUDE_PLAN_TIERS, normalized) ? normalized : null;
  }

  getPlanTierRank(normalizedPlan) {
    return CLAUDE_PLAN_TIERS[normalizedPlan];
  }
}

module.exports = {
  ClaudeQuotaResetStrategy,
  CLAUDE_PLAN_TIERS
};
