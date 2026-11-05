'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MS_PER_MINUTE,
  PHANTOM_TOLERANCE_MS,
  isPhantomSample,
  observeWindow
} = require('../lib/server/window-activation/window-ledger');

const WINDOW_MINUTES = 300;
const WINDOW_MS = WINDOW_MINUTES * MS_PER_MINUTE;
const ANCHOR_MS = Date.UTC(2026, 10, 5, 0, 0, 0);

function buildSnapshot(capturedAtMs, resetAtMs) {
  return {
    capturedAt: capturedAtMs,
    entries: [{
      bucket: 'primary',
      windowMinutes: WINDOW_MINUTES,
      remainingPct: 100,
      resetIn: '5h',
      resetAtMs
    }]
  };
}

const CODEX_SPEC = { windowMatch: { windowMinutes: WINDOW_MINUTES } };

test('isPhantomSample: 锚点与读取时刻相差在容差内就是幻影', () => {
  const resetAtMs = ANCHOR_MS + WINDOW_MS;
  assert.equal(isPhantomSample(ANCHOR_MS, resetAtMs, WINDOW_MINUTES), true);
  assert.equal(isPhantomSample(ANCHOR_MS + 10_000, resetAtMs, WINDOW_MINUTES), true);
  assert.equal(isPhantomSample(ANCHOR_MS - 10_000, resetAtMs, WINDOW_MINUTES), true);
});

test('isPhantomSample: 90s 是闭区间边界', () => {
  const resetAtMs = ANCHOR_MS + WINDOW_MS;
  assert.equal(
    isPhantomSample(ANCHOR_MS + PHANTOM_TOLERANCE_MS, resetAtMs, WINDOW_MINUTES),
    true
  );
  assert.equal(
    isPhantomSample(ANCHOR_MS + PHANTOM_TOLERANCE_MS + 1, resetAtMs, WINDOW_MINUTES),
    false
  );
});

test('isPhantomSample: 字段缺失一律判成「不是幻影」，绝不猜', () => {
  assert.equal(isPhantomSample(0, ANCHOR_MS + WINDOW_MS, WINDOW_MINUTES), false);
  assert.equal(isPhantomSample(ANCHOR_MS, 0, WINDOW_MINUTES), false);
  assert.equal(isPhantomSample(ANCHOR_MS, ANCHOR_MS + WINDOW_MS, 0), false);
  assert.equal(isPhantomSample(null, undefined, NaN), false);
});

test('observeWindow: 空闲时上游现算的 reset 判成 absent', () => {
  // 窗口关闭后没有任何请求：每次读取都报「读取时刻 + 5h」。
  const capturedAtMs = ANCHOR_MS + 30 * MS_PER_MINUTE;
  const observation = observeWindow(
    buildSnapshot(capturedAtMs, capturedAtMs + WINDOW_MS),
    CODEX_SPEC
  );
  assert.equal(observation.kind, 'absent');
  assert.equal(observation.reason, 'phantom_reset');
});

test('observeWindow: 真窗口即使读取时刻接近锚点也不判幻影', () => {
  // 探测成功 → 立刻读快照：锚点落在 lastProbeAt 附近，是探测开出来的真窗口。
  const observation = observeWindow(
    buildSnapshot(ANCHOR_MS + 20_000, ANCHOR_MS + WINDOW_MS),
    CODEX_SPEC,
    { lastProbeAt: ANCHOR_MS + 5_000 }
  );
  assert.equal(observation.kind, 'live');
  assert.equal(observation.reason, 'probe_anchor');
  assert.equal(observation.anchorAtMs, ANCHOR_MS);
  assert.equal(observation.closeAtMs, ANCHOR_MS + WINDOW_MS);
});

test('observeWindow: 窗口运行中段的读取判成 live', () => {
  const observation = observeWindow(
    buildSnapshot(ANCHOR_MS + 45 * MS_PER_MINUTE, ANCHOR_MS + WINDOW_MS),
    CODEX_SPEC
  );
  assert.equal(observation.kind, 'live');
  assert.equal(observation.reason, 'live_anchor');
  assert.equal(observation.anchorAtMs, ANCHOR_MS);
});
