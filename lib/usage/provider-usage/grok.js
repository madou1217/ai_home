'use strict';

module.exports = Object.freeze({
  id: 'grok',
  capability: 'provider.usage',
  accountSnapshotRefresh: true,
  planLabel: (planType) => planType === 'free' ? 'Free' : '',
  cachedAccountMetadata: (account) => ({
    email: String(account.email || '').trim(),
    planType: String(account.planType || '').trim(),
    planName: String(account.planName || '').trim()
  }),
  liveAccountIdentity: ({ configured, apiKeyMode, effectiveUsageSnapshot, cleanAccountName }) => {
    if (!configured || apiKeyMode) return null;
    const account = effectiveUsageSnapshot && effectiveUsageSnapshot.account;
    return {
      planType: String(account && account.planType || 'oauth'),
      planName: String(account && account.planName || ''),
      email: String(account && account.email || '') || cleanAccountName()
    };
  }
});
