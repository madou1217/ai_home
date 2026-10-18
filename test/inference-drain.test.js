'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createInferenceDrain, isInferencePath, SHUTDOWN_GRACE_MS, DEFAULT_DRAIN_TIMEOUT_MS } = require('../lib/server/inference-drain');

function fakeResponse() {
  return new EventEmitter();
}

// 回归：重启时在途的流式回答被强杀，客户端报 "Connection lost mid-response"。
test('shutdown waits for in-flight inference requests only', async () => {
  const drain = createInferenceDrain();
  const stream = fakeResponse();
  const webuiEvents = fakeResponse();
  drain.track('/v1/messages', stream);
  drain.track('/v0/webui/session-events/stream', webuiEvents);
  assert.equal(drain.inFlight(), 1, 'WebUI long-lived streams never hold the drain');

  let settled = null;
  const waiting = drain.waitForIdle(5000).then((idle) => { settled = idle; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, null, 'drain keeps waiting while a stream is in flight');
  stream.emit('finish');
  stream.emit('close');
  await waiting;
  assert.equal(settled, true);
  assert.equal(drain.inFlight(), 0, 'finish + close release exactly once');
});

test('drain gives up after its timeout so shutdown cannot hang forever', async () => {
  const drain = createInferenceDrain();
  drain.track('/v1beta/models/gemini:streamGenerateContent', fakeResponse());
  assert.equal(await drain.waitForIdle(20), false);
  assert.equal(await createInferenceDrain().waitForIdle(20), true);
});

test('stopper grace covers the drain window', () => {
  assert.ok(SHUTDOWN_GRACE_MS > DEFAULT_DRAIN_TIMEOUT_MS);
  assert.equal(isInferencePath('/v1/responses'), true);
  assert.equal(isInferencePath('/v0/webui/accounts'), false);
});

// 回归守卫（2026-10-18 用户决策：极速重启优先）：排空期间监听已关闭、新请求全部被拒，
// 排空上限就是每次重启的停机时长。曾经的 90s 让重启停机 16–90s，却没保住在途回答。
test('shutdown budget stays short so a restart is fast', () => {
  assert.ok(DEFAULT_DRAIN_TIMEOUT_MS <= 5000, `drain ${DEFAULT_DRAIN_TIMEOUT_MS}ms must stay a short grace`);
  assert.ok(SHUTDOWN_GRACE_MS <= 15000, `shutdown grace ${SHUTDOWN_GRACE_MS}ms must stay bounded`);
});
