'use strict';

// zcode 用量展示端口：套餐名来自额度快照的 account.planType（billing/balance 的
// plans[0].name，如「ZCode Weekend Build」）。账号行的 plan badge（AccountBadges 的
// getPlanTagLabel 取 planName || planType）与套餐缓存元数据都从快照取——与 kimi 的端口
// 同构；缺了这个端口，界面只能显示泛型的「OAuth」，快照里的套餐名永远到不了记录上。
// 桌面端应用没有 PTY 会话，ptyUsageStatus 沿用默认 false（终端标题不显示用量）。
module.exports = Object.freeze({
  id: 'zcode',
  capability: 'provider.usage',
  // 查看账号时按需刷新额度快照（与 WebUI 的刷新路径一致：非 API Key 账号）。
  accountSnapshotRefresh: true,
  cachedAccountMetadata: (account) => ({
    email: '',
    planType: String(account && account.planType || '').trim(),
    planName: ''
  }),
  liveAccountIdentity: ({ configured, apiKeyMode, effectiveUsageSnapshot }) => {
    if (!configured || apiKeyMode) return null;
    const snapshotAccount = effectiveUsageSnapshot && effectiveUsageSnapshot.account
      ? effectiveUsageSnapshot.account
      : null;
    const planType = String(snapshotAccount && snapshotAccount.planType || '').trim();
    // 无套餐（空结论快照）时不覆盖既有身份，保持默认的「OAuth」泛型标签。
    // 只有套餐名时不设置 planName：zcode 的套餐名本身就是 planType（badge 取 planName || planType）。
    if (!planType) return null;
    return { planType };
  }
});
