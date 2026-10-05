'use strict';

const { getProviderUsageStrategy } = require('../../../usage/provider-usage');

const HIDDEN_PLAN_TYPES = new Set(['', 'free', 'unknown', 'oauth']);

function normalizePlanValue(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function resolveAccountPlanLabel(input = {}) {
  if (input.apiKeyMode) return '';
  const provider = normalizePlanValue(input.provider);
  const planType = normalizePlanValue(input.planType);
  if (HIDDEN_PLAN_TYPES.has(planType)) return '';

  // 各家套餐的展示名由用量端口模块给出（codex、claude）；其余 provider 不显示。
  return getProviderUsageStrategy(provider).planLabel(planType, {
    rateLimitTier: normalizePlanValue(input.rateLimitTier)
  });
}

module.exports = {
  resolveAccountPlanLabel
};
