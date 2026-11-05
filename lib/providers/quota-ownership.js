'use strict';

// 额度归属的**唯一真值源**。
//
// 为什么要有这张表：迁移期每接一个 Provider 都要去 defs/<p>.js 把 quota.supported 从
// true 改成 false，一天内这类提交出现 8 次——同一事实散落在十几个文件里，漏改一个就会
// 出现「Go 已经在采、Node 还在探」的双采集。把归属收敛到这里后：
//   * 新增 Provider 只改 GO_QUOTA_OWNERS 一处；
//   * descriptor 用 goOwnedQuota(id) 派生，不再手写 supported/reason；
//   * test/quota-ownership.test.js 双向校验（表 ↔ descriptor），防止悄悄漂移。

/** Go 已接管的额度 Provider → 采集端点（只用于 reason 文案）。 */
const GO_QUOTA_OWNERS = Object.freeze({
  kiro: 'GetUsageLimits',
  agy: 'code-assist fetchAvailableModels',
  zcode: 'billing/balance',
  cline: 'plan usage-limits',
  qoder: '/api/v2/quota/usage',
  qodercn: '/api/v2/quota/usage',
  gemini: 'v1internal:retrieveUserQuota',
  grok: 'v1/billing?format=credits',
  kimi: '/usages',
  codebuddy: 'resource summary',
  codebuddycn: 'resource summary',
  workbuddy: 'resource summary',
  workbuddycn: 'resource summary'
});

function normalizeProviderID(id) {
  return String(id || '').trim().toLowerCase();
}

/** 该 Provider 的额度是否由 Go 采集。 */
function isGoOwnedQuota(providerID) {
  return Object.prototype.hasOwnProperty.call(GO_QUOTA_OWNERS, normalizeProviderID(providerID));
}

/**
 * descriptor 的 quota 能力：Go 已接管时返回 supported:false + reason。
 *
 * 不在表里的 Provider 调用它会直接抛错——把这些 Provider 写成「Node 不采集」是漏迁，
 * 不是能力边界，必须在表里显式登记。
 */
function goOwnedQuota(providerID) {
  const id = normalizeProviderID(providerID);
  const source = GO_QUOTA_OWNERS[id];
  if (!source) {
    throw new Error('provider ' + providerID + ' 的额度不是 Go 采集，不能用 goOwnedQuota');
  }
  return Object.freeze({
    supported: false,
    reason: id + ' 额度由 Go 采集（' + source + '）；Node 不再探测。'
  });
}

module.exports = { GO_QUOTA_OWNERS, goOwnedQuota, isGoOwnedQuota };
