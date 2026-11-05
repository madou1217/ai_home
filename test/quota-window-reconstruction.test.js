'use strict';

// 窗口重建是统计页正确性的核心：锚点必须来自「第一个真实请求」，
// 空闲期不能造窗，提前回血要把旧窗截断、新窗等下一个活跃点。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildQuotaWindows,
  QUOTA_WINDOW_DIMENSIONS
} = require('../lib/account/quota-window-reconstruction');

const WINDOW_MINUTES = 300;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2026, 10, 5, 0, 0, 0); // 00:00
const QUOTA_KEY = 'rate_limit:primary';

function sample(capturedAtMs, expectedResetAtMs, remainingPct, overrides = {}) {
  return {
    quotaKey: QUOTA_KEY,
    windowMinutes: WINDOW_MINUTES,
    expectedResetAtMs,
    capturedAtMs,
    remainingPct,
    planType: 'plus',
    ...overrides
  };
}

function resetEvent(occurredAtMs, overrides = {}) {
  return {
    id: overrides.id || 1,
    quotaKey: QUOTA_KEY,
    windowMinutes: WINDOW_MINUTES,
    windowLabel: '5h',
    eventKind: 'cycle_rollover',
    classification: 'natural',
    previousRemainingPct: 20,
    currentRemainingPct: 100,
    occurredAtMs,
    detectedAtMs: occurredAtMs,
    ...overrides
  };
}

function build(overrides = {}) {
  return buildQuotaWindows({
    samples: [],
    resetEvents: [],
    ledger: null,
    windowMinutes: WINDOW_MINUTES,
    quotaKey: QUOTA_KEY,
    rangeFromMs: BASE,
    rangeToMs: BASE + 30 * DAY,
    nowMs: BASE + 30 * DAY,
    ...overrides
  });
}

test('三个维度常量固定为 5h / 7天 / 30天', () => {
  assert.deepEqual(
    QUOTA_WINDOW_DIMENSIONS.map((dimension) => dimension.windowMinutes),
    [300, 10080, 43200]
  );
});

test('全是幻影样本时不造窗', () => {
  const { windows, droppedPhantomGroups } = build({
    samples: [
      sample(BASE + 30 * MINUTE, BASE + 30 * MINUTE + 5 * HOUR, 100),
      sample(BASE + 90 * MINUTE, BASE + 90 * MINUTE + 5 * HOUR, 100)
    ]
  });
  assert.equal(windows.length, 0);
  assert.equal(droppedPhantomGroups, 2);
});

test('90s 容差边界：等于容差算幻影，多 1ms 算真样本', () => {
  const resetAtMs = BASE + 5 * HOUR;
  const phantom = build({
    samples: [sample(BASE + 90 * 1000, resetAtMs, 100)],
    nowMs: BASE + 2 * HOUR
  });
  assert.equal(phantom.windows.length, 0);

  const real = build({
    samples: [sample(BASE + 90 * 1000 + 1, resetAtMs, 100)],
    nowMs: BASE + 2 * HOUR
  });
  assert.equal(real.windows.length, 1);
  assert.equal(real.windows[0].anchorAtMs, BASE);
});

test('F2：同一 resetAtMs 的多次观测只产生一个窗口', () => {
  const resetAtMs = BASE + 5 * HOUR;
  const samples = Array.from({ length: 20 }, (_, index) => (
    sample(BASE + (index + 1) * 10 * MINUTE, resetAtMs, 100 - index)
  ));
  const { windows } = build({ samples, nowMs: BASE + 4 * HOUR });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].anchorAtMs, BASE);
  assert.equal(windows[0].sampleCount, 20);
});

