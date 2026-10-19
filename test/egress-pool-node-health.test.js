'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { test } = require('node:test');

const { EgressPoolNodeHealth, exitIdentity } = require('../lib/runtime/egress-pool-node-health');
const { EgressPoolRuntime } = require('../lib/runtime/egress-pool-runtime');
const { fetchWithEgressRotation } = require('../lib/server/opencode-free-egress-rotation');
const {
  EGRESS_POOL_NODE_FREE_LIMIT_COOLDOWN_MS,
  EGRESS_POOL_NODE_MAX_COOLDOWN_MS,
  EGRESS_POOL_NODE_NETWORK_COOLDOWN_MS
} = require('../lib/cli/config/constants');
const { handleEgressPoolRequest, matchEgressPoolRoute } = require('../lib/server/webui-egress-pool-routes');

function vless(server, extra = {}) {
  return {
    protocol: 'vless', server, port: 443, uuid: `u-${server}`, network: 'tcp', tls: true,
    security: 'reality', sni: server, publicKey: 'pk', shortId: 'sid', fingerprint: 'ios', ...extra
  };
}

function memoryHealth(now) {
  return new EgressPoolNodeHealth({ now: () => now.value });
}

function bind(health, servers) {
  health.bindNodes(servers.map((server, index) => ({ name: `node-${index}`, node: vless(server, { name: `🇺🇸 US-${index}` }) })));
}

// ── 账本：冷却、退避、恢复 ──────────────────────────────────────────────────

test('a free-limit failure cools the node, records who used it, and backs off on repeats', () => {
  const now = { value: 1_000_000 };
  const health = memoryHealth(now);
  bind(health, ['a.example.com', 'b.example.com']);

  const first = health.recordFailure('node-0', 'free_limit', { accountRef: 'acct_a', model: 'opencode/glm-5.3-flash-free' });
  assert.equal(first, EGRESS_POOL_NODE_FREE_LIMIT_COOLDOWN_MS);
  assert.equal(health.isCooling('node-0'), true);
  const second = health.recordFailure('node-0', 'free_limit', { accountRef: 'acct_a' });
  assert.equal(second, Math.min(EGRESS_POOL_NODE_MAX_COOLDOWN_MS, first * 2));

  const view = health.snapshot();
  const node0 = view.nodes.find((node) => node.name === 'node-0');
  assert.equal(node0.label, '🇺🇸 US-0');
  assert.equal(node0.failures, 2);
  assert.equal(node0.failuresByKind.free_limit, 2);
  assert.equal(node0.cooling, true);
  assert.equal(node0.cooldownKind, 'free_limit');
  assert.ok(node0.cooldownRemainingMs > 0);
  assert.deepEqual(node0.accounts.map((entry) => [entry.accountRef, entry.uses]), [['acct_a', 2]]);
  assert.equal(view.events[0].type, 'cooldown');
  assert.equal(view.events[0].model, '');
  assert.equal(view.events[1].model, 'opencode/glm-5.3-flash-free');
  // 节点凭据不进账本快照。
  assert.equal(JSON.stringify(view).includes('u-a.example.com'), false);

  now.value += second + 1;
  assert.equal(health.isCooling('node-0'), false);
});

test('rotation picks the next node that is not cooling, and the earliest-thawing one when all are', () => {
  const now = { value: 5_000 };
  const health = memoryHealth(now);
  bind(health, ['a.example.com', 'b.example.com', 'c.example.com']);
  health.recordFailure('node-1', 'free_limit');
  assert.equal(health.pickNext(0), 2, 'node-1 is skipped while cooling');
  health.recordFailure('node-2', 'network');
  health.recordFailure('node-0', 'free_limit');
  // 全部冷却：选最早解冻的（node-2 的网络冷却最短）。
  assert.equal(health.pickNext(0), 2);
});

