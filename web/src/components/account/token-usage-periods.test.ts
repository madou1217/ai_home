import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTokenUsageMetrics } from './token-usage-periods.ts';
import type { AccountTokenUsage } from '@/types';

function usageOf(partial: Partial<AccountTokenUsage>): AccountTokenUsage {
  return {
    day: 0,
    week: 0,
    month: 0,
    total: 0,
    models: [],
    ...partial
  };
}

test('keeps every window while each one adds usage the narrower window misses', () => {
  const metrics = buildTokenUsageMetrics(usageOf({
    day: 1,
    week: 2,
    month: 3,
    total: 4
  }));

  assert.deepEqual(metrics.map((metric) => metric.key), ['day', 'week', 'month', 'total']);
  assert.deepEqual(metrics.map((metric) => metric.absorbed.length), [0, 0, 0, 0]);
});

test('collapses the all-time window into the month when nothing predates this month', () => {
  const metrics = buildTokenUsageMetrics(usageOf({
    day: 1,
    week: 2,
    month: 3,
    total: 3
  }));

  assert.deepEqual(metrics.map((metric) => metric.key), ['day', 'week', 'month']);
  assert.deepEqual(metrics.at(-1)?.absorbed.map((period) => period.key), ['total']);
});

test('collapses month and total into the week when the month adds nothing', () => {
  const metrics = buildTokenUsageMetrics(usageOf({
    day: 1,
    week: 5,
    month: 5,
    total: 5
  }));

  assert.deepEqual(metrics.map((metric) => metric.key), ['day', 'week']);
  assert.deepEqual(metrics.at(-1)?.absorbed.map((period) => period.key), ['month', 'total']);
});

test('collapses the week into the day when this week added nothing beyond today', () => {
  // 折叠不只发生在尾部：中间那格与前一格相同，同样是重复信息。
  const metrics = buildTokenUsageMetrics(usageOf({
    day: 100,
    week: 100,
    month: 500,
    total: 900
  }));

  assert.deepEqual(metrics.map((metric) => metric.key), ['day', 'month', 'total']);
  assert.deepEqual(metrics[0].absorbed.map((period) => period.key), ['week']);
});

test('collapses both middle and tail duplicates in one pass', () => {
  const metrics = buildTokenUsageMetrics(usageOf({
    day: 100,
    week: 100,
    month: 500,
    total: 500
  }));

  assert.deepEqual(metrics.map((metric) => metric.key), ['day', 'month']);
  assert.deepEqual(metrics[0].absorbed.map((period) => period.key), ['week']);
  assert.deepEqual(metrics[1].absorbed.map((period) => period.key), ['total']);
});

test('collapses to a single bar when all usage happened today', () => {
  const metrics = buildTokenUsageMetrics(usageOf({
    day: 7,
    week: 7,
    month: 7,
    total: 7
  }));

  assert.deepEqual(metrics.map((metric) => metric.key), ['day']);
  assert.deepEqual(metrics[0].absorbed.map((period) => period.key), ['week', 'month', 'total']);
});

test('an account with no usage at all collapses to one zero bar', () => {
  const metrics = buildTokenUsageMetrics(usageOf({}));

  assert.deepEqual(metrics.map((metric) => metric.key), ['day']);
  assert.equal(metrics[0].value, 0);
});

test('an unknown window is kept rather than folded away', () => {
  // total 缺失（老服务端）时是"没统计到"，不是"没有增量"：不能当成相同值折掉，
  // 让"-"自己说话；已知的重复窗口该折还是折。
  const metrics = buildTokenUsageMetrics({
    day: 1,
    week: 1,
    month: 1,
    models: []
  } as unknown as AccountTokenUsage);

  assert.deepEqual(metrics.map((metric) => metric.key), ['day', 'total']);
  assert.deepEqual(metrics[0].absorbed.map((period) => period.key), ['week', 'month']);
  assert.equal(metrics.at(-1)?.value, null);
});
