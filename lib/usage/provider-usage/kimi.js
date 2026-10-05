'use strict';

module.exports = Object.freeze({
  id: 'kimi',
  capability: 'provider.usage',
  accountSnapshotRefresh: true,
  // kimi /me 没有邮箱：昵称作为主标识（email 槽位），脱敏手机号单独返回。
  cachedAccountMetadata: (account) => ({
    email: String(account.displayName || '').trim(),
    planType: String(account.planType || '').trim(),
    planName: String(account.planName || '').trim(),
    phone: String(account.phone || '').trim()
  }),
  liveAccountIdentity: ({ configured, apiKeyMode, effectiveUsageSnapshot }) => {
    if (!configured || apiKeyMode) return null;
    const snapshotAccount = effectiveUsageSnapshot && effectiveUsageSnapshot.account ? effectiveUsageSnapshot.account : null;
    return {
      planType: String((snapshotAccount && snapshotAccount.planType) || 'oauth').trim() || 'oauth',
      // 订阅页品牌档（Allegretto 等），badge 展示优先于 LEVEL_* 枚举。
      planName: String((snapshotAccount && snapshotAccount.planName) || '').trim(),
      email: String((snapshotAccount && snapshotAccount.displayName) || '').trim()
    };
  }
});
