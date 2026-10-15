'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideActivation,
  findWindowEntry,
  normalizeWindowActivationConfig,
  createWindowActivationScheduler,
  MIN_REPROBE_GAP_MS,
  PROBE_AHEAD_WINDOW_MS,
  DEFAULT_INTERVAL_MS
} = require('../lib/server/window-activation-scheduler');

const CODEX_SPEC = require('../lib/server/window-activation/probe-specs').getProbeSpec('codex');
const REF = 'acct_test0000000000000001';

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

function windowSnapshot(resetAtMs = 0) {
  return { entries: [{ bucket: 'primary', windowMinutes: 300, remainingPct: 80, resetAtMs }] };
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
    readLatestResetAt: overrides.readLatestResetAt || (() => 0),
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
    logInfo: () => {},
    logWarn: () => {}
  });
  return { scheduler, dispatches, stateWrites };
}

test('decideActivation：前置过滤（关闭 / 无 spec / API-key / 防抖）', () => {
  const base = { now: 1000, enabled: true, spec: CODEX_SPEC, snapshot: windowSnapshot(0), lastProbeAt: 0, lastActivityAt: 0 };
  assert.equal(decideActivation({ ...base, enabled: false }).trigger, 'disabled');
  assert.equal(decideActivation({ ...base, spec: null }).trigger, 'no_spec');
  assert.equal(decideActivation({ ...base, apiKeyMode: true }).trigger, 'api_key_account');
  assert.equal(decideActivation({ ...base, status: 'down' }).trigger, 'account_down');
  // 运行态被阻塞（配额耗尽 / 限流）的账号不探测：探了会被网关排除并回落，白花别的账号额度
  assert.equal(decideActivation({ ...base, runtimeStatus: 'rate_limited' }).trigger, 'runtime_blocked');
  // healthy / 未上报都不算阻塞（此处未到周期，只断言没有被运行态过滤掉）
  assert.notEqual(decideActivation({ ...base, runtimeStatus: 'healthy' }).trigger, 'runtime_blocked');
  assert.notEqual(decideActivation({ ...base, runtimeStatus: 'unknown' }).trigger, 'runtime_blocked');
  assert.equal(
    decideActivation({ ...base, now: 1000 + MIN_REPROBE_GAP_MS - 1, lastProbeAt: 1000 }).trigger,
    'debounced'
  );
});

