'use strict';

// 窗口激活调度器：需求是「让滚动限额窗口一直处在滚动中」。
// 这几组断言锁住四件事：窗口开着不探、关窗即续、幻影立刻补窗、观察不出来时兜底。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideActivation,
  findWindowEntry,
  normalizeWindowActivationConfig,
  createWindowActivationScheduler,
  MIN_REPROBE_GAP_MS,
  DEFAULT_INTERVAL_MS
} = require('../lib/server/window-activation-scheduler');
const {
  PHANTOM_TOLERANCE_MS,
  PROBE_GRACE_MS,
  PROBE_RETRY_BACKOFF_MS,
  ACTIVITY_EPS_MS
} = require('../lib/server/window-activation/window-ledger');

const CODEX_SPEC = require('../lib/server/window-activation/probe-specs').getProbeSpec('codex');
const REF = 'acct_test0000000000000001';
const MINUTE = 60 * 1000;

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  const cleared = [];
  return {
    timeouts,
    intervals,
    cleared,
    setTimeoutFn: (fn, ms) => {
      const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => cleared.push(timer),
    setIntervalFn: (fn, ms) => {
      const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => cleared.push(timer)
  };
}

function windowSnapshot(resetAtMs = 0, capturedAt = 0) {
  const snapshot = { entries: [{ bucket: 'primary', windowMinutes: 300, remainingPct: 80, resetAtMs }] };
  if (capturedAt > 0) snapshot.capturedAt = capturedAt;
  return snapshot;
}

function unknownLedger(extra = {}) {
  return {
    windowAnchorAtMs: 0,
    windowMinutes: 0,
    windowCloseAtMs: 0,
    windowSource: '',
    windowObservedAtMs: 0,
    probeFailureCount: 0,
    ...extra
  };
}

function openView(closeAtMs, now) {
  return {
    kind: 'open',
    anchorAtMs: closeAtMs - 300 * MINUTE,
    closeAtMs,
    windowMinutes: 300,
    remainingMs: closeAtMs - now,
    source: 'probe',
    observedAtMs: closeAtMs - 300 * MINUTE,
    nextActionAtMs: closeAtMs + PROBE_GRACE_MS
  };
}

function closedView(closeAtMs) {
  return {
    kind: 'closed',
    anchorAtMs: closeAtMs - 300 * MINUTE,
    closeAtMs,
    windowMinutes: 300,
    remainingMs: 0,
    source: 'probe',
    observedAtMs: closeAtMs - 300 * MINUTE,
    nextActionAtMs: closeAtMs
  };
}

function absentView(observedAtMs) {
  return {
    kind: 'absent',
    anchorAtMs: 0,
    closeAtMs: 0,
    windowMinutes: 300,
    remainingMs: 0,
    source: 'snapshot',
    observedAtMs,
    nextActionAtMs: observedAtMs
  };
}

function account(overrides = {}) {
  return {
    provider: 'codex',
    accountRef: REF,
    apiKeyMode: false,
    status: 'up',
    usageSnapshot: windowSnapshot(0),
    ...overrides
  };
}

function makeScheduler(overrides = {}) {
  const dispatches = [];
  const stateWrites = [];
  const configs = overrides.configs || {};
  const states = overrides.states || {};
  const activity = overrides.activity || {};
  const scheduler = createWindowActivationScheduler({
    fs: {},
    aiHomeDir: '/tmp/aih',
    now: () => overrides.now || 1_000_000_000_000,
    listAccounts: () => overrides.accounts || [],
    accountActivity: { snapshot: () => activity },
    resolveBaseUrl: () => 'http://127.0.0.1:9527',
    clientKey: 'test-key',
    fetchImpl: overrides.fetchImpl,
    readAccountConfig: (_fs, _dir, ref) => configs[ref] || null,
    readAccountState: (_fs, _dir, ref) => states[ref] || null,
    writeAccountState: (_fs, _dir, ref, value) => { stateWrites.push({ ref, value }); return true; },
    listAccountModels: overrides.listAccountModels,
    deps: overrides.realDispatch
      ? null
      : {
        dispatchProbe: overrides.dispatchProbe || (async (input) => {
          dispatches.push(input);
          return { ok: true, matched: true, servedAccountRef: input.accountRef };
        })
      },
    config: overrides.config || { enabled: true },
    logInfo: overrides.logInfo || (() => {}),
    logWarn: overrides.logWarn || (() => {})
  });
  return { scheduler, dispatches, stateWrites };
}

test('decideActivation：前置过滤（关闭 / 无 spec / API-key / 防抖 / 运行态阻塞）', () => {
  const base = {
    now: 1000,
    enabled: true,
    spec: CODEX_SPEC,
    view: { kind: 'unknown' },
    ledger: unknownLedger(),
    lastProbeAt: 0,
    lastActivityAt: 0
  };
  assert.equal(decideActivation({ ...base, enabled: false }).trigger, 'disabled');
  assert.equal(decideActivation({ ...base, spec: null }).trigger, 'no_spec');
  assert.equal(decideActivation({ ...base, apiKeyMode: true }).trigger, 'api_key_account');
  assert.equal(decideActivation({ ...base, status: 'down' }).trigger, 'account_down');
  // 运行态被阻塞（配额耗尽 / 限流 / 鉴权失效）的账号不探测：探了会被网关排除并回落，白花别的账号额度
  const blocked = decideActivation({ ...base, runtimeStatus: 'rate_limited', runtimeReason: 'upstream_rate_limited' });
  assert.equal(blocked.trigger, 'runtime_blocked');
  assert.equal(blocked.runtimeStatus, 'rate_limited');
  assert.equal(blocked.runtimeReason, 'upstream_rate_limited');
  // healthy / 未上报都不算阻塞（此处未到周期，只断言没有被运行态过滤掉）
  assert.notEqual(decideActivation({ ...base, runtimeStatus: 'healthy' }).trigger, 'runtime_blocked');
  assert.notEqual(decideActivation({ ...base, runtimeStatus: 'unknown' }).trigger, 'runtime_blocked');
  assert.equal(
    decideActivation({ ...base, now: 1000 + MIN_REPROBE_GAP_MS - 1, lastProbeAt: 1000 }).trigger,
    'debounced'
  );
});

test('decideActivation：窗口运行中一次都不探（探测期内探测是空操作）', () => {
  const now = 1_000_000_000_000;
  const closeAtMs = now + 2 * 60 * MINUTE;
  const decision = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: openView(closeAtMs, now),
    ledger: unknownLedger({ windowCloseAtMs: closeAtMs, windowMinutes: 300 }),
    lastProbeAt: 0,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.trigger, 'window_open');
  assert.equal(decision.closeAtMs, closeAtMs);
  assert.equal(decision.remainingMs, 2 * 60 * MINUTE);
});

