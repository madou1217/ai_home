'use strict';

// 额度视图模型（lib/usage/quota/view.js）的行为契约：把各家形态不同的快照归一成同一组
// scope，且**旁路条目（gift/detail）绝不参与账号级 min 剩余**、形态不匹配必须可观察。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildQuotaView,
  resolveEntryShape,
  resolveEntryShapeByKind,
  humanizeBucketLabel,
  formatQuotaViewInline,
  formatQuotaViewLines,
  formatUnits
} = require('../lib/usage/quota/view');

test('窗口形态：按窗口长度升序，行内与明细格式稳定', () => {
  const view = buildQuotaView({
    kind: 'claude_oauth_usage',
    capturedAt: 1,
    entries: [
      { bucket: 'seven_day', window: '7days', windowMinutes: 10080, remainingPct: 52.4, resetIn: '3d' },
      { bucket: 'five_hour', window: '5h', windowMinutes: 300, remainingPct: 91, resetIn: '4h' }
    ]
  });
  assert.equal(view.shape, 'window');
  assert.deepEqual(view.scopes.map((scope) => scope.label), ['5h', '7days']);
  assert.equal(formatQuotaViewInline(view), '5h: 91.0% / 7days: 52.4%');
  assert.equal(formatQuotaViewInline(view, { compact: true }), '5h:91% 7days:52%');
  assert.deepEqual(formatQuotaViewLines(view), ['5h: 91.0% (resets in 4h)', '7days: 52.4% (resets in 3d)']);
  assert.equal(view.minRemainingPct, 52.4);
});

test('没有窗口长度的条目（月度总量）排在有窗口的条目之后', () => {
  const view = buildQuotaView({
    kind: 'kimi_oauth_usage',
    capturedAt: 1,
    entries: [
      { bucket: 'monthly', window: 'month', windowMinutes: 43200, remainingPct: 83 },
      { bucket: 'rolling_300m', window: '5h', windowMinutes: 300, remainingPct: 89 }
    ]
  });
  assert.deepEqual(view.scopes.map((scope) => scope.label), ['5h', 'month']);
});

test('gift/detail 是旁路条目：不进 min、不进行内摘要、明细里带标签', () => {
  const view = buildQuotaView({
    kind: 'kimi_oauth_usage',
    capturedAt: 1,
    entries: [
      { bucket: 'rolling_300m', window: '5h', windowMinutes: 300, remainingPct: 89 },
      { bucket: 'Invite to Earn Credit', window: 'gift', category: 'gift', remainingPct: 0 }
    ]
  });
  assert.equal(view.minRemainingPct, 89);
  assert.equal(formatQuotaViewInline(view), '5h: 89.0%');
  assert.deepEqual(formatQuotaViewLines(view), ['5h: 89.0%', 'Invite to Earn Credit: 0.0% [gift]']);
  assert.deepEqual(view.secondaryScopes.map((scope) => scope.category), ['gift']);
});

test('具名桶带身份（模型名 / 赠送包名），通用桶显示窗口标签', () => {
  const zcode = buildQuotaView({
    kind: 'zcode_plan_balance',
    capturedAt: 1,
    entries: [{ bucket: 'glm-5.3', window: '1days', windowMinutes: 1440, remainingPct: 99.4, totalUnits: 100, remainingUnits: 99.4, unitType: 'token' }]
  });
  assert.equal(zcode.scopes[0].label, 'glm-5.3 1days');
  assert.equal(formatQuotaViewLines(zcode)[0], 'glm-5.3 1days: 99.4% / 99.40 / 100.00 token');

  const grok = buildQuotaView({
    kind: 'grok_credit_usage',
    capturedAt: 1,
    entries: [{ bucket: 'credits', window: '10080m', windowMinutes: 10080, remainingPct: 100 }]
  });
  // 原始分钟数窗口标签（grok 探针的 `10080m`）归一成人读形式。
  assert.equal(grok.scopes[0].label, '7days');

  const kiro = buildQuotaView({
    kind: 'kiro_credit_usage',
    capturedAt: 1,
    entries: [{ bucket: 'credits', remainingPct: 97.4, totalUnits: 50, remainingUnits: 49.87, unitType: 'credits' }]
  });
  assert.equal(kiro.scopes[0].label, 'Credits');
});

