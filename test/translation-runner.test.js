'use strict';

// AI 翻译的网关请求构造与 SSE 归约。
// 这里不联网：用 ReadableStream 喂入与真实上游同形的分块，验证增量、跨块拼包与错误帧。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildGatewayHeaders,
  buildGatewayPayload,
  buildGatewayUrl,
  pumpChatStream,
  runTranslationStream,
} = require('../lib/server/translation-runner');

function sseStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('translation gateway payload pins stream, temperature and provider routing', () => {
  const payload = buildGatewayPayload({
    model: 'claude-sonnet-4',
    provider: 'Claude',
    messages: [{ role: 'user', content: 'hi' }],
  });
  // 模型 id 保持裸值：provider 由 X-Provider 头钉住。拼成 provider/model 会被网关
  // 当成字面模型 id（agy/gemini-… → 没有账号能服务该模型）。
  assert.equal(payload.model, 'claude-sonnet-4');
  assert.equal(payload.temperature, 0);
  assert.equal(payload.stream, true);
  // 翻译不思考：code-assist 后端会据此省略 thinkingConfig。
  assert.equal(payload.reasoning_effort, 'none');
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'hi' }]);
  // 不默认限制输出长度：译文可能比原文长
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'max_tokens'), false);
  // 会话亲和不写进 body，避免被原样转发给只接受 metadata.user_id 的上游。
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'metadata'), false);

  // 同一 provider/模型固定会话键，账号亲和据此复用暖账号。
  const sessionHeaders = buildGatewayHeaders({
    provider: 'agy',
    sessionKey: 'aih-translation:agy:gemini-2.5-flash',
  });
  assert.equal(sessionHeaders['X-Session-Id'], 'aih-translation:agy:gemini-2.5-flash');

  // 原生带 provider 命名空间的模型 id（如 opencode/glm-…）原样保留
  assert.equal(
    buildGatewayPayload({ model: 'opencode/glm-5.3-flash-free', provider: 'opencode' }).model,
    'opencode/glm-5.3-flash-free',
  );
});

test('translation gateway headers and url target the local loopback gateway', () => {
  assert.equal(buildGatewayUrl({ port: 9527 }), 'http://127.0.0.1:9527/v1/chat/completions');
  const headers = buildGatewayHeaders({ provider: 'Claude', clientKey: 'k1' });
  assert.equal(headers['X-Provider'], 'claude');
  assert.equal(headers.Authorization, 'Bearer k1');
  assert.equal(headers.Accept, 'text/event-stream');
});

test('pumpChatStream accumulates deltas across chunk boundaries and reports usage', async () => {
  const events = [];
  const result = await pumpChatStream(
    sseStream([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n',
      '\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":9}}\n\n',
      'data: [DONE]\n\n',
    ]),
    (event) => events.push(event),
  );

  assert.deepEqual(events, [
    { type: 'delta', content: '你' },
    { type: 'delta', content: '好' },
  ]);
  assert.equal(result.text, '你好');
  assert.deepEqual(result.usage, { total_tokens: 9 });
  assert.equal(result.finishReason, 'stop');
});

test('pumpChatStream ignores malformed frames instead of failing the whole translation', async () => {
  const events = [];
  const result = await pumpChatStream(
    sseStream([
      'data: not-json\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    ]),
    (event) => events.push(event),
  );
  assert.equal(result.text, 'ok');
  assert.deepEqual(events, [{ type: 'delta', content: 'ok' }]);
});

test('pumpChatStream surfaces upstream error frames', async () => {
  await assert.rejects(
    () =>
      pumpChatStream(
        sseStream(['data: {"error":{"message":"rate limit exceeded","type":"rate_limit"}}\n\n']),
        () => {},
      ),
    /rate limit|限流|频繁|请求/i,
  );
});

test('runTranslationStream fails closed without a model and never calls upstream', async () => {
  const result = await runTranslationStream({ model: '', messages: [] }, {}, () => {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'translation_model_required');
  assert.equal(result.text, '');
});
