'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { isUsableNode, readProxyPoolNodes } = require('../lib/runtime/egress-pool-node-source');
const { EgressPoolService } = require('../lib/runtime/egress-pool-service');

const GOOD_NODE = {
  protocol: 'vless', server: 'a.example.com', port: 443, uuid: 'u-1',
  network: 'tcp', tls: true, security: 'reality', sni: 'a.example.com',
  publicKey: 'pk-1', shortId: 'sid-1', fingerprint: 'ios'
};

// ── 节点来源 ───────────────────────────────────────────────────────────────

test('a node without a server is unusable', () => {
  assert.equal(isUsableNode({ protocol: 'vless', port: 443 }), false);
  assert.equal(isUsableNode(null), false);
  assert.equal(isUsableNode('nope'), false);
});

test('a node with an out-of-range port is unusable', () => {
  assert.equal(isUsableNode({ server: 'a.example.com', port: 0 }), false);
  assert.equal(isUsableNode({ server: 'a.example.com', port: 70000 }), false);
  assert.equal(isUsableNode({ server: 'a.example.com', port: 'abc' }), false);
});

test('a well-formed node is usable', () => {
  assert.equal(isUsableNode(GOOD_NODE), true);
});

test('reading without an ai home dir fails closed', () => {
  const result = readProxyPoolNodes({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_ai_home_missing');
});

test('an unreadable store fails closed instead of throwing', () => {
  const result = readProxyPoolNodes({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => { throw new Error('store boom'); }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /egress_pool_store_unavailable/);
});

test('an empty node list fails closed', () => {
  const result = readProxyPoolNodes({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => ({ listNodes: () => [] })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_no_nodes');
});

test('malformed entries are filtered out of the pool', () => {
  const result = readProxyPoolNodes({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => ({
      listNodes: () => [GOOD_NODE, { server: '', port: 443 }, { server: 'b.example.com', port: -1 }]
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.nodes.length, 1);
});

// ── 出口池服务 ─────────────────────────────────────────────────────────────

test('a disabled pool starts nothing and stays silent', async () => {
  const service = new EgressPoolService({ enabled: false, aiHomeDir: '/home/.ai_home' });
  const result = await service.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_disabled');
  assert.equal(service.ready, false);
  assert.equal(service.proxyUrl, '');
});

test('status explains the pool even before it starts', () => {
  const service = new EgressPoolService({ aiHomeDir: '/home/.ai_home' });
  const status = service.status;
  assert.equal(status.ready, false);
  assert.equal(status.proxyUrl, '');
  assert.equal(status.nodeCount, 0);
});

test('stop() before start is a no-op', () => {
  const service = new EgressPoolService({ aiHomeDir: '/home/.ai_home' });
  service.stop(); // 不应抛
  assert.equal(service.ready, false);
});

test('a pool with no nodes never exposes a proxy url', async () => {
  const service = new EgressPoolService({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => ({ listNodes: () => [] })
  });
  const result = await service.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_no_nodes');
  assert.equal(service.proxyUrl, '');
});

test('a failed start leaves no half-dead runtime behind', async () => {
  const service = new EgressPoolService({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => ({ listNodes: () => [GOOD_NODE] }),
    // 内核不存在 → start 失败；此时绝不能留下一个能报出 proxyUrl 的实例。
    fs: { statSync: () => { throw new Error('ENOENT'); }, mkdirSync: () => {}, writeFileSync: () => {} },
    spawn: () => { throw new Error('should not spawn'); }
  });
  const result = await service.start();
  assert.equal(result.ok, false);
  assert.equal(service.ready, false);
  assert.equal(service.proxyUrl, '');
  assert.equal(service.status.ready, false);
});

// ── 进程内单例登记（请求热路径据此轮换出口）─────────────────────────────────

const registry = require('../lib/runtime/egress-pool-registry');

test('the registry reports not-ready before any pool is registered', () => {
  registry.resetEgressPoolServiceForTests();
  assert.equal(registry.isEgressPoolReady(), false);
  assert.equal(registry.currentEgressPoolProxyUrl(), '');
  assert.equal(registry.getEgressPoolService(), null);
});

test('the registry exposes the pool url only while the pool is ready', () => {
  registry.setEgressPoolService({
    ready: false,
    proxyUrl: 'http://127.0.0.1:17890',
    runtime: null
  });
  assert.equal(registry.isEgressPoolReady(), false);
  assert.equal(registry.currentEgressPoolProxyUrl(), '');

  registry.setEgressPoolService({
    ready: true,
    proxyUrl: 'http://127.0.0.1:17890',
    runtime: null
  });
  assert.equal(registry.isEgressPoolReady(), true);
  assert.equal(registry.currentEgressPoolProxyUrl(), 'http://127.0.0.1:17890');
  registry.resetEgressPoolServiceForTests();
});

test('rotating without a pool is a silent no-op', async () => {
  registry.resetEgressPoolServiceForTests();
  assert.equal(await registry.rotateEgressPoolNode(), '');
});

test('rotation never throws even when the runtime does', async () => {
  registry.setEgressPoolService({
    ready: true,
    proxyUrl: 'http://127.0.0.1:17890',
    runtime: { rotateNode: async () => { throw new Error('core died'); } }
  });
  // 失败路径上的补救动作自己出错，不该盖住原始的上游错误。
  assert.equal(await registry.rotateEgressPoolNode(), '');
  registry.resetEgressPoolServiceForTests();
});

test('rotation returns the node it switched to', async () => {
  registry.setEgressPoolService({
    ready: true,
    proxyUrl: 'http://127.0.0.1:17890',
    runtime: { rotateNode: async () => 'node-3' }
  });
  assert.equal(await registry.rotateEgressPoolNode(), 'node-3');
  registry.resetEgressPoolServiceForTests();
});

// ── 按需启动：没人绑定 pool 就不起内核 ──────────────────────────────────────

function countingService(overrides = {}) {
  let starts = 0;
  let clock = 1000;
  const service = new EgressPoolService({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => { starts += 1; return { listNodes: () => [] }; },
    now: () => clock,
    startRetryBackoffMs: 50,
    ...overrides
  });
  return {
    service,
    starts: () => starts,
    advance: (ms) => { clock += ms; }
  };
}

test('concurrent starts share one attempt', async () => {
  const { service, starts } = countingService();
  const [a, b] = await Promise.all([service.start(), service.start()]);
  assert.equal(a, b);
  assert.equal(starts(), 1);
});

test('ensureStarted backs off after a failed start instead of retrying per request', async () => {
  const { service, starts, advance } = countingService();
  assert.equal(service.ensureStarted(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts(), 1);
  // 冷却期内：请求热路径反复调用也不会重新读节点、起进程。
  assert.equal(service.ensureStarted(), false);
  assert.equal(service.ensureStarted(), false);
  assert.equal(starts(), 1);
  advance(60);
  assert.equal(service.ensureStarted(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts(), 2);
});

test('ensureStarted is a no-op on a disabled pool', () => {
  const { service, starts } = countingService({ enabled: false });
  assert.equal(service.ensureStarted(), false);
  assert.equal(starts(), 0);
});

test('the registry lazy-start and awaited start are silent without a registered pool', async () => {
  registry.resetEgressPoolServiceForTests();
  assert.equal(registry.ensureEgressPoolStarted(), false);
  assert.deepEqual(await registry.startEgressPool(), { ok: false, error: 'egress_pool_unavailable' });
});

test('the registry forwards lazy-start and awaited start to the registered pool', async () => {
  const calls = [];
  registry.setEgressPoolService({
    ensureStarted: () => { calls.push('ensure'); return true; },
    start: async () => { calls.push('start'); return { ok: true }; }
  });
  assert.equal(registry.ensureEgressPoolStarted(), true);
  assert.deepEqual(await registry.startEgressPool(), { ok: true });
  assert.deepEqual(calls, ['ensure', 'start']);
  registry.resetEgressPoolServiceForTests();
});

// ── v3：失败原因不丢、stop 抢在启动途中 ─────────────────────────────────────

test('the start failure reason survives in status after the runtime is dropped', async () => {
  const service = new EgressPoolService({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => ({ listNodes: () => [GOOD_NODE] }),
    fs: { statSync: () => { throw new Error('ENOENT'); }, mkdirSync: () => {}, writeFileSync: () => {} }
  });
  await service.start();
  assert.equal(service.runtime, null);
  assert.equal(service.status.lastError, 'egress_pool_core_not_found');
  assert.equal(service.lastStartError, 'egress_pool_core_not_found');

  // registry 把同一原因交给 egress_pool_not_ready 的 reason。
  registry.setEgressPoolService(service);
  assert.equal(registry.describeEgressPoolUnavailable(), 'egress_pool_core_not_found');
  registry.resetEgressPoolServiceForTests();
});

test('service.stop() during a start leaves no core behind and no TypeError', async () => {
  const nodePath = require('node:path');
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  let kills = 0;
  child.kill = () => { kills += 1; };
  let spawned = false;
  let service = null;
  service = new EgressPoolService({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => ({ listNodes: () => [GOOD_NODE] }),
    fs: {
      statSync: (filePath) => {
        if (filePath === nodePath.join('/home/.ai_home', 'tools', 'mihomo')) return { isFile: () => true, size: 1 };
        throw new Error('ENOENT');
      },
      mkdirSync: () => {},
      writeFileSync: () => {}
    },
    networkInterfaces: () => ({}),
    spawn: () => { spawned = true; return child; },
    startupTimeoutMs: 60,
    startupPollIntervalMs: 5,
    fetch: async () => {
      if (!spawned) throw new Error('ECONNREFUSED');
      // shutdown 与惰性启动相撞：内核已 spawn、还在等就绪时 server 退出。
      service.stop();
      return { ok: true, text: async () => '{}' };
    }
  });
  const result = await service.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_stopped_during_start');
  assert.ok(kills >= 1, 'the spawned core must be killed');
  assert.equal(service.runtime, null);
  assert.equal(service.ready, false);
});

// 订阅的「剩余流量 / 距离重置 / 套餐到期」信息行常指向同一服务器：池里留着它们，
// 轮换会在同一个被限的 IP 上连跳（2026-10-18 实测 4 条全是 direct-us-01:36699）。
test('nodes that share one exit collapse into a single pool entry', () => {
  const sameExit = { protocol: 'vless', server: 'direct-us-01.example.com', port: 36699, uuid: 'u-1' };
  const result = readProxyPoolNodes({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => ({
      listNodes: () => [
        { ...sameExit, name: '剩余流量：50 GB' },
        { ...sameExit, name: '套餐到期：2026-11-11' },
        { ...sameExit, name: 'US01' },
        { ...sameExit, port: 36700, name: 'US01-alt-port' },
        { ...sameExit, uuid: 'u-2', name: 'US01-other-credential' }
      ]
    })
  });
  assert.equal(result.ok, true);
  // 同一出口只留一个，且留下的是**真实节点名**：提示行排到后面再按出口去重，
  // 否则用户看到的是「剩余流量：50 GB」而不是能认出是哪台机器的 US01（2026-10-21）。
  assert.deepEqual(result.nodes.map((node) => node.name), ['US01', 'US01-alt-port', 'US01-other-credential']);
});

test('informational and unroutable entries never enter the pool', () => {
  const result = readProxyPoolNodes({
    aiHomeDir: '/home/.ai_home',
    getProxyNodeStore: () => ({
      listNodes: () => [
        // 机场把流量 / 到期写成假节点（真节点库实测 785 个里混着这些）。
        { protocol: 'vless', server: 'us01.example.com', port: 443, uuid: 'u-1', name: '64.48 GB | 300 GB' },
        { protocol: 'vless', server: 'us02.example.com', port: 443, uuid: 'u-2', name: 'Traffic Reset: 25 Days Left' },
        { protocol: 'vless', server: 'us03.example.com', port: 443, uuid: 'u-3', name: 'Expire Date: 2027-03-14' },
        // 占位提示指向文档保留网段 / 全零地址，永远连不上。
        { protocol: 'vmess', server: '192.0.2.1', port: 1, uuid: 'u-4', name: '📢暂不支持clash和singbox' },
        { protocol: 'vmess', server: '0.0.0.0', port: 443, uuid: 'u-5', name: '一元机场.asia' },
        { protocol: 'vless', server: 'uk01.example.com', port: 443, uuid: 'u-6', name: 'UK-London1' }
      ]
    })
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.nodes.map((node) => node.name), ['UK-London1']);
});
