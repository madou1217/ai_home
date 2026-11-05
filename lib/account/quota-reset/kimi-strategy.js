'use strict';

const { BaseQuotaResetStrategy, normalizePlanValue } = require('./base-strategy');

// Kimi 官方会员等级：
// Basic / Free / Level 1 (0) < Intermediate / Allegretto / Level 2 (1) < Advanced / Allegro / Level 3 (2)
// 这张表只用于「是否升级」的比较，不作为识别门槛：未知档位原样通过。
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
    return normalizePlanValue(rawPlan);
  }

  getPlanTierRank(normalizedPlan) {
    return KIMI_PLAN_TIERS[normalizedPlan];
  }
}

module.exports = {
  KimiQuotaResetStrategy,
  KIMI_PLAN_TIERS
};
