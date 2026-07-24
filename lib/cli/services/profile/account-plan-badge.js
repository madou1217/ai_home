'use strict';

const HIDDEN_PLAN_TYPES = new Set(['', 'free', 'unknown', 'oauth']);

const CODEX_PLAN_LABELS = Object.freeze({
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  pro_lite: 'Pro Lite',
  team: 'Team',
  self_serve_business_usage_based: 'Business',
  business: 'Business',
  enterprise_cbp_usage_based: 'Enterprise',
  enterprise: 'Enterprise',
  hc: 'Enterprise',
  edu: 'Edu',
  education: 'Edu'
});

const CLAUDE_PLAN_LABELS = Object.freeze({
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise'
});

const CLAUDE_MAX_TIER_LABELS = Object.freeze({
  default_claude_max_5x: 'Max 5x',
  claude_max_5x: 'Max 5x',
  max_5x: 'Max 5x',
  default_claude_max_20x: 'Max 20x',
  claude_max_20x: 'Max 20x',
  max_20x: 'Max 20x'
});

function normalizePlanValue(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function resolveClaudeMaxLabel(rateLimitTier) {
  return CLAUDE_MAX_TIER_LABELS[normalizePlanValue(rateLimitTier)] || 'Max';
}

function resolveAccountPlanLabel(input = {}) {
  if (input.apiKeyMode) return '';
  const provider = normalizePlanValue(input.provider);
  const planType = normalizePlanValue(input.planType);
  if (HIDDEN_PLAN_TYPES.has(planType)) return '';

  if (provider === 'claude') {
    if (planType === 'max') return resolveClaudeMaxLabel(input.rateLimitTier);
    return CLAUDE_PLAN_LABELS[planType] || '';
  }
  if (provider === 'codex') {
    return CODEX_PLAN_LABELS[planType] || '';
  }
  return '';
}

module.exports = {
  resolveAccountPlanLabel
};
