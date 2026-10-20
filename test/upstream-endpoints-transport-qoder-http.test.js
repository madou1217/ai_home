'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { qoderHttpTransport } = require('../lib/server/upstream-endpoints-transport-qoder-http');
const { runTransportChain } = require('../lib/server/upstream-endpoints-transport-chain');

const SESSION_ID = 'session-ccdbf520-9d60-4bd1-afad-b4d38fd4f736';
const ACCOUNT = Object.freeze({
  provider: 'qodercn',
  accountRef: 'acct_test_qodercn',
  email: 'qoder@example.test'
});

function makeRes() {
  const headers = {};
  const chunks = [];
  let ended = false;
  const res = {
    statusCode: 0,
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(String(chunk)));
      ended = true;
    },
    on() { return res; },
    once() { return res; },
    removeListener() { return res; },
    get headersSent() { return true; },
    get writableEnded() { return ended; }
  };
  return {
    res,
    headers,
    body: () => Buffer.concat(chunks).toString('utf8'),
    ended: () => ended
  };
}

function makeCtx(overrides = {}) {
  const sink = makeRes();
  const logs = [];
  const recorded = [];
  const successes = [];
  const failures = [];
  const attemptMutable = {};
  const ctx = {
    options: { logRequests: true },
    state: { metrics: { totalFailures: 0, totalTimeouts: 0, providerFailures: {} } },
    res: sink.res,
    requestJson: {
      model: 'qodercn/auto',
      messages: [{ role: 'user', content: '只回复 OK' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object' } } }]
    },
    routeKey: 'qodercn',
    requestStartedAt: Date.now() - 5,
    cooldownMs: 1000,
    requestMeta: { requestId: 'req-1', sessionKey: SESSION_ID },
    deps: {},
    provider: 'qodercn',
    streamRequested: false,
    recordAccountSuccess: (account) => successes.push(account),
    recordAccountFailure: (account, policy) => failures.push({ account, policy }),
    diagnosticMaxAttempts: () => 1,
    recordModelUsage: (record) => recorded.push(record),
    appendProxyRequestLog: (entry) => logs.push(entry),
    control: { attempt: 0, setLastError() {} },
    account: ACCOUNT,
    attemptUpstreamTimeoutMs: 120000,
    attemptMutable,
    ...overrides
  };
  return { ctx, sink, logs, recorded, successes, failures, attemptMutable };
}

function sseFrame(body) {
  // Strategy 拿到的是 transport 已经解包后的内层 OpenAI chunk，不是外层 envelope。
  return `data: ${typeof body === 'string' ? body : JSON.stringify(body)}\n\n`;
}

function successfulStream() {
  const body = new PassThrough();
  body.write(sseFrame({
    id: 'chatcmpl-http-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }]
  }));
  body.write(sseFrame({
    id: 'chatcmpl-http-1',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 24,
      completion_tokens: 198,
      total_tokens: 222,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 195 },
      credits: 0.03626,
      original_credits: 0.03626,
      billable: true
    }
  }));
  body.write(sseFrame('[DONE]'));
  body.end();
  return {
    ok: true,
    status: 200,
    body,
    usage: {
      prompt_tokens: 24,
      completion_tokens: 198,
      total_tokens: 222,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 195 },
      credits: 0.03626,
      original_credits: 0.03626,
      billable: true
    },
    usageMessageId: 'chatcmpl-http-1',
    usageEstimated: false,
    egress: 'proxy',
    proxyFallback: false,
    endpoint: 'https://gateway.qoder.com.cn',
    endpointSource: 'endpoint_cache',
    version: '1.1.72',
    modelKey: 'auto',
    toolCount: 1,
    timing: { firstTokenDuration: 3512, totalDuration: 6239, serverDuration: 91 },
    firstTokenMs: 3512,
    totalMs: 6604,
    requestId: 'req-http-1',
    error: null
  };
}

test('qoderHttpTransport matches qoder variants and runTransportChain dispatches to it', async () => {
  assert.equal(qoderHttpTransport.matches({ provider: 'qoder' }), true);
  assert.equal(qoderHttpTransport.matches({ provider: 'qodercn' }), true);
  assert.equal(qoderHttpTransport.matches({ provider: 'claude' }), false);
  assert.equal(qoderHttpTransport.matches(null), false);
});

