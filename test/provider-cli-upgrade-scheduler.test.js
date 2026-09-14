'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProviderCliUpgradeConfig,
  createProviderCliUpgradeScheduler
} = require('../lib/server/provider-cli-upgrade-scheduler');

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

// 账本靠内存假件：调度器只负责「读一次 → 串行喂给每个 provider → 每个跑完就落盘」。
function ledgerStore(initial = { schemaVersion: 1, global: { enabled: true }, providers: {} }) {
  const store = { value: initial, writes: [] };
  return {
    store,
    readLedger: () => store.value,
    writeLedger: (_dir, ledger) => { store.value = ledger; store.writes.push(ledger); return true; }
  };
}

test('默认配置：检查开、应用关、6 小时一轮', () => {
  assert.deepEqual(normalizeProviderCliUpgradeConfig({}), {
    enabled: true,
    applyEnabled: false,
    startDelayMs: 5 * 60 * 1000,
    intervalMs: 6 * 60 * 60 * 1000
  });

  // 间隔低于 30 分钟一律回落默认值：一轮要 spawn 真二进制，不给调成秒级。
  assert.equal(normalizeProviderCliUpgradeConfig({ intervalMs: 1000 }).intervalMs, 6 * 60 * 60 * 1000);
  assert.equal(normalizeProviderCliUpgradeConfig({ applyEnabled: true }).applyEnabled, true);
});

test('启动延迟与周期都按注入的定时器排程,且都 unref', () => {
  const timers = fakeTimers();
  const scheduler = createProviderCliUpgradeScheduler({
    ...timers,
    ...ledgerStore(),
    deps: {},
    providers: ['codex'],
    config: { startDelayMs: 25, intervalMs: 45 * 60 * 1000 },
    runCycle: async () => ({ ledger: {}, state: 'healthy', reason: 'up_to_date' })
  });

  scheduler.start();
  assert.equal(timers.timeouts.length, 1);
  assert.equal(timers.timeouts[0].ms, 25);
  assert.equal(timers.timeouts[0].unrefCalled, true);
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, 45 * 60 * 1000);
  assert.equal(timers.intervals[0].unrefCalled, true);

  scheduler.stop();
  assert.equal(timers.cleared.length, 2);
  assert.equal(scheduler.getState().running, false);
});

test('关掉时不排任何定时器', () => {
  const timers = fakeTimers();
  const scheduler = createProviderCliUpgradeScheduler({
    ...timers,
    ...ledgerStore(),
    deps: {},
    providers: ['codex'],
    config: { enabled: false }
  });

  scheduler.start();
  assert.equal(timers.timeouts.length, 0);
  assert.equal(timers.intervals.length, 0);
  assert.equal(scheduler.getState().enabled, false);
});

test('provider 串行跑,且每跑完一个就落盘', async () => {
  const ledger = ledgerStore();
  const order = [];
  const scheduler = createProviderCliUpgradeScheduler({
    ...fakeTimers(),
    ...ledger,
    deps: {},
    providers: ['codex', 'gemini', 'claude'],
    runCycle: async (provider, current) => {
      order.push(`start:${provider}`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`end:${provider}`);
      return {
        ledger: { ...current, providers: { ...current.providers, [provider]: { state: 'healthy' } } },
        state: 'healthy',
        reason: 'up_to_date'
      };
    }
  });

  const result = await scheduler.runNow('test');
  assert.equal(result.ok, true);
  // 串行：绝不出现 start:a start:b 交错——安装器会抢同一个 BIN_DIR。
  assert.deepEqual(order, [
    'start:codex', 'end:codex',
    'start:gemini', 'end:gemini',
    'start:claude', 'end:claude'
  ]);
  // 每个 provider 一次落盘，而不是全跑完才写一次。
  assert.equal(ledger.store.writes.length, 3);
  assert.deepEqual(Object.keys(ledger.store.value.providers), ['codex', 'gemini', 'claude']);
});

