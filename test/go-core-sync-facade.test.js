'use strict';

// goCoreSync 门面的契约：暴露集合必须与 FACADE_METHODS 完全一致，宿主上多出来的
// 内部能力一律不外溢；缺方法属于装配错误，必须在装配期就红。

const test = require('node:test');
const assert = require('node:assert/strict');

const { FACADE_METHODS, createGoCoreSyncFacade } = require('../lib/server/go-core-sync-facade');

// 宿主替身：所有清单方法都存在，记录调用参数与 this（门面必须把 this 留在宿主上）。
function createFakeHost(overrides = {}) {
  const calls = [];
  const host = {};
  for (const name of FACADE_METHODS) {
    host[name] = function fakeMethod(...args) {
      calls.push({ name, args, receiver: this });
      return { method: name, args };
    };
  }
  host.calls = calls;
  return Object.assign(host, overrides);
}

test('FACADE_METHODS 覆盖现有全部转发方法且无重复', () => {
  assert.ok(FACADE_METHODS.length > 0);
  assert.equal(new Set(FACADE_METHODS).size, FACADE_METHODS.length);
  // 现有清单的完整性守卫：少一项就等于某个 WebUI 编辑不再推给 Go。
  assert.deepEqual([...FACADE_METHODS], [
    'pushModelAliases',
    'pushUpstreamErrorRules',
    'pushOAuthJob',
    'listOAuthJobs',
    'getOAuthJob',
    'isEnabled',
    'editStaticCredential',
    'setAccountEnabled',
    'setProviderDefault',
    'clearProviderDefault',
    'importAccounts',
    'exportAccounts',
    'deleteAccount',
    'reconcileAccounts'
  ]);
});

test('清单里每个方法都能在宿主上找到，并按原参数转发', () => {
  const host = createFakeHost();
  const facade = createGoCoreSyncFacade(host);
  for (const name of FACADE_METHODS) {
    assert.equal(typeof host[name], 'function');
    const result = facade[name]('first', { second: 2 }, 3);
    assert.deepEqual(result, { method: name, args: ['first', { second: 2 }, 3] });
    const lastCall = host.calls[host.calls.length - 1];
    assert.equal(lastCall.name, name);
    assert.deepEqual(lastCall.args, ['first', { second: 2 }, 3]);
    // 原手写转发是 goCoreHost[name](...)，this 必须仍是宿主。
    assert.equal(lastCall.receiver, host);
  }
});

test('返回值原样透传（含异步结果与异常）', async () => {
  const payload = { ok: true };
  const host = createFakeHost({
    pushOAuthJob: async () => payload,
    deleteAccount: () => {
      throw new Error('go_delete_failed');
    }
  });
  const facade = createGoCoreSyncFacade(host);
  assert.equal(await facade.pushOAuthJob({ jobId: 'job-1' }), payload);
  assert.throws(() => facade.deleteAccount('node-ref'), /go_delete_failed/);
});

test('缺方法在装配期抛错，并指出缺的是哪个方法', () => {
  const host = createFakeHost();
  delete host.exportAccounts;
  assert.throws(
    () => createGoCoreSyncFacade(host),
    /exportAccounts/
  );
});

test('宿主不是对象时装配期抛错', () => {
  assert.throws(() => createGoCoreSyncFacade(null), TypeError);
  assert.throws(() => createGoCoreSyncFacade(undefined), TypeError);
});

test('只暴露 FACADE_METHODS，宿主额外方法不外溢', () => {
  const host = createFakeHost({
    start: () => 'started',
    stop: () => 'stopped',
    runtimeStateInternal: () => 'internal'
  });
  const facade = createGoCoreSyncFacade(host);
  assert.deepEqual(Object.keys(facade), [...FACADE_METHODS]);
  assert.equal(facade.start, undefined);
  assert.equal(facade.stop, undefined);
  assert.equal(facade.runtimeStateInternal, undefined);
});

test('门面冻结，运行期不能再挂方法', () => {
  const facade = createGoCoreSyncFacade(createFakeHost());
  assert.throws(() => {
    facade.pushPluginProjection = () => null;
  }, TypeError);
});
