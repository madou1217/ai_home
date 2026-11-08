'use strict';

// Go 额度统计 → 页面契约的形状适配。只锁「形状」：key 改名、嵌套数组、未知字段保留、
// usageBuckets 行归一与汇总、粒度回退。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapGoQuotaStats,
  resolveGranularity,
  camelKey,
  camelize
} = require('../lib/server/account-quota-stats-go-mapping');

test('camelKey 只改下划线边界', () => {
  assert.equal(camelKey('window_minutes'), 'windowMinutes');
  assert.equal(camelKey('avg_cost_usd_per_window'), 'avgCostUsdPerWindow');
  assert.equal(camelKey('cost_supported'), 'costSupported');
});

test('camelize 递归处理数组与对象并保留未知字段', () => {
  const mapped = camelize({
    generated_at_ms: 1,
    dimensions: [{ window_minutes: 300, data_state: 'ready', future_field: 'keep' }],
    nested: { inner_key: null }
  });
  assert.deepEqual(mapped, {
    generatedAtMs: 1,
    dimensions: [{ windowMinutes: 300, dataState: 'ready', futureField: 'keep' }],
    nested: { innerKey: null }
  });
});

test('mapGoQuotaStats 补齐页面契约字段', () => {
  const payload = mapGoQuotaStats(
    { generated_at_ms: 10, range: { from_ms: 1, to_ms: 10, range_days: 7 }, window_minutes: 1440, windows: [] },
    { provider: 'zcode', accountRef: 'acct_x' }
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.provider, 'zcode');
  assert.equal(payload.accountRef, 'acct_x');
  assert.equal(payload.generatedAtMs, 10);
  assert.equal(payload.range.rangeDays, 7);
  assert.equal(payload.windowMinutes, 1440);
  assert.deepEqual(payload.windows, []);
  assert.deepEqual(payload.usageBuckets, []);
  assert.equal(payload.usageSummary, null);
  assert.equal(payload.emptyReason, null);
});

test('resolveGranularity：未指定时按维度可用性决定，指定时原样尊重', () => {
  assert.equal(resolveGranularity({ dimensions: [{ available: true }] }, ''), 'window');
  assert.equal(resolveGranularity({ dimensions: [{ available: false }] }, ''), 'day');
  assert.equal(resolveGranularity({ dimensions: [] }, ''), 'day');
  assert.equal(resolveGranularity({}, ''), 'day');
  assert.equal(resolveGranularity({ dimensions: [{ available: true }] }, 'week'), 'week');
  // Go 的 snake_case 也能判定（映射层先 camelize 再读）。
  assert.equal(resolveGranularity({ dimensions: [{ available: true }] }, ''), 'window');
});

test('注入 usageBuckets 时归一每行并给出汇总，成本标为未知', () => {
  const payload = mapGoQuotaStats({}, {
    provider: 'zcode',
    accountRef: 'acct_x',
    granularity: 'day',
    buckets: [
      { start_ms: 1, end_ms: 2, tokens: 100, request_count: 2 },
      { start_ms: 2, end_ms: 3, tokens: 300, request_count: 2 }
    ]
  });
  assert.equal(payload.granularity, 'day');
  assert.equal(payload.usageBuckets.length, 2);
  // 只有 start_ms 时 bucketStartMs 退回 startMs、index 按顺序补：旧 Go 二进制也能出图。
  assert.deepEqual(payload.usageBuckets[0], {
    index: 0,
    startMs: 1,
    endMs: 2,
    bucketStartMs: 1,
    tokens: 100,
    costUsd: null,
    costKnown: false,
    requestCount: 2
  });
  assert.equal(payload.usageBuckets[1].index, 1);
  assert.equal(payload.usageSummary.totalTokens, 400);
  assert.equal(payload.usageSummary.requestCount, 4);
  assert.equal(payload.usageSummary.avgTokensPerBucket, 200);
  assert.equal(payload.usageSummary.costKnown, false);
  assert.equal(payload.usageSummary.totalCostUsd, null);
  assert.equal(payload.emptyReason, null);
});

test('Go 已带 index/bucketStartMs/cost 时原样尊重', () => {
  const payload = mapGoQuotaStats({}, {
    provider: 'zcode',
    accountRef: 'acct_x',
    granularity: 'day',
    buckets: [
      { index: 7, start_ms: 12, end_ms: 24, bucket_start_ms: 6, tokens: 5, cost_usd: 0.25, cost_known: true, request_count: 1 }
    ]
  });
  assert.deepEqual(payload.usageBuckets[0], {
    index: 7,
    startMs: 12,
    endMs: 24,
    bucketStartMs: 6,
    tokens: 5,
    costUsd: 0.25,
    costKnown: true,
    requestCount: 1
  });
  assert.equal(payload.usageSummary.costKnown, true);
  assert.equal(payload.usageSummary.totalCostUsd, 0.25);
  assert.equal(payload.usageSummary.avgCostUsdPerBucket, 0.25);
});

test('日视图没有用量时把空态改成 no_usage_in_range', () => {
  const payload = mapGoQuotaStats({ empty_reason: 'dimension_unavailable' }, {
    provider: 'zcode',
    accountRef: 'acct_x',
    granularity: 'day',
    buckets: [{ start_ms: 1, end_ms: 2, tokens: 0, request_count: 0 }]
  });
  assert.equal(payload.emptyReason, 'no_usage_in_range');
});

test('窗口视图保留 Go 的空态（不注入桶）', () => {
  const payload = mapGoQuotaStats({ empty_reason: 'dimension_unavailable' }, {
    provider: 'zcode',
    accountRef: 'acct_x',
    granularity: 'window'
  });
  assert.equal(payload.emptyReason, 'dimension_unavailable');
  assert.deepEqual(payload.usageBuckets, []);
  assert.equal(payload.usageSummary, null);
});