test('decideActivation：关窗即续——关窗时刻 + 时钟余量之后补探测', () => {
  const now = 1_000_000_000_000;
  const closeAtMs = now - 30 * MINUTE;
  const base = {
    enabled: true,
    spec: CODEX_SPEC,
    view: closedView(closeAtMs),
    ledger: unknownLedger({ windowCloseAtMs: closeAtMs, windowMinutes: 300 }),
    lastProbeAt: 0,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  };
  // 刚过关闭时刻（时钟余量内）先不动，避免打在上游还没翻页的旧窗口上
  const grace = decideActivation({ ...base, now: closeAtMs + PROBE_GRACE_MS - 1 });
  assert.equal(grace.action, 'skip');
  assert.equal(grace.trigger, 'close_grace');
  assert.equal(grace.probeAtMs, closeAtMs + PROBE_GRACE_MS);
  // 余量之后：补窗
  const due = decideActivation({ ...base, now: closeAtMs + PROBE_GRACE_MS + 1 });
  assert.equal(due.action, 'probe');
  assert.equal(due.trigger, 'window_closed');
  assert.equal(due.closeAtMs, closeAtMs);
});

test('decideActivation：关窗后用户自己用过 → 只重锚账本，不浪费探测', () => {
  const now = 1_000_000_000_000;
  const closeAtMs = now - 30 * MINUTE;
  const reanchorAtMs = closeAtMs + 2 * MINUTE;
  const decision = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: closedView(closeAtMs),
    ledger: unknownLedger({ windowCloseAtMs: closeAtMs, windowMinutes: 300 }),
    lastProbeAt: reanchorAtMs - 5 * MINUTE,
    lastActivityAt: reanchorAtMs,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.trigger, 'user_reopened');
  assert.equal(decision.reanchorAtMs, reanchorAtMs);
});

