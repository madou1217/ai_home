'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { test } = require('node:test');

const { EgressPoolRuntime } = require('../lib/runtime/egress-pool-runtime');
const { buildEgressPoolConfig } = require('../lib/runtime/egress-pool-config');
const { createEgressPoolPlanner, scopeKey } = require('../lib/server/egress-pool-planner');
const { probeUpstreamViaNode } = require('../lib/server/egress-upstream-probe');
const {
  nodeExitKey,
  readUpstreamEvidence,
  recordUpstreamEvidence,
  writeUpstreamPolicy
} = require('../lib/server/egress-region-policy');
const registry = require('../lib/runtime/egress-pool-registry');
const { setNodeDisabled, writeNodePolicy } = require('../lib/runtime/egress-pool-node-policy');

function node(server, extra = {}) {
  return { protocol: 'ss', server, port: 443, cipher: 'aes-128-gcm', password: `p-${server}`, name: server, ...extra };
}
const NODES = [node('hk1'), node('us1'), node('jp1'), node('us2')];

function fakeCore() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const state = { spawned: false };
  const memfs = {
    statSync: (filePath) => {
      if (filePath === nodePath.join('/home/.ai_home', 'tools', 'mihomo')) return { isFile: () => true, size: 4096 };
      throw new Error('ENOENT');
    },
    mkdirSync: () => {},
    chmodSync: () => {},
    writeFileSync: () => {},
    renameSync: () => {},
    readFileSync: () => { throw new Error('ENOENT'); }
  };
  return { child, state, fs: memfs, spawn: () => { state.spawned = true; return child; } };
}

function buildRuntime(overrides = {}) {
  const core = fakeCore();
  const puts = [];
  const runtime = new EgressPoolRuntime({
    aiHomeDir: '/home/.ai_home',
    nodes: NODES,
    mixedPort: 17900,
    controllerPort: 17901,
    probePort: 17902,
    lanePorts: [17903, 17904, 17905],
    fs: core.fs,
    spawn: core.spawn,
    fetch: async (url, init) => {
      if (!core.state.spawned) throw new Error('ECONNREFUSED');
      if (init && init.method === 'PUT') puts.push({ url, body: JSON.parse(init.body) });
      if (/\/delay\?/.test(url)) return { ok: true, text: async () => '{"delay":42}' };
      return { ok: true, text: async () => '{}' };
    },
    networkInterfaces: () => ({}),
    startupTimeoutMs: 60,
    startupPollIntervalMs: 5,
    switchSettleMs: 0,
    probeIntervalMs: 0,
    health: undefined,
    ...overrides
  });
  return { runtime, puts };
}

test('config: lanes and probe listener are loopback-only select groups over all nodes', () => {
  const built = buildEgressPoolConfig({
    nodes: NODES, mixedPort: 1, controllerPort: 2, secret: 's', interfaceName: '', probePort: 3, lanePorts: [4, 5]
  });
  const groups = built.config['proxy-groups'].map((group) => group.name);
  assert.deepEqual(groups, ['GLOBAL', 'AIH-PROBE', 'LANE-0', 'LANE-1']);
  assert.ok(built.config['proxy-groups'].every((group) => group.proxies.length === NODES.length));
  assert.deepEqual(built.config.listeners.map((listener) => [listener.port, listener.listen, listener.proxy]),
    [[3, '127.0.0.1', 'AIH-PROBE'], [4, '127.0.0.1', 'LANE-0'], [5, '127.0.0.1', 'LANE-1']]);
  const plain = buildEgressPoolConfig({ nodes: NODES, mixedPort: 1, controllerPort: 2, secret: 's', interfaceName: '' });
  assert.equal(plain.config.listeners, undefined, 'no lanes = legacy single-exit config');
});

