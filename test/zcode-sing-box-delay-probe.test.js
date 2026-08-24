'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  probeSingBoxOutboundDelay,
  probeSingBoxOutboundDelays
} = require('../lib/server/zcode-sing-box-delay-probe');

function response(statusCode, body) {
  return {
    statusCode,
    body: { text: async () => body }
  };
}

test('sing-box delay 探针只读调用指定 outbound，并返回真实延迟', async () => {
  const calls = [];
  const result = await probeSingBoxOutboundDelay({
    controllerPort: 23990,
    controllerSecret: 'controller-secret',
    outboundTag: 'aih-zcode-target-a',
    targetUrl: 'https://www.gstatic.com/generate_204',
    timeoutMs: 4321,
    requestImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(200, JSON.stringify({ delay: 37 }));
    }
  });

  assert.deepEqual(result, {
    ok: true,
    measured: true,
    latencyMs: 37
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/proxies/aih-zcode-target-a/delay');
  assert.equal(url.searchParams.get('timeout'), '4321');
  assert.equal(url.searchParams.get('url'), 'https://www.gstatic.com/generate_204');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.authorization, 'Bearer controller-secret');
  assert.equal(calls[0].options.body, undefined);
});

test('节点级超时写为 -1，controller 鉴权失败不污染节点健康状态', async () => {
  const timeout = await probeSingBoxOutboundDelay({
    controllerPort: 23990,
    controllerSecret: 'secret',
    outboundTag: 'node-timeout',
    requestImpl: async () => response(504, 'timeout')
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.measured, true);
  assert.equal(timeout.latencyMs, -1);

  const unauthorized = await probeSingBoxOutboundDelay({
    controllerPort: 23990,
    controllerSecret: 'secret',
    outboundTag: 'node-a',
    requestImpl: async () => response(401, 'unauthorized')
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.measured, false);
  assert.equal(unauthorized.latencyMs, null);
});

test('候选测速使用有界并发、保持输入顺序并隔离单节点失败', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await probeSingBoxOutboundDelays({
    controllerPort: 23990,
    controllerSecret: 'secret',
    concurrency: 2,
    candidates: [
      { nodeId: 'node-a', outboundTag: 'tag-a' },
      { nodeId: 'node-b', outboundTag: 'tag-b' },
      { nodeId: 'node-c', outboundTag: 'tag-c' },
      { nodeId: 'node-d', outboundTag: 'tag-d' }
    ],
    probeOutbound: async ({ outboundTag }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      if (outboundTag === 'tag-c') {
        return { ok: false, measured: true, latencyMs: -1, error: 'timeout' };
      }
      return {
        ok: true,
        measured: true,
        latencyMs: Number(outboundTag.at(-1).charCodeAt(0))
      };
    }
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(result.results.map((item) => item.nodeId), [
    'node-a', 'node-b', 'node-c', 'node-d'
  ]);
  assert.deepEqual(result.results.map((item) => item.latencyMs), [97, 98, -1, 100]);
  assert.equal(result.measuredCount, 4);
  assert.equal(result.healthyCount, 3);
  assert.equal(result.failedCount, 1);
});