test('decideActivation：关窗后的活动就是上一次探测 → 不算用户开窗，照常续窗', () => {
  const now = 1_000_000_000_000;
  const closeAtMs = now - 30 * MINUTE;
  const probedAt = closeAtMs + 10 * MINUTE;
  const decision = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: closedView(closeAtMs),
    ledger: unknownLedger({ windowCloseAtMs: closeAtMs, windowMinutes: 300 }),
    // 活动记账发生在探测请求上（探测本身也计入 accountActivity），差值在 ACTIVITY_EPS_MS 内
    lastProbeAt: probedAt,
    lastActivityAt: probedAt + ACTIVITY_EPS_MS - 1000,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(decision.action, 'probe');
  assert.equal(decision.trigger, 'window_closed');
});

test('decideActivation：观察到「没有活跃窗口」（幻影）→ 立刻补窗', () => {
  const now = 1_000_000_000_000;
  const observedAtMs = now - 5 * MINUTE;
  const decision = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: absentView(observedAtMs),
    ledger: unknownLedger({ windowMinutes: 300 }),
    lastProbeAt: 0,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(decision.action, 'probe');
  assert.equal(decision.trigger, 'window_absent');
  assert.equal(decision.observedAtMs, observedAtMs);
});

test('decideActivation：同一张「无窗口」快照下已经成功激活过 → 不重复探', () => {
  const now = 1_000_000_000_000;
  const observedAtMs = now - 5 * MINUTE;
  const decision = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: absentView(observedAtMs),
    ledger: unknownLedger({ windowMinutes: 300 }),
    lastProbeAt: now - MINUTE,
    lastActivatedAt: now - MINUTE,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.trigger, 'probe_pending_observation');
});

test('decideActivation：探测失败按退避重试——打到账号的快重试，没打到的等兜底间隔', () => {
  const now = 1_000_000_000_000;
  const base = {
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: absentView(now - 5 * MINUTE),
    lastProbeAt: now - MINUTE,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  };
  // 打到账号但上游报错：10 分钟内退避
  const fast = decideActivation({
    ...base,
    ledger: unknownLedger({ windowMinutes: 300, probeFailureCount: 1 }),
    lastOutcome: 'matched_upstream_error'
  });
  assert.equal(fast.trigger, 'probe_retry_backoff');
  assert.equal(fast.retryInMs, PROBE_RETRY_BACKOFF_MS - MINUTE);
  // 池回落：按兜底间隔重试（免得每次失败都白花别的账号额度）
  const slow = decideActivation({
    ...base,
    ledger: unknownLedger({ windowMinutes: 300, probeFailureCount: 1 }),
    lastOutcome: 'account_not_matched'
  });
  assert.equal(slow.trigger, 'probe_retry_backoff');
  assert.equal(slow.retryInMs, DEFAULT_INTERVAL_MS - MINUTE);
  // 退避到期后回到正常判定
  const ready = decideActivation({
    ...base,
    now: now + PROBE_RETRY_BACKOFF_MS + MINUTE,
    ledger: unknownLedger({ windowMinutes: 300, probeFailureCount: 1 }),
    lastOutcome: 'matched_upstream_error'
  });
  assert.equal(ready.action, 'probe');
  assert.equal(ready.trigger, 'window_absent');
});

test('decideActivation：观察不出窗口时退回固定间隔兜底（含活跃闸门）', () => {
  const now = 100 * DEFAULT_INTERVAL_MS;
  const due = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: { kind: 'unknown' },
    ledger: unknownLedger(),
    lastProbeAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivatedAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivityAt: now - DEFAULT_INTERVAL_MS - 1,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.deepEqual(due, { action: 'probe', trigger: 'periodic_fallback' });

  const gated = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: { kind: 'unknown' },
    ledger: unknownLedger(),
    lastProbeAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivatedAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivityAt: now - MINUTE, // 区间内有真实活动
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(gated.action, 'skip');
  assert.equal(gated.trigger, 'activity_gate');

  const notDue = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: { kind: 'unknown' },
    ledger: unknownLedger(),
    // 超过防抖窗口，但远未到周期（周期锚点是上次成功激活）
    lastProbeAt: now - 2 * MIN_REPROBE_GAP_MS,
    lastActivatedAt: now - 2 * MIN_REPROBE_GAP_MS,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(notDue.trigger, 'not_due');
});

