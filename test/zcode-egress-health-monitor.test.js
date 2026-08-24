'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ZcodeEgressHealthMonitor
} = require('../lib/server/zcode-egress-health-monitor');

function createMonitor(overrides = {}) {
  let now = 1000;
  const timers = [];
  const monitor = new ZcodeEgressHealthMonitor({
    intervalMs: 60000,
    failureThreshold: 2,
    now: () => ++now,
    isProcessAlive: () => true,
    setInterval(callback, delay) {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearInterval() {},
    ...overrides
  });
  return { monitor, timers };
}

test('健康监测连续失败达到阈值后只把当前节点交给服务故障切换', async () => {
  const recoveries = [];
  let probes = 0;
  const { monitor, timers } = createMonitor({
    probeProxyServer: async () => {
      probes += 1;
      return { ok: false, reason: `probe-${probes}` };
    },
    recoverAccount: async (input) => {
      recoveries.push(input);
      return {
        ok: true,
        applied: true,
        proxyServer: '127.0.0.1:23100',
        selectedNodeId: 'node-b',
        groupId: 'group-a'
      };
    }
  });
  monitor.track({
    accountRef: 'acct_a',
    proxyServer: '127.0.0.1:23100',
    selectedNodeId: 'node-a',
    groupId: 'group-a',
    pid: 123,
    recoveryInput: { marker: 'context' }
  });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].unrefCalled, true);
  await monitor.checkNow('acct_a');
  assert.equal(recoveries.length, 0);
  const switched = await monitor.checkNow('acct_a');

  assert.deepEqual(recoveries[0], {
    accountRef: 'acct_a',
    failedNodeIds: ['node-a'],
    recoveryInput: { marker: 'context' }
  });
  assert.equal(switched.selectedNodeId, 'node-b');
  assert.equal(switched.consecutiveFailures, 0);
  assert.ok(switched.lastSwitchAt);
});

test('健康探测恢复后清零失败计数，ZCode PID 消失时停止监测', async () => {
  let alive = true;
  const probes = [{ ok: false, reason: 'temporary' }, { ok: true }];
  const { monitor } = createMonitor({
    probeProxyServer: async () => probes.shift() || { ok: true },
    isProcessAlive: () => alive
  });
  monitor.track({
    accountRef: 'acct_a',
    proxyServer: '127.0.0.1:23100',
    selectedNodeId: 'node-a',
    groupId: 'group-a',
    pid: 123
  });

  assert.equal((await monitor.checkNow('acct_a')).consecutiveFailures, 1);
  const healthy = await monitor.checkNow('acct_a');
  assert.equal(healthy.consecutiveFailures, 0);
  assert.ok(healthy.lastHealthyAt);

  alive = false;
  assert.deepEqual(await monitor.checkNow('acct_a'), { monitoring: false, inactive: true });
  assert.deepEqual(monitor.getStatus('acct_a'), { monitoring: false });
});

test('全部候选恢复失败后下一轮不永久排除旧节点', async () => {
  const failedLists = [];
  const { monitor } = createMonitor({
    failureThreshold: 1,
    probeProxyServer: async () => ({ ok: false, reason: 'offline' }),
    recoverAccount: async ({ failedNodeIds }) => {
      failedLists.push(failedNodeIds);
      return { ok: false, error: 'proxy_unreachable' };
    }
  });
  monitor.track({
    accountRef: 'acct_a',
    proxyServer: '127.0.0.1:23100',
    selectedNodeId: 'node-a',
    groupId: 'group-a'
  });

  await monitor.checkNow('acct_a');
  await monitor.checkNow('acct_a');
  assert.deepEqual(failedLists, [['node-a'], []]);
});
