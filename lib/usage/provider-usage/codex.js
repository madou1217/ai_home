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
  planLabel: (planType) => PLAN_LABELS[planType] || '',
  cachedAccountMetadata: (account) => ({
    email: String(account.email || '').trim(),
    planType: String(account.planType || '').trim()
  }),
  liveAccountIdentity: ({ configured, apiKeyMode, usageSnapshot }) => {
    if (!configured || apiKeyMode) return null;
    const snapshotAccount = usageSnapshot && usageSnapshot.account ? usageSnapshot.account : null;
    return {
      planType: String(snapshotAccount && snapshotAccount.planType || 'oauth').trim() || 'oauth',
      email: String(snapshotAccount && snapshotAccount.email || '').trim()
    };
  }
});
