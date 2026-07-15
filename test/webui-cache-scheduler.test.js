const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runSingleFlightRefresh,
  scheduleDirtyRefresh,
  ensurePeriodicRefresh
} = require('../lib/server/webui-cache-scheduler');

test('runSingleFlightRefresh coalesces concurrent refresh calls and replays one queued run', async () => {
  const cacheState = {
    refreshing: false,
    queued: false,
    dirty: false
  };
  let refreshCalls = 0;
  let releaseFirst;
  let releaseSecond;
  let markSecondStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });

  const refresh = () => runSingleFlightRefresh(cacheState, async () => {
    refreshCalls += 1;
    if (refreshCalls === 1) {
      await firstGate;
    } else {
      markSecondStarted();
      await secondGate;
    }
    return refreshCalls;
  });

  const first = refresh();
  const second = refresh();
  assert.equal(cacheState.refreshing, true);
  assert.equal(cacheState.queued, true);

  releaseFirst();
  await first;
  await second;
  assert.ok(cacheState.pendingRefreshTimer);
  cacheState.pendingRefreshTimer.ref?.();
  await secondStarted;
  assert.equal(cacheState.refreshing, true);

  releaseSecond();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(refreshCalls, 2);
  assert.equal(cacheState.refreshing, false);
  assert.equal(cacheState.queued, false);
});

test('scheduleDirtyRefresh keeps dirty flag and supports immediate refresh', async () => {
  const cacheState = {
    refreshing: false,
    queued: false,
    dirty: false
  };
  let refreshCalls = 0;

  scheduleDirtyRefresh(cacheState, async () => {
    refreshCalls += 1;
  }, { immediate: true });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(refreshCalls, 1);
  assert.equal(cacheState.dirty, true);
});

test('scheduleDirtyRefresh respects delayMs before starting refresh', async () => {
  const cacheState = {
    refreshing: false,
    queued: false,
    dirty: false
  };
  let refreshCalls = 0;

  scheduleDirtyRefresh(cacheState, async () => {
    refreshCalls += 1;
  }, { delayMs: 30 });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(refreshCalls, 0);

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(refreshCalls, 1);
  assert.equal(cacheState.dirty, true);
});

test('ensurePeriodicRefresh only installs one timer', async () => {
  const cacheState = {
    refreshTimer: null
  };
  let refreshCalls = 0;

  ensurePeriodicRefresh(cacheState, {
    shouldRefresh: () => false,
    refresh: async () => {
      refreshCalls += 1;
    },
    intervalMs: 100,
    warmupMs: 5
  });
  const firstTimer = cacheState.refreshTimer;
  ensurePeriodicRefresh(cacheState, {
    shouldRefresh: () => false,
    refresh: async () => {
      refreshCalls += 1;
    },
    intervalMs: 100,
    warmupMs: 5
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cacheState.refreshTimer, firstTimer);
  assert.equal(refreshCalls, 1);

  clearInterval(cacheState.refreshTimer);
});
