'use strict';

// Go 额度统计 → 页面契约的形状适配。
//
// 只说形状，不重算任何业务值：窗口可用性、覆盖窗口数、成本口径全部来自 Go——
// 这正是切流的目的（页面口径由 Go 决定，Node 不再自己推一遍）。
//
// 为什么用递归 key 转换而不是手写 40 个字段：两边是同一套模型（Go 侧按页面契约设计），
// 手写映射在任一新增字段时都会静默丢字段；递归转换 + 单测锁定已知字段更安全。
// 唯一的例外是 usageBuckets：它来自另一个接口（/usage/buckets），单独注入。

function camelKey(key) {
  return String(key).replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase());
}

function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (!value || typeof value !== 'object') return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) next[camelKey(key)] = camelize(item);
  return next;
}

function summarizeBuckets(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  const totalTokens = buckets.reduce((sum, bucket) => sum + (Number(bucket.tokens) || 0), 0);
  const totalRequests = buckets.reduce((sum, bucket) => sum + (Number(bucket.requestCount) || 0), 0);
  return {
    bucketCount: buckets.length,
    totalTokens,
    // Go 的桶不带定价：成本是「未知」，不是 0。
    totalCostUsd: null,
    costKnown: false,
    requestCount: totalRequests,
    avgTokensPerBucket: Math.round(totalTokens / buckets.length),
    avgCostUsdPerBucket: null
  };
}

/**
 * mapGoQuotaStats 把 Go 的 QuotaStatsResult 转成 /v0/webui/accounts/:p/:ref/quota-stats
 * 的响应形状。
 *
 * @param {object} goData   Go 的 {generated_at_ms, range, dimensions, windows, summary, ...}
 * @param {object} options
 * @param {string} options.provider
 * @param {string} options.accountRef
 * @param {object[]} [options.buckets] Go /usage/buckets 的 buckets（已 camel 或 snake 均可）
 * @param {string} [options.granularity] 'day' | 'week'
 */
function mapGoQuotaStats(goData, options = {}) {
  const mapped = camelize(goData || {});
  const payload = {
    ok: true,
    provider: options.provider || '',
    accountRef: options.accountRef || '',
    ...mapped
  };
  if (options.granularity) payload.granularity = options.granularity;
  if (Array.isArray(options.buckets)) {
    const buckets = camelize(options.buckets);
    payload.usageBuckets = buckets;
    payload.usageSummary = summarizeBuckets(buckets);
  }
  if (!payload.emptyReason && payload.emptyReason !== null) payload.emptyReason = null;
  return payload;
}

module.exports = { mapGoQuotaStats, camelKey, camelize };