test('a network cooldown is lifted early by a successful probe or request; a free-limit cooldown is not', () => {
  const now = { value: 10_000 };
  const health = memoryHealth(now);
  bind(health, ['a.example.com', 'b.example.com']);
  health.recordFailure('node-0', 'network');
  health.recordFailure('node-1', 'free_limit');
  assert.deepEqual(health.dueForProbe(), ['node-0', 'node-1'], 'never-probed nodes and network-cooled nodes are due');

  health.recordProbe('node-0', { ok: true, latencyMs: 120 });
  health.recordProbe('node-1', { ok: true, latencyMs: 80 });
  assert.equal(health.isCooling('node-0'), false, 'probe ok lifts a network cooldown');
  assert.equal(health.isCooling('node-1'), true, 'reachability does not prove the free quota is back');
  assert.equal(health.snapshot().nodes[0].probe.latencyMs, 120);
  assert.equal(health.snapshot().events[0].type, 'recovered');

  health.recordFailure('node-0', 'network');
  health.recordSuccess('node-0', { accountRef: 'acct_b' });
  assert.equal(health.isCooling('node-0'), false, 'a request that succeeded through the node proves it reachable');
  assert.equal(health.clearCooldown('node-1'), true);
  assert.equal(health.isCooling('node-1'), false);
  assert.ok(EGRESS_POOL_NODE_NETWORK_COOLDOWN_MS > 0);
});

