'use strict';

const PLAN_LABELS = Object.freeze({
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise'
});

const MAX_TIER_LABELS = Object.freeze({
  default_claude_max_5x: 'Max 5x',
  claude_max_5x: 'Max 5x',
  max_5x: 'Max 5x',
  default_claude_max_20x: 'Max 20x',
  claude_max_20x: 'Max 20x',
  max_20x: 'Max 20x'
});

module.exports = Object.freeze({
  id: 'claude',
  capability: 'provider.usage',
  accountSnapshotRefresh: true,
  ptyUsageStatus: true,
  // Max 订阅按 rateLimitTier 细分倍数；planType/rateLimitTier 已由调用方规范化为小写下划线形式。
  planLabel: (planType, { rateLimitTier }) => (planType === 'max'
    ? MAX_TIER_LABELS[rateLimitTier] || 'Max'
    : PLAN_LABELS[planType] || ''),
  cachedAccountMetadata: (account) => ({
    email: String(account.email || '').trim(),
    planType: String(account.planType || '').trim()
  }),
  liveAccountIdentity: ({ configured, apiKeyMode, effectiveUsageSnapshot, cleanAccountName }) => {
    if (!configured) return null;
    const snapshotAccount = !apiKeyMode && effectiveUsageSnapshot && effectiveUsageSnapshot.account ? effectiveUsageSnapshot.account : null;
    const snapshotEmail = String((snapshotAccount && snapshotAccount.email) || '').trim();
    const snapshotName = String((snapshotAccount && snapshotAccount.fullName) || '').trim();
    return {
      planType: apiKeyMode
        ? 'api-key'
        : String((snapshotAccount && snapshotAccount.planType) || 'oauth').trim() || 'oauth',
      // /api/oauth/profile 的身份优先于 checkStatus 的令牌占位名（"Access Token: sk-..."，不含邮箱）。
      email: snapshotEmail || snapshotName || cleanAccountName()
    };
  }
});
