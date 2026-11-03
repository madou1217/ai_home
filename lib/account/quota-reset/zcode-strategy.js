'use strict';

const { BaseQuotaResetStrategy, isNonPlanAuthMode } = require('./base-strategy');

// ZCode 官方套餐等级：
// Start / ZCode Start Plan / Free (0) < Pro / Advanced / Standard (1) < Team / Enterprise (2)
const ZCODE_PLAN_TIERS = Object.freeze({
  free: 0,
  start: 0,
  start_plan: 0,
  zcode_start_plan: 0,
  standard: 1,
  pro: 1,
  advanced: 1,
  team: 2,
  enterprise: 2
});

class ZCodeQuotaResetStrategy extends BaseQuotaResetStrategy {
  constructor() {
    super('zcode');
  }

  normalizePlanType(rawPlan) {
    if (!rawPlan || isNonPlanAuthMode(rawPlan)) return null;
    const lower = String(rawPlan).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!lower || isNonPlanAuthMode(lower)) return null;
    return Object.prototype.hasOwnProperty.call(ZCODE_PLAN_TIERS, lower) ? lower : null;
  }

  getPlanTierRank(normalizedPlan) {
    return ZCODE_PLAN_TIERS[normalizedPlan];
  }
}

module.exports = {
  ZCodeQuotaResetStrategy,
  ZCODE_PLAN_TIERS
};
