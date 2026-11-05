'use strict';

const { BaseQuotaResetStrategy, normalizePlanValue } = require('./base-strategy');

// ZCode 官方套餐等级：
// Start / ZCode Start Plan / Free (0) < Pro / Advanced / Standard (1) < Team / Enterprise (2)
// 这张表只用于「是否升级」的比较，不作为识别门槛：未知档位原样通过。
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
    return normalizePlanValue(rawPlan);
  }

  getPlanTierRank(normalizedPlan) {
    return ZCODE_PLAN_TIERS[normalizedPlan];
  }
}

module.exports = {
  ZCodeQuotaResetStrategy,
  ZCODE_PLAN_TIERS
};