test('the ledger survives a restart and follows the exit, not the node-N index', () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-egress-health-'));
  try {
    const now = { value: 100_000 };
    const first = new EgressPoolNodeHealth({ fs, aiHomeDir: dir, now: () => now.value });
    first.bindNodes([{ name: 'node-0', node: vless('a.example.com') }, { name: 'node-1', node: vless('b.example.com') }]);
    first.recordFailure('node-1', 'free_limit', { accountRef: 'acct_a' });
    assert.equal(first.flush(), true);
    const file = nodePath.join(dir, 'run', 'egress-pool', 'node-health.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, 'utf8').includes('u-b.example.com'), false, 'no credentials on disk');

    // 重启后节点顺序变了：b 现在是 node-0，冷却仍跟着 b。
    const second = new EgressPoolNodeHealth({ fs, aiHomeDir: dir, now: () => now.value });
    second.bindNodes([{ name: 'node-0', node: vless('b.example.com') }, { name: 'node-1', node: vless('a.example.com') }]);
    assert.equal(second.isCooling('node-0'), true);
    assert.equal(second.isCooling('node-1'), false);
    assert.equal(exitIdentity(vless('B.Example.com')), 'vless|b.example.com|443');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 运行时：冷却感知的轮换 + 恢复探测 ───────────────────────────────────────

function runtimeWithFakeCore(now, overrides = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const state = { spawned: false };
  const calls = [];
  const health = memoryHealth(now);
  const runtime = new EgressPoolRuntime({
    aiHomeDir: '/home/.ai_home',
    nodes: [vless('a.example.com'), vless('b.example.com'), vless('c.example.com')],
    mixedPort: 17900,
    controllerPort: 19100,
    health,
    fs: {
      statSync: (filePath) => {
        if (filePath === nodePath.join('/home/.ai_home', 'tools', 'mihomo')) return { isFile: () => true, size: 4096 };
        throw new Error('ENOENT');
      },
      mkdirSync() {}, chmodSync() {}, writeFileSync() {}
    },
    spawn: () => { state.spawned = true; return child; },
    fetch: async (url, init) => {
      if (!state.spawned) throw new Error('ECONNREFUSED');
      calls.push({ url, method: (init && init.method) || 'GET', body: (init && init.body) || '' });
      if (url.includes('/delay?')) {
        const down = (overrides.downNodes || []).some((name) => url.includes(`/proxies/${name}/delay`));
        return down ? { ok: false, text: async () => '{"message":"Timeout"}' } : { ok: true, text: async () => '{"delay":88}' };
      }
      return { ok: true, text: async () => '{}' };
    },
    networkInterfaces: () => ({ en1: [{ family: 'IPv4', address: '10.0.0.2', internal: false }] }),
    startupTimeoutMs: 60,
    startupPollIntervalMs: 5,
    switchSettleMs: 0,
    probeIntervalMs: 0
  });
  return { runtime, calls, health };
}

test('the runtime skips cooling nodes when it rotates and records the switch', async () => {
  const now = { value: 50_000 };
  const { runtime, calls } = runtimeWithFakeCore(now);
  assert.equal((await runtime.start()).ok, true);
  runtime.recordNodeOutcome('node-1', { ok: false, kind: 'free_limit' }, { accountRef: 'acct_a' });
  assert.equal(runtime.status.activeNode, 'node-0', 'a non-active node cooling does not move the pool');
  assert.equal(await runtime.rotateNode('node-0', 'free_limit'), 'node-2', 'node-1 is cooling');
  const put = calls.filter((call) => call.method === 'PUT').pop();
  assert.deepEqual(JSON.parse(put.body), { name: 'node-2' });
  const events = runtime.healthSnapshot().events;
  assert.equal(events[0].type, 'switch');
  assert.equal(events[0].from, 'node-0');
  assert.equal(events[0].node, 'node-2');
  assert.equal(events[0].reason, 'free_limit');
  assert.equal(runtime.status.coolingCount, 1);
  runtime.stop();
});

test('recovery probes go through the core delay API without switching the active node', async () => {
  const now = { value: 70_000 };
  const { runtime, calls } = runtimeWithFakeCore(now, { downNodes: ['node-2'] });
  await runtime.start();
  runtime.recordNodeOutcome('node-1', { ok: false, kind: 'network' });
  const results = await runtime.probeDue({ all: true });
  assert.deepEqual(results.map((entry) => [entry.name, entry.ok]), [['node-0', true], ['node-1', true], ['node-2', false]]);
  const probes = calls.filter((call) => call.url.includes('/delay?'));
  assert.equal(probes.length, 3);
  assert.match(probes[0].url, /timeout=\d+&url=https%3A%2F%2Fwww\.gstatic\.com%2Fgenerate_204/);
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, 'probing never switches the pool');
  const view = runtime.healthSnapshot();
  assert.equal(view.nodes[1].cooling, false, 'node-1 recovered by probe');
  assert.equal(view.nodes[0].probe.latencyMs, 88);
  assert.equal(view.nodes[2].probe.ok, false);
  runtime.stop();
});

// ── 请求路径：每个出口结果都记进账本 ───────────────────────────────────────

test('pool-bound requests record success and egress-bound failures per node; other egress is not recorded', async () => {
  const outcomes = [];
  let active = 'node-0';
  const limited = Object.assign(new Error('HTTP 429'), {
    code: 'HTTP_429', statusCode: 429,
    responseBody: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}'
  });
  let calls = 0;
  const result = await fetchWithEgressRotation(async () => {
    calls += 1;
    if (calls === 1) throw limited;
    return 'ok';
  }, {
    poolBound: true,
    provider: 'opencode',
    currentNode: () => active,
    rotate: async (from, reason) => { outcomes.push(['rotate', from, reason]); active = 'node-1'; return active; },
    recordOutcome: (node, outcome) => outcomes.push([node, outcome.ok, outcome.kind || ''])
  });
  assert.equal(result, 'ok');
  assert.deepEqual(outcomes, [['node-0', false, 'free_limit'], ['rotate', 'node-0', 'free_limit'], ['node-1', true, '']]);

  const unbound = [];
  await fetchWithEgressRotation(async () => 'ok', {
    poolBound: false, currentNode: () => 'node-0', recordOutcome: (...args) => unbound.push(args)
  });
  assert.deepEqual(unbound, []);
});

// ── WebUI 路由 ─────────────────────────────────────────────────────────────

function capture() {
  const res = {};
  return { res, writeJson: (_res, status, body) => { res.status = status; res.body = body; } };
}

test('the egress pool route serves the ledger view and runs node actions', async () => {
  assert.equal(matchEgressPoolRoute('GET', '/v0/webui/egress-pool'), true);
  assert.equal(matchEgressPoolRoute('POST', '/v0/webui/egress-pool/probe'), true);
  assert.equal(matchEgressPoolRoute('POST', '/v0/webui/egress-pool/nodes/node-3/select'), true);
  assert.equal(matchEgressPoolRoute('POST', '/v0/webui/egress-pool/nodes/node-3/clear-cooldown'), true);
  assert.equal(matchEgressPoolRoute('DELETE', '/v0/webui/egress-pool'), false);

  const actions = [];
  const deps = {
    describeEgressPool: () => ({ available: true, status: { ready: true, nodeCount: 2 }, nodes: [{ name: 'node-0' }], events: [] }),
    runEgressPoolAction: async (action, node) => { actions.push([action, node]); return { ok: true }; },
    listEgressPoolBoundAccounts: () => [{ accountRef: 'acct_a', provider: 'opencode' }]
  };
  const get = capture();
  await handleEgressPoolRequest({ method: 'GET', pathname: '/v0/webui/egress-pool', aiHomeDir: '/x', deps, ...get });
  assert.equal(get.res.status, 200);
  assert.equal(get.res.body.status.nodeCount, 2);
  assert.deepEqual(get.res.body.boundAccounts, [{ accountRef: 'acct_a', provider: 'opencode' }]);

  const select = capture();
  await handleEgressPoolRequest({ method: 'POST', pathname: '/v0/webui/egress-pool/nodes/node-1/select', deps, ...select });
  const probe = capture();
  await handleEgressPoolRequest({
    method: 'POST', pathname: '/v0/webui/egress-pool/probe', deps,
    readRequestBody: async () => Buffer.from('{"node":"node-1"}'), ...probe
  });
  assert.deepEqual(actions, [['select', 'node-1'], ['probe', 'node-1']]);

  const bad = capture();
  await handleEgressPoolRequest({
    method: 'POST', pathname: '/v0/webui/egress-pool/probe', deps,
    readRequestBody: async () => Buffer.from('{not json'), ...bad
  });
  assert.equal(bad.res.status, 400);
});

// 2026-10-19 真机：node-1..6 都回 403 FreeTierError「detected abusive traffic from this IP address」。
// 这是出口 IP 被拉黑：不是形状问题（不换形状重发）、不会几分钟内翻转（长时间冷却）、探测证明不了解封。
test('an IP-blacklisted exit is cooled for hours, not retried with another shape, and not cleared by a probe', async () => {
  const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');
  const { egressFailureKind } = require('../lib/server/opencode-free-egress-rotation');
  const { __private: zen } = require('../lib/server/opencode-zen-free-client');
  const { EGRESS_POOL_NODE_IP_BLOCKED_COOLDOWN_MS } = require('../lib/cli/config/constants');
  const body = JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account." } });
  const error = Object.assign(new Error('HTTP 403'), { code: 'HTTP_403', statusCode: 403, responseBody: body });

  const policy = classifyUpstreamFailure({ provider: 'opencode', statusCode: 403, body });
  assert.equal(policy.failureReason, 'opencode_free_tier_client_gated', 'still no account accounting');
  assert.equal(policy.openCodeFreeIpBlocked, true);
  assert.match(policy.detail, /出口 IP/);
  assert.equal(egressFailureKind(error, 'opencode', 60000), 'ip_blocked');
  assert.equal(zen.isZenFreeGateRejection(403, body), false, 'no shape retry for a blacklisted IP');

  const now = { value: 1_000 };
  const health = memoryHealth(now);
  bind(health, ['a.example.com', 'b.example.com']);
  assert.equal(health.recordFailure('node-0', 'ip_blocked'), EGRESS_POOL_NODE_IP_BLOCKED_COOLDOWN_MS);
  assert.equal(health.recordFailure('node-0', 'ip_blocked'), EGRESS_POOL_NODE_IP_BLOCKED_COOLDOWN_MS, 'fixed, no backoff');
  health.recordProbe('node-0', { ok: true, latencyMs: 50 });
  assert.equal(health.isCooling('node-0'), true, 'reachability does not prove the IP was unblocked');
  assert.equal(health.pickNext(1), 1, 'rotation skips the blacklisted node');
});

// 2026-10-19 真机截图：跳数用完时池停在刚被拉黑的 node-12 上，下一个请求还得先撞它一次。
test('when the active exit goes into cooldown the pool moves off it right away', async () => {
  const now = { value: 90_000 };
  const { runtime } = runtimeWithFakeCore(now);
  await runtime.start();
  assert.equal(runtime.status.activeNode, 'node-0');
  runtime.recordNodeOutcome('node-0', { ok: false, kind: 'ip_blocked' });
  await runtime.rotationQueue;
  assert.equal(runtime.status.activeNode, 'node-1');
  runtime.stop();
});
