'use strict';

const { normalizeAgyPlanType } = require('../../server/agy-account-usage-view');

module.exports = Object.freeze({
  id: 'agy',
  capability: 'provider.usage',
  accountSnapshotRefresh: true,
  cachedAccountMetadata: (account) => ({
    email: String(account.email || '').trim(),
    planType: normalizeAgyPlanType(account.subscriptionTier, String(account.planType || '').trim())
  }),
  liveAccountIdentity: ({ configured, agyUsageView, cleanAccountName }) => (configured
    ? { planType: agyUsageView ? agyUsageView.planType : 'oauth', email: cleanAccountName() }
    : null)
});