test('模型形态：最紧的模型排前，min 取最紧模型', () => {
  const view = buildQuotaView({
    kind: 'agy_code_assist_quota',
    capturedAt: 1,
    models: [
      { model: 'gemini-3-pro', remainingPct: 88, resetIn: '6h' },
      { model: 'claude-sonnet-4-6', remainingPct: 12, resetIn: '2h' }
    ]
  });
  assert.equal(view.shape, 'models');
  assert.deepEqual(view.scopes.map((scope) => scope.label), ['claude-sonnet-4-6', 'gemini-3-pro']);
  assert.equal(view.minRemainingPct, 12);
  assert.equal(formatQuotaViewInline(view), 'claude-sonnet-4-6: 12.0% / gemini-3-pro: 88.0%');
});

test('顶层 remainingPct 兜底成账号级 Balance scope', () => {
  const view = buildQuotaView({ kind: 'unknown_kind', capturedAt: 1, remainingPct: 77 });
  // 有兜底 scope 就算渲染成功（unrenderable 只在真的没有可渲染内容时才带原因）。
  assert.equal(view.unrenderable, '');
  assert.equal(view.scopes[0].shape, 'account');
  assert.equal(formatQuotaViewInline(view), 'Balance: 77.0%');
});

test('形态与快照结构不匹配时可观察，不静默返回空', () => {
  const mismatch = buildQuotaView({ kind: 'x', capturedAt: 1 }, { entryShape: 'bucket' });
  assert.equal(mismatch.unrenderable, 'entry_shape_bucket_without_entries');
  assert.deepEqual(mismatch.scopes, []);
  assert.equal(buildQuotaView(null).unrenderable, 'snapshot_missing');
});

test('形态解析：显式入参 > 描述符 > kind 反查 > 结构推断', () => {
  const snapshot = { kind: 'claude_oauth_usage', capturedAt: 1, entries: [] };
  assert.equal(resolveEntryShape(snapshot, { entryShape: 'models' }), 'models');
  assert.equal(resolveEntryShape(snapshot, { provider: 'claude' }), 'window');
  assert.equal(resolveEntryShape(snapshot), 'window');
  assert.equal(resolveEntryShapeByKind('kimi_oauth_usage'), 'window');
  assert.equal(resolveEntryShapeByKind('not_a_declared_kind'), '');
  assert.equal(resolveEntryShape({ kind: 'x', capturedAt: 1, models: [] }), 'models');
  assert.equal(resolveEntryShape({ kind: 'x', capturedAt: 1, entries: [] }), 'bucket');
});

test('单位与桶名渲染：美元 / 积分 / 原始桶名', () => {
  assert.equal(humanizeBucketLabel('rolling_300m'), '5h');
  assert.equal(humanizeBucketLabel('five_hour'), '5h');
  assert.equal(humanizeBucketLabel('seven_day'), '7days');
  assert.equal(humanizeBucketLabel('credits'), 'Credits');
  assert.equal(humanizeBucketLabel('gift:Invite to Earn Credit'), 'Invite to Earn Credit');
  assert.equal(humanizeBucketLabel('glm-5.3'), 'glm-5.3');
  assert.equal(formatUnits({ remainingUnits: 16.8, totalUnits: 40, unitType: 'usd' }), '$16.80 / $40.00');
  assert.equal(formatUnits({ remainingUnits: 49.87, totalUnits: 50, unitType: 'credits' }), '49.87 / 50.00 credits');
  assert.equal(formatUnits({ remainingUnits: null, totalUnits: null, unitType: '' }), '');
});

test('remainingPct 越界值被夹到 0..100，非数值归一为 null', () => {
  const view = buildQuotaView({
    kind: 'claude_oauth_usage',
    capturedAt: 1,
    entries: [
      { bucket: 'five_hour', window: '5h', windowMinutes: 300, remainingPct: 130 },
      { bucket: 'seven_day', window: '7days', windowMinutes: 10080, remainingPct: 'n/a' }
    ]
  });
  assert.equal(view.scopes[0].remainingPct, 100);
  assert.equal(view.scopes[1].remainingPct, null);
  assert.equal(view.minRemainingPct, 100);
});
