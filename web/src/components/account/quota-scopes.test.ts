'use strict';

// 额度展示行派生（WebUI）的回归测试：标签/顺序/旁路标记都来自服务端归一结果，
// 老缓存记录（无 label / 无 entryShape）必须仍然可渲染。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fallbackScopeLabel,
  getMinRemainingPct,
  getPrimaryQuotaScopes,
  getQuotaScopes,
  hasRenderableScopes,
  isNamedBucket
} from './quota-scopes.ts';
import type { AccountUsageSnapshot } from '@/types';

test('余额桶：聚合行说「账户额度」，每包明细用商品桶名，聚合排最前', () => {
  const snapshot = {
    kind: 'codebuddy_credit_balance',
    entryShape: 'bucket',
    capturedAt: 1,
    entries: [
      { bucket: 'credits', label: 'Credits', remainingPct: 16.67, windowMinutes: 0, window: '', resetIn: '', resetAtMs: 0 },
      { bucket: 'activity', label: 'activity', category: 'detail', remainingPct: 100, windowMinutes: 0, window: '', resetIn: '', resetAtMs: 0 },
      { bucket: 'proTrialMon', label: 'proTrialMon', category: 'detail', remainingPct: 0, windowMinutes: 0, window: '', resetIn: '', resetAtMs: 0 }
    ]
  } as unknown as AccountUsageSnapshot;

  const rows = getQuotaScopes(snapshot);
  assert.deepEqual(rows.map((row) => row.label), ['账户额度', 'activity', 'proTrialMon']);
  assert.equal(rows[0].category, 'primary');
  assert.equal(rows[0].remainingPct, 16.67);
  // 账号级 min 只吃聚合行，明细包用尽不影响账号可用性。
  assert.equal(getMinRemainingPct(snapshot), 16.67);
  assert.equal(getPrimaryQuotaScopes(snapshot).length, 1);
});

test('窗口形态：短窗在前，gift 不进主额度', () => {
  const snapshot = {
    kind: 'kimi_oauth_usage',
    entryShape: 'window',
    capturedAt: 1,
    entries: [
      { bucket: 'monthly', label: 'month', window: 'month', windowMinutes: 43200, remainingPct: 83, resetIn: '', resetAtMs: 0 },
      { bucket: 'rolling_300m', label: '5h', window: '5h', windowMinutes: 300, remainingPct: 89, resetIn: '', resetAtMs: 0 },
      { bucket: 'Invite to Earn Credit', label: 'Invite to Earn Credit', window: 'gift', category: 'gift', windowMinutes: 0, remainingPct: 0, resetIn: '', resetAtMs: 0 }
    ]
  } as unknown as AccountUsageSnapshot;

  assert.deepEqual(getQuotaScopes(snapshot).map((row) => row.label), ['5h', 'month', 'Invite to Earn Credit']);
  assert.deepEqual(getPrimaryQuotaScopes(snapshot).map((row) => row.label), ['5h', 'month']);
  assert.equal(getMinRemainingPct(snapshot), 83);
});

test('模型形态：按剩余升序，min 取最紧模型', () => {
  const snapshot = {
    kind: 'gemini_oauth_stats',
    entryShape: 'models',
    capturedAt: 1,
    models: [
      { model: 'gemini-3-pro', label: 'gemini-3-pro', remainingPct: 88, resetIn: '', resetAtMs: 0 },
      { model: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', remainingPct: 12, resetIn: '', resetAtMs: 0 }
    ]
  } as unknown as AccountUsageSnapshot;

  assert.deepEqual(getQuotaScopes(snapshot).map((row) => row.model), ['claude-sonnet-4-6', 'gemini-3-pro']);
  assert.equal(getMinRemainingPct(snapshot), 12);
});

test('老缓存记录（无 label / 无 entryShape）按结构兜底', () => {
  const legacy = {
    kind: 'kiro_credit_usage',
    capturedAt: 1,
    entries: [{ bucket: 'credits', remainingPct: 97.4, windowMinutes: 0, window: '', resetIn: '', resetAtMs: 0, totalUnits: 50, remainingUnits: 49.87, unitType: 'credits' }]
  } as unknown as AccountUsageSnapshot;

  const rows = getQuotaScopes(legacy);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shape, 'bucket');
  assert.equal(rows[0].label, 'Credits');
  assert.equal(rows[0].remainingUnits, 49.87);
  assert.equal(hasRenderableScopes(legacy), true);

  assert.equal(fallbackScopeLabel({ bucket: 'glm-5.3', window: '1days', windowMinutes: 1440, remainingPct: 99, resetIn: '', resetAtMs: 0 }), 'glm-5.3 1days');
  assert.equal(fallbackScopeLabel({ bucket: 'rolling_300m', window: '5h', windowMinutes: 300, remainingPct: 50, resetIn: '', resetAtMs: 0 }), '5h');
  assert.equal(isNamedBucket('glm-5.3'), true);
  assert.equal(isNamedBucket('credits'), false);
  assert.equal(isNamedBucket('rolling_300m'), false);
});

test('没有可渲染条目时不产出任何行', () => {
  assert.deepEqual(getQuotaScopes(null), []);
  assert.equal(hasRenderableScopes(null), false);
  assert.equal(getMinRemainingPct({ kind: 'codex_oauth_status', entryShape: 'window', capturedAt: 1, entries: [] } as unknown as AccountUsageSnapshot), null);
});
