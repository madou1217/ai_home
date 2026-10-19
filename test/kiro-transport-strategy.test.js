const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const { kiroStreamTransport } = require('../lib/server/upstream-endpoints-transport-kiro');

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    headersSent: false,
    writableEnded: false,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    getHeader(key) { return this.headers[String(key).toLowerCase()]; },
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    flushHeaders() { this.headersSent = true; },
    write(chunk) { this.headersSent = true; this.chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk) this.chunks.push(String(chunk)); this.writableEnded = true; },
    once() {},
    on() {}
  };
}

function createCtx(fetchStream, overrides = {}) {
  const calls = { failures: [], successes: 0, usage: 0, lastError: '' };
  const ctx = {
    options: { logRequests: false },
    state: { metrics: { totalTimeouts: 0, totalFailures: 0, providerFailures: {} } },
    res: createRes(),
    requestJson: { model: 'claude-opus-5.5', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'r1' },
    deps: { fetchKiroChatCompletionStream: fetchStream },
    provider: 'kiro',
    streamRequested: true,
    recordAccountSuccess: () => { calls.successes += 1; },
    recordAccountFailure: (_account, policy) => { calls.failures.push(policy); },
    diagnosticMaxAttempts: () => 2,
    recordModelUsage: () => { calls.usage += 1; },
    appendProxyRequestLog: () => {},
    control: { attempt: 0, setLastError: (value) => { calls.lastError = value; } },
    account: { accountRef: 'acct_test', provider: 'kiro' },
    attemptUpstreamTimeoutMs: 1000,
    attemptMutable: {},
    ...overrides
  };
  return { ctx, calls };
}

function streamOf(text) {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

test('a failure before the first byte retries another account and writes nothing to the client', async () => {
  const error = Object.assign(new Error('model_not_found: Invalid model.'), { code: 'model_not_found', kiroStatusCode: 400 });
  const { ctx, calls } = createCtx(async () => { throw error; });
  const action = await kiroStreamTransport.run(ctx);
  assert.equal(action.action, 'retry_next');
  assert.equal(ctx.res.chunks.length, 0);
  assert.equal(ctx.res.headersSent, false);
  assert.equal(calls.failures[0].kind, 'model_not_available_on_endpoint');
  assert.equal(calls.failures[0].scope, 'model');
});

test('a mid-stream failure is recorded as an account failure, never as a success', async () => {
  const error = Object.assign(new Error('boom'), { code: 'kiro_upstream_capacity', kiroStatusCode: 503 });
  const body = 'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'
    + 'data: {"error":{"message":"boom","code":"kiro_upstream_capacity","status":503}}\n\n';
  const { ctx, calls } = createCtx(async () => ({
    ok: true, status: 200, body: streamOf(body), completion: Promise.resolve({ ok: false, error })
  }));
  const action = await kiroStreamTransport.run(ctx);
  assert.equal(action.action, 'return');
  assert.equal(calls.successes, 0);
  assert.equal(calls.usage, 0);
  assert.equal(calls.failures.length, 1);
  assert.equal(ctx.attemptMutable.streamTransport, 'kiro_event_stream_error');
  assert.match(ctx.res.chunks.join(''), /"error":\{"message":"boom"/);
});

test('a client abort is not counted against the account', async () => {
  const controller = new AbortController();
  controller.abort();
  const error = Object.assign(new Error('kiro_client_aborted'), { code: 'kiro_client_aborted', kiroStatusCode: 499 });
  const { ctx, calls } = createCtx(async () => { throw error; }, { requestMeta: { requestId: 'r2', signal: controller.signal } });
  const action = await kiroStreamTransport.run(ctx);
  assert.equal(action.action, 'break');
  assert.equal(calls.failures.length, 0);
});

test('a completed stream records success and usage', async () => {
  const body = 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'
    + 'data: [DONE]\n\n';
  const { ctx, calls } = createCtx(async () => ({
    ok: true, status: 200, body: streamOf(body), completion: Promise.resolve({ ok: true, result: {} })
  }));
  const action = await kiroStreamTransport.run(ctx);
  assert.equal(action.action, 'return');
  assert.equal(calls.successes, 1);
  assert.equal(calls.usage, 1);
  assert.equal(calls.failures.length, 0);
});