test('用户例子：03:10 提前回血，新窗口锚定 06:00 而不是 05:00', () => {
  const scheduledCloseAtMs = BASE + 5 * HOUR;
  const replenishedAtMs = BASE + 3 * HOUR + 10 * MINUTE;
  const nextAnchorAtMs = BASE + 6 * HOUR;

  const { windows } = build({
    samples: [
      // 旧窗口：起点 00:00，计划 05:00 关窗
      sample(BASE + 5 * MINUTE, scheduledCloseAtMs, 100),
      sample(BASE + 1 * HOUR, scheduledCloseAtMs, 70),
      sample(BASE + 2 * HOUR, scheduledCloseAtMs, 50),
      sample(BASE + 3 * HOUR, scheduledCloseAtMs, 45),
      // 03:10 回血后空闲：每次读取都报「读取时刻 + 5h」= 幻影
      sample(BASE + 3 * HOUR + 30 * MINUTE, BASE + 8 * HOUR + 30 * MINUTE, 100),
      sample(BASE + 4 * HOUR + 30 * MINUTE, BASE + 9 * HOUR + 30 * MINUTE, 100),
      sample(BASE + 5 * HOUR + 30 * MINUTE, BASE + 10 * HOUR + 30 * MINUTE, 100),
      // 06:00 用户重新开始用，窗口才锚定
      sample(nextAnchorAtMs + 5 * MINUTE, nextAnchorAtMs + 5 * HOUR, 100),
      sample(nextAnchorAtMs + 30 * MINUTE, nextAnchorAtMs + 5 * HOUR, 92),
      sample(nextAnchorAtMs + 1 * HOUR, nextAnchorAtMs + 5 * HOUR, 85)
    ],
    resetEvents: [resetEvent(replenishedAtMs, {
      id: 7,
      eventKind: 'replenishment',
      classification: 'early_inferred',
      previousRemainingPct: 45
    })],
    nowMs: nextAnchorAtMs + 70 * MINUTE
  });

  assert.equal(windows.length, 2, '只应有旧窗口和新窗口两个');

  const [first, second] = windows;
  assert.equal(first.anchorAtMs, BASE);
  assert.equal(first.closeAtMs, replenishedAtMs, '旧窗口在回血时刻被截断');
  assert.equal(first.scheduledCloseAtMs, scheduledCloseAtMs);
  assert.equal(first.truncated, true);
  assert.equal(first.consumedPct, 55);
  assert.equal(first.resetKind, 'replenishment');
  assert.equal(first.approximateClose, true);

  assert.equal(second.anchorAtMs, nextAnchorAtMs, '新窗口锚定在下一个活跃点 06:00');
  assert.equal(second.closeAtMs, nextAnchorAtMs + 5 * HOUR);
  assert.equal(second.live, true);

  const anchors = windows.map((window) => window.anchorAtMs);
  assert.ok(!anchors.includes(BASE + 5 * HOUR), '不能把计划关窗时刻当成新窗口锚点');
  assert.ok(!anchors.includes(replenishedAtMs), '也不能把回血时刻当成新窗口锚点');
});

test('两个窗口之间的长时间空闲不会产生额外窗口', () => {
  const firstClose = BASE + 5 * HOUR;
  const secondAnchor = BASE + 15 * HOUR;
  const { windows } = build({
    samples: [
      sample(BASE + 5 * MINUTE, firstClose, 100),
      sample(BASE + 4 * HOUR, firstClose, 40),
      // 10 小时空闲：全是幻影
      ...Array.from({ length: 10 }, (_, index) => {
        const capturedAt = BASE + 5 * HOUR + (index + 1) * HOUR;
        return sample(capturedAt, capturedAt + 5 * HOUR, 100);
      }),
      sample(secondAnchor + 5 * MINUTE, secondAnchor + 5 * HOUR, 100)
    ],
    nowMs: secondAnchor + 30 * MINUTE
  });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.anchorAtMs), [BASE, secondAnchor]);
});

test('只有 cycle_rollover 事件时给低置信窗口，消耗取事件里的重置前剩余', () => {
  const closeAtMs = BASE + 5 * HOUR;
  const { windows } = build({
    resetEvents: [resetEvent(closeAtMs, { previousRemainingPct: 20 })],
    nowMs: BASE + 6 * HOUR
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].anchorAtMs, BASE);
  assert.equal(windows[0].source, 'reset');
  assert.equal(windows[0].confidence, 'low');
  assert.equal(windows[0].consumedPct, 80);
  assert.equal(windows[0].anchorEstimated, false);
  assert.equal(windows[0].approximateClose, false);
});

