'use strict';

// 窗口账本：把用量快照翻成「当前有没有活跃窗口」。
//
// 这组断言锁住本功能最容易搞错的地方：快照里的 reset 是不是幻影。搞错方向就反了 ——
// 误判成「没有窗口」最多多探一次（无害）；误判成「有窗口」会一直不续窗（有害）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PHANTOM_TOLERANCE_MS,
  PROBE_GRACE_MS,
  observeWindow,
  reconcileLedger,
  describeWindowView,
  anchorWindowAt,
  markProbeFailure,
  normalizeLedger,
  findWindowEntry
} = require('../lib/server/window-activation/window-ledger');

const CODEX_SPEC = require('../lib/server/window-activation/probe-specs').getProbeSpec('codex');
const MINUTE = 60 * 1000;
const NOW = 1_800_000_000_000;

function windowSnapshot(resetAtMs, capturedAt) {
  const snapshot = {
    source: 'codex-app-server',
    entries: [{ bucket: 'primary', windowMinutes: 300, remainingPct: 80, resetIn: '5h', resetAtMs }]
  };
  if (capturedAt !== undefined) snapshot.capturedAt = capturedAt;
  return snapshot;
}

test('observeWindow：幻影——reset 正好是「读取时刻 + 窗口时长」', () => {
  const capturedAt = NOW - 5 * MINUTE;
  const observation = observeWindow(windowSnapshot(capturedAt + 300 * MINUTE, capturedAt), CODEX_SPEC, { now: NOW });
  assert.equal(observation.kind, 'absent');
  assert.equal(observation.reason, 'phantom_reset');
  assert.equal(observation.observedAtMs, capturedAt);
});

test('observeWindow：真窗口——锚点在读取时刻之前（差值远大于容差）', () => {
  const capturedAt = NOW - 5 * MINUTE;
  const anchorAtMs = capturedAt - 2 * 60 * MINUTE;
  const observation = observeWindow(windowSnapshot(anchorAtMs + 300 * MINUTE, capturedAt), CODEX_SPEC, { now: NOW });
  assert.equal(observation.kind, 'live');
  assert.equal(observation.reason, 'live_anchor');
  assert.equal(observation.anchorAtMs, anchorAtMs);
  assert.equal(observation.closeAtMs, anchorAtMs + 300 * MINUTE);
  assert.equal(observation.windowMinutes, 300);
});

test('observeWindow：真实取证样例（meadeodeo 真窗口 / gmail 幻影）', () => {
  // 2026-10-16 真机取证：meadeodeo 在 10:21:40 开窗，快照读于 15:21:40 前 → 真窗口
  const liveCaptured = Date.UTC(2026, 9, 16, 6, 0, 0); // 本地 14:00
  const liveAnchor = liveCaptured - 2 * 60 * MINUTE;
  const live = observeWindow(
    windowSnapshot(liveAnchor + 300 * MINUTE, liveCaptured),
    CODEX_SPEC,
    { now: liveCaptured }
  );
  assert.equal(live.kind, 'live');
  assert.equal(live.anchorAtMs, liveAnchor);

  // gmail 12:43:51 的快照：reset 恰好是「读取时刻 + 5h」（幻影，窗口当时空着）
  const phantomCaptured = Date.UTC(2026, 9, 16, 4, 43, 51); // 本地 12:43:51
  const phantom = observeWindow(
    windowSnapshot(phantomCaptured + 300 * MINUTE, phantomCaptured),
    CODEX_SPEC,
    { now: phantomCaptured + 60 * 1000 }
  );
  assert.equal(phantom.kind, 'absent');
  assert.equal(phantom.reason, 'phantom_reset');
});

test('observeWindow：锚点落到我们自己的探测附近 → 那是我们开出来的真窗口', () => {
  const lastProbeAt = NOW - 6 * MINUTE;
  const capturedAt = lastProbeAt + 1000; // 探测成功后马上读了一次快照
  const observation = observeWindow(
    windowSnapshot(lastProbeAt + 300 * MINUTE, capturedAt),
    CODEX_SPEC,
    { now: NOW, lastProbeAt }
  );
  assert.equal(observation.kind, 'live');
  assert.equal(observation.reason, 'probe_anchor');
  assert.equal(observation.anchorAtMs, lastProbeAt);
});