// runner 承诺不抛，但它的依赖是真实世界（spawn / 网络 / 文件）。
test('单个 provider 抛错不影响这一轮剩下的 provider', async () => {
  const ledger = ledgerStore();
  const done = [];
  const warns = [];
  const scheduler = createProviderCliUpgradeScheduler({
    ...fakeTimers(),
    ...ledger,
    deps: {},
    providers: ['codex', 'gemini', 'claude'],
    logWarn: (msg) => warns.push(msg),
    runCycle: async (provider, current) => {
      if (provider === 'gemini') throw new Error('spawn ENOENT');
      done.push(provider);
      return { ledger: current, state: 'healthy', reason: 'up_to_date' };
    }
  });

  const result = await scheduler.runNow('test');
  assert.equal(result.ok, true);
  assert.deepEqual(done, ['codex', 'claude']);
  assert.equal(result.providers.gemini.state, 'error');
  assert.match(result.providers.gemini.reason, /ENOENT/);
  assert.equal(warns.length, 1);
  // 出错的 provider 同样要落盘，后面的 provider 才不会丢状态。
  assert.equal(ledger.store.writes.length, 3);
});

test('上一轮还没跑完时不重叠', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let cycles = 0;
  const scheduler = createProviderCliUpgradeScheduler({
    ...fakeTimers(),
    ...ledgerStore(),
    deps: {},
    providers: ['codex'],
    runCycle: async (_provider, current) => {
      cycles += 1;
      await gate;
      return { ledger: current, state: 'healthy', reason: 'up_to_date' };
    }
  });

  const first = scheduler.runNow('interval');
  const second = await scheduler.runNow('interval');
  assert.deepEqual(second, { ok: false, skipped: true, reason: 'already_running' });

  release();
  await first;
  assert.equal(cycles, 1);
  assert.equal(scheduler.getState().cycling, false);
});

test('没有依赖或没有候选 provider 时安静跳过', async () => {
  const noDeps = createProviderCliUpgradeScheduler({ ...fakeTimers(), ...ledgerStore(), providers: ['codex'] });
  assert.deepEqual(await noDeps.runNow(), { ok: false, skipped: true, reason: 'deps_unavailable' });

  const disabled = createProviderCliUpgradeScheduler({
    ...fakeTimers(), ...ledgerStore(), deps: {}, providers: ['codex'], config: { enabled: false }
  });
  assert.deepEqual(await disabled.runNow(), { ok: false, skipped: true, reason: 'disabled' });
});

// 阶段一的语义：applyEnabled 必须原样传给 runner，否则「只检查不改动」形同虚设。
test('applyEnabled 透传给 runner', async () => {
  const seen = [];
  const make = (applyEnabled) => createProviderCliUpgradeScheduler({
    ...fakeTimers(),
    ...ledgerStore(),
    deps: {},
    providers: ['codex'],
    config: { applyEnabled },
    runCycle: async (_p, current, _deps, config) => {
      seen.push(config.applyEnabled);
      return { ledger: current, state: 'healthy', reason: 'apply_disabled' };
    }
  });

  await make(false).runNow();
  await make(true).runNow();
  assert.deepEqual(seen, [false, true]);
});

// 故障是有时效的：一轮整体跑干净之后，getState() 不该还挂着上一轮的旧错误。
test('整轮跑干净后清掉上一轮的错误', async () => {
  let shouldThrow = true;
  const scheduler = createProviderCliUpgradeScheduler({
    ...fakeTimers(),
    ...ledgerStore(),
    deps: {},
    providers: ['codex'],
    runCycle: async (_p, current) => {
      if (shouldThrow) throw new Error('boom');
      return { ledger: current, state: 'healthy', reason: 'up_to_date' };
    }
  });

  await scheduler.runNow();
  assert.match(scheduler.getState().lastError, /boom/);

  shouldThrow = false;
  await scheduler.runNow();
  assert.equal(scheduler.getState().lastError, '');
});
