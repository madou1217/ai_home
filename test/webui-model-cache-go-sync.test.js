'use strict';

// WebUI 模型缓存「批量读 Go」路径：
//   * 一次 account-models 读整池，写回既有快照形状（byAccount/errorsByAccount/accountUpdatedAt/byProvider）；
//   * 别名读取前 30 秒节流；
//   * Go 失败保留旧缓存；
//   * 开关为 scheduler（默认）时旧调度器行为不变。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  initWebUiModelsCache,
  refreshWebUiModelsCacheFromGo
} = require('../lib/server/webui-model-cache');
const {
  ensureWebUiModelCacheGoSync,
  resolveWebUiModelCacheSyncMode,
  runWebUiModelCacheGoSync,
  syncWebUiModelsCacheFromGoIfStale
} = require('../lib/server/webui-model-cache-go-sync');
const { ensureWebUiModelRefreshScheduler } = require('../lib/server/webui-model-refresh-scheduler');

function accountRows() {
  return [
    {
      account_ref: 'goaaaaaaaaaaaaaaaaaaaaaa',
      provider_id: 'opencode',
      last_attempt_at_ms: 1111,
      last_source: 'remote',
      models: [
        { model_id: 'm/zeta', effective: true },
        { model_id: 'm/alpha', effective: true }
      ]
    },
    {
      account_ref: 'gobbbbbbbbbbbbbbbbbbbbbb',
      provider_id: 'opencode',
      last_attempt_at_ms: 2222,
      last_source: 'empty',
      models: []
    },
    {
      account_ref: 'gocccccccccccccccccccccc',
      provider_id: 'opencode',
      last_attempt_at_ms: 3333,
      last_error_message: 'catalog_failed',
      last_source: 'error',
      models: []
    },
    // Go 里残留、但 Node 运行池已经删掉的账号：不能拿 Go ref 当页面 key。
    {
      account_ref: 'gooooooooooooooooooooooo',
      provider_id: 'opencode',
      last_attempt_at_ms: 4444,
      models: [{ model_id: 'orphan/model', effective: true }]
    }
  ];
}

function goResponse(rows = accountRows()) {
  return {
    ok: true,
    status: 200,
    data: rows,
    body: { data: rows, generation: 7, updated_at_ms: 5000 }
  };
}