test('decideActivation：触发 3 reset_at 对齐最高优先', () => {
  const resetAtMs = 5_000_000;
  const decision = decideActivation({
    now: resetAtMs - 1000,
    enabled: true,
    spec: CODEX_SPEC,
    snapshot: windowSnapshot(resetAtMs),
    lastProbeAt: 0,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.deepEqual(decision, { action: 'probe', trigger: 'reset_aligned', resetAtMs });
});

test('decideActivation：reset 后已有真实流量则不再探测', () => {
  const resetAtMs = 5_000_000;
  const decision = decideActivation({
    now: resetAtMs + 1000,
    enabled: true,
    spec: CODEX_SPEC,
    snapshot: windowSnapshot(resetAtMs),
    lastProbeAt: 0,
    lastActivityAt: resetAtMs + 500,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.trigger, 'activity_gate');
});

test('decideActivation：同一 resetAtMs 只对齐一次（探测后 lastProbeAt 越过 reset）', () => {
  const resetAtMs = 5_000_000;
  const decision = decideActivation({
    now: resetAtMs + 1000,
    enabled: true,
    spec: CODEX_SPEC,
    snapshot: windowSnapshot(resetAtMs),
    lastProbeAt: resetAtMs + 500,
    lastActivityAt: resetAtMs + 500,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.notEqual(decision.trigger, 'reset_aligned');
});

test('decideActivation：触发 1 周期到点探测，触发 2 活跃闸门拦下', () => {
  const now = 100 * DEFAULT_INTERVAL_MS;
  const due = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    snapshot: windowSnapshot(0),
    lastProbeAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivatedAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivityAt: now - DEFAULT_INTERVAL_MS - 1,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.deepEqual(due, { action: 'probe', trigger: 'periodic' });

  const gated = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    snapshot: windowSnapshot(0),
    lastProbeAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivatedAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivityAt: now - 60_000, // 区间内有真实活动
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(gated.action, 'skip');
  assert.equal(gated.trigger, 'activity_gate');

  const notDue = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    snapshot: windowSnapshot(0),
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
  // 刚刚尝试过（防抖窗口外），但从未成功激活过：周期锚点仍是 0 → 到点探测
  const decision = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    snapshot: windowSnapshot(0),
    lastProbeAt: now - 2 * MIN_REPROBE_GAP_MS,
    lastActivatedAt: 0,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.deepEqual(decision, { action: 'probe', trigger: 'periodic' });
});

test('decideActivation：无 5h 窗口时回退纯固定周期', () => {
  const now = 100 * DEFAULT_INTERVAL_MS;
  const snapshot = { entries: [{ bucket: 'primary', windowMinutes: 10080, resetAtMs: 0 }] };
  const decision = decideActivation({
    now,
    enabled: true,
    spec: CODEX_SPEC,
    snapshot,
    lastProbeAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivatedAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  });
  assert.equal(decision.action, 'probe');
  assert.equal(decision.trigger, 'periodic');
});

test('decideActivation：窗口重置后从重置点重新计时', () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  // 距上次成功激活已超一个周期，本应探测
  const base = {
    now,
    enabled: true,
    spec: CODEX_SPEC,
    snapshot: windowSnapshot(0),
    lastProbeAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivatedAt: now - DEFAULT_INTERVAL_MS - 1,
    lastActivityAt: 0,
    effectiveIntervalMs: DEFAULT_INTERVAL_MS
  };
  assert.equal(decideActivation(base).action, 'probe');

  // 但账号 10 分钟前刚被重置：新窗口从重置点开始，下一轮应为「重置后 4h」
  const rebased = decideActivation({ ...base, lastResetAtMs: now - 10 * 60 * 1000 });
  assert.equal(rebased.action, 'skip');
  assert.equal(rebased.trigger, 'not_due');

  // 重置点早于上次探测时，锚点仍是上次探测，不受影响
  const staleReset = decideActivation({ ...base, lastResetAtMs: now - DEFAULT_INTERVAL_MS - 60_000 });
  assert.equal(staleReset.action, 'probe');
});

test('findWindowEntry：按 windowMatch 命中，容忍浮点', () => {
  assert.ok(findWindowEntry(windowSnapshot(1), CODEX_SPEC.windowMatch));
  assert.equal(findWindowEntry({ entries: [{ windowMinutes: 10080 }] }, CODEX_SPEC.windowMatch), null);
  assert.equal(findWindowEntry(null, CODEX_SPEC.windowMatch), null);
});

test('normalizeWindowActivationConfig：默认关、默认 4h、下限 1h', () => {
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

test('runNow：启用账号到点探测，命中后记录 activated 并落盘状态', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches, stateWrites } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true, intervalMs: null } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.ok, true);
  assert.equal(result.probed.length, 1);
  assert.equal(result.probed[0].outcome, 'activated');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].accountRef, REF);
  assert.equal(dispatches[0].provider, 'codex');
  assert.equal(dispatches[0].baseUrl, 'http://127.0.0.1:9527');
  assert.equal(stateWrites.length, 1);
  assert.equal(stateWrites[0].ref, REF);
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

test('runNow：探测失败不推进激活锚点，下一轮仍会重试', async () => {
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

  // 防抖窗口过后（同一个 tick 内不会，但下一轮会）应当再次尝试
  const next = makeScheduler({
    now: now + MIN_REPROBE_GAP_MS + 1000,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    states: { [REF]: { lastProbeAt: now, lastActivatedAt: 0, lastOutcome: 'http_503' } },
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

test('runNow：per-account 间隔覆盖全局默认', async () => {
  const intervalMs = 2 * 60 * 60 * 1000;
  const now = 3 * 60 * 60 * 1000; // 3h 后：全局 4h 未到，账号 2h 已到
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true, intervalMs } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed.length, 1);
  assert.equal(dispatches.length, 1);
});

test('runNow：活跃闸门——区间内已有真实流量则跳过', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    activity: { [`codex:${REF}`]: { lastActivityAt: now - 60_000 } }
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed.length, 0);
  assert.equal(dispatches.length, 0);
});

test('runNow：窗口刚重置的账号本轮不探测（从重置点重新计时）', async () => {
  const now = 10 * DEFAULT_INTERVAL_MS;
  const { scheduler, dispatches } = makeScheduler({
    now,
    accounts: [account()],
    configs: { [REF]: { enabled: true } },
    states: { [REF]: { lastProbeAt: now - DEFAULT_INTERVAL_MS - 1 } },
    readLatestResetAt: () => now - 10 * 60 * 1000
  });
  const result = await scheduler.runNow('manual');
  assert.equal(result.probed.length, 0);
  assert.equal(dispatches.length, 0);
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

test('PROBE_AHEAD_WINDOW_MS 是 5 分钟', () => {
  assert.equal(PROBE_AHEAD_WINDOW_MS, 5 * 60 * 1000);
});
