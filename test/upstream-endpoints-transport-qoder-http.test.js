'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { qoderHttpTransport } = require('../lib/server/upstream-endpoints-transport-qoder-http');
const { qoderCliTransport } = require('../lib/server/upstream-endpoints-transport-qoder-cli');
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
  assert.equal(attemptMutable.annotations.qoderHttpErrorCode, undefined,
    'HTTP error classification must not be duplicated outside transportAttempts');
  const attempts = attemptMutable.annotations.transportAttempts;
  assert.equal(attempts.length, 1, 'HTTP failure must produce one unified attempt record');
  assert.equal(attempts[0].transport, 'qoder_http');
  assert.equal(attempts[0].outcome, 'failure');
  assert.equal(attempts[0].errorCode, 'qoder_http_sign_failed');
  assert.equal(attempts[0].stream, false);
  assert.equal(attempts[0].firstTokenMs, undefined, 'no first byte means no firstTokenMs');
  assert.ok(attempts[0].durationMs >= 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].streamTransport, 'qoder_http_failed');
  assert.equal(logs[0].streamRequested, false);
  assert.equal(logs[0].qoderHttpFallback, true);
  assert.equal(logs[0].transportAttemptsPartial, true, 'intermediate fallback lines must be marked');
  assert.match(String(logs[0].error), /qoder_http_sign_failed/);
});