function makeState() {
  return {
    accounts: {
      opencode: [
        { accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa' },
        { accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb' },
        { accountRef: 'acct_cccccccccccccccccccc' }
      ]
    },
    webUiModelsCache: initWebUiModelsCache()
  };
}

const NODE_REF_BY_GO_REF = {
  goaaaaaaaaaaaaaaaaaaaaaa: 'acct_aaaaaaaaaaaaaaaaaaaa',
  gobbbbbbbbbbbbbbbbbbbbbb: 'acct_bbbbbbbbbbbbbbbbbbbb',
  gocccccccccccccccccccccc: 'acct_cccccccccccccccccccc'
};

function goBatchDeps(overrides = {}) {
  return {
    readAccountModels: async () => goResponse(),
    nodeAccountRefFor: (ref) => NODE_REF_BY_GO_REF[ref] || '',
    ...overrides
  };
}

test('批量读 Go 写回 byAccount / accountUpdatedAt / byProvider 的既有形状', async () => {
  const state = makeState();
  // 失败账号必须保留旧目录（Go 的 error 行不能把已知模型抹空）。
  // updatedAt > 0 才会被 ensureWebUiModelsCacheLoaded 当作「当前快照」（否则会换成空快照）。
  state.webUiModelsCache.updatedAt = 1;
  state.webUiModelsCache.byAccount.acct_cccccccccccccccccccc = ['old/model'];

  const result = await refreshWebUiModelsCacheFromGo(state, {}, goBatchDeps());

  assert.deepEqual(state.webUiModelsCache.byAccount.acct_aaaaaaaaaaaaaaaaaaaa, ['m/alpha', 'm/zeta']);
  assert.deepEqual(state.webUiModelsCache.byAccount.acct_bbbbbbbbbbbbbbbbbbbb, []);
  assert.deepEqual(state.webUiModelsCache.byAccount.acct_cccccccccccccccccccc, ['old/model']);
  assert.equal(
    Object.prototype.hasOwnProperty.call(state.webUiModelsCache.byAccount, 'gooooooooooooooooooooooo'),
    false,
    'Go ref 翻译不到 Node ref 时必须丢弃'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(state.webUiModelsCache.byAccount, 'goaaaaaaaaaaaaaaaaaaaaaa'),
    false,
    '不能把 Go ref 直接写进页面快照'
  );
  assert.deepEqual(state.webUiModelsCache.accountUpdatedAt, {
    acct_aaaaaaaaaaaaaaaaaaaa: 1111,
    acct_bbbbbbbbbbbbbbbbbbbb: 2222,
    acct_cccccccccccccccccccc: 3333
  });
  assert.deepEqual(state.webUiModelsCache.errorsByAccount, { acct_cccccccccccccccccccc: 'catalog_failed' });
  assert.equal(state.webUiModelsCache.firstError, 'catalog_failed');
  assert.deepEqual(state.webUiModelsCache.byProvider, {
    opencode: ['m/alpha', 'm/zeta', 'old/model']
  });
  assert.deepEqual(result, { opencode: ['m/alpha', 'm/zeta', 'old/model'] });
});

test('别名/候选读取前的 30 秒节流：窗口内不重复拉 Go', async () => {
  const state = makeState();
  let clock = 100000;
  let calls = 0;
  const deps = {
    readServerConfig: () => ({ modelCacheSync: 'go-batch' }),
    now: () => clock,
    readAccountModels: async () => {
      calls += 1;
      return goResponse([{
        account_ref: 'goaaaaaaaaaaaaaaaaaaaaaa',
        provider_id: 'opencode',
        last_attempt_at_ms: clock,
        models: [{ model_id: 'm/alpha', effective: true }]
      }]);
    },
    nodeAccountRefFor: (ref) => NODE_REF_BY_GO_REF[ref] || ''
  };
  const ctx = { state, deps };

  assert.equal(resolveWebUiModelCacheSyncMode(ctx), 'go-batch');
  assert.equal(await syncWebUiModelsCacheFromGoIfStale(ctx), true);
  assert.equal(calls, 1);

  clock += 10 * 1000;
  assert.equal(await syncWebUiModelsCacheFromGoIfStale(ctx), false);
  assert.equal(calls, 1, '30 秒内必须命中内存快照');

  clock += 21 * 1000;
  assert.equal(await syncWebUiModelsCacheFromGoIfStale(ctx), true);
  assert.equal(calls, 2);
  if (state.webUiModelCacheGoSync.timer) clearTimeout(state.webUiModelCacheGoSync.timer);
});

test('Go 失败保留旧缓存且不抛错', async () => {
  const state = makeState();
  state.webUiModelsCache = {
    ...initWebUiModelsCache(),
    updatedAt: 1234,
    byAccount: { acct_aaaaaaaaaaaaaaaaaaaa: ['keep/me'] },
    byProvider: { opencode: ['keep/me'] },
    errorsByAccount: {},
    accountUpdatedAt: { acct_aaaaaaaaaaaaaaaaaaaa: 999 }
  };
  const before = state.webUiModelsCache;

  const failed = await refreshWebUiModelsCacheFromGo(state, {}, {
    readAccountModels: async () => ({ ok: false, status: 503, data: null, errorCode: 'unavailable' }),
    nodeAccountRefFor: (ref) => NODE_REF_BY_GO_REF[ref] || ''
  });
  assert.equal(failed, null);
  assert.equal(state.webUiModelsCache, before, '失败时不能替换缓存对象');
  assert.deepEqual(state.webUiModelsCache.byAccount, { acct_aaaaaaaaaaaaaaaaaaaa: ['keep/me'] });

  const viaRunner = await runWebUiModelCacheGoSync({
    state,
    deps: {
      now: () => 2000,
      readAccountModels: async () => null
    }
  });
  assert.equal(viaRunner, null);
  assert.equal(state.webUiModelsCache, before);
  assert.equal(state.webUiModelCacheGoSync.lastSyncAt, 0);
  assert.equal(state.webUiModelCacheGoSync.lastError, 'go_model_catalog_unavailable');
  if (state.webUiModelCacheGoSync.timer) clearTimeout(state.webUiModelCacheGoSync.timer);
});

test('开关为 scheduler（默认）时旧调度器行为不变，不碰 Go', () => {
  const state = makeState();
  state.webUiModelsCache.updatedAt = 50000;
  state.webUiModelsCache.accountUpdatedAt = { acct_aaaaaaaaaaaaaaaaaaaa: 50000, acct_bbbbbbbbbbbbbbbbbbbb: 50000, acct_cccccccccccccccccccc: 50000 };
  let goCalls = 0;
  const ctx = {
    state,
    options: {},
    fs: null,
    aiHomeDir: '',
    deps: {
      readServerConfig: () => ({ modelCacheSync: 'scheduler' }),
      readAccountModels: async () => { goCalls += 1; return goResponse(); },
      now: () => 50000
    }
  };

  assert.equal(resolveWebUiModelCacheSyncMode(ctx), 'scheduler');
  ensureWebUiModelRefreshScheduler(ctx);

  assert.equal(goCalls, 0, 'scheduler 模式不能读 Go');
  assert.ok(state.webUiModelRefreshScheduler, '旧调度器状态必须照旧创建');
  assert.ok(state.webUiModelRefreshScheduler.timer, '旧调度器必须照旧排下一次 tick');
  assert.equal(state.webUiModelCacheGoSync, undefined, 'scheduler 模式不能初始化 go-batch 状态');
  clearTimeout(state.webUiModelRefreshScheduler.timer);
});

test('go-batch 模式下启动入口只排批量同步，不创建旧调度器 timer', () => {
  const state = makeState();
  const ctx = {
    state,
    options: {},
    deps: {
      readServerConfig: () => ({ modelCacheSync: 'go-batch' }),
      readAccountModels: async () => goResponse(),
      now: () => 1000
    }
  };

  // 走旧调度器的公共入口，验证开关分派。
  ensureWebUiModelRefreshScheduler(ctx);
  assert.ok(state.webUiModelCacheGoSync.timer, '应排一次启动后的批量同步');
  assert.equal(state.webUiModelRefreshScheduler, undefined, 'go-batch 模式不创建旧调度器状态');
  clearTimeout(state.webUiModelCacheGoSync.timer);

  // 再次调用必须幂等（WebUI 每个请求都会走这个入口）。
  ensureWebUiModelCacheGoSync(ctx);
  assert.ok(state.webUiModelCacheGoSync.timer);
  clearTimeout(state.webUiModelCacheGoSync.timer);
});
