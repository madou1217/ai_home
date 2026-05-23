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

function chooseAvailableAccount(pool, _state, _cursorKey, options = {}) {
  const excludeIds = options.excludeIds instanceof Set ? options.excludeIds : new Set();
  const now = Date.now();
  return (pool || []).find((account) => {
    const id = String(account && account.id || '');
    if (id && excludeIds.has(id)) return false;
    return now >= Number(account && account.cooldownUntil || 0);
  }) || null;
}

function markFailureWithCooldown(account, reason, cooldownMs, threshold = 1) {
  account.consecutiveFailures = Number(account.consecutiveFailures || 0) + 1;
  account.lastError = String(reason || '');
  if (account.consecutiveFailures >= threshold) {
    account.cooldownUntil = Date.now() + Math.max(1000, Number(cooldownMs) || 0);
  }
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

test('upstream passthrough returns pool unavailable after codex 401 attempts are exhausted', async () => {
  const res = createResCapture();
  const accounts = [
    { id: '10023', email: 'code1@example.com', accessToken: 'bad-1', cooldownUntil: 0 },
    { id: '10025', email: 'code3@example.com', accessToken: 'bad-2', cooldownUntil: 0 }
  ];
  const state = {
    accounts: { codex: accounts },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const failures = [];

  await handleUpstreamPassthrough({
    options: {
      provider: 'codex',
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/responses', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"model":"gpt-5.3-codex","input":"hi"}'),
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
    deps: {
      chooseServerAccount: chooseAvailableAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => ({
        ok: false,
        status: 401,
        headers: new Map(),
        arrayBuffer: async () => Buffer.from('{"error":"unauthorized"}')
      }),
      refreshCodexAccessToken: async () => ({ ok: false, refreshed: false, reason: 'refresh_http_401' }),
      markProxyAccountFailure: (account, reason, cooldownMs, threshold) => {
        failures.push({ id: account.id, reason });
        markFailureWithCooldown(account, reason, cooldownMs, threshold);
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(failures, [
    { id: '10023', reason: 'auth_invalid_reauth_required' },
    { id: '10025', reason: 'auth_invalid_reauth_required' }
  ]);
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'auth_invalid_reauth_required');
  assert.match(String(body.detail || ''), /cooldown:auth_invalid_reauth_required=2/);
});

test('upstream passthrough honors explicit x-provider and x-account-id headers over model inference', async () => {
  const res = createResCapture();
  let seenAuthorization = '';
  const state = {
    accounts: {
      codex: [{ id: '10000', email: 'codex@example.com', accessToken: 'codex-token' }],
      claude: [
        { id: '3', email: 'claude-3@example.com', accessToken: 'claude-token-3', baseUrl: 'https://claude.example.com' },
        { id: '4', email: 'claude-4@example.com', accessToken: 'claude-token-4', baseUrl: 'https://claude.example.com' }
      ]
    },
    cursors: { codex: 0, claude: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'auto',
      codexBaseUrl: 'https://codex.example.com',
      claudeBaseUrl: 'https://claude.example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        'x-provider': 'claude',
        'x-account-id': '3'
      }
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from(JSON.stringify({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: '你好' }] })),
    requestJson: { model: 'qwen3.6-plus', messages: [{ role: 'user', content: '你好' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (_url, init) => {
        seenAuthorization = String(init && init.headers && init.headers.authorization || '');
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
  assert.match(seenAuthorization, /claude-token-3/);
  assert.equal(state.metrics.providerCounts.claude, 1);
  assert.equal(state.metrics.providerCounts.codex, undefined);
});

test('upstream passthrough uses codex account openai base url for api key accounts', async () => {
  const res = createResCapture();
  let seenUrl = '';
  const state = {
    accounts: {
      codex: [{
        id: '10014',
        email: 'api@example.com',
        accessToken: 'sk-live',
        apiKeyMode: true,
        authType: 'api-key',
        openaiBaseUrl: 'https://proxy.example.com/v1'
      }]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'codex',
      codexBaseUrl: 'https://codex.example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json'
      }
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'gpt-5.3-codex', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (url) => {
        seenUrl = String(url || '');
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
  assert.equal(seenUrl, 'https://proxy.example.com/v1/chat/completions');
});

test('upstream passthrough sends anthropic messages with x-api-key header for claude', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenHeaders = null;
  const state = {
    accounts: {
      claude: [{
        id: '3',
        email: 'claude@example.com',
        accessToken: 'anthropic-key',
        baseUrl: 'https://api.anthropic.com/v1'
      }]
    },
    cursors: { claude: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'claude',
      claudeBaseUrl: 'https://api.anthropic.com/v1',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1/messages',
      headers: {
        'content-type': 'application/json'
      }
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"messages":[]}'),
    requestJson: { model: 'claude-sonnet-4', messages: [] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (url, init) => {
        seenUrl = String(url || '');
        seenHeaders = init.headers || {};
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          arrayBuffer: async () => Buffer.from('{"id":"msg_1","type":"message"}')
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(seenUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(seenHeaders['x-api-key'], 'anthropic-key');
  assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
  assert.equal(Object.hasOwn(seenHeaders, 'authorization'), false);
});

test('upstream passthrough keeps /v1/messages for claude anthropic-compatible base url', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenHeaders = null;
  const state = {
    accounts: {
      claude: [{
        id: '3',
        email: 'claude@example.com',
        accessToken: 'anthropic-key',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic'
      }]
    },
    cursors: { claude: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'claude',
      claudeBaseUrl: 'https://api.anthropic.com/v1',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1/messages',
      headers: {
        'content-type': 'application/json'
      }
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"messages":[]}'),
    requestJson: { model: 'qwen3.6-plus', messages: [] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (url, init) => {
        seenUrl = String(url || '');
        seenHeaders = init.headers || {};
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          arrayBuffer: async () => Buffer.from('{"id":"msg_dashscope","type":"message"}')
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(seenUrl, 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages');
  assert.equal(seenHeaders['x-api-key'], 'anthropic-key');
  assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
  assert.equal(Object.hasOwn(seenHeaders, 'authorization'), false);
});

test('upstream passthrough resolves qwen model to claude by model availability in auto mode', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenHeaders = null;
  const state = {
    accounts: {
      codex: [{ id: '6', email: 'codex@example.com', accessToken: 'codex-token' }],
      claude: [{
        id: '3',
        email: 'claude@example.com',
        accessToken: 'anthropic-key',
        baseUrl: 'https://api.anthropic.com/v1',
        availableModels: ['qwen3.6-plus']
      }]
    },
    cursors: { claude: 0, codex: 0 },
    webUiModelsCache: {
      byProvider: {
        codex: ['gpt-5.4'],
        claude: ['qwen3.6-plus']
      }
    },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'auto',
      codexBaseUrl: 'https://codex.example.com',
      claudeBaseUrl: 'https://api.anthropic.com/v1',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1/messages',
      headers: {
        'content-type': 'application/json'
      }
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from(JSON.stringify({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: '你好' }] })),
    requestJson: { model: 'qwen3.6-plus', messages: [{ role: 'user', content: '你好' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      resolveRequestProvider: (options, requestJson, headers, stateArg) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, stateArg),
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (url, init) => {
        seenUrl = String(url || '');
        seenHeaders = init.headers || {};
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          arrayBuffer: async () => Buffer.from('{"id":"msg_qwen","type":"message","model":"qwen3.6-plus"}')
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(seenUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(seenHeaders['x-api-key'], 'anthropic-key');
  assert.equal(state.metrics.providerCounts.claude, 1);
  assert.equal(state.metrics.providerCounts.codex, undefined);
});

test('upstream passthrough returns clear invalid_request when claude account uses anthropic-compatible endpoint with chat completions path', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      claude: [{ id: '3', email: 'claude-3@example.com', accessToken: 'claude-token-3', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }]
    },
    cursors: { claude: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} }
  };
  let fetchCalled = false;

  await handleUpstreamPassthrough({
    options: {
      provider: 'auto',
      claudeBaseUrl: 'https://claude.example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        'x-provider': 'claude',
        'x-account-id': '3'
      }
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from(JSON.stringify({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: '你好' }] })),
    requestJson: { model: 'qwen3.6-plus', messages: [{ role: 'user', content: '你好' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        fetchCalled = true;
        throw new Error('should not fetch upstream');
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(fetchCalled, false);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'invalid_request');
  assert.match(String(body.detail || ''), /Anthropic 兼容端点/);
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

test('upstream passthrough 404 does not mark account success and returns raw upstream body', async () => {
  const res = createResCapture();
  const state = {
    accounts: { claude: [{ id: '1', email: 'a@example.com', accessToken: 'tok', cooldownUntil: 0 }] },
    cursors: { claude: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  let successCalls = 0;
  let failureCalls = 0;

  await handleUpstreamPassthrough({
    options: {
      provider: 'claude',
      claudeBaseUrl: 'https://example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 2,
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
      fetchWithTimeout: async () => ({
        status: 404,
        headers: new Map([['content-type', 'application/json']]),
        arrayBuffer: async () => Buffer.from('{"error":"not found"}')
      }),
      markProxyAccountFailure: () => { failureCalls += 1; },
      markProxyAccountSuccess: () => { successCalls += 1; },
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 404);
  assert.equal(String(res.body), '{"error":"not found"}');
  assert.equal(successCalls, 0);
  assert.equal(failureCalls, 0);
  assert.equal(state.metrics.totalSuccess, 0);
  assert.equal(state.metrics.totalFailures, 1);
});

test('upstream passthrough 429 applies cooldown and retries another account before any downstream bytes are sent', async () => {
  const res = createResCapture();
  const accounts = [
    { id: '1', email: 'a@example.com', accessToken: 'tok-1', cooldownUntil: 0 },
    { id: '2', email: 'b@example.com', accessToken: 'tok-2', cooldownUntil: 0 }
  ];
  const state = {
    accounts: { claude: accounts },
    cursors: { claude: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const seen = [];
  const requestLogs = [];

  await handleUpstreamPassthrough({
    options: {
      provider: 'claude',
      claudeBaseUrl: 'https://example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 2,
      logRequests: true
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'upstream-capacity-1' },
    deps: {
      chooseServerAccount: (pool, _state, _cursorKey, options = {}) => {
        const excluded = options.excludeIds || new Set();
        const next = pool.find((account) => !excluded.has(String(account.id)));
        if (next) seen.push(String(next.id));
        return next || null;
      },
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (_url, init) => {
        if (String(init.headers.authorization).includes('tok-1')) {
          return {
            status: 429,
            headers: new Map([['content-type', 'application/json'], ['retry-after', '120']]),
            arrayBuffer: async () => Buffer.from('{"error":"rate limited"}')
          };
        }
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          arrayBuffer: async () => Buffer.from('{"ok":true}')
        };
      },
      markProxyAccountFailure: (account, _reason, cooldownMs, threshold) => {
        account.consecutiveFailures = Number(account.consecutiveFailures || 0) + 1;
        if (account.consecutiveFailures >= threshold) {
          account.cooldownUntil = Date.now() + cooldownMs;
        }
      },
      markProxyAccountSuccess: (account) => {
        account.consecutiveFailures = 0;
      },
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(seen, ['1', '2']);
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.body), '{"ok":true}');
  assert.equal(accounts[0].cooldownUntil > Date.now(), true);
  assert.equal(state.metrics.totalSuccess, 1);
});

test('upstream passthrough model capacity 400 retries another account instead of passing raw error to client', async () => {
  const res = createResCapture();
  const accounts = [
    { id: '1', email: 'a@example.com', accessToken: 'tok-1', cooldownUntil: 0 },
    { id: '2', email: 'b@example.com', accessToken: 'tok-2', cooldownUntil: 0 }
  ];
  const state = {
    accounts: { claude: accounts },
    cursors: { claude: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const seen = [];
  const requestLogs = [];

  await handleUpstreamPassthrough({
    options: {
      provider: 'claude',
      claudeBaseUrl: 'https://example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 2,
      logRequests: true
    },
    state,
    req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'upstream-capacity-1' },
    deps: {
      chooseServerAccount: (pool, _state, _cursorKey, options = {}) => {
        const excluded = options.excludeIds || new Set();
        const next = pool.find((account) => !excluded.has(String(account.id)));
        if (next) seen.push(String(next.id));
        return next || null;
      },
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (_url, init) => {
        const token = String(init.headers.authorization || init.headers['x-api-key'] || '');
        if (token.includes('tok-1')) {
          return {
            status: 400,
            headers: new Map([
              ['content-type', 'application/json'],
              ['x-request-id', 'upstream-capacity-header'],
              ['set-cookie', 'secret-cookie=1']
            ]),
            arrayBuffer: async () => Buffer.from(JSON.stringify({
              error: {
                message: 'Selected model is at capacity. Please try a different model.'
              }
            }))
          };
        }
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          arrayBuffer: async () => Buffer.from('{"ok":true}')
        };
      },
      markProxyAccountFailure: (account, _reason, cooldownMs, threshold) => {
        account.consecutiveFailures = Number(account.consecutiveFailures || 0) + 1;
        if (account.consecutiveFailures >= threshold) {
          account.cooldownUntil = Date.now() + cooldownMs;
        }
      },
      markProxyAccountSuccess: (account) => {
        account.consecutiveFailures = 0;
      },
      appendProxyRequestLog: (entry) => requestLogs.push(entry)
    }
  });

  assert.deepEqual(seen, ['1', '2']);
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.body), '{"ok":true}');
  assert.equal(accounts[0].cooldownUntil > Date.now(), true);
  const retryLog = requestLogs.find((entry) => entry.kind === 'account_retry_failure');
  assert.ok(retryLog);
  assert.equal(retryLog.requestId, 'upstream-capacity-1');
  assert.equal(retryLog.upstreamRequestId, 'upstream-capacity-header');
  assert.equal(retryLog.provider, 'claude');
  assert.equal(retryLog.accountId, '1');
  assert.equal(retryLog.error, 'upstream_400: {"error":{"message":"Selected model is at capacity. Please try a different model."}}');
  assert.equal(retryLog.upstreamHeaders['x-request-id'], 'upstream-capacity-header');
  assert.equal(Object.hasOwn(retryLog.upstreamHeaders, 'set-cookie'), false);
  assert.match(retryLog.upstreamBody, /Selected model is at capacity/);
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
    requestMeta: { sessionKey: 'thread-1' },
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
      fetchGeminiCodeAssistChatCompletion: async (callOptions) => {
        assert.equal(String(callOptions.sessionKey || ''), 'thread-1');
        assert.ok(callOptions.geminiSessionIdMap instanceof Map);
        assert.equal(callOptions.geminiSessionIdMap, state.geminiSessionIdMap);
        return payload;
      },
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
          candidates: [{ content: { parts: [{ thought: true, text: 'internal thought' }, { text: '你' }] } }]
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
  assert.match(body, /"reasoning_content":"internal thought"/);
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
      fetchGeminiCodeAssistChatCompletionStream: async function* (callOptions) {
        callOptions.appendGeminiCodeAssistDiagnostic({
          sessionId: '12345678-1234-4123-8123-123456789abc',
          userPromptId: '12345678-1234-4123-8123-123456789abc########0',
          sessionSource: 'mapped',
          sessionReused: false,
          externalSessionKeyHash: 'abc123',
          creditsEnabled: true,
          creditBalance: 90,
          creditDecisionReason: 'available_credit',
          upstreamUrl: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
          method: 'streamGenerateContent',
          userAgent: 'GeminiCLI-cli-command/0.42.0/gemini-2.5-pro (darwin; arm64; terminal)'
        });
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
  assert.equal(requestLogs[0].geminiCodeAssistSessionId, '12345678-1234-4123-8123-123456789abc');
  assert.equal(requestLogs[0].geminiCodeAssistUserPromptId, '12345678-1234-4123-8123-123456789abc########0');
  assert.equal(requestLogs[0].geminiCodeAssistCreditsEnabled, true);
  assert.equal(requestLogs[0].geminiCodeAssistCreditBalance, 90);
  assert.equal(requestLogs[0].geminiCodeAssistMethod, 'streamGenerateContent');
  assert.match(requestLogs[0].geminiCodeAssistUpstreamUrl, /:streamGenerateContent\?alt=sse$/);
  assert.match(requestLogs[0].geminiCodeAssistUserAgent, /^GeminiCLI-cli-command\/0\.42\.0\/gemini-2\.5-pro /);
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

test('Gemini Code Assist 429 triggers immediate cooldown and returns 429 upstream_failed', async () => {
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
      markProxyAccountFailure: (target, _reason, nextCooldownMs, threshold) => {
        target.consecutiveFailures = Number(target.consecutiveFailures || 0) + 1;
        if (target.consecutiveFailures >= threshold) {
          target.cooldownUntil = Date.now() + nextCooldownMs;
        }
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 429);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'upstream_failed');
  assert.match(String(body.detail || ''), /quota exhausted/);
  assert.equal(Number(account.cooldownUntil || 0) > Date.now(), true);
});

test('Gemini Code Assist model capacity 429 does not block the account', async () => {
  const res = createResCapture();
  const account = { id: 'g1', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal', cooldownUntil: 0 };
  const state = {
    accounts: { gemini: [account] },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, lastErrors: [] }
  };
  let failureCalls = 0;

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
        const err = new Error(
          'HTTP 429 {"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 26s."}}'
        );
        err.code = 'HTTP_429';
        throw err;
      },
      markProxyAccountFailure: () => {
        failureCalls += 1;
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 429);
  assert.equal(failureCalls, 0);
  assert.equal(Number(account.cooldownUntil || 0), 0);
  assert.equal(String(account.lastFailureKind || ''), '');
});

test('Gemini Code Assist 401 blocks account and returns pool unavailable', async () => {
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
      markProxyAccountFailure: (target, _reason, nextCooldownMs, threshold) => {
        target.consecutiveFailures = Number(target.consecutiveFailures || 0) + 1;
        if (target.consecutiveFailures >= threshold) {
          target.cooldownUntil = Date.now() + nextCooldownMs;
        }
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 401);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'auth_invalid_reauth_required');
  assert.match(String(body.detail || ''), /auth_invalid_reauth_required/);
  assert.equal(Number(account.cooldownUntil || 0) > Date.now(), true);
});
