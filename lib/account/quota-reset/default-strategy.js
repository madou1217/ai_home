'use strict';

const { BaseQuotaResetStrategy, isNonPlanAuthMode } = require('./base-strategy');

class DefaultQuotaResetStrategy extends BaseQuotaResetStrategy {
  constructor(providerName = 'default') {
    super(providerName);
  }

  normalizePlanType(rawPlan) {
    if (!rawPlan || isNonPlanAuthMode(rawPlan)) return null;
    const lower = String(rawPlan).trim().toLowerCase();
    if (!lower || isNonPlanAuthMode(lower)) return null;
    return lower;
  }

  getPlanTierRank(_normalizedPlan) {
    return undefined; // 通用默认策略不盲目比较未知 provider 的套餐等级
  }
}

module.exports = {
  DefaultQuotaResetStrategy
};