test('lanes: allowed set, sticky avoidance, overflow fail-closed, rotation inside allowed set', async () => {
  const { runtime, puts } = buildRuntime({ lanePorts: [17903, 17904] });
  await runtime.start();
  // node-0 = hk1, node-1 = us1, node-2 = jp1, node-3 = us2
  await runtime.applyLanePlan([
    { key: 'sticky:a', accounts: ['a'], allowed: ['node-1', 'node-2', 'node-3'], avoidGroup: 'api.anthropic.com', strategy: 'sticky' },
    { key: 'sticky:b', accounts: ['b'], allowed: ['node-1', 'node-2', 'node-3'], avoidGroup: 'api.anthropic.com', strategy: 'sticky' },
    { key: 'shared:x', accounts: ['c'], allowed: null }
  ]);
  const a = runtime.laneActiveNode('a');
  const b = runtime.laneActiveNode('b');
  assert.ok(['node-1', 'node-2', 'node-3'].includes(a));
  assert.ok(['node-1', 'node-2', 'node-3'].includes(b));
  assert.notEqual(a, b, 'sticky lanes of one upstream use different exits');
  assert.equal(runtime.laneProxyUrl('a'), 'http://127.0.0.1:17903');
  assert.equal(runtime.laneProxyUrl('b'), 'http://127.0.0.1:17904');
  // 车道只有 2 个：第三个车道的账号 fail-closed，而不是回落到可能被拒的默认出口。
  assert.equal(runtime.laneProxyUrl('c'), '');
  assert.equal(runtime.laneUnavailableReason('c'), 'egress_pool_lane_overflow');
  assert.equal(runtime.laneProxyUrl('nobody'), null);
  assert.ok(puts.some((put) => /LANE-0$/.test(put.url)));

  const rotated = await runtime.rotateLane('a', a, 'free_limit');
  assert.ok(['node-1', 'node-2', 'node-3'].includes(rotated));
  assert.notEqual(rotated, 'node-0', 'rotation never leaves the allowed set');
  // fromNode 已不是当前节点：不再前进。
  assert.equal(await runtime.rotateLane('a', 'node-9', 'x'), rotated);
  runtime.stop();
});

test('lanes: empty allowed set blocks the lane with the planner reason', async () => {
  const { runtime } = buildRuntime();
  await runtime.start();
  await runtime.applyLanePlan([{ key: 'k', accounts: ['a'], allowed: [], blockedReason: 'egress_region_denied_all_nodes' }]);
  assert.equal(runtime.laneProxyUrl('a'), '');
  assert.equal(runtime.laneUnavailableReason('a'), 'egress_region_denied_all_nodes');
  runtime.stop();
});

test('lanes: a node entering cooldown is rotated out of every lane using it', async () => {
  const { runtime } = buildRuntime();
  await runtime.start();
  await runtime.applyLanePlan([{ key: 'k', accounts: ['a'], allowed: ['node-1', 'node-2'] }]);
  const before = runtime.laneActiveNode('a');
  runtime.recordNodeOutcome(before, { ok: false, kind: 'free_limit' });
  await runtime.rotationQueue;
  assert.notEqual(runtime.laneActiveNode('a'), before);
  runtime.stop();
});

test('lanes planned before start are applied when the core becomes ready', async () => {
  const { runtime, puts } = buildRuntime();
  await runtime.applyLanePlan([{ key: 'k', accounts: ['a'], allowed: ['node-2'] }]);
  assert.equal(runtime.laneProxyUrl('a'), '', 'not ready yet');
  await runtime.start();
  assert.equal(runtime.laneActiveNode('a'), 'node-2');
  assert.ok(puts.some((put) => /LANE-0$/.test(put.url) && put.body.name === 'node-2'));
  runtime.stop();
});

