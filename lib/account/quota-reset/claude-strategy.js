'use strict';

const { BaseQuotaResetStrategy, normalizePlanValue } = require('./base-strategy');

// Claude 官方订阅等级：Free (0) < Pro (1) < Team (2) < Business (3) < Enterprise (4) < Max (5)
// 这张表只用于「是否升级」的比较，不作为识别门槛：未知档位原样通过。
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
    return normalizePlanValue(rawPlan);
  }

  getPlanTierRank(normalizedPlan) {
    return CLAUDE_PLAN_TIERS[normalizedPlan];
  }
}

module.exports = {
  ClaudeQuotaResetStrategy,
  CLAUDE_PLAN_TIERS
};
