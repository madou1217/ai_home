import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import UsageSnapshotCell from './UsageSnapshotCell';

test('period-only quota keeps the reset and shows an unknown allowance without a zero-percent bar', () => {
  const html = renderToStaticMarkup(<UsageSnapshotCell record={{
    configured: true, apiKeyMode: false, provider: 'grok', quotaStatus: 'pending',
    quotaReason: 'provider_returned_no_numeric_usage',
    usageSnapshot: { kind: 'grok_credit_usage', capturedAt: 1000, entries: [{
      bucket: 'credits', window: '10080m', windowMinutes: 10080, remainingPct: null,
      resetIn: '', resetAtMs: Date.parse('2030-01-08T00:00:00Z')
    }] }
  }} />);
  assert.match(html, /额度未知/);
  assert.match(html, /usage-meta-line-reset-at/);
  assert.doesNotMatch(html, /data-usage-progress-value/);
  assert.doesNotMatch(html, /等待采集|已耗尽|已停池/);
});

test('a failed collection is shown alongside cached quota in the quota cell', () => {
  const html = renderToStaticMarkup(<UsageSnapshotCell record={{
    configured: true, apiKeyMode: false, remainingPct: 75,
    quotaStatus: 'probe_failed', quotaReason: 'timeout'
  }} />);
  assert.match(html, /采集失败/);
  assert.match(html, /data-usage-progress-value="75"/);
  assert.doesNotMatch(html, /已停池|已耗尽/);
});

test('known exhausted quota retains its zero-percent bar without a collection warning', () => {
  const html = renderToStaticMarkup(<UsageSnapshotCell record={{
    configured: true, apiKeyMode: false, remainingPct: 0, quotaStatus: 'exhausted'
  }} />);
  assert.match(html, /data-usage-progress-value="0"/);
  assert.doesNotMatch(html, /额度未知|采集失败|等待采集/);
});

test('API-key accounts never render OAuth quota collection notices', () => {
  const html = renderToStaticMarkup(<UsageSnapshotCell record={{
    configured: true, apiKeyMode: true, quotaStatus: 'probe_failed', quotaReason: 'timeout'
  }} />);
  assert.match(html, /额度由上游管理/);
  assert.doesNotMatch(html, /采集失败|等待采集/);
});

test('Kiro credits retain their official remaining percentage and reset date', () => {
  const html = renderToStaticMarkup(<UsageSnapshotCell record={{
    configured: true, apiKeyMode: false, provider: 'kiro',
    usageSnapshot: { kind: 'kiro_credit_usage', capturedAt: 1000,
      account: { email: 'kiro@example.invalid', planType: 'free', planName: 'KIRO FREE' },
      entries: [{ bucket: 'credits', totalUnits: 50, usedUnits: 0.13, remainingUnits: 49.87,
        unitType: 'credits', remainingPct: 99.74, resetAtMs: Date.parse('2026-11-01T00:00:00Z'),
        resetIn: '', window: '', windowMinutes: 0 }] }
  }} />);
  assert.match(html, /data-usage-progress-value="99.74"/);
  assert.match(html, /usage-meta-line-reset-at/);
  assert.doesNotMatch(html, /额度未知|采集失败|等待采集/);
});
