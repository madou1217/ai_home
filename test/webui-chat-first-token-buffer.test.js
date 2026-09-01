'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPreFirstTokenBuffer } = require('../lib/server/webui-chat-routes');

function createFixture(options = {}) {
  const written = [];
  const buffer = createPreFirstTokenBuffer((item) => written.push(item), options);
  return { buffer, written };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('首 token 前事件在 TTL 内保持缓冲，不产生任何直写', async () => {
  const { buffer, written } = createFixture({ ttlMs: 80, maxEvents: 50 });

  buffer.push({ type: 'thinking', thinking: 'a' });
  buffer.push({ type: 'thinking', thinking: 'b' });
  await sleep(30);

  assert.equal(written.length, 0);
  assert.equal(buffer.isVisible(), false);

  buffer.flush();
  assert.deepEqual(written.map((item) => item.thinking), ['a', 'b']);
});

test('缓冲超过 TTL 后兜底倒出已缓冲事件并停止后续缓冲', async () => {
  const { buffer, written } = createFixture({ ttlMs: 30, maxEvents: 50 });

  buffer.push({ type: 'thinking', thinking: 'warmup' });
  assert.equal(written.length, 0);

  await sleep(80);
  assert.deepEqual(written.map((item) => item.thinking), ['warmup']);
  assert.equal(buffer.isVisible(), true);

  // 兜底触发后：后续事件直写，不再进缓冲。
  buffer.push({ type: 'thinking', thinking: 'after-ttl' });
  assert.deepEqual(written.map((item) => item.thinking), ['warmup', 'after-ttl']);
});

test('缓冲达到条数上限立即倒出，不等 TTL', async () => {
  const { buffer, written } = createFixture({ ttlMs: 60_000, maxEvents: 3 });

  buffer.push({ type: 'thinking', thinking: '1' });
  buffer.push({ type: 'thinking', thinking: '2' });
  assert.equal(written.length, 0);

  buffer.push({ type: 'thinking', thinking: '3' });
  assert.deepEqual(written.map((item) => item.thinking), ['1', '2', '3']);
  assert.equal(buffer.isVisible(), true);

  buffer.push({ type: 'thinking', thinking: '4' });
  assert.deepEqual(written.map((item) => item.thinking), ['1', '2', '3', '4']);
});

test('首个 delta 到达时 flush 倒出缓冲且幂等，无重复写', () => {
  const { buffer, written } = createFixture({ ttlMs: 60_000, maxEvents: 50 });

  buffer.push({ type: 'thinking', thinking: 'x' });
  buffer.flush();
  buffer.flush();

  assert.deepEqual(written.map((item) => item.thinking), ['x']);
  assert.equal(buffer.isVisible(), true);
});
