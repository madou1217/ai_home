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

  const refresh = () => runSingleFlightRefresh(cacheState, async () => {
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return refreshCalls;
  });

  const first = refresh();
  const second = refresh();
  assert.equal(cacheState.refreshing, true);
  assert.equal(cacheState.queued, true);

  await first;
  await second;
  await new Promise((resolve) => setTimeout(resolve, 30));

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
