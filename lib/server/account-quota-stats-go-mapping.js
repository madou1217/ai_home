'use strict';

// Go 额度统计 → 页面契约的形状适配。
//
// 只说形状，不重算任何业务值：窗口可用性、覆盖窗口数、成本口径全部来自 Go——
// 这正是切流的目的（页面口径由 Go 决定，Node 不再自己推一遍）。
//
// 为什么用递归 key 转换而不是手写 40 个字段：两边是同一套模型（Go 侧按页面契约设计），
// 手写映射在任一新增字段时都会静默丢字段；递归转换 + 单测锁定已知字段更安全。
// 例外只有两处：
//   · usageBuckets 来自另一个接口（/usage/buckets），在这里补页面要求的行形状；
//   · granularity 由请求或 Go 的维度可用性决定（Go 的契约里没有这个字段）。

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

/**
 * 未指定粒度时，按账号能把哪些维度算出来决定视图。
 *
 * 与切流前一致：有可用窗口就给窗口视图，否则给日统计——页面首屏不该落在一个
 * 空窗口图上。这里只读 Go 已经算好的 dimensions.available，不重新判断维度。
 */
function resolveGranularity(goData, requested) {
  if (requested) return requested;
  const mapped = camelize(goData || {});
  const dimensions = Array.isArray(mapped.dimensions) ? mapped.dimensions : [];
  return dimensions.some((dimension) => Boolean(dimension && dimension.available)) ? 'window' : 'day';
}

// 桶行按页面契约补三个字段：index（行 key）、bucketStartMs（横轴与区间标签）、
// costKnown/costUsd（Go 的桶目前不带定价，必须标未知而不是 0）。
function normalizeBucketRow(row, position) {
  const source = row && typeof row === 'object' ? row : {};
  const startMs = Number(source.startMs) || 0;
  const bucketStartMs = Number(source.bucketStartMs);
  const costUsd = Number(source.costUsd);
  const indexValue = Number(source.index);
  const costKnown = source.costKnown === true;
  return {
    index: Number.isInteger(indexValue) ? indexValue : position,
    startMs,
    endMs: Number(source.endMs) || 0,
    bucketStartMs: Number.isFinite(bucketStartMs) && bucketStartMs > 0 ? bucketStartMs : startMs,
    tokens: Number(source.tokens) || 0,
    costUsd: costKnown && Number.isFinite(costUsd) ? costUsd : null,
    costKnown,
    requestCount: Number(source.requestCount) || 0
  };
}

function summarizeBuckets(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  const totalTokens = buckets.reduce((sum, bucket) => sum + (Number(bucket.tokens) || 0), 0);
  const totalRequests = buckets.reduce((sum, bucket) => sum + (Number(bucket.requestCount) || 0), 0);
  // 任一行缺定价，整个汇总就是「未知」：部分已知的合计数会被当成真实成本。
  const costKnown = buckets.every((bucket) => bucket.costKnown === true);
  const totalCostUsd = costKnown
    ? buckets.reduce((sum, bucket) => sum + (Number(bucket.costUsd) || 0), 0)
    : null;
  return {
    bucketCount: buckets.length,
    totalTokens,
    totalCostUsd,
    costKnown,
    requestCount: totalRequests,
    avgTokensPerBucket: Math.round(totalTokens / buckets.length),
    avgCostUsdPerBucket: costKnown ? totalCostUsd / buckets.length : null
  };
}

/**
 * mapGoQuotaStats 把 Go 的额度统计转成 /v0/webui/accounts/:p/:ref/quota-stats 的响应形状。
 *
 * @param {object} goData   Go 的 {generated_at_ms, range, dimensions, windows, summary, ...}
 * @param {object} options
 * @param {string} options.provider
 * @param {string} options.accountRef
 * @param {object[]|null} [options.buckets] Go /usage/buckets 的 buckets（snake 或 camel 均可）
 * @param {string} [options.granularity] 'window' | 'day' | 'week'
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
    const buckets = options.buckets.map((row, index) => normalizeBucketRow(camelize(row), index));
    payload.usageBuckets = buckets;
    payload.usageSummary = summarizeBuckets(buckets);
    // 日/周视图的空态由桶决定：Go 的窗口空态（dimension_unavailable）在日视图里
    // 会让「有用量」的页面被误判成没有数据。
    payload.emptyReason = buckets.some((bucket) => bucket.tokens > 0 || bucket.requestCount > 0)
      ? null
      : 'no_usage_in_range';
  } else {
    // 窗口视图也保留这两个字段（旧契约里恒在），避免前端读到 undefined。
    payload.usageBuckets = [];
    payload.usageSummary = null;
  }
  if (!payload.emptyReason && payload.emptyReason !== null) payload.emptyReason = null;
  return payload;
}

module.exports = {
  mapGoQuotaStats,
  resolveGranularity,
  normalizeBucketRow,
  summarizeBuckets,
  camelKey,
  camelize
};
