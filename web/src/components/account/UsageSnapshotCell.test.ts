import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatResetAt,
  formatResetIn,
  formatWindowDuration,
  groupAgyQuotaModels
} from './usage-snapshot-format.ts';

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

test('groupAgyQuotaModels groups models into Gemini Models and Claude & GPT Models with dynamic limits', () => {
  const nowMs = Date.UTC(2026, 7, 12, 10, 0, 0, 0);
  const models = [
    {
      model: 'gemini-2.5-flash',
      displayName: 'Gemini Flash',
      remainingPct: 98.87,
      resetIn: '1h 4m',
      resetAtMs: nowMs + (1 * 60 + 4) * 60 * 1000
    },
    {
      model: 'gemini-2.5-pro',
      displayName: 'Gemini Pro',
      remainingPct: 83.56,
      resetIn: '94h 5m',
      resetAtMs: nowMs + (94 * 60 + 5) * 60 * 1000
    },
    {
      model: 'claude-3-7-sonnet',
      displayName: 'Claude Sonnet',
      remainingPct: 0.0,
      resetIn: '66h 35m',
      resetAtMs: nowMs + (66 * 60 + 35) * 60 * 1000
    },
    {
      model: 'claude-opus-4-6',
      displayName: 'Claude Opus',
      remainingPct: 0.0,
      resetIn: '66h 35m',
      resetAtMs: nowMs + (66 * 60 + 35) * 60 * 1000
    },
    {
      model: 'gpt-oss-1',
      displayName: 'GPT-OSS',
      remainingPct: 99.0,
      resetIn: '2h 10m',
      resetAtMs: nowMs + (2 * 60 + 10) * 60 * 1000
    }
  ];

  const groups = groupAgyQuotaModels(models, nowMs);
  assert.equal(groups.length, 2);

  // Gemini Group
  const geminiGroup = groups.find((g) => g.key === 'gemini');
  assert.ok(geminiGroup);
  assert.equal(geminiGroup.title, 'Gemini Models');
  assert.deepEqual(geminiGroup.members, [
    { id: 'gemini-2.5-flash', name: 'Gemini Flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini Pro' }
  ]);
  assert.deepEqual(geminiGroup.memberNames, ['Gemini Flash', 'Gemini Pro']);
  assert.equal(geminiGroup.limits.length, 2);
  assert.equal(geminiGroup.limits[0].label, '5h Limit');
  assert.equal(geminiGroup.limits[0].remainingPct, 98.87);
  assert.equal(geminiGroup.limits[1].label, 'Weekly Limit');
  assert.equal(geminiGroup.limits[1].remainingPct, 83.56);
  assert.equal(geminiGroup.minRemainingPct, 83.56);

  // Claude & GPT Group
  const claudeGptGroup = groups.find((g) => g.key === 'claude_gpt');
  assert.ok(claudeGptGroup);
  assert.equal(claudeGptGroup.title, 'Claude & GPT Models');
  assert.deepEqual(claudeGptGroup.members, [
    { id: 'claude-3-7-sonnet', name: 'Claude Sonnet' },
    { id: 'claude-opus-4-6', name: 'Claude Opus' },
    { id: 'gpt-oss-1', name: 'GPT-OSS' }
  ]);
  assert.deepEqual(claudeGptGroup.memberNames, ['Claude Sonnet', 'Claude Opus', 'GPT-OSS']);
  // Notice Claude Sonnet & Claude Opus share identical 66h 35m reset and 0% remaining, so they deduplicate to 1 Weekly Limit
  assert.equal(claudeGptGroup.limits.length, 2);
  assert.equal(claudeGptGroup.limits[0].label, '5h Limit');
  assert.equal(claudeGptGroup.limits[0].remainingPct, 99.0);
  assert.equal(claudeGptGroup.limits[1].label, 'Weekly Limit');
  assert.equal(claudeGptGroup.limits[1].remainingPct, 0.0);
  assert.equal(claudeGptGroup.minRemainingPct, 0.0);
});

test('groupAgyQuotaModels gracefully handles empty or invalid models', () => {
  assert.deepEqual(groupAgyQuotaModels([]), []);
  assert.deepEqual(groupAgyQuotaModels(null as any), []);
  assert.deepEqual(groupAgyQuotaModels([{ model: 'invalid', remainingPct: null } as any]), []);
});

