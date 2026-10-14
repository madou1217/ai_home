'use strict';

// Cline（Cline Pass 订阅 / API Key）的**用量端口**：把额度快照里的套餐身份投影到账号记录。
//
// 额度采集本身在额度插件 `lib/usage/quota/plugins/cline.js`（服务端权威 percentUsed）；
// 本模块只负责「账号页/CLI 的套餐标签」这一层，分工与 kimi.js 一致：
//   - cachedAccountMetadata：快速快照路径的 metadata（套餐列读它）
//   - liveAccountIdentity：账号页 hydration 的套餐补丁
// 少了这两支，cline 的套餐列只能落到默认值 `oauth`，看不到真实套餐名。
//
// 刻意**不**把 email 填进 metadata：displayName 的取值优先级里 metadata.email 高于
// fastPresence.displayName，填了会把账号名从「Deo Mea」换成邮箱，属于观感倒退。

module.exports = Object.freeze({
  id: 'cline',
  capability: 'provider.usage',
  // 账号状态读取时按需刷新用量快照（网络探测，缓存策略由 usage 服务统一管）。
  accountSnapshotRefresh: true,
  // 刻意不开 ptyUsageStatus：终端标题是用户可见面，是否显示 5h/7days/30days 由用户决定
  // （要开就在本模块加 ptyUsageStatus: true，渲染与 codex/claude 同一套）。
  cachedAccountMetadata: (account) => ({
    email: '',
    planType: 'oauth',
    planName: String(account.planName || '').trim()
  }),
  liveAccountIdentity: ({ configured, apiKeyMode, effectiveUsageSnapshot }) => {
    if (!configured || apiKeyMode) return null;
    const snapshotAccount = effectiveUsageSnapshot && effectiveUsageSnapshot.account
      ? effectiveUsageSnapshot.account
      : null;
    return {
      planType: 'oauth',
      planName: String((snapshotAccount && snapshotAccount.planName) || '').trim()
    };
  }
});
