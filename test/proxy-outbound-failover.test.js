'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');
const {
  OutboundFailoverWatchdog,
  normalizeFailoverConfig,
  validateFailoverConfigUpdate
} = require('../lib/cli/services/toolkit/proxy-pool/outbound-failover');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-outbound-failover-'));
}

// 节点按名字给出测速结果：数字 = 可达延迟，-1 = 不通。
function setup({ latency, running = true, mode = 'rule' } = {}) {
  const filePath = path.join(tempDir(), 'proxy-pool.json');
  const state = { running, latency: { ...latency }, reloads: 0 };
  const runtime = {
    getStatus: () => ({ running: state.running, dataPlaneReady: state.running, installed: true, activeListeners: [] }),
    reload: async () => { state.reloads += 1; return { ok: true, applied: true, action: 'reload', warnings: [] }; },
    pingNode: async (node) => (state.latency[node.name] >= 0
      ? { ok: true, latencyMs: state.latency[node.name] }
      : { ok: false, error: 'timeout' })
  };
  const logs = [];
  let clock = 1_000;
  const service = new ProxyPoolService({ storeOptions: { filePath }, coreRuntime: runtime, platform: 'linux' });
  service.outboundFailover = new OutboundFailoverWatchdog({
    service,
    store: service.store,
    now: () => clock,
    log: (line) => logs.push(line)
  });
  const ids = {};
  for (const name of Object.keys(latency)) {
    ids[name] = service.store.upsertNode({ name, protocol: 'socks5', server: `${name}.example`, port: 1080 }).id;
  }
  service.store.setRoutingConfig({ mode, activeOutboundNodeId: ids.a || null });
  service.store.setOutboundFailoverConfig({ enabled: true, failureThreshold: 3 });
  const tick = async () => { clock += 60_000; return service.outboundFailover.check(); };
  return { service, state, ids, logs, tick, filePath };
}

test('配置规范化：默认关闭、间隔与阈值有边界；提交越界值直接拒绝', () => {
  assert.deepEqual(normalizeFailoverConfig(undefined), { enabled: false, intervalSec: 60, failureThreshold: 3 });
  assert.deepEqual(normalizeFailoverConfig({ enabled: true, intervalSec: 1, failureThreshold: 99 }), {
    enabled: true, intervalSec: 15, failureThreshold: 10
  });
  assert.equal(validateFailoverConfigUpdate({ intervalSec: 5 }).error, 'invalid_outbound_failover_interval');
  assert.equal(validateFailoverConfigUpdate({ failureThreshold: 0 }).error, 'invalid_outbound_failover_threshold');
  assert.equal(validateFailoverConfigUpdate({ enabled: 'yes' }).error, 'invalid_outbound_failover_config');
  assert.equal(validateFailoverConfigUpdate({}).error, 'invalid_outbound_failover_config');
  assert.deepEqual(validateFailoverConfigUpdate({ enabled: true, intervalSec: 30 }).update, { enabled: true, intervalSec: 30 });
});

test('默认出口连续不通达到阈值才切换到最快的其它节点，并记录事件、写入分流', async () => {
  const { service, state, ids, logs, tick } = setup({ latency: { a: 50, b: 300, c: 90, d: -1 } });
  assert.equal((await tick()).action, 'healthy');

  state.latency.a = -1;
  assert.equal((await tick()).action, 'degraded');
  assert.equal((await tick()).action, 'degraded');
  assert.equal(service.store.getRoutingConfig().activeOutboundNodeId, ids.a, '未达阈值不切换');

  const switched = await tick();
  assert.equal(switched.action, 'switched');
  assert.equal(service.store.getRoutingConfig().activeOutboundNodeId, ids.c, '换成最快的可用节点');
  assert.ok(state.reloads >= 1, '新出口下发到内核');
  const status = service.getOutboundFailover();
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.events.length, 1);
  assert.deepEqual(
    { reason: status.events[0].reason, from: status.events[0].from.name, to: status.events[0].to.name, latency: status.events[0].to.latencyMs },
    { reason: 'unreachable', from: 'a', to: 'c', latency: 90 }
  );
  assert.match(logs[0], /a -> c/);
});

