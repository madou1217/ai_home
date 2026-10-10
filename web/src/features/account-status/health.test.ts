import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEALTH_SCALE_STOPS,
  alignBuckets,
  buildGlobalBuckets,
  countBucket,
  dedupeAccountsForGlobal,
  healthColorForBucket,
  healthColorForRate,
  healthColorForUptime,
  indexBucketsByStart,
  summarizeUptime,
  tierForBucket,
  tierForRate
} from './health';
import type { AccountOutcomes, OutcomeBucket } from './types';

function bucket(startMs: number, success: number, failures: Record<string, number> = {}): OutcomeBucket {
  return { startMs, success, failures };
}

test('countBucket 把 request_cancelled 视为中立，不计入分子分母', () => {
  const b = bucket(1, 8, { rate_limited: 2, request_cancelled: 5 });
  assert.deepEqual(countBucket(b), { success: 8, failureTotal: 2, total: 10 });
  assert.deepEqual(countBucket(null), { success: 0, failureTotal: 0, total: 0 });
});

test('tierForRate 按阈值分档：>=0.99 operational，>=0.90 degraded，>=0.50 partial，否则 major；total<=0 为 none', () => {
  assert.equal(tierForRate(0, 0), 'none');
  assert.equal(tierForRate(99, 100), 'operational');
  assert.equal(tierForRate(100, 100), 'operational');
  assert.equal(tierForRate(90, 100), 'degraded');
  assert.equal(tierForRate(98, 100), 'degraded');
  assert.equal(tierForRate(50, 100), 'partial');
  assert.equal(tierForRate(89, 100), 'partial');
  assert.equal(tierForRate(49, 100), 'major');
  assert.equal(tierForRate(0, 100), 'major');
});

test('tierForBucket 全部取消（无有效请求）视为 none，而不是 operational', () => {
  const cancelledOnly = bucket(1, 0, { request_cancelled: 12 });
  assert.equal(tierForBucket(cancelledOnly), 'none');
});

test('summarizeUptime 跨非空桶求和，两位小数；全空返回 rate=null/hasData=false', () => {
  const buckets = [bucket(1, 99, { rate_limited: 1 }), null, bucket(2, 50, { rate_limited: 50 })];
  const summary = summarizeUptime(buckets);
  // success=149, total=200 => 74.5%
  assert.equal(summary.rate, 74.5);
  assert.equal(summary.tier, 'partial');
  assert.equal(summary.totalRequests, 200);
  assert.equal(summary.hasData, true);

  const empty = summarizeUptime([null, undefined, bucket(1, 0, { request_cancelled: 9 })]);
  assert.equal(empty.rate, null);
  assert.equal(empty.hasData, false);
  assert.equal(empty.tier, 'none');
});

test('indexBucketsByStart / alignBuckets 把稀疏数组对齐到完整时间轴，缺失补 null', () => {
  const sparse = [bucket(10, 5), bucket(30, 7)];
  const index = indexBucketsByStart(sparse);
  assert.equal(index.get(10)?.success, 5);
  assert.equal(index.has(20), false);

  const aligned = alignBuckets([10, 20, 30], sparse);
  assert.equal(aligned[0]?.success, 5);
  assert.equal(aligned[1], null);
  assert.equal(aligned[2]?.success, 7);
});

test('dedupeAccountsForGlobal 去掉 days+hours 完全相同的合并账号，只保留第一条', () => {
  const days = [bucket(1, 10)];
  const hours = [bucket(2, 3)];
  const accounts: AccountOutcomes[] = [
    { accountRef: 'a', days, hours },
    { accountRef: 'a-legacy', days: [bucket(1, 10)], hours: [bucket(2, 3)] }, // 内容相同，视为合并账号
    { accountRef: 'b', days: [bucket(1, 999)], hours }
  ];
  const deduped = dedupeAccountsForGlobal(accounts);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped.map((a) => a.accountRef), ['a', 'b']);
});

test('buildGlobalBuckets 对去重后的账号按时间轴逐桶求和，某桶全员无数据时返回空桶', () => {
  const accounts: AccountOutcomes[] = [
    { accountRef: 'a', days: [bucket(1, 10, { rate_limited: 1 })], hours: [] },
    { accountRef: 'a-dup', days: [bucket(1, 10, { rate_limited: 1 })], hours: [] }, // 与 a 完全相同 -> 去重
    { accountRef: 'b', days: [bucket(1, 5)], hours: [] }
  ];
  const merged = buildGlobalBuckets(accounts, [1, 2], 'days');
  assert.equal(merged.length, 2);
  // startMs=1: a(10 success + 1 rate_limited) + b(5 success) = 15 success, 1 rate_limited
  assert.equal(merged[0].success, 15);
  assert.equal(merged[0].failures.rate_limited, 1);
  // startMs=2: no account has data -> empty bucket
  assert.equal(merged[1].success, 0);
  assert.deepEqual(merged[1].failures, {});
  assert.equal(tierForBucket(merged[1]), 'none');
});

test('healthColorForRate 在相邻色标间连续插值：满分纯绿、色标处取色标本色、区间内按比例混色', () => {
  assert.equal(healthColorForRate(1), 'var(--health-scale-100)');
  assert.equal(healthColorForRate(0.95), 'var(--health-scale-95)');
  assert.equal(healthColorForRate(0.5), 'var(--health-scale-50)');
  assert.equal(healthColorForRate(0), 'var(--health-scale-0)');
  // 99% 仍以绿为主，只掺一点黄绿；而不是像旧四档那样一掉出 99% 就变橙。
  assert.equal(healthColorForRate(0.99), 'color-mix(in oklab, var(--health-scale-100) 67%, var(--health-scale-97))');
  assert.equal(healthColorForRate(0.925), 'color-mix(in oklab, var(--health-scale-95) 50%, var(--health-scale-90))');
  assert.equal(healthColorForRate(0.25), 'color-mix(in oklab, var(--health-scale-50) 50%, var(--health-scale-0))');
});

test('healthColorForRate 越界与非数字收敛到两端，色标按成功率严格降序', () => {
  assert.equal(healthColorForRate(1.5), 'var(--health-scale-100)');
  assert.equal(healthColorForRate(-1), 'var(--health-scale-0)');
  assert.equal(healthColorForRate(Number.NaN), 'var(--health-scale-0)');
  for (let index = 1; index < HEALTH_SCALE_STOPS.length; index += 1) {
    assert.ok(HEALTH_SCALE_STOPS[index].rate < HEALTH_SCALE_STOPS[index - 1].rate);
  }
  assert.equal(HEALTH_SCALE_STOPS[0].rate, 1);
  assert.equal(HEALTH_SCALE_STOPS[HEALTH_SCALE_STOPS.length - 1].rate, 0);
});

test('healthColorForBucket / healthColorForUptime 无可计数请求时不着色', () => {
  assert.equal(healthColorForBucket(null), undefined);
  assert.equal(healthColorForBucket(bucket(1, 0, { request_cancelled: 3 })), undefined);
  assert.equal(healthColorForBucket(bucket(1, 97, { rate_limited: 3 })), 'var(--health-scale-97)');
  assert.equal(healthColorForUptime(summarizeUptime([null])), undefined);
  assert.equal(healthColorForUptime(summarizeUptime([bucket(1, 90, { request_timeout: 10 })])), 'var(--health-scale-90)');
});
