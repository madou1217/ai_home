'use strict';

// 守卫：旧逐账号调度器退役后，go-batch / legacy 两条路径都不允许再创建
// setInterval/setTimeout 轮询；显式刷新只走 Go（或退化为标记 stale）。
//
// 这里同时锁住三件事：
//   1. legacy 的 ensure 不排任何 timer，也不请求 Go；
//   2. go-batch 的 ensure 只排 6 小时批量同步的启动延迟（不是逐账号轮询）；
//   3. trigger 只发一次 Go 刷新 / 一次批量读，绝不顺手排下一轮。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureWebUiModelRefreshScheduler,
  triggerWebUiModelRefreshSoon
} = require('../lib/server/webui-model-refresh-scheduler');
const { initWebUiModelsCache } = require('../lib/server/webui-model-cache');
const { createGoCoreHost } = require('../lib/server/go-core-host');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function makeState(accountRefs = [ACCOUNT_REF]) {
  return {
    accounts: {
      opencode: accountRefs.map((accountRef) => ({ accountRef }))
    },
    webUiModelsCache: {
      ...initWebUiModelsCache(),
      updatedAt: 50000,
      byAccount: Object.fromEntries(accountRefs.map((ref) => [ref, ['m/keep']])),
      accountUpdatedAt: Object.fromEntries(accountRefs.map((ref) => [ref, 40000]))
    }
  };
}

// 直接包 global.setTimeout/setInterval：node:test 没有公开「当前已排的 timer 列表」，
// 而这里只需要回答「有没有人偷偷排了轮询」。
function spyTimers(t) {
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const calls = [];
  global.setTimeout = function patchedSetTimeout(fn, ms, ...args) {
    calls.push({ kind: 'timeout', ms: Number(ms) || 0 });
    return originalSetTimeout(fn, ms, ...args);
  };
  global.setInterval = function patchedSetInterval(fn, ms, ...args) {
    calls.push({ kind: 'interval', ms: Number(ms) || 0 });
    return originalSetInterval(fn, ms, ...args);
  };
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
  });
  return calls;
}

function clearStateTimers(state) {
  if (state && state.webUiModelCacheGoSync && state.webUiModelCacheGoSync.timer) {
    clearTimeout(state.webUiModelCacheGoSync.timer);
    state.webUiModelCacheGoSync.timer = null;
  }
}

test('legacy: ensure 不创建任何定时器，也不碰 Go', (t) => {
  const state = makeState();
  const calls = spyTimers(t);
  const ctx = {
    state,
    options: {},
    deps: { readServerConfig: () => ({ modelCacheSync: 'scheduler' }) }
  };

  ensureWebUiModelRefreshScheduler(ctx);

  assert.deepEqual(calls, [], 'legacy 不得排 setTimeout/setInterval');
  assert.equal(state.webUiModelRefreshScheduler, undefined, '旧调度器状态不再创建');
  assert.equal(state.webUiModelCacheGoSync, undefined, 'legacy 不初始化批量同步状态');
});

test('go-batch: ensure 只排批量同步的启动延迟，不排轮询', (t) => {
  const state = makeState();
  const calls = spyTimers(t);
  const ctx = {
    state,
    options: {},
    deps: {
      readServerConfig: () => ({ modelCacheSync: 'go-batch' }),
      readAccountModels: async () => null
    }
  };

  ensureWebUiModelRefreshScheduler(ctx);

  assert.equal(calls.filter((call) => call.kind === 'interval').length, 0, '不得创建 setInterval');
  assert.equal(calls.length, 1, '只允许一个启动后的批量同步 timer');
  assert.ok(calls[0].ms < 5000, '启动延迟不应是 45s–60min 的旧调度轮询间隔');
  assert.ok(state.webUiModelCacheGoSync.timer, '批量同步状态应已初始化');
  clearStateTimers(state);
});

test('trigger 带 ref：只调用 Go 的账号模型刷新，不排定时器', async (t) => {
  const state = makeState();
  const calls = spyTimers(t);
  const refreshed = [];
  const ctx = {
    state,
    deps: {
      refreshAccountModels: async (ref) => {
        refreshed.push(ref);
        return { ok: true, status: 200 };
      }
    }
  };

  const result = await triggerWebUiModelRefreshSoon(ctx, ACCOUNT_REF);

  assert.deepEqual(refreshed, [ACCOUNT_REF]);
  assert.equal(result.mode, 'go');
  assert.deepEqual(result.stale, []);
  assert.deepEqual(calls, [], 'trigger 不得创建任何定时器');
  assert.equal(state.webUiModelsCache.accountUpdatedAt[ACCOUNT_REF], 40000, '成功刷新不需要标 stale');
});

test('trigger 的 Go 不可用：保留目录，只清探测时刻（stale）', async (t) => {
  const state = makeState();
  const calls = spyTimers(t);
  const ctx = {
    state,
    deps: { refreshAccountModels: async () => null }
  };

  const result = await triggerWebUiModelRefreshSoon(ctx, ACCOUNT_REF);

  assert.equal(result.mode, 'stale');
  assert.deepEqual(result.stale, [ACCOUNT_REF]);
  assert.equal(state.webUiModelsCache.accountUpdatedAt[ACCOUNT_REF], undefined, '应标记为待探测');
  assert.deepEqual(state.webUiModelsCache.byAccount[ACCOUNT_REF], ['m/keep'], '目录必须保留');
  assert.deepEqual(calls, [], '退化路径也不得创建定时器');
});