test('decideActivation：失败的探测不推进周期锚点（窗口没被激活就该尽快重试）', () => {
  const now = 100 * DEFAULT_INTERVAL_MS;
  const decision = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    view: { kind: 'unknown' },
    ledger: unknownLedger(),
    lastProbeAt: now - 2 * MIN_REPROBE_GAP_MS,
    lastActivatedAt: 0,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.deepEqual(decision, { action: 'probe', trigger: 'periodic_fallback' });
});

test('findWindowEntry：按 windowMatch 命中，容忍浮点', () => {
  assert.ok(findWindowEntry(windowSnapshot(1), CODEX_SPEC.windowMatch));
  assert.equal(findWindowEntry({ entries: [{ windowMinutes: 10080 }] }, CODEX_SPEC.windowMatch), null);
  assert.equal(findWindowEntry(null, CODEX_SPEC.windowMatch), null);
});

test('normalizeWindowActivationConfig：默认关、默认 1h、下限 1h', () => {
  const config = normalizeWindowActivationConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.defaultIntervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(config.minIntervalMs, 60 * 60 * 1000);
  // 默认间隔不得低于下限
  assert.equal(normalizeWindowActivationConfig({ defaultIntervalMs: 1000 }).defaultIntervalMs, 60 * 60 * 1000);
  assert.equal(normalizeWindowActivationConfig({ enabled: true }).enabled, true);
});

test('runNow：默认关闭时直接跳过', async () => {
  const { scheduler, dispatches } = makeScheduler({ config: { enabled: false } });
  const result = await scheduler.runNow('manual');
  assert.deepEqual(result, { ok: false, skipped: true, reason: 'disabled' });
  assert.equal(dispatches.length, 0);
});

test('runNow：观察不出窗口的账号按兜底间隔探测，命中后记录 activated 并落盘状态', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches, stateWrites } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true, intervalMs: null } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.ok, true);
  assert.equal(result.decisions[0].trigger, 'periodic_fallback');
  assert.equal(result.probed.length, 1);
  assert.equal(result.probed[0].outcome, 'activated');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].accountRef, REF);
  assert.equal(dispatches[0].provider, 'codex');
  assert.equal(dispatches[0].baseUrl, 'http://127.0.0.1:9527');
  assert.equal(stateWrites.length, 1);
  assert.equal(stateWrites[0].ref, REF);
  // 兜底分支的成功探测也要推进周期锚点，否则下一轮（10 分钟后）会立刻再探。
  assert.equal(stateWrites[0].value.lastActivatedAt, now);
  assert.equal(stateWrites[0].value.lastDecisionReason, 'periodic_fallback');
});

test('runNow：账本说窗口运行中 → 一次都不探（快照缺失也不探）', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const closeAtMs = now + 2 * 60 * MINUTE;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account({ usageSnapshot: null })],
    configs: { [REF]: { enabled: true } },
    states: {
      [REF]: unknownLedger({
        windowAnchorAtMs: closeAtMs - 300 * MINUTE,
        windowMinutes: 300,
        windowCloseAtMs: closeAtMs,
        windowSource: 'probe',
        windowObservedAtMs: closeAtMs - 300 * MINUTE,
        lastProbeAt: closeAtMs - 300 * MINUTE,
        lastActivatedAt: closeAtMs - 300 * MINUTE
      })
    }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(dispatches.length, 0);
  assert.equal(result.probed.length, 0);
  assert.equal(result.decisions[0].trigger, 'window_open');
  assert.equal(result.decisions[0].window.kind, 'open');
});

test('runNow：账本说关窗 → 探测续窗并把账本锚定到探测时刻', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const closeAtMs = now - 60 * MINUTE;
  const { scheduler, dispatches, stateWrites } = makeScheduler({
    now,
    accounts: [account({ usageSnapshot: null })],
    configs: { [REF]: { enabled: true } },
    states: {
      [REF]: unknownLedger({
        windowAnchorAtMs: closeAtMs - 300 * MINUTE,
        windowMinutes: 300,
        windowCloseAtMs: closeAtMs,
        windowSource: 'probe',
        windowObservedAtMs: closeAtMs - 300 * MINUTE,
        lastProbeAt: closeAtMs - 300 * MINUTE,
        lastActivatedAt: closeAtMs - 300 * MINUTE
      })
    }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed.length, 1);
  assert.equal(result.probed[0].trigger, 'window_closed');
  assert.equal(dispatches.length, 1);
  const written = stateWrites[stateWrites.length - 1].value;
  assert.equal(written.windowAnchorAtMs, now);
  assert.equal(written.windowCloseAtMs, now + 300 * MINUTE);
  assert.equal(written.windowSource, 'probe');
  assert.equal(written.lastActivatedAt, now);
  assert.equal(written.probeFailureCount, 0);
  assert.equal(written.lastDecisionReason, 'window_closed');
});

