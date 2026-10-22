'use strict';

// 2026-10-21 报障：保存出口时拿池当前的活动节点直接探一次 204，节点恰好连不上就
// fail-closed 回滚绑定，用户看到「新出口不可用，已恢复原绑定」——可他只是想启用出口池。
// 池的意义就是坏节点自动换，所以探测失败要按池的规则换一个可用节点重探。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MAX_PROBE_HOPS,
  probePoolEgressWithRotation
} = require('../lib/server/egress-pool-egress-probe');

function probeSequence(results) {
  const tried = [];
  return {
    tried,
    probe: async () => {
      const next = results[Math.min(tried.length, results.length - 1)];
      tried.push(next);
      return next;
    }
  };
}

test('a probe that succeeds first time never rotates the pool', async () => {
  const { tried, probe } = probeSequence([{ ok: true }]);
  let rotations = 0;
  const result = await probePoolEgressWithRotation({
    proxyUrl: 'http://127.0.0.1:17890',
    probe,
    currentNode: () => 'node-7',
    rotate: async () => { rotations += 1; return 'node-8'; }
  });
  assert.deepEqual(result, { ok: true, hops: 0, proxyUrl: 'http://127.0.0.1:17890', rotatedTo: '' });
  assert.equal(rotations, 0);
  assert.equal(tried.length, 1);
});

test('a dead node is rotated away and the probe retried on the new exit', async () => {
  const { tried, probe } = probeSequence([{ ok: false, reason: 'curl_exit_35' }, { ok: true }]);
  const rotatedFrom = [];
  const result = await probePoolEgressWithRotation({
    proxyUrl: 'http://127.0.0.1:17890',
    probe,
    currentNode: () => 'node-0',
    rotate: async (fromNode) => { rotatedFrom.push(fromNode); return 'node-1'; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.hops, 1);
  assert.equal(result.rotatedTo, 'node-1');
  assert.deepEqual(rotatedFrom, ['node-0']);
  assert.equal(tried.length, 2);
});

test('a pool whose every exit fails reports the last reason after bounded hops', async () => {
  const { tried, probe } = probeSequence([{ ok: false, reason: 'curl_exit_28' }]);
  let rotations = 0;
  const result = await probePoolEgressWithRotation({
    proxyUrl: 'http://127.0.0.1:17890',
    probe,
    currentNode: () => `node-${rotations}`,
    rotate: async () => { rotations += 1; return `node-${rotations}`; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'curl_exit_28');
  // 首次 + DEFAULT_MAX_PROBE_HOPS 次重试，轮换次数与之一致。
  assert.equal(tried.length, DEFAULT_MAX_PROBE_HOPS + 1);
  assert.equal(rotations, DEFAULT_MAX_PROBE_HOPS);
});

test('a rotation that cannot pick another node stops instead of looping', async () => {
  const { tried, probe } = probeSequence([{ ok: false, reason: 'curl_exit_35' }]);
  const result = await probePoolEgressWithRotation({
    proxyUrl: 'http://127.0.0.1:17890',
    probe,
    currentNode: () => 'node-0',
    rotate: async () => ''
  });
  assert.equal(result.ok, false);
  assert.equal(tried.length, 1);
});

test('a probe that throws is treated as a failed attempt, not a crash', async () => {
  const result = await probePoolEgressWithRotation({
    proxyUrl: 'http://127.0.0.1:17890',
    probe: async () => { throw new Error('spawn failed'); },
    rotate: null
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'spawn failed');
});

test('without a proxy url or probe there is nothing to try', async () => {
  assert.equal((await probePoolEgressWithRotation({ probe: async () => ({ ok: true }) })).reason, 'egress_pool_probe_unavailable');
  assert.equal((await probePoolEgressWithRotation({ proxyUrl: 'http://127.0.0.1:1' })).reason, 'egress_pool_probe_unavailable');
});