test('恢复可达会清零失败计数；没有可用候选时不切换、下一轮再试', async () => {
  const { service, state, ids, tick } = setup({ latency: { a: 50, b: -1 } });
  service.store.setOutboundFailoverConfig({ failureThreshold: 2 });
  state.latency.a = -1;
  await tick();
  state.latency.a = 40;
  assert.equal((await tick()).action, 'healthy');
  assert.equal(service.getOutboundFailover().consecutiveFailures, 0);

  state.latency.a = -1;
  await tick();
  const result = await tick();
  assert.equal(result.action, 'no_candidate');
  assert.equal(service.store.getRoutingConfig().activeOutboundNodeId, ids.a);
  assert.equal(service.getOutboundFailover().events.length, 0);
});

test('默认出口节点被删除时立即切换，不等待累计失败', async () => {
  const { service, ids, tick } = setup({ latency: { a: 50, b: 70 } });
  service.store.deleteNode(ids.a);
  service.store.setRoutingConfig({ activeOutboundNodeId: ids.a });
  const result = await tick();
  assert.equal(result.action, 'switched');
  assert.equal(result.event.reason, 'node_missing');
  assert.equal(service.store.getRoutingConfig().activeOutboundNodeId, ids.b);
});

test('检测期间用户改了默认出口：放弃本次切换，不覆盖用户选择', async () => {
  const { service, ids } = setup({ latency: { a: 50, b: 70, c: 90 } });
  service.store.setRoutingConfig({ activeOutboundNodeId: ids.b });
  const result = await service.replaceActiveOutbound(ids.a, ids.c);
  assert.equal(result.error, 'outbound_changed_concurrently');
  assert.equal(service.store.getRoutingConfig().activeOutboundNodeId, ids.b);
});

test('关闭、直连模式、内核未运行、未设默认出口时只记录跳过原因', async () => {
  const off = setup({ latency: { a: 50, b: 70 } });
  off.service.store.setOutboundFailoverConfig({ enabled: false });
  assert.equal((await off.tick()).reason, 'disabled');
  assert.equal((await off.service.checkOutboundFailover()).action, 'healthy', '立即检测在关闭时也执行');

  assert.equal((await setup({ latency: { a: 50 }, mode: 'direct' }).tick()).reason, 'direct_mode');
  assert.equal((await setup({ latency: { a: 50 }, running: false }).tick()).reason, 'core_not_running');
  const unset = setup({ latency: { a: 50 } });
  unset.service.store.setRoutingConfig({ activeOutboundNodeId: null });
  assert.equal((await unset.tick()).reason, 'no_active_outbound');
});

test('定时器按配置启停，改间隔会重新排定；配置与事件持久化', async () => {
  const timers = [];
  const { service, filePath } = setup({ latency: { a: 50 } });
  const watchdog = new OutboundFailoverWatchdog({
    service,
    store: service.store,
    setInterval: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearInterval: (timer) => { timer.cleared = true; }
  });
  watchdog.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  watchdog.start();
  assert.equal(timers.length, 1, '配置未变不重复排定');

  assert.equal(watchdog.updateConfig({ intervalSec: 30 }).config.intervalSec, 30);
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[1].ms, 30_000);

  watchdog.updateConfig({ enabled: false });
  assert.equal(timers[1].cleared, true);
  assert.equal(watchdog.getStatus().scheduled, false);

  const reopened = new ProxyPoolService({ storeOptions: { filePath }, coreRuntime: { getStatus: () => ({}) }, platform: 'linux' });
  assert.deepEqual(reopened.getOutboundFailover().config, { enabled: false, intervalSec: 30, failureThreshold: 3 });
});
