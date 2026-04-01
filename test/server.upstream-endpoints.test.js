const test = require('node:test');
const assert = require('node:assert/strict');
const { handleUpstreamPassthrough } = require('../lib/server/upstream-endpoints');

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    write(chunk = '') {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.body = Buffer.concat([this.body, buf]);
    },
    end(chunk = '') {
      if (chunk !== undefined && chunk !== null && String(chunk).length > 0) this.write(chunk);
    }
  };
}

test('upstream passthrough strips hop-by-hop headers before fetch', async () => {
  const res = createResCapture();
  let seenHeaders = null;
  const state = {
    accounts: { codex: [{ id: '1', email: 'a@example.com', accessToken: 'tok' }] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleUpstreamPassthrough({
    options: {
      codexBaseUrl: 'https://example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1/chat/completions',
      headers: {
        host: '127.0.0.1:8317',
        authorization: 'Bearer client-key',
        connection: 'keep-alive',
        'proxy-connection': 'keep-alive',
        te: 'trailers',
        upgrade: 'websocket',
        'content-length': '12',
        'content-type': 'application/json'
      }
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (_url, init) => {
        seenHeaders = init.headers || {};
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          arrayBuffer: async () => Buffer.from('{"ok":true}')
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(state.metrics.totalSuccess, 1);
  assert.equal(String(res.body), '{"ok":true}');
  assert.equal(typeof seenHeaders.authorization, 'string');
  assert.equal(seenHeaders['x-aih-account-id'], '1');
  assert.equal(seenHeaders['content-type'], 'application/json');
  assert.equal(Object.hasOwn(seenHeaders, 'connection'), false);
  assert.equal(Object.hasOwn(seenHeaders, 'proxy-connection'), false);
  assert.equal(Object.hasOwn(seenHeaders, 'te'), false);
  assert.equal(Object.hasOwn(seenHeaders, 'upgrade'), false);
  assert.equal(Object.hasOwn(seenHeaders, 'host'), false);
  assert.equal(Object.hasOwn(seenHeaders, 'content-length'), false);
});

test('upstream passthrough fast-fails on global network errors and surfaces error code', async () => {
  const res = createResCapture();
  const state = {
    accounts: { codex: [{ id: '1', email: 'a@example.com', accessToken: 'tok' }] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let fetchCalls = 0;
  await handleUpstreamPassthrough({
    options: {
      codexBaseUrl: 'https://example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        fetchCalls += 1;
        const err = new Error('fetch failed');
        err.cause = { code: 'ECONNRESET' };
        throw err;
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });
  assert.equal(fetchCalls, 1);
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'upstream_failed');
  assert.match(String(body.detail || ''), /ECONNRESET/);
});

test('upstream passthrough skips invalid token and retries with another account in same request', async () => {
  const res = createResCapture();
  const pool = [
    { id: '1', email: 'bad@example.com', accessToken: 'bad\ntoken' },
    { id: '2', email: 'ok@example.com', accessToken: 'good-token' }
  ];
  const state = {
    accounts: { codex: pool },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const seenAccountIds = [];
  let seenHeaders = null;

  await handleUpstreamPassthrough({
    options: {
      codexBaseUrl: 'https://example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
    deps: {
      chooseServerAccount: (accounts, _state, _cursorKey, options = {}) => {
        const excluded = options.excludeIds || new Set();
        const next = accounts.find((acc) => !excluded.has(String(acc.id)));
        if (next) seenAccountIds.push(String(next.id));
        return next || null;
      },
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (_url, init) => {
        seenHeaders = init.headers || {};
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          arrayBuffer: async () => Buffer.from('{"ok":true}')
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(seenAccountIds, ['1', '2']);
  assert.equal(res.statusCode, 200);
  assert.match(String(seenHeaders.authorization || ''), /Bearer good-token/);
});

test('upstream passthrough refreshes codex token on 401 and retries same account', async () => {
  const res = createResCapture();
  const state = {
    accounts: { codex: [{ id: '1', email: 'a@example.com', accessToken: 'expired-token', refreshToken: 'rt_1' }] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let upstreamCalls = 0;
  let forcedRefreshCalls = 0;

  await handleUpstreamPassthrough({
    options: {
      provider: 'codex',
      codexBaseUrl: 'https://example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async (account, opts) => {
        if (opts && opts.force) {
          forcedRefreshCalls += 1;
          account.accessToken = 'fresh-token';
          return { ok: true, refreshed: true };
        }
        return { ok: true, refreshed: false, reason: 'not_due' };
      },
      fetchWithTimeout: async (_url, init) => {
        upstreamCalls += 1;
        if (String(init && init.headers && init.headers.authorization || '').includes('expired-token')) {
          return {
            status: 401,
            headers: new Map([['content-type', 'application/json']]),
            arrayBuffer: async () => Buffer.from('{"error":"expired"}')
          };
        }
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          arrayBuffer: async () => Buffer.from('{"ok":true}')
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(forcedRefreshCalls, 1);
  assert.equal(upstreamCalls, 2);
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.body), '{"ok":true}');
  assert.equal(state.metrics.totalSuccess, 1);
});

test('upstream passthrough uses Gemini Code Assist adapter for oauth-personal chat completions', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      gemini: [{ id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let fetchCalled = false;
  const payload = { id: 'chatcmpl-1', object: 'chat.completion', choices: [] };

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        fetchCalled = true;
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => payload,
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(fetchCalled, false);
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.body), JSON.stringify(payload));
  assert.equal(state.metrics.totalSuccess, 1);
});

test('Gemini Code Assist stream=true uses streamGenerateContent and emits incremental SSE chunks', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      gemini: [{ id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let streamCalled = 0;

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_buffered_generateContent');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {
        streamCalled += 1;
        yield {
          model: 'gemini-2.5-pro',
          candidates: [{ content: { parts: [{ text: '你' }] } }]
        };
        yield {
          model: 'gemini-2.5-pro',
          candidates: [{ content: { parts: [{ text: '好' }] }, finishReason: 'STOP' }]
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  const body = String(res.body);
  assert.equal(streamCalled, 1);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/i);
  assert.match(body, /"delta":\{"role":"assistant"\}/);
  assert.match(body, /"content":"你"/);
  assert.match(body, /"content":"好"/);
  assert.match(body, /\[DONE\]/);
  assert.equal(state.metrics.totalSuccess, 1);
});

test('Gemini Code Assist stream=true emits tool_calls chunk and tool_calls finish_reason', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      gemini: [{ id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_buffered_generateContent');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {
        yield {
          model: 'gemini-2.5-pro',
          candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          toolCallsByCandidate: [[{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'mcp__CherryHub__list',
              arguments: '{"limit":10}'
            }
          }]]
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  const body = String(res.body);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/i);
  assert.match(body, /"tool_calls":\[\{"index":0,"id":"call_1","type":"function"/);
  assert.match(body, /"name":"mcp__CherryHub__list"/);
  assert.match(body, /"finish_reason":"tool_calls"/);
  assert.match(body, /\[DONE\]/);
  assert.equal(state.metrics.totalSuccess, 1);
});

test('Gemini Code Assist stream=true falls back to buffered generateContent when stream endpoint is unsupported', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      gemini: [{ id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let fallbackCalled = 0;

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        fallbackCalled += 1;
        return {
          id: 'chatcmpl-fallback',
          object: 'chat.completion',
          created: 123,
          model: 'gemini-2.5-pro',
          choices: [{ index: 0, message: { role: 'assistant', content: 'fallback-ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        };
      },
      fetchGeminiCodeAssistChatCompletionStream: async () => {
        const err = new Error('stream endpoint unsupported');
        err.code = 'HTTP_404';
        throw err;
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  const body = String(res.body);
  assert.equal(fallbackCalled, 1);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/i);
  assert.match(body, /"content":"fallback-ok"/);
  assert.match(body, /\[DONE\]/);
  assert.equal(state.metrics.totalSuccess, 1);
});

test('Gemini Code Assist stream fallback emits tool_calls chunk when buffered response is function call', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      gemini: [{ id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => ({
        id: 'chatcmpl-fallback',
        object: 'chat.completion',
        created: 123,
        model: 'gemini-2.5-pro',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'mcp__CherryHub__list', arguments: '{"limit":5}' }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      fetchGeminiCodeAssistChatCompletionStream: async () => {
        const err = new Error('stream endpoint unsupported');
        err.code = 'HTTP_404';
        throw err;
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  const body = String(res.body);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/i);
  assert.match(body, /"tool_calls":\[\{"index":0,"id":"call_1","type":"function"/);
  assert.match(body, /"finish_reason":"tool_calls"/);
  assert.match(body, /\[DONE\]/);
  assert.equal(state.metrics.totalSuccess, 1);
});

test('Gemini Code Assist true stream logs streamRequested/streamTransport=upstream_sse', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      gemini: [{ id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const requestLogs = [];

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: true
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'req-stream-1' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_buffered_generateContent');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {
        yield {
          model: 'gemini-2.5-pro',
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }]
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: (entry) => requestLogs.push(entry)
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(requestLogs.length, 1);
  assert.equal(requestLogs[0].requestId, 'req-stream-1');
  assert.equal(requestLogs[0].streamRequested, true);
  assert.equal(requestLogs[0].streamTransport, 'upstream_sse');
});

test('Gemini Code Assist buffered fallback logs streamRequested/streamTransport=buffered_fallback', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      gemini: [{ id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const requestLogs = [];

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: true
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'req-stream-2' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => ({
        id: 'chatcmpl-fallback',
        object: 'chat.completion',
        created: 123,
        model: 'gemini-2.5-pro',
        choices: [{ index: 0, message: { role: 'assistant', content: 'fallback-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      fetchGeminiCodeAssistChatCompletionStream: async () => {
        const err = new Error('stream endpoint unsupported');
        err.code = 'HTTP_404';
        throw err;
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: (entry) => requestLogs.push(entry)
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(requestLogs.length, 1);
  assert.equal(requestLogs[0].requestId, 'req-stream-2');
  assert.equal(requestLogs[0].streamRequested, true);
  assert.equal(requestLogs[0].streamTransport, 'buffered_fallback');
});

test('Gemini Code Assist 404 does not trigger cooldown and returns 404 upstream_failed', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      gemini: [{ id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal', cooldownUntil: 0 }]
    },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-3.1-pro-preview', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        const err = new Error('not found');
        err.code = 'HTTP_404';
        throw err;
      },
      markProxyAccountFailure: () => {
        throw new Error('should_not_mark_failure_for_404');
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 404);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'upstream_failed');
  assert.match(String(body.detail || ''), /not found/);
  assert.equal(Number(state.accounts.gemini[0].cooldownUntil || 0), 0);
});

test('Gemini Code Assist 429 does not trigger cooldown and returns 429 upstream_failed', async () => {
  const res = createResCapture();
  const account = { id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal', cooldownUntil: 0 };
  const state = {
    accounts: { gemini: [account] },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-3.1-pro-preview', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        const err = new Error('quota exhausted');
        err.code = 'HTTP_429';
        throw err;
      },
      markProxyAccountFailure: () => {
        throw new Error('should_not_mark_failure_for_429');
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 429);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'upstream_failed');
  assert.match(String(body.detail || ''), /quota exhausted/);
  assert.equal(Number(account.cooldownUntil || 0), 0);
});

test('Gemini Code Assist 401 does not trigger cooldown and returns 401 upstream_failed', async () => {
  const res = createResCapture();
  const account = { id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal', cooldownUntil: 0 };
  const state = {
    accounts: { gemini: [account] },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'gemini',
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gemini-3.1-pro-preview', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        const err = new Error('invalid auth');
        err.code = 'HTTP_401';
        throw err;
      },
      markProxyAccountFailure: () => {
        throw new Error('should_not_mark_failure_for_401');
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 401);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'upstream_failed');
  assert.match(String(body.detail || ''), /invalid auth/);
  assert.equal(Number(account.cooldownUntil || 0), 0);
});