test('fallback logs one unified attempt for HTTP failure and one for CLI success', async () => {
  const payload = {
    id: 'chatcmpl-cli-fallback',
    object: 'chat.completion',
    created: 1,
    model: 'Qwen3.8-Flash',
    choices: [{ index: 0, message: { role: 'assistant', content: 'fallback ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  };
  Object.defineProperty(payload, 'usageEstimated', { value: true, enumerable: false });
  const { ctx, logs, successes, failures, attemptMutable } = makeCtx({
    deps: {
      fetchQoderHttpChatCompletion: async () => {
        const error = new Error('connection refused');
        error.code = 'ECONNREFUSED';
        error.qoderHttpEndpoint = 'https://gateway.qoder.com.cn';
        error.qoderHttpEgress = 'proxy';
        throw error;
      },
      fetchQoderCliChatCompletion: async () => payload
    }
  });
  const action = await runTransportChain(ctx, [qoderHttpTransport, qoderCliTransport]);
  assert.deepEqual(action, { action: 'return' });
  const attempts = attemptMutable.annotations.transportAttempts;
  assert.equal(attempts.length, 2, 'HTTP failure + CLI success must both be visible');
  assert.equal(attempts[0].transport, 'qoder_http');
  assert.equal(attempts[0].outcome, 'failure');
  assert.equal(attempts[0].upstream, 'https://gateway.qoder.com.cn');
  assert.equal(attempts[0].errorCode, 'ECONNREFUSED');
  assert.ok(attempts[0].durationMs >= 0);
  assert.equal(attempts[1].transport, 'qoder_cli');
  assert.equal(attempts[1].outcome, 'success');
  assert.equal(attempts[1].upstream, 'qoder-cli');
  assert.equal(attempts[1].model, 'qodercn/auto');
  assert.equal(attempts[1].stream, false);
  assert.equal(attempts[1].usage.source, 'estimated');
  assert.equal(attempts[1].usage.promptTokens, 10);
  assert.ok(attempts[1].durationMs >= 0);
  assert.equal(failures.length, 0, 'HTTP pre-header failure must not be recorded as account failure');
  assert.equal(successes.length, 1, 'only the CLI success is an account success');
  assert.equal(logs.length, 2);
  assert.equal(logs[0].streamTransport, 'qoder_http_failed');
  assert.equal(logs[0].transportAttemptsPartial, true);
  assert.equal(logs[1].transportAttemptsPartial, undefined, 'final route log is the complete record');
  assert.equal(logs[1].transportAttempts.length, 2, 'final route log must carry both attempts');
  assert.equal(logs[1].transportAttempts[0].transport, 'qoder_http');
  assert.equal(logs[1].transportAttempts[1].transport, 'qoder_cli');
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
  const [attemptRecord] = attemptMutable.annotations.transportAttempts;
  assert.equal(attemptRecord.usage.source, 'exact');
  assert.equal(attemptRecord.usage.promptTokens, 24);
  assert.equal(attemptRecord.usage.completionTokens, 198);
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
  assert.equal(attemptMutable.annotations.qoderHttp, undefined,
    'HTTP must not keep a second parallel stats model');
  const [attemptRecord] = attemptMutable.annotations.transportAttempts;
  assert.equal(attemptRecord.transport, 'qoder_http');
  assert.equal(attemptRecord.outcome, 'success');
  assert.equal(attemptRecord.upstream, 'https://gateway.qoder.com.cn');
  assert.equal(attemptRecord.provider, 'qodercn');
  assert.equal(attemptRecord.accountRef, ACCOUNT.accountRef);
  assert.equal(attemptRecord.model, 'qodercn/auto');
  assert.equal(attemptRecord.stream, true);
  assert.equal(attemptRecord.firstTokenMs, 3512);
  assert.equal(attemptRecord.usage.source, 'exact');
  assert.equal(attemptRecord.usage.promptTokens, 24);
  assert.equal(attemptRecord.usage.completionTokens, 198);
  assert.equal(attemptRecord.usage.totalTokens, 222);
  assert.equal(attemptRecord.usage.cachedTokens, 20);
  assert.equal(attemptRecord.usage.reasoningTokens, 195);
  assert.equal(attemptRecord.usage.credits, 0.03626);
  assert.equal(attemptRecord.usage.billable, true);
  assert.equal(attemptRecord.details.endpointSource, 'endpoint_cache');
  assert.equal(attemptRecord.details.egress, 'proxy');
  assert.equal(attemptRecord.details.clientVersion, '1.1.72');
  assert.equal(attemptRecord.details.upstreamModel, 'auto');
  assert.equal(attemptRecord.details.upstreamTotalMs, 6239);
  assert.equal(attemptRecord.details.serverDurationMs, 91);
  assert.equal(attemptRecord.details.usageMessageId, 'chatcmpl-http-1');
  assert.equal(attemptRecord.details.statusCode, 200);
  assert.equal(attemptRecord.details.streamTransport, 'qoder_http_sse');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].streamTransport, 'qoder_http_sse');
  assert.equal(logs[0].transportAttempts.length, 1, 'unified attempts must be flattened into the log line');
  assert.equal(logs[0].qoderHttpPromptTokens, undefined,
    'token counts must only live in transportAttempts.usage');
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
  const [attemptRecord] = attemptMutable.annotations.transportAttempts;
  assert.equal(attemptRecord.transport, 'qoder_http');
  assert.equal(attemptRecord.outcome, 'failure');
  assert.equal(attemptRecord.errorCode, 'ECONNRESET');
  assert.equal(attemptRecord.usage, undefined);
  assert.equal(attemptRecord.details.policyKind, 'network_error');
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
  const { ctx, logs, recorded, failures, attemptMutable } = makeCtx({
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
  const [attemptRecord] = attemptMutable.annotations.transportAttempts;
  assert.equal(attemptRecord.outcome, 'failure');
  assert.equal(attemptRecord.usage.source, 'exact');
  assert.equal(attemptRecord.usage.promptTokens, 24);
  assert.equal(attemptRecord.usage.completionTokens, 198);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].streamTransport, 'qoder_http_sse_error');
  assert.equal(logs[0].qoderHttpPromptTokens, undefined);
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
  const [attemptRecord] = attemptMutable.annotations.transportAttempts;
  assert.equal(attemptRecord.transport, 'qoder_http');
  assert.equal(attemptRecord.outcome, 'success');
  assert.equal(attemptRecord.upstream, 'https://gateway.qoder.com.cn');
  assert.equal(attemptRecord.stream, false);
  assert.equal(attemptRecord.firstTokenMs, 792);
  assert.equal(attemptRecord.usage.source, 'exact');
  assert.equal(attemptRecord.usage.promptTokens, 22);
  assert.equal(attemptRecord.usage.completionTokens, 91);
  assert.equal(attemptRecord.usage.totalTokens, 113);
  assert.equal(attemptRecord.details.upstreamTotalMs, 2079);
  assert.equal(attemptRecord.details.serverDurationMs, 59);
  assert.equal(attemptRecord.details.streamTransport, 'qoder_http_json');
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
  const [attemptRecord] = attemptMutable.annotations.transportAttempts;
  assert.equal(attemptRecord.transport, 'qoder_http');
  assert.equal(attemptRecord.outcome, 'success');
  assert.equal(attemptRecord.usage.source, 'estimated');
  assert.equal(attemptRecord.usage.promptTokens, 10);
  assert.equal(attemptRecord.model, 'qoder/auto');
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

// 排队短路（2026-10-22）：上游回「被排队 / RESOURCE_LIMIT」时**不回落 CLI**。
//
// 为什么必须钉住：回落的前提是「换条路径可能成功」，但 qoder 的排队是服务端资源限制，
// CLI 走的是**同一个队列**（2026-10-21 取证注释自己写了这一点）。上游此刻没有在处理
// 我们的内容，等或重试都不会更快。实测排队 16.6s/115.4s/177.3s 三次，而 CLI 预算 180s——
// 177.3s 只剩 2.7s 余量，再长就变成空等 5 分钟。所以这里断言：立刻 429 说清状况，
// 且**链上的 CLI transport 一次都不能被调用**。
const QODER_QUEUE_BODY = JSON.stringify({
  code: '403',
  message: JSON.stringify({
    code: '10605',
    message: JSON.stringify({
      isQueued: true,
      modelKey: 'cmodel',
      queueCount: 0,
      queueType: 'p3',
      retryAfterSeconds: 30,
      serviceAvailable: false,
      subCode: 'RESOURCE_LIMIT',
      waitTime: 30
    }),
    subCode: 'RESOURCE_LIMIT'
  })
});

test('上游排队时短路：不回落 CLI，直接 429 说明状况', async () => {
  let cliCalled = false;
  const { ctx, sink, logs, attemptMutable } = makeCtx({
    deps: {
      fetchQoderHttpChatCompletion: async () => {
        const error = new Error(QODER_QUEUE_BODY);
        error.code = 'qoder_http_upstream_error';
        error.statusCode = 403;
        error.upstreamBody = QODER_QUEUE_BODY;
        throw error;
      },
      fetchQoderCliChatCompletion: async () => { cliCalled = true; return null; }
    }
  });
  // 走整条链：HTTP 在前、CLI 在后。排队必须让链在 HTTP 这一步就结束。
  const action = await runTransportChain(ctx, [qoderHttpTransport, qoderCliTransport]);

  assert.equal(cliCalled, false, '排队时 CLI transport 不应被调用（它等的是同一个队列）');
  assert.deepEqual(action, { action: 'return' }, '应返回终止动作，让链停在这里');
  assert.equal(sink.res.statusCode, 429, '排队是 429（可重试的资源限制），不是 502/504 故障');
  assert.equal(sink.headers['retry-after'], '30', '应透出上游给的 retryAfterSeconds');
  assert.equal(sink.headers['x-aih-qoder-queue'], '1');
  const payload = JSON.parse(sink.body());
  assert.match(payload.error.message, /排队/);
  assert.match(payload.error.message, /30 秒后可重试/);
  // 给用户的话必须点明「等也不会更快」，否则他只会一直等下去。
  assert.match(payload.error.message, /等待或立即重试都不会更快/);
  // 记账语义不变：与凭据无关，不记账号失败、不换号。
  // 注解走 attempt.annotations 袋子（annotateAttempt 的存储位置），不是顶层属性。
  assert.equal(attemptMutable.annotations.qoderQueueShortCircuit, true);
  assert.equal(attemptMutable.annotations.qoderQueueRetryAfterMs, 30000);
  const attemptLog = logs.find((entry) => entry.streamTransport === 'qoder_http_queued');
  assert.ok(attemptLog, '应留下 qoder_http_queued 证据行');
  assert.equal(attemptLog.status, 429);
});

test('排队短路也覆盖流式请求（首字节前就排队）', async () => {
  const { ctx, sink } = makeCtx({
    streamRequested: true,
    deps: {
      fetchQoderHttpChatCompletionStream: async () => {
        const error = new Error(QODER_QUEUE_BODY);
        error.code = 'qoder_http_upstream_error';
        error.statusCode = 403;
        error.upstreamBody = QODER_QUEUE_BODY;
        throw error;
      }
    }
  });
  const action = await qoderHttpTransport.run(ctx);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(sink.res.statusCode, 429);
  assert.equal(sink.headers['x-aih-stream-refused'], 'queued');
});

test('非排队的首字节前失败仍然回落 CLI（短路不能误伤正常兜底）', async () => {
  // 关键断言只有一条：CLI 被调用了。短路若写宽了（例如按 statusCode===403 判），
  // 这个用例会红——普通网络失败必须继续走兜底。
  let cliCalled = false;
  const { ctx } = makeCtx({
    deps: {
      fetchQoderHttpChatCompletion: async () => {
        const error = new Error('connection refused');
        error.code = 'ECONNREFUSED';
        throw error;
      },
      fetchQoderCliChatCompletion: async () => { cliCalled = true; return null; }
    }
  });
  await runTransportChain(ctx, [qoderHttpTransport, qoderCliTransport]);
  assert.equal(cliCalled, true, '普通网络失败仍应交给 CLI 兜底');
});

test('排队短路只认排队：其他 overloaded（529 过载）仍回落 CLI', async () => {
  // 529 与排队**同为 kind=overloaded**，但语义完全不同：529 是上游过载，
  // 换 CLI 可能真的落到别的容量上，应当继续兜底。短路若只判 kind 就会误伤这里。
  let cliCalled = false;
  const { ctx } = makeCtx({
    deps: {
      fetchQoderHttpChatCompletion: async () => {
        const error = new Error('upstream overloaded');
        error.code = 'qoder_http_upstream_error';
        error.statusCode = 529;
        throw error;
      },
      fetchQoderCliChatCompletion: async () => { cliCalled = true; return null; }
    }
  });
  await runTransportChain(ctx, [qoderHttpTransport, qoderCliTransport]);
  assert.equal(cliCalled, true, '529 过载不是排队，必须继续走 CLI 兜底');
});