test('runNow：幻影快照（没有活跃窗口）立刻补窗，不等兜底间隔', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const capturedAt = now - 5 * MINUTE;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account({ usageSnapshot: windowSnapshot(capturedAt + 300 * MINUTE, capturedAt) })],
    configs: { [REF]: { enabled: true } },
    // 上次成功探测已是 6 小时前：这张快照比它更新，说明窗口确实关着
    states: { [REF]: unknownLedger({ lastProbeAt: now - 6 * 60 * MINUTE, lastActivatedAt: now - 6 * 60 * MINUTE }) }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.decisions[0].window.kind, 'absent');
  assert.equal(result.probed.length, 1);
  assert.equal(result.probed[0].trigger, 'window_absent');
  assert.equal(dispatches.length, 1);
});

test('runNow：关窗后有用户自己的流量 → 只重锚账本，不探测', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const closeAtMs = now - 60 * MINUTE;
  const userTrafficAt = closeAtMs + 5 * MINUTE;
  const { scheduler, dispatches, stateWrites } = makeScheduler({
    now,
    accounts: [account({ usageSnapshot: null })],
    configs: { [REF]: { enabled: true } },
    states: {
      [REF]: unknownLedger({
        windowAnchorAtMs: closeAtMs - 300 * MINUTE,
        windowMinutes: 300,
        windowCloseAtMs: closeAtMs,
        windowSource: 'probe',
        windowObservedAtMs: closeAtMs - 300 * MINUTE,
        lastProbeAt: closeAtMs - 300 * MINUTE,
        lastActivatedAt: closeAtMs - 300 * MINUTE
      })
    },
    activity: { [`codex:${REF}`]: { lastActivityAt: userTrafficAt } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(dispatches.length, 0);
  assert.equal(result.decisions[0].trigger, 'user_reopened');
  const written = stateWrites[stateWrites.length - 1].value;
  assert.equal(written.windowSource, 'activity');
  assert.equal(written.windowAnchorAtMs, userTrafficAt);
  assert.equal(written.windowCloseAtMs, userTrafficAt + 300 * MINUTE);
});

test('runNow：运行态被阻塞的账号跳过且原因可见（不再静默）', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account({ runtimeStatus: 'quota_exhausted', runtimeReason: 'usage_snapshot_remaining_pct_zero' })],
    configs: { [REF]: { enabled: true } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(dispatches.length, 0);
  assert.equal(result.decisions[0].action, 'skip');
  assert.equal(result.decisions[0].trigger, 'runtime_blocked');
  // 阻塞账号的恢复不靠探测：额度类阻塞由 account-quota-probe-scheduler 的 1 分钟用量刷新
  // 读回新快照后自动解除（探测本身会被网关排除、只会白花别的账号的额度）；
  // 鉴权/权限类阻塞本质不可由探测修复 → 一直跳过但账号页可见原因。
  const blocked = await scheduler.runNow('manual');
  assert.equal(blocked.decisions[0].trigger, 'runtime_blocked');
});

test('runNow：跳过原因变化时打一行日志，稳态不刷屏', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const closeAtMs = now + 2 * 60 * MINUTE;
  const openLedger = unknownLedger({
    windowAnchorAtMs: closeAtMs - 300 * MINUTE,
    windowMinutes: 300,
    windowCloseAtMs: closeAtMs,
    windowSource: 'probe',
    windowObservedAtMs: closeAtMs - 300 * MINUTE
  });
  // 原因没变（上一轮也是 window_open）→ 不打日志
  const quietLogs = [];
  const quiet = makeScheduler({
    now,
    accounts: [account({ usageSnapshot: null })],
    configs: { [REF]: { enabled: true } },
    states: { [REF]: { ...openLedger, lastDecisionAction: 'skip', lastDecisionReason: 'window_open' } },
    logInfo: (line) => quietLogs.push(line)
  });
  await quiet.scheduler.runNow('manual');
  assert.deepEqual(quietLogs, []);

  // 原因变了（上一轮是 periodic_fallback）→ 打一行，含关窗时刻便于事后取证
  const logs = [];
  const changed = makeScheduler({
    now,
    accounts: [account({ usageSnapshot: null })],
    configs: { [REF]: { enabled: true } },
    states: { [REF]: { ...openLedger, lastDecisionAction: 'probe', lastDecisionReason: 'periodic_fallback' } },
    logInfo: (line) => logs.push(line)
  });
  await changed.scheduler.runNow('manual');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /skip window_open/);
  assert.match(logs[0], /close \d{2}:\d{2}:\d{2}/);
});

