'use strict';

// 节点拦截策略：延迟阈值 / 连不上 / 手动关闭三条路各自独立开关，
// 判定与轮换共用同一份结论（账本 pickNext 与规划器的 allowed 集合）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { test } = require('node:test');

const {
  BLOCK_REASONS,
  DEFAULT_LATENCY_MAX_MS,
  decideNode,
  describeNodePolicy,
  effectiveProbeTimeoutMs,
  isNodeBlocked,
  normalizeNodePolicy,
  readNodePolicy,
  setNodeDisabled,
  writeNodePolicy
} = require('../lib/runtime/egress-pool-node-policy');
const { EgressPoolNodeHealth, exitIdentity } = require('../lib/runtime/egress-pool-node-health');

function vless(server, extra = {}) {
  return {
    protocol: 'vless', server, port: 443, uuid: `u-${server}`, network: 'tcp', tls: true,
    security: 'reality', sni: server, publicKey: 'pk', shortId: 'sid', fingerprint: 'ios', ...extra
  };
}

function tempHome(t) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-node-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── 判定（纯函数）──────────────────────────────────────────────────────────

test('a missing policy blocks nothing and defaults to a 3000ms latency threshold', () => {
  const policy = normalizeNodePolicy(null);
  assert.deepEqual(policy.latency, { enabled: false, maxMs: DEFAULT_LATENCY_MAX_MS });
  assert.equal(policy.unreachable.enabled, false);
  assert.deepEqual(policy.disabled, {});
  // 未启用时，再慢、再不通也不拦。
  assert.equal(isNodeBlocked({ policy, identity: 'i', probe: { ok: true, latencyMs: 99999, at: 1 } }), false);
  assert.equal(isNodeBlocked({ policy, identity: 'i', probe: { ok: false, error: 'probe_unreachable', at: 1 } }), false);
  assert.equal(describeNodePolicy(policy).summary, '未启用任何拦截');
});

test('the latency and unreachable switches are independent', () => {
  const latencyOnly = normalizeNodePolicy({ latency: { enabled: true, maxMs: 2000 } });
  const slow = { ok: true, latencyMs: 5000, at: 1 };
  const down = { ok: false, error: 'probe_unreachable', at: 1 };
  assert.equal(decideNode({ policy: latencyOnly, identity: 'i', probe: slow }).reason, BLOCK_REASONS.latency);
  assert.equal(isNodeBlocked({ policy: latencyOnly, identity: 'i', probe: down }), false, '慢开关不该顺带拦掉连不上');
  assert.equal(isNodeBlocked({ policy: latencyOnly, identity: 'i', probe: { ok: true, latencyMs: 1999, at: 1 } }), false);

  const downOnly = normalizeNodePolicy({ unreachable: { enabled: true } });
  assert.equal(decideNode({ policy: downOnly, identity: 'i', probe: down }).reason, BLOCK_REASONS.unreachable);
  assert.equal(isNodeBlocked({ policy: downOnly, identity: 'i', probe: slow }), false, '连不上开关不该顺带拦掉慢节点');
  assert.equal(isNodeBlocked({ policy: downOnly, identity: 'i', probe: { ok: true, latencyMs: 1, at: 1 } }), false);
});

test('a node that was never probed is unknown, not unusable', () => {
  const policy = normalizeNodePolicy({ latency: { enabled: true, maxMs: 1000 }, unreachable: { enabled: true } });
  assert.equal(isNodeBlocked({ policy, identity: 'i', probe: null }), false);
  assert.equal(isNodeBlocked({ policy, identity: 'i', probe: { ok: true, latencyMs: 0, at: 0 } }), false);
});

test('the block verdict follows the latest probe, so a 10s node stays blocked', () => {
  const policy = normalizeNodePolicy({ latency: { enabled: true, maxMs: 3000 } });
  const probe = { ok: true, latencyMs: 10000, at: 1_000_000 };
  assert.equal(isNodeBlocked({ policy, identity: 'i', probe }), true);
  // 时间流逝本身不解除：否则 10s 的节点过一会儿又能被选中，正是要挡的情况。
  assert.equal(isNodeBlocked({ policy, identity: 'i', probe, now: 1_000_000 + 86_400_000 }), true);
  // 重探出正常延迟后自动放行。
  assert.equal(isNodeBlocked({ policy, identity: 'i', probe: { ok: true, latencyMs: 200, at: 2 } }), false);
});

test('manual block wins over probe results and survives a policy round-trip', (t) => {
  const dir = tempHome(t);
  const identity = exitIdentity(vless('a.example.com'));
  assert.equal(readNodePolicy(fs, dir).disabled[identity], undefined);

  setNodeDisabled(fs, dir, identity, true, { label: '🇺🇸 US-0' }, 1000);
  const policy = readNodePolicy(fs, dir);
  assert.deepEqual(Object.keys(policy.disabled), [identity]);
  // 手动关闭与探测结果无关：探测正常也拦。
  assert.equal(decideNode({ policy, identity, probe: { ok: true, latencyMs: 10, at: 1 } }).reason, BLOCK_REASONS.manual);

  // 局部更新阈值不会丢掉手动关闭的节点。
  writeNodePolicy(fs, dir, { latency: { enabled: true, maxMs: 5000 } }, 2000);
  const updated = readNodePolicy(fs, dir);
  assert.equal(updated.latency.maxMs, 5000);
  assert.ok(updated.disabled[identity], '写阈值不该抹掉手动关闭');

  setNodeDisabled(fs, dir, identity, false, {}, 3000);
  assert.deepEqual(readNodePolicy(fs, dir).disabled, {});
});

