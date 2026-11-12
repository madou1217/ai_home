'use strict';

// 管理客户端的端点回退：supervisor 的 state 只表示「本进程拉起的 Go 子进程」。
// 外部 launchd / 独立进程已经监听同一 loopback 端点时，没有自己的 child 也要能建出
// 管理客户端，否则所有管理面调用都会被误判成 go_core_unavailable。
//
// 回退只在 Go Core 启用时生效：关闭态不能凭持久化的 host/port 造客户端，否则本该
// 静默跳过（返回 null）的调用会真的发出网络请求到那个端口。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGoCoreHost } = require('../lib/server/go-core-host');

function createHost({ enabled } = {}) {
  const built = [];
  const calls = { listRuntimeStates: 0 };
  const host = createGoCoreHost({
    settings: {
      enabled,
      accountSync: false,
      routes: [],
      host: '127.0.0.9',
      port: 24567,
      managementKey: 'test-management-key'
    },
    manifest: { entries: [] },
    log: { log() {}, error() {} },
    // 不是 ready、也没有 endpoint：模拟 supervisor 这次进程里没拉起 Go。
    createGoCoreSupervisor: () => ({
      status: () => ({ state: 'stopped', endpoint: '' }),
      start: async () => ({ state: 'stopped', endpoint: '' }),
      stop: async () => {}
    }),
    createGoCoreGatewayForwarder: () => ({
      tryHandleHttp: () => false,
      tryHandleUpgrade: () => false
    }),
    createGoManagementClient: (options) => {
      built.push(options);
      return {
        listRuntimeStates: async () => {
          calls.listRuntimeStates += 1;
          return { ok: true, status: 200, data: [] };
        }
      };
    }
  });
  return { host, built, calls };
}

test('supervisor 未就绪时按 settings 的 host/port 建管理客户端', async () => {
  const { host, built, calls } = createHost({ enabled: true });

  assert.deepEqual(await host.listRuntimeStates(), []);
  assert.equal(built.length, 1);
  assert.equal(built[0].baseUrl, 'http://127.0.0.9:24567');
  assert.equal(built[0].managementKey, 'test-management-key');
  assert.equal(calls.listRuntimeStates, 1);
});

test('Go Core 关闭时同样的 host/port 不建客户端', async () => {
  const { host, built, calls } = createHost({ enabled: false });

  assert.equal(await host.listRuntimeStates(), null);
  assert.equal(built.length, 0);
  assert.equal(calls.listRuntimeStates, 0);
});