test('pre-header HTTP failure falls back to the next transport without recording account failure', async () => {
  let cliCalled = false;
  const fakeCli = {
    matches: () => true,
    async run() {
      cliCalled = true;
      return { action: 'return' };
    }
  };
  const { ctx, logs, failures, attemptMutable } = makeCtx({
    deps: {
      fetchQoderHttpChatCompletion: async () => {
        const error = new Error('qoder_http_sign_failed');
        error.code = 'qoder_http_sign_failed';
        throw error;
      }
    }
  });
  const action = await runTransportChain(ctx, [qoderHttpTransport, fakeCli]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(cliCalled, true);
  assert.equal(failures.length, 0);
  assert.equal(attemptMutable.streamTransport, undefined);
  assert.equal(attemptMutable.annotations.qoderHttpFallback, true);
  assert.equal(attemptMutable.annotations.qoderHttpErrorCode, 'qoder_http_sign_failed');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].streamTransport, 'qoder_http_failed');
  assert.equal(logs[0].streamRequested, false);
  assert.equal(logs[0].qoderHttpFallback, true);
  assert.match(String(logs[0].error), /qoder_http_sign_failed/);
});

test('streaming annotations drop the pre-finalization estimated flag when exact usage arrives', async () => {
  const exactUsage = {
    prompt_tokens: 24,
    completion_tokens: 198,
    total_tokens: 222,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 195 }
  };
  const state = {
    ok: true,
    status: 200,
    body: new PassThrough(),
    usage: null,
    usageMessageId: '',
    usageEstimated: true,
    usageFinalized: false,
    egress: 'proxy',
    endpoint: 'https://gateway.qoder.com.cn',
    endpointSource: 'endpoint_cache',
    version: '1.1.72',
    modelKey: 'auto',
    toolCount: 0,
    timing: {},
    firstTokenMs: 10,
    requestId: 'req-late-usage',
    error: null
  };
  const { ctx, recorded, attemptMutable } = makeCtx({
    streamRequested: true,
    deps: {
      fetchQoderHttpChatCompletionStream: async () => {
        setTimeout(() => {
          state.usage = exactUsage;
          state.usageMessageId = 'chatcmpl-late-usage';
          state.usageEstimated = false;
          state.usageFinalized = true;
          state.body.write(sseFrame({ id: 'chatcmpl-late-usage', choices: [] }));
          state.body.write(sseFrame('[DONE]'));
          state.body.end();
        }, 10);
        return state;
      }
    }
  });
  const action = await runTransportChain(ctx, [qoderHttpTransport]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].sourceKind, 'server_qoder_http_proxy');
  assert.equal(attemptMutable.annotations.qoderHttpUsageExact, true);
  assert.equal(attemptMutable.annotations.qoderHttpUsageEstimated, undefined);
});

test('streaming HTTP success records exact usage with the shared message event key', async () => {
  const { ctx, sink, logs, recorded, successes, failures, attemptMutable } = makeCtx({
    streamRequested: true,
    deps: {
      fetchQoderHttpChatCompletionStream: async () => successfulStream()
    }
  });
  const action = await runTransportChain(ctx, [qoderHttpTransport]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(sink.res.statusCode, 200);
  assert.equal(sink.headers['x-aih-server-account-ref'], ACCOUNT.accountRef);
  assert.equal(sink.headers['x-aih-server-account-email'], ACCOUNT.email);
  assert.match(sink.body(), /"content":"OK"/);
  assert.equal(sink.body().trim().endsWith('data: [DONE]'), true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].eventKey, 'qodercn:message:chatcmpl-http-1');
  assert.equal(recorded[0].sourceKind, 'server_qoder_http_proxy');
  assert.equal(recorded[0].sessionId, SESSION_ID);
  assert.equal(recorded[0].usage.prompt_tokens, 24);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 0);
  assert.equal(attemptMutable.streamTransport, 'qoder_http_sse');
  assert.equal(attemptMutable.annotations.qoderHttp, true);
  assert.equal(attemptMutable.annotations.qoderHttpEgress, 'proxy');
  assert.equal(attemptMutable.annotations.qoderHttpEndpoint, 'https://gateway.qoder.com.cn');
  assert.equal(attemptMutable.annotations.qoderHttpClientVersion, '1.1.72');
  assert.equal(attemptMutable.annotations.qoderHttpFirstTokenMs, 3512);
  assert.equal(attemptMutable.annotations.qoderHttpUpstreamTotalMs, 6239);
  assert.equal(attemptMutable.annotations.qoderHttpServerDurationMs, 91);
  assert.equal(attemptMutable.annotations.qoderHttpUsageExact, true);
  assert.equal(attemptMutable.annotations.qoderHttpUsageEstimated, undefined);
  assert.equal(attemptMutable.annotations.qoderHttpPromptTokens, 24);
  assert.equal(attemptMutable.annotations.qoderHttpCompletionTokens, 198);
  assert.equal(attemptMutable.annotations.qoderHttpCachedTokens, 20);
  assert.equal(attemptMutable.annotations.qoderHttpReasoningTokens, 195);
  assert.equal(attemptMutable.annotations.qoderHttpCredits, 0.03626);
  assert.equal(attemptMutable.annotations.qoderHttpBillable, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].streamTransport, 'qoder_http_sse');
  assert.equal(logs[0].qoderHttpUsageExact, true);
});

