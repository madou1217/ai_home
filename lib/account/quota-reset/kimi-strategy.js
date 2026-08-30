'use strict';

const { BaseQuotaResetStrategy, isNonPlanAuthMode } = require('./base-strategy');

// Kimi 官方会员等级：
// Basic / Free / Level 1 (0) < Intermediate / Allegretto / Level 2 (1) < Advanced / Allegro / Level 3 (2)
const KIMI_PLAN_TIERS = Object.freeze({
  free: 0,
  basic: 0,
  level_1: 0,
  level1: 0,
  intermediate: 1,
  allegretto: 1,
  level_2: 1,
  level2: 1,
  advanced: 2,
  allegro: 2,
  level_3: 2,
  level3: 2
});

class KimiQuotaResetStrategy extends BaseQuotaResetStrategy {
  constructor() {
    super('kimi');
  }

  normalizePlanType(rawPlan) {
    if (!rawPlan || isNonPlanAuthMode(rawPlan)) return null;
    const lower = String(rawPlan).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!lower || isNonPlanAuthMode(lower)) return null;
    return Object.prototype.hasOwnProperty.call(KIMI_PLAN_TIERS, lower) ? lower : null;
  }

  getPlanTierRank(normalizedPlan) {
    return KIMI_PLAN_TIERS[normalizedPlan];
  }
}

module.exports = {
  KimiQuotaResetStrategy,
  KIMI_PLAN_TIERS
};