test('trigger 缺少 host 封装：退化为 stale', async () => {
  const state = makeState();
  const ctx = { state, deps: {} };

  const result = await triggerWebUiModelRefreshSoon(ctx, ACCOUNT_REF);

  assert.equal(result.mode, 'stale');
  assert.equal(state.webUiModelsCache.accountUpdatedAt[ACCOUNT_REF], undefined);
  assert.deepEqual(state.webUiModelsCache.byAccount[ACCOUNT_REF], ['m/keep']);
});

test('全局 trigger 在 legacy 下把运行池账号标成 stale，不读 Go', async (t) => {
  const state = makeState(['acct_aaaaaaaaaaaaaaaaaaaa', 'acct_bbbbbbbbbbbbbbbbbbbb']);
  const calls = spyTimers(t);
  let goCalls = 0;
  const ctx = {
    state,
    deps: {
      readServerConfig: () => ({ modelCacheSync: 'scheduler' }),
      readAccountModels: async () => { goCalls += 1; return null; }
    }
  };

  const result = await triggerWebUiModelRefreshSoon(ctx);

  assert.equal(goCalls, 0, 'legacy 全局刷新不读 Go');
  assert.equal(result.mode, 'stale');
  assert.deepEqual(result.stale.sort(), ['acct_aaaaaaaaaaaaaaaaaaaa', 'acct_bbbbbbbbbbbbbbbbbbbb']);
  assert.deepEqual(state.webUiModelsCache.accountUpdatedAt, {}, '所有运行池账号都应待探测');
  assert.deepEqual(state.webUiModelsCache.byAccount.acct_aaaaaaaaaaaaaaaaaaaa, ['m/keep']);
  assert.deepEqual(calls, [], '全局 trigger 不得创建定时器');
});

test('全局 trigger 在 go-batch 下只批量读一次 Go，不排下一轮', async (t) => {
  const state = makeState(['acct_0123456789abcdef0123']);
  const calls = spyTimers(t);
  let reads = 0;
  const ctx = {
    state,
    deps: {
      readServerConfig: () => ({ modelCacheSync: 'go-batch' }),
      readAccountModels: async () => {
        reads += 1;
        return {
          ok: true,
          status: 200,
          data: [{
            account_ref: 'go0123456789abcdef0123',
            provider_id: 'opencode',
            last_attempt_at_ms: 60000,
            models: [{ model_id: 'm/fresh', effective: true }]
          }]
        };
      },
      nodeAccountRefFor: (goRef) => (goRef === 'go0123456789abcdef0123' ? ACCOUNT_REF : '')
    }
  };

  const result = await triggerWebUiModelRefreshSoon(ctx);

  assert.equal(reads, 1, '只允许一次批量读');
  assert.equal(result.mode, 'go-batch');
  assert.deepEqual(state.webUiModelsCache.byAccount[ACCOUNT_REF], ['m/fresh']);
  assert.deepEqual(calls.map((call) => call.kind), [], '一次性读不得排后续 timer');
});

test('host 封装：refreshAccountModels 发 POST /v1/management/accounts/{ref}/models/refresh', async () => {
  const requests = [];
  const host = createGoCoreHost({
    settings: { enabled: false, accountSync: false, routes: [] },
    manifest: { entries: [] },
    log: { log() {}, error() {} },
    createGoCoreSupervisor: () => ({
      status: () => ({ state: 'ready', endpoint: 'http://go.local:19550' }),
      start: async () => ({ state: 'ready', endpoint: 'http://go.local:19550' }),
      stop: async () => {}
    }),
    createGoCoreGatewayForwarder: () => ({
      tryHandleHttp: () => false,
      tryHandleUpgrade: () => false
    }),
    createGoManagementClient: () => ({
      send: async (request) => {
        requests.push(request);
        return { ok: true, status: 200, data: [] };
      }
    })
  });

  const result = await host.refreshAccountModels(ACCOUNT_REF);

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/v1/management/accounts/' + ACCOUNT_REF + '/models/refresh');
});

test('host 封装：Go 未就绪时返回 null（调用方据此退化）', async () => {
  const host = createGoCoreHost({
    settings: { enabled: false, accountSync: false, routes: [] },
    manifest: { entries: [] },
    log: { log() {}, error() {} },
    createGoCoreSupervisor: () => ({
      status: () => ({ state: 'stopped', endpoint: '' }),
      start: async () => ({ state: 'stopped', endpoint: '' }),
      stop: async () => {}
    }),
    createGoCoreGatewayForwarder: () => ({
      tryHandleHttp: () => false,
      tryHandleUpgrade: () => false
    })
  });

  assert.equal(await host.refreshAccountModels(ACCOUNT_REF), null);
});

test('旧探测索引已随调度器删除', () => {
  assert.throws(
    () => require.resolve('../lib/server/model-probe-index.js'),
    /Cannot find module|MODULE_NOT_FOUND/
  );
});