test('the latency threshold is clamped to a usable range', () => {
  assert.equal(normalizeNodePolicy({ latency: { maxMs: 10 } }).latency.maxMs, 100);
  assert.equal(normalizeNodePolicy({ latency: { maxMs: 999999 } }).latency.maxMs, 15000);
  assert.equal(normalizeNodePolicy({ latency: { maxMs: 'abc' } }).latency.maxMs, DEFAULT_LATENCY_MAX_MS);
});

test('probe timeout widens past the latency threshold so slow != unreachable', () => {
  const off = normalizeNodePolicy(null);
  assert.equal(effectiveProbeTimeoutMs(off, 5000), 5000);
  const high = normalizeNodePolicy({ latency: { enabled: true, maxMs: 8000 } });
  assert.equal(effectiveProbeTimeoutMs(high, 5000), 9000, '阈值 8s 时探测要等 9s，否则 6s 的节点会被判成连不上');
  const low = normalizeNodePolicy({ latency: { enabled: true, maxMs: 1000 } });
  assert.equal(effectiveProbeTimeoutMs(low, 5000), 5000, '阈值低于探测超时时不缩短');
});

// ── 账本：pickNext 跳过被拦的节点 ───────────────────────────────────────────

function boundHealth(t, policyRef) {
  const dir = tempHome(t);
  const health = new EgressPoolNodeHealth({
    fs,
    aiHomeDir: dir,
    now: () => 1_000_000,
    policyProvider: () => policyRef.value
  });
  health.bindNodes([
    { name: 'node-0', node: vless('a.example.com') },
    { name: 'node-1', node: vless('b.example.com') },
    { name: 'node-2', node: vless('c.example.com') }
  ]);
  return { health, dir };
}

test('pickNext skips nodes the policy blocks, and resumes them once they recover', (t) => {
  const policyRef = { value: normalizeNodePolicy(null) };
  const { health } = boundHealth(t, policyRef);
  // node-1 探测 10s：启用延迟拦截后它不该再被选中。
  health.recordProbe('node-1', { ok: true, latencyMs: 10000 });
  assert.equal(health.pickNext(0), 1, '未启用拦截时仍会选到它');
  policyRef.value = normalizeNodePolicy({ latency: { enabled: true, maxMs: 3000 } });
  assert.equal(health.pickNext(0), 2, '启用后被跳过');
  assert.equal(health.blockedReason('node-1').reason, BLOCK_REASONS.latency);
  assert.equal(health.usableCount(), 2);
  // 重探出正常延迟：自动回到可用集合（不需要用户手动放行）。
  health.recordProbe('node-1', { ok: true, latencyMs: 120 });
  assert.equal(health.pickNext(0), 1);
  assert.equal(health.usableCount(), 3);
});

test('a manually closed node is skipped by rotation and still probed', (t) => {
  const policyRef = { value: normalizeNodePolicy(null) };
  const { health, dir } = boundHealth(t, policyRef);
  setNodeDisabled(fs, dir, health.nodes[2].identity, true, { label: 'US-2' });
  policyRef.value = readNodePolicy(fs, dir);
  assert.equal(health.pickNext(1), 0, 'node-2 被手动关闭：从 node-1 之后绕回去选 node-0');
  assert.deepEqual(health.dueForProbe(8).includes('node-2'), true, '被拦的节点仍要重探');
  const view = health.snapshot();
  const node2 = view.nodes.find((node) => node.name === 'node-2');
  assert.deepEqual([node2.blocked, node2.blockedReason], [true, BLOCK_REASONS.manual]);
  assert.deepEqual([view.nodes[0].blocked, view.nodes[0].blockedReason], [false, '']);
});

test('pickNext prefers a policy-blocked node over a cooling one when everything is out', (t) => {
  const policyRef = { value: normalizeNodePolicy({ unreachable: { enabled: true } }) };
  const { health } = boundHealth(t, policyRef);
  health.recordFailure('node-0', 'network');
  health.recordFailure('node-2', 'network');
  health.recordProbe('node-1', { ok: false, error: 'probe_unreachable' });
  // node-0 与 node-2 冷却中、node-1 只是被拦：优先试被拦的（冷却的刚失败过）。
  assert.equal(health.pickNext(-1), 1);
});

test('the ledger keeps working when the policy cannot be read', (t) => {
  const dir = tempHome(t);
  const health = new EgressPoolNodeHealth({
    fs,
    aiHomeDir: dir,
    now: () => 1_000_000,
    policyProvider: () => { throw new Error('store boom'); }
  });
  health.bindNodes([{ name: 'node-0', node: vless('a.example.com') }]);
  // 策略读不到时按「不拦截」处理：绝不因为策略问题让池空掉。
  assert.deepEqual(health.blockedReason('node-0'), { blocked: false, reason: '', detail: '' });
  assert.equal(health.pickNext(-1), 0);
});
