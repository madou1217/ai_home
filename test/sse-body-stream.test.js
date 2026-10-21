'use strict';

// 回归：SSE 中继流在「消费方已离场」后被 destroy(error) 不得杀死进程。
// 2026-10-21 本机 server 因 qoder_cli_no_output_180000ms / opencode free tier
// 两条路径各崩一次：客户端在 CLI 首字节前断开 → forwarder 立刻返回并摘掉 error
// 监听 → 180s 后看门狗 destroy(error) → events 层 throw → 整个进程退出。

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSseBodyStream } = require('../lib/server/sse-body-stream');
const { pipeReadableBodyToResponse } = require('../lib/server/upstream-stream-forwarder');

function createClosedResponse() {
  const response = new EventEmitter();
  response.writableEnded = false;
  response.destroyed = true; // 客户端在建流之前就已断开
  response.write = () => true;
  response.end = () => { response.writableEnded = true; };
  return response;
}

function createLiveResponse() {
  const response = new EventEmitter();
  response.writableEnded = false;
  response.destroyed = false;
  response.chunks = [];
  response.write = (chunk) => { response.chunks.push(Buffer.from(chunk)); return true; };
  response.end = () => { response.writableEnded = true; };
  return response;
}

test('createSseBodyStream 在无人监听时吞掉 destroy(error)', async () => {
  const body = createSseBodyStream();
  body.destroy(new Error('qoder_cli_no_output_180000ms'));
  // 未捕获的 error 会让本进程直接退出；能走到这里即通过。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(body.destroyed, true);
});

test('消费方已离场（res 已关闭）后 destroy(error) 不崩进程', async () => {
  const body = createSseBodyStream();
  await pipeReadableBodyToResponse(body, createClosedResponse());
  assert.equal(body.listenerCount('error'), 1, '兜底监听必须仍在');

  body.destroy(new Error('qoder_cli_no_output_180000ms'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(body.destroyed, true);
});

test('消费方在场时错误仍按原契约传给 forwarder', async () => {
  const body = createSseBodyStream();
  const response = createLiveResponse();
  const piping = pipeReadableBodyToResponse(body, response);
  body.write('data: {"choices":[]}\n\n');
  await new Promise((resolve) => setImmediate(resolve));

  body.destroy(new Error('upstream failed'));
  await assert.rejects(piping, /upstream failed/);
  assert.equal(response.chunks.length, 1, '已写出的帧不该丢');
});

test('正常结束路径不受兜底监听影响', async () => {
  const body = createSseBodyStream();
  const response = createLiveResponse();
  const piping = pipeReadableBodyToResponse(body, response);
  body.write('data: {"choices":[]}\n\n');
  body.end();

  const result = await piping;
  assert.equal(result.downstreamDisconnected, false);
  assert.equal(response.chunks.length, 1);
});
