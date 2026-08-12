import assert from 'node:assert/strict';
import test from 'node:test';

import { formatResetAt, formatResetIn, formatWindowDuration } from './usage-snapshot-format';

test('formats usage windows from minutes using only non-zero units', () => {
  assert.equal(formatWindowDuration(300, '5h'), '5h');
  assert.equal(formatWindowDuration(2160, '36h'), '1day 12h');
  assert.equal(formatWindowDuration(10080, '7days'), '7day');
  assert.equal(formatWindowDuration(43200, '30days'), '30day');
  assert.equal(formatWindowDuration(90, '90m'), '1h 30m');
  assert.equal(formatWindowDuration(30, '30m'), '30m');
});

test('falls back to the upstream window label when minutes are unavailable', () => {
  assert.equal(formatWindowDuration(0, 'provider-window'), 'provider-window');
  assert.equal(formatWindowDuration(null, 'provider-window'), 'provider-window');
  assert.equal(formatWindowDuration(undefined), '');
});

test('formats reset timestamps in the browser local date-time shape', () => {
  const resetAt = new Date(2026, 7, 12, 18, 5, 0, 0).getTime();
  assert.equal(formatResetAt(resetAt), '08-12 18:05');
  assert.equal(formatResetAt(0), '');
  assert.equal(formatResetAt(null), '');
});

test('formats reset countdowns with only positive day, hour, and minute units', () => {
  assert.equal(formatResetIn('166h'), '6d22h');
  assert.equal(formatResetIn('3h 25m'), '3h25m');
  assert.equal(formatResetIn('1d 0h'), '1d');
  assert.equal(formatResetIn('0d0h'), '');
  assert.equal(formatResetIn('0h0m'), '');
  assert.equal(formatResetIn('unknown'), '');
  assert.equal(formatResetIn('soon'), '');
});

test('derives the reset countdown from the reset timestamp when available', () => {
  const nowMs = Date.UTC(2026, 7, 12, 10, 0, 0, 0);
  assert.equal(formatResetIn('', nowMs + (24 * 60 + 3 * 60) * 60 * 1000, nowMs), '1d3h');
  assert.equal(formatResetIn('', nowMs + (3 * 60 + 25) * 60 * 1000, nowMs), '3h25m');
  assert.equal(formatResetIn('', nowMs - 1, nowMs), '');
});