test('stream error after headers records account failure and never falls back', async () => {
  const { ctx, logs, recorded, failures, attemptMutable } = makeCtx({
    streamRequested: true,
    deps: {
      fetchQoderHttpChatCompletionStream: async () => {
        const body = new PassThrough();
        body.write(sseFrame({
          id: 'chatcmpl-http-error',
          choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }]
        }));
        setImmediate(() => {
          const error = new Error('upstream reset');
          error.code = 'ECONNRESET';
          body.destroy(error);
        });
        return {
          ok: true,
          status: 200,
          body,
          usage: null,
          usageMessageId: 'chatcmpl-http-error',
          usageEstimated: false,
          egress: 'proxy',
          endpoint: 'https://gateway.qoder.com.cn',
          endpointSource: 'endpoint_cache',
          version: '1.1.72',
          modelKey: 'auto',
          toolCount: 1,
          timing: {},
          firstTokenMs: 10,
          requestId: 'req-http-error'
        };
      }
    }
  });
  const action = await runTransportChain(ctx, [qoderHttpTransport]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(recorded.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(ctx.state.metrics.totalFailures, 1);
  assert.equal(attemptMutable.streamTransport, 'qoder_http_sse_error');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].streamTransport, 'qoder_http_sse_error');
  assert.match(String(logs[0].error), /upstream reset/);
});

test('stream error after exact usage still records the consumed tokens', async () => {
  const exactUsage = {
    prompt_tokens: 24,
    completion_tokens: 198,
    total_tokens: 222,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 195 },
    credits: 0.03626,
    billable: true
  };
  const { ctx, logs, recorded, failures } = makeCtx({
    streamRequested: true,
    deps: {
      fetchQoderHttpChatCompletionStream: async () => {
        const body = new PassThrough();
        body.write(sseFrame({
          id: 'chatcmpl-http-failed-usage',
          choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }],
          usage: exactUsage
        }));
        setImmediate(() => body.destroy(new Error('tail timing parse failed')));
        return {
          ok: true,
          status: 200,
          body,
          usage: exactUsage,
          usageMessageId: 'chatcmpl-http-failed-usage',
          usageEstimated: false,
          egress: 'proxy',
          endpoint: 'https://gateway.qoder.com.cn',
          version: '1.1.72',
          modelKey: 'auto',
          toolCount: 0,
          timing: { firstTokenDuration: 1, totalDuration: 2, serverDuration: 3 },
          firstTokenMs: 10,
          requestId: 'req-http-failed-usage'
        };
      }
    }
  });
  const action = await runTransportChain(ctx, [qoderHttpTransport]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].eventKey, 'qodercn:message:chatcmpl-http-failed-usage');
  assert.equal(recorded[0].sourceKind, 'server_qoder_http_proxy');
  assert.equal(recorded[0].usage.completion_tokens, 198);
  assert.equal(failures.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].streamTransport, 'qoder_http_sse_error');
  assert.equal(logs[0].qoderHttpUsageExact, true);
});