test('runNow：探测未命中目标账号（池回落）不算激活', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    dispatchProbe: async () => ({ ok: true, matched: false, servedAccountRef: 'acct_other' })
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed[0].outcome, 'account_not_matched');
  assert.equal(result.probed[0].matched, false);
});

test('runNow：打到了账号但上游报错 → matched_upstream_error，不算激活', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const closeAtMs = now - 60 * MINUTE;
  const { scheduler, stateWrites } = makeScheduler({
    now,
    accounts: [account({ usageSnapshot: null })],
    configs: { [REF]: { enabled: true } },
    states: {
      [REF]: unknownLedger({
        windowMinutes: 300,
        windowCloseAtMs: closeAtMs,
        windowSource: 'probe',
        windowObservedAtMs: closeAtMs - 300 * MINUTE,
        lastProbeAt: closeAtMs - 300 * MINUTE
      })
    },
    dispatchProbe: async (input) => ({ ok: false, matched: true, servedAccountRef: input.accountRef, error: 'http_500' })
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed[0].outcome, 'matched_upstream_error');
  const written = stateWrites[stateWrites.length - 1].value;
  // 不算激活：不推进激活锚点、账本不重锚、转为失败退避
  assert.equal(written.lastActivatedAt, 0);
  assert.equal(written.windowCloseAtMs, closeAtMs);
  assert.equal(written.probeFailureCount, 1);
});

test('runNow：探测抛异常时整轮仍 ok 且不向上抛', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    dispatchProbe: async () => { throw new Error('boom'); }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.ok, true);
  assert.equal(result.probed[0].outcome, 'boom');
});

test('runNow：探测模型来自目标账号目录（首选不在目录里就回退，避免路由层 503）', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    listAccountModels: () => ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-sol'],
    dispatchProbe: async (input) => {
      dispatches.push(input);
      return { ok: true, matched: true, servedAccountRef: input.accountRef };
    }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed[0].outcome, 'activated');
  assert.equal(dispatches[0].model, 'gpt-5.6-sol');
  assert.equal(result.probed[0].model, 'gpt-5.6-sol');
});

test('runNow：账号目录里没有可用模型时不发探测（outcome=no_probe_model）', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches, stateWrites } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    listAccountModels: () => ['o3-mini'],
    dispatchProbe: async (input) => {
      dispatches.push(input);
      return { ok: true, matched: true, servedAccountRef: input.accountRef };
    }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(dispatches.length, 0);
  assert.equal(result.probed[0].outcome, 'no_probe_model');
  // 原因必须落盘（账号页据此解释「为什么没探测」）
  assert.equal(stateWrites[0].value.lastOutcome, 'no_probe_model');
});

test('runNow：未注入 listAccountModels 时按目录未知处理，仍用 spec 默认模型', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    dispatchProbe: async (input) => {
      dispatches.push(input);
      return { ok: true, matched: true, servedAccountRef: input.accountRef };
    }
  });
  await scheduler.runNow('manual');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].model, CODEX_SPEC.model);
});

test('runNow：探测失败不推进激活锚点，退避之后仍会重试', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches, stateWrites } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    dispatchProbe: async (input) => {
      dispatches.push(input);
      return { ok: false, matched: false, httpStatus: 503, error: 'http_503' };
    }
  });
  const first = await scheduler.runNow('manual');
  assert.equal(first.probed[0].outcome, 'http_503');
  // 失败只记录尝试时间与原因，不推进「上次成功激活」
  assert.equal(stateWrites[0].value.lastProbeAt, now);
  assert.equal(stateWrites[0].value.lastActivatedAt, 0);
  assert.equal(stateWrites[0].value.probeFailureCount, 1);

  // 退避窗口（10 分钟）之后的下一轮应当再次尝试
  const next = makeScheduler({
    now: now + PROBE_RETRY_BACKOFF_MS + 1000,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    states: { [REF]: { lastProbeAt: now, lastActivatedAt: 0, lastOutcome: 'http_503', probeFailureCount: 1 } },
    dispatchProbe: async (input) => {
      dispatches.push(input);
      return { ok: true, matched: true, servedAccountRef: input.accountRef };
    }
  });
  const second = await next.scheduler.runNow('manual');
  assert.equal(second.probed[0].outcome, 'activated');
});

