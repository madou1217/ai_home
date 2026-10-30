'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runBackgroundSupervisor } = require('../lib/cli/services/background/supervisor-runtime');

/**
 * 构造一个可控的 supervisor 依赖包：
 * - readState 返回只含 server 组件的状态（无 relay/webrtc/registry-agent，避免外部连接）
 * - startLocalServer 返回一个句柄，其 .stop() 可被 await，.closed 永不 resolve（除非显式拒绝）
 * - processObj 是一个伪造的 EventEmitter，能 once/removeListener SIGTERM/SIGINT
 *
 * 关键复现路径：SIGTERM 到来时，onSigterm → stop('SIGTERM') → stopped resolve →
 * runBackgroundSupervisor 返回。修复前 router 会 exit(0)，launchd 不重启；
 * 修复后必须抛 background_supervisor_signaled（非零）让 launchd 拉起。
 */
function buildSupervisorHarness() {
  const handlers = new Map();
  const processObj = {
    once(signal, handler) {
      handlers.set(signal, handler);
    },
    removeListener(signal, handler) {
      if (handlers.get(signal) === handler) handlers.delete(signal);
    }
  };
  const serverStopCalls = [];
  const serverHandle = {
    stop(signal) {
      serverStopCalls.push(signal);
      return Promise.resolve();
    },
    // 永不自行 close —— 这样 lifecycleEvent 只会来自 stopped（信号路径）
    closed: new Promise(() => {})
  };
  const deps = {
    aiHomeDir: '/tmp/test-aih',
    readState: () => ({
      schemaVersion: 1,
      components: {
        server: { id: 'server', args: ['server', 'serve'] }
      }
    }),
    startLocalServer: async () => serverHandle,
    processObj,
    // 立即触发的定时器会让 restart 路径在测试里不可达——这里只测信号路径
    setTimeout: () => null,
    clearTimeout: () => {}
  };
  return { deps, processObj, serverStopCalls, handlers };
}

test('SIGTERM 关闭必须抛 background_supervisor_signaled（非零退出，launchd 才会重启）', async () => {
  const { deps, handlers } = buildSupervisorHarness();
  const runPromise = runBackgroundSupervisor(deps);
  // 让 startLocalServer 与 worker 初始化完成
  await Promise.resolve();
  await Promise.resolve();
  handlers.get('SIGTERM')();
  await assert.rejects(
    runPromise,
    (error) => error.code === 'background_supervisor_signaled'
      && error.signal === 'SIGTERM',
    'SIGTERM 停机应抛 background_supervisor_signaled 让 launchd KeepAlive 重启'
  );
});

test('SIGINT 关闭同样必须抛 background_supervisor_signaled', async () => {
  const { deps, handlers } = buildSupervisorHarness();
  const runPromise = runBackgroundSupervisor(deps);
  await Promise.resolve();
  await Promise.resolve();
  handlers.get('SIGINT')();
  await assert.rejects(
    runPromise,
    (error) => error.code === 'background_supervisor_signaled' && error.signal === 'SIGINT'
  );
});

test('server 自行关闭仍抛 background_server_stopped（与信号路径区分）', async () => {
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
  const { deps } = buildSupervisorHarness();
  // 覆盖 closed，让 server 自行关闭
  deps.startLocalServer = async () => ({
    stop: () => Promise.resolve(),
    closed: closedPromise
  });
  const runPromise = runBackgroundSupervisor(deps);
  await Promise.resolve();
  await Promise.resolve();
  resolveClosed();
  await assert.rejects(
    runPromise,
    (error) => error.code === 'background_server_stopped'
  );
});

test('启动期 startLocalServer 不可用仍抛 background_server_runtime_unavailable（不重启）', async () => {
  const { deps } = buildSupervisorHarness();
  deps.startLocalServer = async () => {
    throw new Error('boom');
  };
  await assert.rejects(
    runBackgroundSupervisor(deps),
    (error) => /boom/.test(error.message)
  );
});
