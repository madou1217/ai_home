'use strict';

// 额度归属的**唯一真值源**。
//
// 为什么要有这张表：迁移期每接一个 Provider 都要去 defs/<p>.js 把 quota.supported 从
// true 改成 false，一天内这类提交出现 8 次——同一事实散落在十几个文件里，漏改一个就会
// 出现「Go 已经在采、Node 还在探」的双采集。把归属收敛到这里后：
//   * 新增 Provider 只改 GO_QUOTA_OWNERS 一处；
//   * descriptor 用 goOwnedQuota(id) 派生，不再手写 supported/reason；
//   * test/quota-ownership.test.js 双向校验（表 ↔ descriptor），防止悄悄漂移。
//
// **必须保留展示契约**：Go 只负责采集，WebUI/CLI 仍由 Node 渲染。快照的
// kind/shape/entryShape 是 Node 侧反查「怎么展示」的唯一依据；迁移时只留
// supported:false 会让 kind 反查索引失效，账号列表的剩余额度整列变成 Unknown
// （2026-11-05 实测：13 个 Go 采集的 Provider 全部中招）。
//
// windows 是**额度统计维度的泛范围**（分钟）：这个 Provider 最多能产出哪些窗口长度。
// 它不是账号实际拥有的窗口——Plus 可能没有 5h、API Key 根本没有窗口期——所以
// 统计页先看账号自己的快照，只有快照给不出答案时才回落到这里（见
// lib/account/quota-stats-strategy.js）。空数组 = 这个 Provider 产不出窗口
// （积分/余额型），不是「没想过」。

/** Go 已接管的额度 Provider → 采集端点 + 展示契约 + 统计维度的泛范围。 */
const GO_QUOTA_OWNERS = Object.freeze({
  kiro: Object.freeze({ endpoint: 'GetUsageLimits', kind: 'kiro_credit_usage', shape: 'entries', entryShape: 'bucket', windows: [] }),
  agy: Object.freeze({ endpoint: 'code-assist fetchAvailableModels', kind: 'agy_code_assist_quota', shape: 'models', entryShape: 'models', windows: [300] }),
  zcode: Object.freeze({ endpoint: 'billing/balance', kind: 'zcode_plan_balance', shape: 'entries', entryShape: 'bucket', windows: [1440, 10080, 43200] }),
  cline: Object.freeze({ endpoint: 'plan usage-limits', kind: 'cline_pass_usage', shape: 'entries', entryShape: 'window', windows: [300, 10080, 43200] }),
  qoder: Object.freeze({ endpoint: '/api/v2/quota/usage', kind: 'qoder_credit_usage', shape: 'entries', entryShape: 'window', windows: [] }),
  qodercn: Object.freeze({ endpoint: '/api/v2/quota/usage', kind: 'qoder_credit_usage', shape: 'entries', entryShape: 'window', windows: [] }),
  gemini: Object.freeze({ endpoint: 'v1internal:retrieveUserQuota', kind: 'gemini_oauth_stats', shape: 'models', entryShape: 'models', windows: [] }),
  grok: Object.freeze({ endpoint: 'v1/billing?format=credits', kind: 'grok_credit_usage', shape: 'entries', entryShape: 'bucket', windows: [] }),
  kimi: Object.freeze({ endpoint: '/usages', kind: 'kimi_oauth_usage', shape: 'entries', entryShape: 'window', windows: [] }),
  codebuddy: Object.freeze({ endpoint: 'resource summary', kind: 'codebuddy_credit_balance', shape: 'entries', entryShape: 'bucket', windows: [] }),
  codebuddycn: Object.freeze({ endpoint: 'resource summary', kind: 'codebuddy_credit_balance', shape: 'entries', entryShape: 'bucket', windows: [] }),
  workbuddy: Object.freeze({ endpoint: 'resource summary', kind: 'codebuddy_credit_balance', shape: 'entries', entryShape: 'bucket', windows: [] }),
  workbuddycn: Object.freeze({ endpoint: 'resource summary', kind: 'codebuddy_credit_balance', shape: 'entries', entryShape: 'bucket', windows: [] })
});

function normalizeProviderID(id) {
  return String(id || '').trim().toLowerCase();
}

/** 该 Provider 的额度是否由 Go 采集。 */
function isGoOwnedQuota(providerID) {
  return Object.prototype.hasOwnProperty.call(GO_QUOTA_OWNERS, normalizeProviderID(providerID));
}

/**
 * descriptor 的 quota 能力：Go 已接管时返回 supported:false + reason + 展示契约。
 *
 * 不在表里的 Provider 调用它会直接抛错——把这些 Provider 写成「Node 不采集」是漏迁，
 * 不是能力边界，必须在表里显式登记。
 */
function goOwnedQuota(providerID) {
  const id = normalizeProviderID(providerID);
  const owner = GO_QUOTA_OWNERS[id];
  if (!owner) {
    throw new Error('provider ' + providerID + ' 的额度不是 Go 采集，不能用 goOwnedQuota');
  }
  return Object.freeze({
    supported: false,
    reason: id + ' 额度由 Go 采集（' + owner.endpoint + '）；Node 不再探测。',
    kind: owner.kind,
    shape: owner.shape,
    entryShape: owner.entryShape,
    stats: Object.freeze({ windows: Object.freeze([...owner.windows]) })
  });
}

module.exports = { GO_QUOTA_OWNERS, goOwnedQuota, isGoOwnedQuota };