test('runNow：未开启的账号不探测', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: false } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed.length, 0);
  assert.equal(dispatches.length, 0);
});

test('runNow：无 spec 的 provider 不探测', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account({ provider: 'claude', usageSnapshot: { entries: [{ windowMinutes: 300 }] } })],
    configs: { [REF]: { enabled: true } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed.length, 0);
  assert.equal(dispatches.length, 0);
});

test('runNow：per-account 间隔覆盖全局默认（兜底节奏）', async () => {
  const intervalMs = 2 * 60 * 60 * 1000;
  const now = 3 * 60 * 60 * 1000; // 3h 后：全局 1h 已到，账号自定义 2h 也已到
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true, intervalMs } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed.length, 1);
  assert.equal(dispatches.length, 1);
});

test('runNow：兜底分支的活跃闸门——区间内已有真实流量则跳过', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    activity: { [`codex:${REF}`]: { lastActivityAt: now - MINUTE } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed.length, 0);
  assert.equal(dispatches.length, 0);
  assert.equal(result.decisions[0].trigger, 'activity_gate');
});

test('runNow：每轮最多探测 batchSize 个账号', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const accounts = Array.from({ length: 5 }, (_v, i) => account({
    accountRef: `acct_test000000000000000${i + 1}`
  }));
  const configs = {};
  for (const acc of accounts) configs[acc.accountRef] = { enabled: true };
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts,
    configs,
    config: { enabled: true, batchSize: 2 }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed.length, 2);
  assert.equal(dispatches.length, 2);
});

test('runNow：走真实派发时只发 /v1/responses 且带 x-account-ref，不碰 chat', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'x-aih-server-account-ref' ? REF : '') },
      body: null,
      text: async () => ''
    };
  };
  const { scheduler } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    fetchImpl,
    realDispatch: true
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed[0].outcome, 'activated');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/v1/responses'), calls[0].url);
  assert.ok(!calls[0].url.includes('/v0/webui/chat'), calls[0].url);
  assert.equal(calls[0].init.headers['x-account-ref'], REF);
  assert.equal(calls[0].init.headers['x-provider'], 'codex');
});

test('start/stop：排程 initial+interval 且都 unref，stop 全部清理', () => {
  const timers = fakeTimers();
  const s = createWindowActivationScheduler({
    ...timers,
    fs: {},
    aiHomeDir: '/tmp/aih',
    listAccounts: () => [],
    config: { enabled: true, startDelayMs: 25, tickIntervalMs: 120_000 },
    logInfo: () => {},
    logWarn: () => {}
  });
  s.start();
  assert.equal(timers.timeouts.length, 1);
  assert.equal(timers.timeouts[0].ms, 25);
  assert.equal(timers.timeouts[0].unrefCalled, true);
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, 120_000);
  assert.equal(timers.intervals[0].unrefCalled, true);

  s.stop();
  assert.equal(timers.cleared.length, 2);
  assert.equal(s.getState().running, false);

  // 关闭时不排任何定时器
  const t2 = fakeTimers();
  const s2 = createWindowActivationScheduler({ ...t2, fs: {}, aiHomeDir: '/tmp/aih', listAccounts: () => [], config: { enabled: false } });
  s2.start();
  assert.equal(t2.timeouts.length, 0);
  assert.equal(t2.intervals.length, 0);
});

test('常量：幻影容差比关窗余量大，退避不小于防抖间隔', () => {
  assert.equal(PHANTOM_TOLERANCE_MS, 90 * 1000);
  assert.equal(PROBE_GRACE_MS, 60 * 1000);
  assert.equal(PROBE_RETRY_BACKOFF_MS, 10 * 60 * 1000);
  assert.ok(PROBE_RETRY_BACKOFF_MS >= MIN_REPROBE_GAP_MS);
});