test('observeWindow：容差边界——刚好在容差内算幻影，超出一点点就算真窗口', () => {
  const capturedAt = NOW - 5 * MINUTE;
  const inside = observeWindow(
    windowSnapshot(capturedAt + PHANTOM_TOLERANCE_MS - 1000 + 300 * MINUTE, capturedAt),
    CODEX_SPEC,
    { now: NOW }
  );
  assert.equal(inside.kind, 'absent');
  const outside = observeWindow(
    windowSnapshot(capturedAt + PHANTOM_TOLERANCE_MS + 1000 + 300 * MINUTE, capturedAt),
    CODEX_SPEC,
    { now: NOW }
  );
  assert.equal(outside.kind, 'live');
  assert.equal(outside.anchorAtMs, capturedAt + PHANTOM_TOLERANCE_MS + 1000);
});

test('observeWindow：观察不出窗口时一律 unknown（缺失 / 无 capturedAt / 无 resetAtMs）', () => {
  assert.equal(observeWindow(null, CODEX_SPEC, { now: NOW }).kind, 'unknown');
  assert.equal(observeWindow(windowSnapshot(NOW + MINUTE, NOW), null, { now: NOW }).kind, 'unknown');
  // 没有读取时刻就无法区分幻影：宁可不写账本
  assert.equal(observeWindow(windowSnapshot(NOW + MINUTE, undefined), CODEX_SPEC, { now: NOW }).kind, 'unknown');
  // agy 形态：只有「距重置 5h」标签，没有 windowMinutes/resetAtMs
  const agySnapshot = { capturedAt: NOW, models: [{ bucket: 'primary', resetIn: '5h' }] };
  const observation = observeWindow(agySnapshot, { windowMatch: { windowMinutes: 300, resetInLabel: '5h' } }, { now: NOW });
  assert.equal(observation.kind, 'unknown');
  assert.equal(observation.reason, 'window_entry_unusable');
});

test('findWindowEntry：windowMinutes 与 resetInLabel 两种形状都能命中', () => {
  const windowMatch = { windowMinutes: 300, resetInLabel: '5h' };
  assert.ok(findWindowEntry({ entries: [{ windowMinutes: 300 }] }, windowMatch));
  assert.ok(findWindowEntry({ models: [{ resetIn: '5H' }] }, windowMatch));
  assert.equal(findWindowEntry({ models: [{ resetIn: '7d' }] }, windowMatch), null);
});

test('reconcileLedger：更新的观察覆盖账本，更旧的观察绝不倒退', () => {
  const closeAtMs = NOW - 10 * MINUTE;
  const ledger = {
    windowAnchorAtMs: closeAtMs - 300 * MINUTE,
    windowMinutes: 300,
    windowCloseAtMs: closeAtMs,
    windowSource: 'probe',
    windowObservedAtMs: closeAtMs - 300 * MINUTE
  };

  // 更旧的快照（生成于上次观察之前）不覆盖
  const stale = reconcileLedger(ledger, {
    kind: 'live',
    anchorAtMs: NOW - 100 * MINUTE,
    closeAtMs: NOW + 200 * MINUTE,
    windowMinutes: 300,
    observedAtMs: closeAtMs - 400 * MINUTE
  });
  assert.equal(stale.windowCloseAtMs, closeAtMs);

  // 更新的真窗口覆盖（用户自己开过窗、上游给了新锚点）
  const fresh = reconcileLedger(ledger, {
    kind: 'live',
    anchorAtMs: NOW - 20 * MINUTE,
    closeAtMs: NOW + 280 * MINUTE,
    windowMinutes: 300,
    observedAtMs: NOW - MINUTE
  });
  assert.equal(fresh.windowCloseAtMs, NOW + 280 * MINUTE);
  assert.equal(fresh.windowAnchorAtMs, NOW - 20 * MINUTE);
  assert.equal(fresh.windowSource, 'snapshot');

  // unknown 一律不覆盖
  assert.deepEqual(reconcileLedger(ledger, { kind: 'unknown' }), normalizeLedger(ledger));
});

