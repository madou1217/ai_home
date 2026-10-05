'use strict';

const PLAN_LABELS = Object.freeze({
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

module.exports = Object.freeze({
  id: 'codex',
  capability: 'provider.usage',
  accountSnapshotRefresh: true,
  ptyUsageStatus: true,
  planLabel: (planType) => PLAN_LABELS[planType] || ''
});
