'use strict';

// goCoreSync 门面的契约：暴露集合必须与 FACADE_METHODS 完全一致，宿主上多出来的
// 内部能力一律不外溢；缺方法属于装配错误，必须在装配期就红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FACADE_METHODS, createGoCoreSyncFacade } = require('../lib/server/go-core-sync-facade');

const SERVER_DIR = path.join(__dirname, '..', 'lib', 'server');

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

test('FACADE_METHODS 无重复', () => {
  assert.ok(FACADE_METHODS.length > 0);
  assert.equal(new Set(FACADE_METHODS).size, FACADE_METHODS.length);
});

// 真值源守卫：清单是否完整不靠手写一份期望值（那只是把同一个错误抄两遍），
// 而是扫 WebUI 路由里真正出现的调用。少一项的后果是运行期 undefined——
// 请求静默 503，最容易在「切完流忘了加门面」时出现。
test('WebUI 路由调用的每个 goCoreSync 方法都在门面清单里', () => {
  // 真值源：扫路由里真正出现的调用。手写一份期望清单只是把同一个错误抄两遍。
  // 少一个方法的后果是运行期 undefined——请求静默 503，最容易在
  // 「切完流忘了加门面」时出现。
  // 扫所有 X.y 形式，再看 X 是不是 goCoreSync 的别名——比动态拼正则更不容易写错。
  const memberPattern = /([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
  const aliasPattern = /const\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*goCoreSync[^;\n]*/g;
  const used = new Map();
  for (const name of fs.readdirSync(SERVER_DIR)) {
    if (!/^webui-.*\.js$/.test(name)) continue;
    const text = fs.readFileSync(path.join(SERVER_DIR, name), 'utf8');
    // 路由里通常是 const goHost = ctx.deps.goCoreSync，再 goHost.xxx()。
    const aliases = new Set(['goCoreSync', 'goSync']);
    for (const match of text.matchAll(aliasPattern)) aliases.add(match[1]);
    for (const match of text.matchAll(memberPattern)) {
      if (!aliases.has(match[1])) continue;
      if (!used.has(match[2])) used.set(match[2], name);
    }
  }
  assert.ok(used.size > 0, '没有扫到任何 goCoreSync 调用，正则或目录结构变了');
  const missing = [...used.entries()]
    .filter(([method]) => !FACADE_METHODS.includes(method))
    .map(([method, file]) => method + ' (调用方 ' + file + ')');
  assert.deepEqual(missing, [], '这些调用不在 FACADE_METHODS 里，运行期会拿到 undefined');
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