test('只有 replenishment 事件时关窗和锚点都标成估算', () => {
  const closeAtMs = BASE + 3 * HOUR;
  const { windows } = build({
    resetEvents: [resetEvent(closeAtMs, { eventKind: 'replenishment', classification: 'early_inferred' })],
    nowMs: BASE + 6 * HOUR
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].source, 'reset');
  assert.equal(windows[0].confidence, 'low');
  assert.equal(windows[0].approximateClose, true);
  assert.equal(windows[0].anchorEstimated, true);
});

test('窗口长度不匹配的事件不会污染当前维度', () => {
  const { windows } = build({
    resetEvents: [resetEvent(BASE + 5 * HOUR, { windowMinutes: 10080, quotaKey: 'rate_limit:secondary' })],
    nowMs: BASE + 6 * HOUR
  });
  assert.equal(windows.length, 0);
});

test('账本里的活跃窗口即使没有样本也会出现', () => {
  const ledger = {
    windowMinutes: WINDOW_MINUTES,
    windowAnchorAtMs: BASE,
    windowCloseAtMs: BASE + 5 * HOUR,
    windowSource: 'snapshot',
    windowObservedAtMs: BASE
  };
  const { windows } = build({ ledger, nowMs: BASE + 2 * HOUR });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].source, 'live');
  assert.equal(windows[0].confidence, 'low');
  assert.equal(windows[0].live, true);
  assert.equal(windows[0].anchorAtMs, BASE);
});

test('账本来自 activity 时锚点标成估算', () => {
  const ledger = {
    windowMinutes: WINDOW_MINUTES,
    windowAnchorAtMs: BASE,
    windowCloseAtMs: BASE + 5 * HOUR,
    windowSource: 'activity',
    windowObservedAtMs: BASE
  };
  const { windows } = build({ ledger, nowMs: BASE + 2 * HOUR });
  assert.equal(windows[0].anchorEstimated, true);
});

test('窗口长度不匹配的账本不会混进当前维度', () => {
  const ledger = {
    windowMinutes: 10080,
    windowAnchorAtMs: BASE,
    windowCloseAtMs: BASE + 7 * DAY,
    windowSource: 'snapshot'
  };
  const { windows } = build({ ledger, nowMs: BASE + 2 * HOUR });
  assert.equal(windows.length, 0);
});

test('账本窗口已关闭且无样本/事件时不造窗', () => {
  const ledger = {
    windowMinutes: WINDOW_MINUTES,
    windowAnchorAtMs: BASE,
    windowCloseAtMs: BASE + 5 * HOUR,
    windowSource: 'snapshot'
  };
  const { windows } = build({ ledger, nowMs: BASE + 6 * HOUR });
  assert.equal(windows.length, 0);
});

test('按范围裁剪并按锚点升序编号', () => {
  const samples = [
    sample(BASE - 10 * DAY + 5 * MINUTE, BASE - 10 * DAY + 5 * HOUR, 100),
    sample(BASE + 5 * MINUTE, BASE + 5 * HOUR, 100),
    sample(BASE + 6 * HOUR + 5 * MINUTE, BASE + 11 * HOUR, 100)
  ];
  const { windows } = build({
    samples,
    rangeFromMs: BASE,
    rangeToMs: BASE + 12 * HOUR,
    nowMs: BASE + 12 * HOUR
  });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.index), [0, 1]);
  assert.deepEqual(windows.map((window) => window.anchorAtMs), [BASE, BASE + 6 * HOUR]);
});

test('样本缺口导致起点/末端未覆盖时降级为 reconstructed', () => {
  const closeAtMs = BASE + 5 * HOUR;
  const { windows } = build({
    samples: [
      // 第一条样本在锚点后 2 小时：起点没观测到
      sample(BASE + 2 * HOUR, closeAtMs, 60),
      // 最后一条离关窗还有 2 小时：末端没观测到，且没有事件背书
      sample(BASE + 3 * HOUR, closeAtMs, 50)
    ],
    nowMs: BASE + 6 * HOUR
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startEstimated, true);
  assert.equal(windows[0].source, 'reconstructed');
  assert.equal(windows[0].confidence, 'medium');
  // 消耗仍按「起点满额」算，不拿第一个样本当起点
  assert.equal(windows[0].consumedPct, 50);
});
