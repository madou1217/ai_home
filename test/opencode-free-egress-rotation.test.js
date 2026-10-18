'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { fetchWithEgressRotation, isEgressBoundFailure } = require('../lib/server/opencode-free-egress-rotation');

const FREE_LIMIT_BODY = JSON.stringify({
  type: 'error',
  error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' }
});

function httpError(status, body = '') {
  const error = new Error(`HTTP ${status} ${body}`);
  error.code = `HTTP_${status}`;
  error.statusCode = status;
  error.responseBody = body;
  return error;
}

function scripted(outcomes) {
  const calls = { count: 0 };
  const call = async () => {
    const outcome = outcomes[Math.min(calls.count, outcomes.length - 1)];
    calls.count += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { call, calls };
}

function rotator() {
  const rotations = [];
  return {
    rotations,
    rotate: async () => {
      const node = `node-${rotations.length + 1}`;
      rotations.push(node);
      return node;
    }
  };
}

// ── 分类 ───────────────────────────────────────────────────────────────────

test('a free-usage 429 is an egress-bound failure', () => {
  assert.equal(isEgressBoundFailure(httpError(429, FREE_LIMIT_BODY), 'opencode', 60000), true);
});

test('a dead pool node (network error) is an egress-bound failure', () => {
  const error = new Error('fetch failed');
  error.code = 'ECONNRESET';
  assert.equal(isEgressBoundFailure(error, 'opencode', 60000), true);
});

test('a client-gate 403 is egress-bound too (the gate varies by exit IP)', () => {
  // 实测：同一请求 node-0/3 被 FreeTierError 403，node-10/20/35/50/60/70 全 200。
  const body = JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode" } });
  assert.equal(isEgressBoundFailure(httpError(403, body), 'opencode', 60000), true);
});

test('an ordinary 403 (not the free-tier gate) is not egress-bound', () => {
  assert.equal(isEgressBoundFailure(httpError(403, '{"error":"forbidden"}'), 'opencode', 60000), false);
});

// ── 原地换出口重发（单账号池的核心场景）──────────────────────────────────────

test('a limited egress is rotated and the same request succeeds on the next node', async () => {
  // 2026-10-18 事故：单账号池 maxAttempts=1，旧逻辑轮换完节点却没有下一次尝试。
  const { call, calls } = scripted([httpError(429, FREE_LIMIT_BODY), { status: 200 }]);
  const { rotate, rotations } = rotator();
  const result = await fetchWithEgressRotation(call, { poolBound: true, rotate, provider: 'opencode' });
  assert.equal(result.status, 200);
  assert.equal(calls.count, 2);
  assert.deepEqual(rotations, ['node-1']);
});

test('a run of limited nodes is crossed until one works', async () => {
  const limited = httpError(429, FREE_LIMIT_BODY);
  const { call, calls } = scripted([limited, limited, limited, { status: 200 }]);
  const { rotate, rotations } = rotator();
  const hops = [];
  const result = await fetchWithEgressRotation(call, {
    poolBound: true, rotate, provider: 'opencode', onRotate: (_node, hop) => hops.push(hop)
  });
  assert.equal(result.status, 200);
  assert.equal(calls.count, 4);
  assert.equal(rotations.length, 3);
  assert.deepEqual(hops, [1, 2, 3]);
});

test('hops are bounded so a fully limited pool fails fast', async () => {
  const { call, calls } = scripted([httpError(429, FREE_LIMIT_BODY)]);
  const { rotate } = rotator();
  await assert.rejects(fetchWithEgressRotation(call, { poolBound: true, rotate, provider: 'opencode', maxHops: 2 }), /HTTP 429/);
  assert.equal(calls.count, 3);
});

test('an account not bound to the pool never rotates the shared pool', async () => {
  const { call, calls } = scripted([httpError(429, FREE_LIMIT_BODY)]);
  const { rotate, rotations } = rotator();
  await assert.rejects(fetchWithEgressRotation(call, { poolBound: false, rotate, provider: 'opencode' }), /HTTP 429/);
  assert.equal(calls.count, 1);
  assert.deepEqual(rotations, []);
});

test('a non-egress failure is surfaced immediately', async () => {
  const { call, calls } = scripted([httpError(400, '{"error":"bad request"}')]);
  const { rotate, rotations } = rotator();
  await assert.rejects(fetchWithEgressRotation(call, { poolBound: true, rotate, provider: 'opencode' }), /HTTP 400/);
  assert.equal(calls.count, 1);
  assert.deepEqual(rotations, []);
});

test('a failed rotation surfaces the original error', async () => {
  const { call, calls } = scripted([httpError(429, FREE_LIMIT_BODY)]);
  await assert.rejects(
    fetchWithEgressRotation(call, { poolBound: true, rotate: async () => '', provider: 'opencode' }),
    /HTTP 429/
  );
  assert.equal(calls.count, 1);
});

test('a cancelled client request stops rotating', async () => {
  const controller = new AbortController();
  controller.abort();
  const { call, calls } = scripted([httpError(429, FREE_LIMIT_BODY), { status: 200 }]);
  const { rotate, rotations } = rotator();
  await assert.rejects(
    fetchWithEgressRotation(call, { poolBound: true, rotate, provider: 'opencode', signal: controller.signal }),
    /HTTP 429/
  );
  assert.equal(calls.count, 1);
  assert.deepEqual(rotations, []);
});

// ── 并发请求共享一个池：比较后再换 ─────────────────────────────────────────

test('the rotation is told which node the failed request used', async () => {
  const { call } = scripted([httpError(429, FREE_LIMIT_BODY), { status: 200 }]);
  const seen = [];
  await fetchWithEgressRotation(call, {
    poolBound: true,
    provider: 'opencode',
    currentNode: () => 'node-0',
    rotate: async (fromNode) => { seen.push(fromNode); return 'node-1'; }
  });
  assert.deepEqual(seen, ['node-0']);
});
