import assert from 'node:assert/strict';
import test from 'node:test';
import dayjs from 'dayjs';

import type { ModelUsageTrendPoint } from '@/types';
import {
  buildTrendSlots,
  buildUsageQuery,
  buildUsageRangeByMode,
  isUsageDashboardQueryActive,
  isUsageScanJobActive
} from './model-usage-query.ts';

function point(bucketStartMs: number): ModelUsageTrendPoint {
  return {
    bucketStartMs,
    calls: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 2,
    costUsd: 0,
    cacheHitRate: null
  };
}

test('usage query keeps start time only for 1h / custom ranges and always sends the snapshot end time', () => {
  const range: [dayjs.Dayjs, dayjs.Dayjs] = [dayjs('2026-09-01T08:30:00'), dayjs('2026-09-02T09:45:00')];
  const today = buildUsageQuery(range, 'today', '', ' gpt-5 ');
  assert.equal(today.from, '2026-09-01');
  assert.match(String(today.to), /^2026-09-02T09:45:00/);
  assert.equal(today.model, 'gpt-5');
  assert.equal(today.limit, 50);
  assert.equal(today.scan, false);
  assert.match(String(buildUsageQuery(range, 'custom', 'codex', '').from), /^2026-09-01T08:30:00/);
  assert.match(String(buildUsageQuery(range, 'hour', 'codex', '').from), /^2026-09-01T08:30:00/);
});

test('range presets are anchored to now', () => {
  const [start, end] = buildUsageRangeByMode('7d');
  assert.equal(start.format('HH:mm:ss'), '00:00:00');
  assert.equal(end.diff(start, 'day'), 6);
  const [hourStart, hourEnd] = buildUsageRangeByMode('hour');
  assert.equal(hourEnd.diff(hourStart, 'minute'), 60);
});

test('job activity helpers match the desktop state machine', () => {
  assert.equal(isUsageScanJobActive(null), false);
  assert.equal(isUsageScanJobActive({ status: 'running' } as never), true);
  assert.equal(isUsageScanJobActive({ status: 'succeeded' } as never), false);
  assert.equal(isUsageDashboardQueryActive({ status: 'preparing' } as never), true);
  assert.equal(isUsageDashboardQueryActive({ status: 'cancelled' } as never), false);
});

test('trend slots fill missing buckets with null and cap at 120', () => {
  const slots = buildTrendSlots({ fromMs: 0, toMs: 3000, bucketMs: 1000, points: [point(0), point(2000)] });
  assert.deepEqual(slots.map((slot) => slot?.bucketStartMs ?? null), [0, null, 2000, null]);
  assert.equal(buildTrendSlots({ fromMs: 0, toMs: 500_000, bucketMs: 1000, points: [] }).length, 120);
  assert.deepEqual(buildTrendSlots({ fromMs: 0, toMs: 0, bucketMs: 0, points: [] }), []);
});