test('non-stream HTTP success writes chat.completion and records exact usage', async () => {
  const payload = {
    id: 'chatcmpl-http-2',
    object: 'chat.completion',
    created: 1,
    model: 'auto',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 22,
      completion_tokens: 91,
      total_tokens: 113,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 87 },
      credits: 0.02480124,
      billable: true
    }
  };
  Object.defineProperty(payload, 'usageMessageId', { value: 'chatcmpl-http-2', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpEgress', { value: 'proxy', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpEndpoint', { value: 'https://gateway.qoder.com.cn', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpEndpointSource', { value: 'endpoint_cache', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpClientVersion', { value: '1.1.72', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpModelKey', { value: 'auto', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpToolCount', { value: 1, enumerable: false });
  Object.defineProperty(payload, 'qoderHttpFirstTokenMs', { value: 792, enumerable: false });
  Object.defineProperty(payload, 'qoderHttpTiming', {
    value: { firstTokenDuration: 792, totalDuration: 2079, serverDuration: 59 },
    enumerable: false
  });
  Object.defineProperty(payload, 'qoderHttpRequestId', { value: 'req-http-2', enumerable: false });

  const { ctx, sink, logs, recorded, attemptMutable } = makeCtx({
    streamRequested: false,
    deps: {
      fetchQoderHttpChatCompletion: async () => payload
    }
  });
  const action = await runTransportChain(ctx, [qoderHttpTransport]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(sink.res.statusCode, 200);
  assert.equal(JSON.parse(sink.body()).choices[0].message.content, 'OK');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].eventKey, 'qodercn:message:chatcmpl-http-2');
  assert.equal(recorded[0].sourceKind, 'server_qoder_http_proxy');
  assert.equal(attemptMutable.streamTransport, 'qoder_http_json');
  assert.equal(attemptMutable.annotations.qoderHttpFirstTokenMs, 792);
  assert.equal(attemptMutable.annotations.qoderHttpUpstreamTotalMs, 2079);
  assert.equal(attemptMutable.annotations.qoderHttpUsageExact, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].streamTransport, 'qoder_http_json');
});

test('estimated non-stream HTTP usage is marked with the estimated source kind', async () => {
  const payload = {
    id: 'chatcmpl-http-3',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  };
  Object.defineProperty(payload, 'usageEstimated', { value: true, enumerable: false });
  Object.defineProperty(payload, 'usageMessageId', { value: 'chatcmpl-http-3', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpEgress', { value: 'direct', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpEndpoint', { value: 'https://api3.qoder.sh', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpClientVersion', { value: '1.1.73', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpModelKey', { value: 'auto', enumerable: false });
  Object.defineProperty(payload, 'qoderHttpRequestId', { value: 'req-http-3', enumerable: false });

  const { ctx, recorded, attemptMutable } = makeCtx({
    provider: 'qoder',
    account: { provider: 'qoder', accountRef: 'acct_test_qoder' },
    requestJson: { model: 'qoder/auto', messages: [{ role: 'user', content: 'hi' }] },
    deps: {
      fetchQoderHttpChatCompletion: async () => payload
    }
  });
  await runTransportChain(ctx, [qoderHttpTransport]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].sourceKind, 'server_qoder_http_proxy_estimated');
  assert.equal(attemptMutable.annotations.qoderHttpUsageEstimated, true);
  assert.equal(attemptMutable.annotations.qoderHttpUsageExact, undefined);
});

test('attempt chain wires qoder HTTP before the CLI fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'upstream-endpoints-attempt.js'), 'utf8');
  const match = source.match(/runTransportChain\(transportCtx, \[([^\]]*qoderHttpTransport[^\]]*)\]\)/);
  assert.ok(match, 'qoderHttpTransport must be registered in the attempt chain');
  const chain = match[1].split(',').map((entry) => entry.trim()).filter(Boolean);
  const httpIndex = chain.indexOf('qoderHttpTransport');
  const cliIndex = chain.indexOf('qoderCliTransport');
  assert.ok(httpIndex >= 0, 'qoderHttpTransport missing from the chain');
  assert.ok(cliIndex > httpIndex, 'qoder HTTP must run before the CLI fallback');
});

test('HTTP usage event key is shared with the session scanner', () => {
  const { __private } = require('../lib/server/upstream-endpoints-transport-qoder-http');
  assert.equal(__private.qoderHttpUsageEventKey('qoder', 'chatcmpl-x', 'req'), 'qoder:message:chatcmpl-x');
  assert.equal(__private.qoderHttpUsageEventKey('qodercn', '', 'req'), 'qodercn:http:req');
  assert.equal(__private.qoderHttpUsageEventKey('qodercn', '', ''), undefined);
});
