'use strict';

// Go 额度统计 → 页面契约的形状适配。只锁「形状」：key 改名、嵌套数组、未知字段保留、
// usageBuckets 注入与汇总。

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapGoQuotaStats, camelKey, camelize } = require('../lib/server/account-quota-stats-go-mapping');

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
  assert.equal(payload.emptyReason, null);
});

test('注入 usageBuckets 时给出汇总，成本标为未知', () => {
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
  assert.deepEqual(payload.usageBuckets[0], { startMs: 1, endMs: 2, tokens: 100, requestCount: 2 });
  assert.equal(payload.usageSummary.totalTokens, 400);
  assert.equal(payload.usageSummary.requestCount, 4);
  assert.equal(payload.usageSummary.avgTokensPerBucket, 200);
  assert.equal(payload.usageSummary.costKnown, false);
  assert.equal(payload.usageSummary.totalCostUsd, null);
});