test('probe listener: lookups are serialized and routed via AIH-PROBE', async () => {
  // 位置查询分两段（2026-10-22）：① 经节点拿出口 IP（出网，走 AIH-PROBE 串行化）；
  // ② IP → 归属地（本地 mmdb 库，不出网）。所以这里 mock 的 proxyFetch 只需要回一个 IP。
  const seen = [];
  const { runtime, puts } = buildRuntime({
    proxyFetch: async (proxyUrl, url) => {
      seen.push({ proxyUrl, url, probe: puts.filter((put) => /AIH-PROBE$/.test(put.url)).pop().body.name });
      // 第一个端点（ipify，JSON 形状）就成功 —— 不成功的响应会让实现继续试下一个端点，
      // 那是多端点故障转移的正常行为，但这里要验的是「经 AIH-PROBE 串行化」，不是端点回退。
      return { ok: true, status: 200, text: async () => JSON.stringify({ ip: '1.2.3.4' }) };
    },
    // 注入本地库替身：真实 mmdb 文件不该出现在单测依赖里（这台机器有没有文件因机器而异）。
    geoChain: {
      lookup: (ip) => ({ ok: true, geo: { ip, country: 'HK', region: 'Hong Kong', city: 'Hong Kong', asn: 'AS9304' }, providers: ['fake-city'], attempts: [] })
    }
  });
  await runtime.start();
  const [first, second] = await Promise.all([runtime.lookupNodeGeo('node-0'), runtime.lookupNodeGeo('node-1')]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  // 串行化：两次查询各自经自己节点的 AIH-PROBE 入口，没有交叉。
  assert.deepEqual(seen.map((entry) => entry.probe), ['node-0', 'node-1']);
  assert.ok(seen.every((entry) => entry.proxyUrl === 'http://127.0.0.1:17902'));
  assert.equal(runtime.health.geoOf('node-0').country, 'HK');
  assert.equal(runtime.health.geoOf('node-0').asn, 'AS9304');
  // 记下了出口 IP 与数据来源（本地库），便于诊断。
  assert.equal(runtime.health.geoOf('node-0').ip, '1.2.3.4');
  assert.match(runtime.health.geoOf('node-0').source, /^local:/);
  const cached = await runtime.lookupNodeGeo('node-0');
  assert.equal(cached.cached, true);
  runtime.stop();
});

function tempHome() {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-lanes-'));
}

function fakeService(runtime) {
  return {
    runtime,
    get ready() { return runtime.ready; },
    applyLanePlan: (plan) => runtime.applyLanePlan(plan)
  };
}

function plannerFor(home, runtime, bindings, extra = {}) {
  return createEgressPoolPlanner({
    fs,
    aiHomeDir: home,
    getService: () => fakeService(runtime),
    getPools: () => ({ claude: [{ provider: 'claude', accountRef: 'c1' }, { provider: 'claude', accountRef: 'c2' }], agy: [{ provider: 'agy', accountRef: 'g1' }] }),
    listBindings: () => bindings,
    readCatalog: () => ({ ok: true, nodes: [], groups: [{ id: 'p:us', name: 'US', identities: ['ss|us1|443', 'ss|us2|443'] }] }),
    ...extra
  });
}

test('planner: claude lanes exclude hinted regions and wait for unknown geo; scope via groups', async () => {
  const home = tempHome();
  const { runtime } = buildRuntime();
  try {
    await runtime.start();
    const pool = (scope, strategy = 'shared') => ({ mode: 'pool', proxyUrl: '', scope, strategy });
    const bindings = [
      { accountRef: 'c1', provider: 'claude', binding: pool({ kind: 'all', groups: [], nodes: [] }) },
      { accountRef: 'c2', provider: 'claude', binding: pool({ kind: 'all', groups: [], nodes: [] }) },
      { accountRef: 'g1', provider: 'agy', binding: pool({ kind: 'groups', groups: ['p:us'], nodes: [] }) }
    ];
    const planner = plannerFor(home, runtime, bindings);
    // 还没有任何位置：claude（有按国家的提示）全部挂起。
    let computed = planner.planNow();
    assert.equal(computed.accounts.get('c1').blockedReason, 'egress_pool_geo_pending');
    assert.equal(computed.plan.filter((lane) => lane.accounts.includes('c1'))[0].accounts.length, 2, 'shared lane per upstream+scope');
    // 查到位置：hk1 在 HK（提示拒绝），其余在 US/JP。
    runtime.health.recordGeo('node-0', { country: 'HK' });
    runtime.health.recordGeo('node-1', { country: 'US' });
    runtime.health.recordGeo('node-2', { country: 'JP' });
    runtime.health.recordGeo('node-3', { country: 'US' });
    computed = planner.planNow();
    const claudeLane = computed.plan.find((lane) => lane.accounts.includes('c1'));
    assert.deepEqual(claudeLane.allowed.sort(), ['node-1', 'node-2', 'node-3']);
    const agyLane = computed.plan.find((lane) => lane.accounts.includes('g1'));
    assert.deepEqual(agyLane.allowed.sort(), ['node-1', 'node-3'], 'group scope expands to its identities');
    await runtime.rotationQueue;
    assert.notEqual(runtime.laneActiveNode('c1'), 'node-0');
    assert.ok(runtime.laneProxyUrl('c1'));

    // 实测 ok 推翻提示（例如用户在 WebUI 里实测 HK 节点可用）。
    const upstreamId = claudeLane.upstream;
    recordUpstreamEvidence(fs, home, upstreamId, nodeExitKey('ss|hk1|443'), { status: 'ok', source: 'manual' });
    computed = planner.reconcile();
    assert.ok(computed.plan.find((lane) => lane.accounts.includes('c1')).allowed.includes('node-0'));
    // 用户规则最优先：拒绝 JP。
    writeUpstreamPolicy(fs, home, upstreamId, { rules: [{ effect: 'deny', match: { country: ['JP'] } }] });
    computed = planner.reconcile();
    assert.ok(!computed.plan.find((lane) => lane.accounts.includes('c1')).allowed.includes('node-2'));
    assert.equal(scopeKey({ kind: 'all' }), 'all');
  } finally {
    runtime.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('planner: sticky lanes downgrade to shared when slots run out', async () => {
  const home = tempHome();
  const { runtime } = buildRuntime({ lanePorts: [17903] });
  try {
    await runtime.start();
    ['node-0', 'node-1', 'node-2', 'node-3'].forEach((name) => runtime.health.recordGeo(name, { country: 'US' }));
    const sticky = { mode: 'pool', proxyUrl: '', scope: { kind: 'all', groups: [], nodes: [] }, strategy: 'sticky' };
    const planner = plannerFor(home, runtime, [
      { accountRef: 'c1', provider: 'claude', binding: sticky },
      { accountRef: 'c2', provider: 'claude', binding: sticky }
    ]);
    const computed = planner.planNow();
    assert.equal(computed.plan.length, 1);
    assert.deepEqual(computed.plan[0].accounts.sort(), ['c1', 'c2']);
    assert.equal(computed.accounts.get('c1').downgraded, true);
  } finally {
    runtime.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('registry: account lanes resolve per account without blocking the request on a plan', async () => {
  const { runtime } = buildRuntime();
  await runtime.start();
  let planned = 0;
  const service = {
    runtime,
    get ready() { return runtime.ready; },
    get proxyUrl() { return runtime.proxyUrl; },
    planNow: () => { planned += 1; runtime.assignLanes([{ key: 'k', accounts: ['a'], allowed: ['node-1'] }]); }
  };
  registry.setEgressPoolService(service);
  try {
    // 第一次查询：账号还没有车道 → 请求**不等**规划，当场走默认出口（2w 节点时同步规划会把请求卡住）。
    assert.equal(registry.currentEgressPoolProxyUrl({ accountRef: 'a' }), 'http://127.0.0.1:17900');
    assert.equal(planned, 0, '请求路径上不同步规划');
    // 规划在后台补上（setImmediate）。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(planned, 1, '后台补了一次规划');
    await runtime.reselectAssignedLanes();
    // 车道就绪后按账号返回车道地址。
    assert.equal(registry.currentEgressPoolProxyUrl({ accountRef: 'a' }), 'http://127.0.0.1:17903');
    assert.equal(registry.currentEgressPoolNode('a'), 'node-1');
    // 没有账号上下文：默认出口（旧行为）。
    assert.equal(registry.currentEgressPoolProxyUrl({}), 'http://127.0.0.1:17900');
  } finally {
    registry.resetEgressPoolServiceForTests();
    runtime.stop();
  }
});

test('passive upstream probe: reset = blocked, 401 = reachable, unreachable node = no verdict', async () => {
  const home = tempHome();
  try {
    const upstream = { id: 'api.anthropic.com', host: 'api.anthropic.com', baseUrl: 'https://api.anthropic.com', provider: 'claude', official: true };
    const runtime = {
      health: { identityOf: (name) => `ss|${name}|443` },
      probeNode: async (name) => (name === 'dead' ? { ok: false } : { ok: true, latencyMs: 10 }),
      fetchUpstreamViaNode: async (name, url) => {
        assert.equal(url, 'https://api.anthropic.com/v1/models');
        if (name === 'hk') return { ok: true, reached: false, error: 'ECONNRESET' };
        if (name === 'denied') return { ok: true, reached: true, status: 403, text: '{"error":{"message":"Request not allowed"}}' };
        return { ok: true, reached: true, status: 401, text: '{"type":"error"}' };
      }
    };
    assert.equal((await probeUpstreamViaNode({ runtime, upstream, node: 'hk', fs, aiHomeDir: home })).status, 'blocked');
    assert.equal((await probeUpstreamViaNode({ runtime, upstream, node: 'denied', fs, aiHomeDir: home })).status, 'blocked');
    assert.equal((await probeUpstreamViaNode({ runtime, upstream, node: 'us', fs, aiHomeDir: home })).status, 'reachable');
    assert.equal((await probeUpstreamViaNode({ runtime, upstream, node: 'dead', fs, aiHomeDir: home })).status, 'skipped');
    const evidence = readUpstreamEvidence(fs, home, upstream.id);
    assert.equal(evidence['node:ss|hk|443'].status, 'blocked');
    assert.equal(evidence['node:ss|us|443'].status, 'reachable');
    assert.equal(evidence['node:ss|dead|443'], undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('traffic evidence: region denial on a lane records blocked, skips account cooldown, and replans', async () => {
  const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');
  const { applyAccountFailurePolicy } = require('../lib/server/account-runtime-state');
  const evidenceStore = require('../lib/server/egress-traffic-evidence');
  const policy = classifyUpstreamFailure({ provider: 'claude', statusCode: 403, body: '{"error":{"type":"forbidden","message":"Request not allowed"}}' });
  assert.equal(policy.egressRegionDenied, true);
  assert.equal(classifyUpstreamFailure({ provider: 'claude', statusCode: 451, body: '' }).egressRegionDenied, true);
  assert.notEqual(classifyUpstreamFailure({ provider: 'claude', statusCode: 401, body: 'invalid x-api-key' }).egressRegionDenied, true);

  const { runtime } = buildRuntime();
  await runtime.start();
  await runtime.applyLanePlan([{ key: 'k', accounts: ['a'], allowed: ['node-1', 'node-2'] }]);
  const recorded = [];
  let reconciled = 0;
  evidenceStore.configureEgressTrafficEvidence(evidenceStore.createEgressTrafficEvidenceObserver({
    getService: () => fakeService(runtime),
    planner: { reconcile: () => { reconciled += 1; } },
    resolveUpstream: () => ({ id: 'api.anthropic.com' }),
    recordEvidence: (upstreamId, exitKey, entry) => recorded.push({ upstreamId, exitKey, ...entry }),
    ttlMs: () => 1000
  }));
  try {
    const active = runtime.laneActiveNode('a');
    const account = { accountRef: 'a', provider: 'claude' };
    let marked = 0;
    applyAccountFailurePolicy(account, policy, { markProxyAccountFailure: () => { marked += 1; } });
    assert.equal(marked, 0, 'pool-handled region denial does not cool the account');
    assert.equal(reconciled, 1);
    assert.deepEqual([recorded[0].status, recorded[0].source, recorded[0].exitKey],
      ['blocked', 'traffic', `node:${runtime.health.identityOf(active)}`]);
    // 不走车道的账号：照旧按账号冷却。
    applyAccountFailurePolicy({ accountRef: 'other' }, policy, { markProxyAccountFailure: () => { marked += 1; } });
    assert.equal(marked, 1);
    evidenceStore.notifyEgressSuccess(account);
    evidenceStore.notifyEgressSuccess(account);
    assert.equal(recorded.filter((entry) => entry.status === 'ok').length, 1, 'ok evidence is throttled');
  } finally {
    evidenceStore.configureEgressTrafficEvidence(null);
    runtime.stop();
  }
});

test('session strategy: planner reserves distinct-node lanes per account; state file exposes them', async () => {
  const home = tempHome();
  const { runtime } = buildRuntime({ lanePorts: [17903, 17904, 17905] });
  try {
    await runtime.start();
    ['node-0', 'node-1', 'node-2', 'node-3'].forEach((name) => runtime.health.recordGeo(name, { country: 'US' }));
    const session = { mode: 'pool', proxyUrl: '', scope: { kind: 'all', groups: [], nodes: [] }, strategy: 'session' };
    const planner = plannerFor(home, runtime, [{ accountRef: 'g1', provider: 'agy', binding: session }]);
    const computed = planner.planNow();
    const lanes = computed.plan.filter((lane) => lane.strategy === 'session');
    assert.equal(lanes.length, 3, 'capped by free lane slots');
    assert.deepEqual(lanes.map((lane) => lane.sessionSlot), [0, 1, 2]);
    await runtime.rotationQueue;
    const urls = runtime.sessionLaneUrlMap().g1;
    assert.equal(urls.length, 3);
    const actives = runtime.describeLanes().filter((lane) => lane.sessionSlot !== undefined).map((lane) => lane.activeNode);
    assert.equal(new Set(actives).size, 3, 'each session lane exits through a different node');
    // 网关请求走槽位 0。
    assert.equal(runtime.laneProxyUrl('g1'), urls[0]);
  } finally {
    runtime.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session leases: concurrent sessions get different lanes, dead holders are reclaimed, overflow shares', () => {
  const { acquireSessionLane, describeSessionLeases } = require('../lib/runtime/egress-pool-session-lease');
  const home = tempHome();
  try {
    const urls = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];
    const alive = new Set([101, 102, 103]);
    const isPidAlive = (pid) => alive.has(Number(pid));
    const first = acquireSessionLane({ fs, aiHomeDir: home, accountRef: 'acct_x', urls, pid: 101, isPidAlive });
    const second = acquireSessionLane({ fs, aiHomeDir: home, accountRef: 'acct_x', urls, pid: 102, isPidAlive });
    assert.deepEqual([first.slot, second.slot, first.shared, second.shared], [0, 1, false, false]);
    // 同一进程再查一次：拿回自己的槽位。
    assert.equal(acquireSessionLane({ fs, aiHomeDir: home, accountRef: 'acct_x', urls, pid: 101, isPidAlive }).slot, 0);
    // 两条都被占：第三个会话复用一条并标记 shared。
    assert.equal(acquireSessionLane({ fs, aiHomeDir: home, accountRef: 'acct_x', urls, pid: 103, isPidAlive }).shared, true);
    // 101 退出：新会话接管槽位 0。
    alive.delete(101);
    const reclaimed = acquireSessionLane({ fs, aiHomeDir: home, accountRef: 'acct_x', urls, pid: 104, isPidAlive: (pid) => pid === 104 || alive.has(Number(pid)) });
    assert.deepEqual([reclaimed.slot, reclaimed.shared], [0, false]);
    assert.deepEqual(describeSessionLeases({ fs, aiHomeDir: home, accountRef: 'acct_x', count: 2, isPidAlive: (pid) => pid === 104 || alive.has(Number(pid)) })
      .map((lease) => [lease.pid, lease.alive]), [[104, true], [102, true]]);
    assert.equal(acquireSessionLane({ fs, aiHomeDir: home, accountRef: 'acct_x', urls: [] }), null);
    // Windows 没有 POSIX 权限位（stat 恒为 0o666），只在 POSIX 上校验 0600。
    if (process.platform !== 'win32') {
      const mode = fs.statSync(nodePath.join(home, 'run', 'egress-pool', 'session-leases', 'acct_x', 'lane-0.json')).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('registry: CLI sessions of a session-strategy account read leased lanes from the state file', () => {
  const stateFile = require('../lib/runtime/egress-pool-state-file');
  const home = tempHome();
  try {
    fs.mkdirSync(nodePath.join(home, 'run', 'egress-pool'), { recursive: true });
    stateFile.writeEgressPoolState({
      fs, aiHomeDir: home, ownerPid: process.pid, corePid: process.pid, proxyUrl: 'http://127.0.0.1:17890',
      controllerPort: 17891, secret: 's',
      lanes: { acct_x: 'http://127.0.0.1:17893' },
      sessionLanes: { acct_x: ['http://127.0.0.1:17893', 'http://127.0.0.1:17894', 'http://evil.example:1'] }
    });
    registry.resetEgressPoolServiceForTests();
    assert.deepEqual(stateFile.readEgressPoolState({ fs, aiHomeDir: home }).sessionLanes.acct_x,
      ['http://127.0.0.1:17893', 'http://127.0.0.1:17894'], 'non-loopback lanes are dropped');
    // 非会话调用（用量探测等）：槽位 0 / 账号车道。
    assert.equal(registry.currentEgressPoolProxyUrl({ fs, aiHomeDir: home, accountRef: 'acct_x' }), 'http://127.0.0.1:17893');
    // 会话调用：认领租约（本进程 = 持有者）。
    const leased = registry.currentEgressPoolProxyUrl({ fs, aiHomeDir: home, accountRef: 'acct_x', session: true });
    assert.ok(['http://127.0.0.1:17893', 'http://127.0.0.1:17894'].includes(leased));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 2026-10-21：拦截策略（延迟阈值 / 连不上 / 手动关闭）与地区判定一样是车道的硬约束 ——
// 被拦的节点不进 allowed，这样账号不会经它出网（用户诉求：总命中 10000ms+ 无响应的节点）。
test('planner: blocked nodes (slow / unreachable / manually closed) never enter a lane', async () => {
  const home = tempHome();
  const { runtime } = buildRuntime();
  try {
    await runtime.start();
    const pool = { mode: 'pool', proxyUrl: '', scope: { kind: 'all', groups: [], nodes: [] }, strategy: 'shared' };
    const bindings = [{ accountRef: 'g1', provider: 'agy', binding: pool }];
    const planner = plannerFor(home, runtime, bindings);
    // 全组节点都有位置（agy 无地区提示，位置不影响判定），先确认四个都可用。
    ['node-0', 'node-1', 'node-2', 'node-3'].forEach((name) => runtime.health.recordGeo(name, { country: 'US' }));
    assert.deepEqual(planner.planNow().plan[0].allowed.sort(), ['node-0', 'node-1', 'node-2', 'node-3']);

    // 1) 延迟阈值：node-1 探测 10s，启用后不进车道。
    runtime.health.recordProbe('node-1', { ok: true, latencyMs: 10000 });
    writeNodePolicy(fs, home, { latency: { enabled: true, maxMs: 3000 } });
    let computed = planner.reconcile({ force: true });
    assert.deepEqual(computed.plan[0].allowed.sort(), ['node-0', 'node-2', 'node-3']);
    assert.equal(computed.accounts.get('g1').blockedCount, 1);

    // 2) 连不上：node-2 探测失败，单独开关也生效。
    runtime.health.recordProbe('node-2', { ok: false, error: 'probe_unreachable' });
    writeNodePolicy(fs, home, { unreachable: { enabled: true } });
    computed = planner.reconcile({ force: true });
    assert.deepEqual(computed.plan[0].allowed.sort(), ['node-0', 'node-3']);

    // 3) 手动关闭：node-0 被关掉；关掉延迟拦截后 node-1 应回来，但 node-0 仍然不在。
    setNodeDisabled(fs, home, runtime.health.nodes[0].identity, true, { label: 'US-0' });
    writeNodePolicy(fs, home, { latency: { enabled: false }, unreachable: { enabled: false } });
    computed = planner.reconcile({ force: true });
    assert.deepEqual(computed.plan[0].allowed.sort(), ['node-1', 'node-2', 'node-3']);

    // 4) 全部被拦：车道给出「全被拦截」这个原因，用户才知道去关拦截而不是查地区策略。
    ['node-0', 'node-1', 'node-2', 'node-3'].forEach((name, index) => {
      if (index === 0) return;
      setNodeDisabled(fs, home, runtime.health.nodes[index].identity, true, { label: `US-${index}` });
    });
    computed = planner.reconcile({ force: true });
    assert.deepEqual(computed.plan[0].allowed, []);
    assert.equal(computed.accounts.get('g1').blockedReason, 'egress_pool_all_nodes_blocked');
  } finally {
    runtime.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 2026-10-21 报障：保存出口后立即探测，而车道是异步选节点的 —— 不等就吃到
// egress_pool_lane_not_ready、把刚保存的绑定回滚。reconcileAndApply 就是那个「等」。
test('planner: reconcileAndApply waits until the lane has picked its node', async () => {
  const home = tempHome();
  const { runtime } = buildRuntime();
  try {
    await runtime.start();
    const planner = plannerFor(home, runtime, [
      { accountRef: 'c1', provider: 'claude', binding: { mode: 'pool', proxyUrl: '', scope: { kind: 'all', groups: [], nodes: [] }, strategy: 'shared' } }
    ]);
    // 应用车道表被拖慢：reconcile（不等）会立刻返回，而 reconcileAndApply 必须等它完成。
    let applied = false;
    const slowService = {
      runtime,
      get ready() { return runtime.ready; },
      async applyLanePlan(plan) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await runtime.applyLanePlan(plan);
        applied = true;
      }
    };
    const slowPlanner = plannerFor(home, runtime, [
      { accountRef: 'c1', provider: 'claude', binding: { mode: 'pool', proxyUrl: '', scope: { kind: 'all', groups: [], nodes: [] }, strategy: 'shared' } }
    ], { getService: () => slowService });
    // claude 上游按国家判定：先给节点位置，否则车道挂起（与本用例无关的既有语义）。
    for (const name of runtime.nodeNames) runtime.health.recordGeo(name, { country: 'US' });
    slowPlanner.planNow();
    assert.equal(applied, false, 'planNow 不等待车道应用');
    await slowPlanner.reconcileAndApply({ force: true });
    assert.equal(applied, true, 'reconcileAndApply 等到车道应用完成');
    assert.equal(runtime.laneUnavailableReason('c1'), '', '车道已就绪');
    assert.ok(runtime.laneProxyUrl('c1'), '车道给出可用的出口地址');
    planner.planNow();
  } finally {
    runtime.stop();
  }
});

// 策略改完要**立即**生效：正在用被拦节点的车道不能等下一次规划才换走
// （用户点「关闭」时期望当场就不再走这个节点）。
test('planner: a lane already using a node switches away as soon as the node gets blocked', async () => {
  const home = tempHome();
  const { runtime } = buildRuntime();
  try {
    await runtime.start();
    const pool = { mode: 'pool', proxyUrl: '', scope: { kind: 'all', groups: [], nodes: [] }, strategy: 'shared' };
    const planner = plannerFor(home, runtime, [{ accountRef: 'g1', provider: 'agy', binding: pool }]);
    ['node-0', 'node-1', 'node-2', 'node-3'].forEach((name) => runtime.health.recordGeo(name, { country: 'US' }));
    planner.planNow();
    await runtime.rotationQueue;
    const before = runtime.laneActiveNode('g1');
    assert.ok(before, '车道先要有出口');

    // 手动关闭这个正在被使用的节点，然后重新规划（WebUI 保存策略走的就是这条路径）。
    setNodeDisabled(fs, home, runtime.health.nodes[runtime.nodeNames.indexOf(before)].identity, true, { label: before });
    planner.reconcile({ force: true });
    await runtime.rotationQueue;
    const after = runtime.laneActiveNode('g1');
    assert.notEqual(after, before, '被关闭的节点必须立刻从车道上换走');
    assert.equal(runtime.health.blockedReason(after).blocked, false, '换到的节点不该也是被拦的');
  } finally {
    runtime.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