test('reconcileLedger：absent 只在「观察到无窗口的时刻」晚于已知关窗时刻才覆盖', () => {
  const closeAtMs = NOW - 10 * MINUTE;
  const ledger = {
    windowAnchorAtMs: closeAtMs - 300 * MINUTE,
    windowMinutes: 300,
    windowCloseAtMs: closeAtMs,
    windowSource: 'probe',
    windowObservedAtMs: closeAtMs - 300 * MINUTE
  };
  // 快照落在窗口期内 → 与账本说的是同一件事，不覆盖
  const sameWindow = reconcileLedger(ledger, { kind: 'absent', observedAtMs: closeAtMs - 100 * MINUTE });
  assert.equal(sameWindow.windowCloseAtMs, closeAtMs);
  // 快照晚于关窗时刻 → 确认「没有活跃窗口」
  const afterClose = reconcileLedger(ledger, { kind: 'absent', observedAtMs: NOW, windowMinutes: 300 });
  assert.equal(afterClose.windowCloseAtMs, 0);
  assert.equal(afterClose.windowObservedAtMs, NOW);
  assert.equal(afterClose.windowMinutes, 300);
});

test('describeWindowView：open / closed / absent / unknown 四态', () => {
  const closeAtMs = NOW + 60 * MINUTE;
  const open = describeWindowView({
    windowAnchorAtMs: closeAtMs - 300 * MINUTE,
    windowMinutes: 300,
    windowCloseAtMs: closeAtMs,
    windowSource: 'probe',
    windowObservedAtMs: closeAtMs - 300 * MINUTE
  }, NOW);
  assert.equal(open.kind, 'open');
  assert.equal(open.remainingMs, 60 * MINUTE);
  assert.equal(open.nextActionAtMs, closeAtMs + PROBE_GRACE_MS);

  const closed = describeWindowView({
    windowCloseAtMs: closeAtMs,
    windowMinutes: 300,
    windowSource: 'probe'
  }, closeAtMs + 1);
  assert.equal(closed.kind, 'closed');
  assert.equal(closed.remainingMs, 0);

  const absent = describeWindowView({ windowObservedAtMs: NOW - MINUTE, windowMinutes: 300 }, NOW);
  assert.equal(absent.kind, 'absent');

  assert.equal(describeWindowView({}, NOW).kind, 'unknown');
  assert.equal(describeWindowView(null, NOW).kind, 'unknown');
});

test('anchorWindowAt：只有窗口已确认关闭时才能把锚点定到探测时刻', () => {
  const ledger = { windowMinutes: 300, probeFailureCount: 3 };
  const anchored = anchorWindowAt(ledger, NOW, 300, 'probe');
  assert.equal(anchored.windowAnchorAtMs, NOW);
  assert.equal(anchored.windowCloseAtMs, NOW + 300 * MINUTE);
  assert.equal(anchored.windowSource, 'probe');
  assert.equal(anchored.windowObservedAtMs, NOW);
  // 探测成功清掉失败计数
  assert.equal(anchored.probeFailureCount, 0);
  // 用户流量的重锚不清失败计数（那与探测无关），来源标成 activity
  const byActivity = anchorWindowAt({ ...ledger }, NOW, 300, 'activity');
  assert.equal(byActivity.windowSource, 'activity');
  assert.equal(byActivity.probeFailureCount, 3);
  // 缺窗口时长时锚定失败（宁可保持未知，也不写一个假窗口）
  assert.deepEqual(anchorWindowAt({}, NOW, 0, 'probe').windowCloseAtMs, 0);
});

test('markProbeFailure：累计失败次数并封顶', () => {
  let ledger = normalizeLedger({});
  for (let i = 0; i < 40; i += 1) ledger = markProbeFailure(ledger);
  assert.equal(ledger.probeFailureCount, 32);
});
