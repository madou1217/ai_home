const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseServerAccount, markProxyAccountFailure } = require('../lib/server/router');
const { handleUpstreamPassthrough } = require('../lib/server/upstream-endpoints');
const { getAccountModelCooldownUntil } = require('../lib/server/account-runtime-state');
const {
  createProviderProtocolRouteMeta,
  resolveDirectProviderProtocolRoute
} = require('../lib/server/provider-protocol-routing');
const {
  compactProviderProtocolPlan,
  createProviderProtocolPlan
} = require('../lib/server/provider-protocol-plan');

const AGY_ANTHROPIC_MESSAGES_ROUTE = resolveDirectProviderProtocolRoute('anthropic_messages', 'agy');
const AGY_GEMINI_TO_ANTHROPIC_PLAN = compactProviderProtocolPlan(createProviderProtocolPlan({
  route: AGY_ANTHROPIC_MESSAGES_ROUTE,
  provider: 'agy',
  sourceClientProtocol: 'gemini_generate_content'
}));

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

test('upstream passthrough records provider model usage from successful response', async () => {
  const res = createResCapture();
  const records = [];
  const successes = [];
  const state = {
    accounts: { gemini: [{ id: '9', email: 'g@example.com', accessToken: 'tok' }] },
    cursors: { gemini: 0 },
    metrics: {
      totalFailures: 0,
      totalSuccess: 0,
      totalTimeouts: 0,
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {}
    }
  };

  await handleUpstreamPassthrough({
    options: {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1beta/models/gemini-3.1-pro:generateContent',
      headers: {}
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from(JSON.stringify({ contents: [] })),
    requestJson: { model: 'gemini-3.1-pro' },
    requestMeta: {
      requestId: 'req_usage_1',
      sessionKey: 'session_usage_1'
    },
    routeKey: 'POST /v1beta/models/gemini-3.1-pro:generateContent',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      resolveRequestProvider: () => 'gemini',
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => ({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          modelVersion: 'gemini-3.1-pro',
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 3,
            totalTokenCount: 14
          }
        }))
      }),
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: (account) => successes.push(account.id),
      recordModelUsage: (record) => records.push(record),
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(state.metrics.totalSuccess, 1);
  assert.deepEqual(successes, ['9']);
  assert.equal(records.length, 1);
  assert.deepEqual({
    provider: records[0].provider,
    accountId: records[0].accountId,
    requestId: records[0].requestId,
    sessionId: records[0].sessionId,
    model: records[0].model,
    usageFormat: records[0].usageFormat,
    sourceKind: records[0].sourceKind
  }, {
    provider: 'gemini',
    accountId: '9',
    requestId: 'req_usage_1',
    sessionId: 'session_usage_1',
    model: 'gemini-3.1-pro',
    usageFormat: 'gemini',
    sourceKind: 'server_proxy'
  });
  assert.deepEqual(records[0].usage, {
    promptTokenCount: 11,
    candidatesTokenCount: 3,
    totalTokenCount: 14
  });
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

test('upstream passthrough does not reject OpenCode provider catalog without account mapping', async () => {
  const res = createResCapture();
  let called = false;
  const model = 'opencode-go/glm-5.2';
  const route = createProviderProtocolRouteMeta(resolveDirectProviderProtocolRoute('openai_chat', 'opencode'));
  const state = {
    accounts: {
      opencode: [{ id: '1', provider: 'opencode', accessToken: 'opencode-local' }]
    },
    cursors: { opencode: 0 },
    webUiModelsCache: {
      updatedAt: Date.now(),
      byProvider: {
        opencode: [model]
      },
      byAccount: {}
    },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'opencode',
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
    bodyBuffer: Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })),
    requestJson: { model, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { providerProtocolRoute: route },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        throw new Error('should not call OpenAI-compatible passthrough for opencode');
      },
      fetchOpenCodeChatCompletion: async (_options, account, requestJson) => {
        called = true;
        assert.equal(account.id, '1');
        assert.equal(requestJson.model, model);
        return {
          id: 'chatcmpl-opencode-test',
          object: 'chat.completion',
          created: 1,
          model,
          sessionId: 'chatcmpl-opencode-test',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(String(res.body)).model, model);
  assert.equal(state.metrics.providerCounts.opencode, 1);
  assert.equal(state.metrics.providerSuccess.opencode, 1);
});

test('upstream passthrough uses OpenCode Go transport from route instead of provider name', async () => {
  const res = createResCapture();
  let called = false;
  const model = 'opencode-go/glm-5.2';
  const route = createProviderProtocolRouteMeta({
    id: 'openai_chat:claude:go_api',
    clientProtocol: 'openai_chat',
    provider: 'claude',
    transport: 'opencode_go_api',
    upstreamProtocol: 'opencode_go_chat',
    requestAdapter: null,
    responseAdapter: null
  });
  const state = {
    accounts: {
      claude: [{ id: '3', provider: 'claude', accessToken: 'transport-token' }]
    },
    cursors: { claude: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'claude',
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
    bodyBuffer: Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })),
    requestJson: { model, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { providerProtocolRoute: route },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        throw new Error('route transport should not use provider passthrough');
      },
      fetchOpenCodeChatCompletion: async (_options, account, requestJson) => {
        called = true;
        assert.equal(account.id, '3');
        assert.equal(requestJson.model, model);
        return {
          id: 'chatcmpl-route-transport-test',
          object: 'chat.completion',
          created: 1,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(String(res.body)).model, model);
  assert.equal(state.metrics.providerCounts.claude, 1);
  assert.equal(state.metrics.providerSuccess.claude, 1);
});

test('upstream passthrough treats OpenCode AbortError as transient without first-failure cooldown', async () => {
  const res = createResCapture();
  const model = 'opencode-go/glm-5.2';
  const account = { id: '1', provider: 'opencode', accessToken: 'opencode-local', cooldownUntil: 0 };
  const route = createProviderProtocolRouteMeta(resolveDirectProviderProtocolRoute('openai_chat', 'opencode'));
  const state = {
    accounts: { opencode: [account] },
    cursors: { opencode: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'opencode',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })),
    requestJson: { model, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: { providerProtocolRoute: route },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        throw new Error('opencode route should use the Go transport');
      },
      fetchOpenCodeChatCompletion: async () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        err.code = 20;
        throw err;
      },
      markProxyAccountFailure: markFailureWithCooldown,
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 504);
  assert.equal(account.consecutiveFailures, 1);
  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.lastError, 'This operation was aborted [20]');
  assert.equal(state.metrics.totalTimeouts, 1);
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

test('upstream passthrough 429 applies model cooldown and retries another account before any downstream bytes are sent', async () => {
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
    bodyBuffer: Buffer.from('{"model":"claude-sonnet-4-6","messages":[]}'),
    requestJson: { model: 'claude-sonnet-4-6', messages: [] },
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
      markProxyAccountFailure: (account, reason, cooldownMs, threshold, opts) => {
        markProxyAccountFailure(account, reason, cooldownMs, threshold, opts);
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
  assert.equal(Number(accounts[0].cooldownUntil || 0), 0);
  assert.equal(getAccountModelCooldownUntil(accounts[0], 'claude-sonnet-4-6') > Date.now(), true);
  assert.equal(state.metrics.totalSuccess, 1);
});

test('upstream passthrough can defer exhausted 429 to alias runtime fallback before writing response', async () => {
  const res = createResCapture();
  const accounts = [
    { id: '1', email: 'a@example.com', accessToken: 'tok-1', cooldownUntil: 0 }
  ];
  const state = {
    accounts: { claude: accounts },
    cursors: { claude: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };

  const result = await handleUpstreamPassthrough({
    options: {
      provider: 'claude',
      claudeBaseUrl: 'https://example.com',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"model":"claude-sonnet-4-6","messages":[]}'),
    requestJson: { model: 'claude-sonnet-4-6', messages: [] },
    requestMeta: {
      aliasRuntimeFallback: { enabled: true },
      aliasResolution: {
        aliasMatched: true,
        aliasId: 'alias-high',
        requestedModel: 'claude-opus-4-8',
        aliasTarget: 'claude-sonnet-4-6'
      }
    },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    deps: {
      chooseServerAccount: chooseAvailableAccount,
      resolveRequestProvider: () => 'claude',
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => ({
        status: 429,
        headers: new Map([['content-type', 'application/json'], ['retry-after', '120']]),
        arrayBuffer: async () => Buffer.from('{"error":"rate limited"}')
      }),
      markProxyAccountFailure: markFailureWithCooldown,
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(result.retryAliasCandidate, true);
  assert.equal(result.statusCode, 429);
  assert.equal(result.model, 'claude-sonnet-4-6');
  assert.deepEqual(result.attemptedAccountIds, ['1']);
  assert.equal(res.statusCode, 0);
  assert.equal(String(res.body), '');
  assert.equal(state.metrics.totalFailures, 0);
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
    bodyBuffer: Buffer.from('{"model":"claude-sonnet-4-6","messages":[]}'),
    requestJson: { model: 'claude-sonnet-4-6', messages: [] },
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
      markProxyAccountFailure: (account, reason, cooldownMs, threshold, opts) => {
        markProxyAccountFailure(account, reason, cooldownMs, threshold, opts);
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
  assert.equal(Number(accounts[0].cooldownUntil || 0), 0);
  assert.equal(Number(accounts[0].overloadUntil || 0), 0);
  assert.equal(getAccountModelCooldownUntil(accounts[0], 'claude-sonnet-4-6') > Date.now(), true);
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

test('upstream passthrough uses Code Assist adapter for agy provider', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      agy: [{ id: 'a1', provider: 'agy', email: 'agy@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let passthroughCalled = false;
  const payload = { id: 'chatcmpl-agy', object: 'chat.completion', choices: [] };

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
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
    requestJson: { model: 'agy-gemini-3-flash', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 'agy-thread-1' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        passthroughCalled = true;
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async (callOptions) => {
        assert.equal(callOptions.provider, 'agy');
        assert.equal(String(callOptions.sessionKey || ''), 'agy-thread-1');
        assert.ok(callOptions.geminiSessionIdMap instanceof Map);
        assert.equal(callOptions.geminiSessionIdMap, state.agySessionIdMap);
        return payload;
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(passthroughCalled, false);
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.body), JSON.stringify(payload));
  assert.equal(state.metrics.totalSuccess, 1);
});

test('upstream passthrough uses native Gemini generateContent for Code Assist providers', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      gemini: [{ id: 'g1', provider: 'gemini', email: 'g@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { gemini: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let passthroughCalled = false;
  let seenRequest = null;
  let seenOptions = null;
  const payload = {
    candidates: [{
      content: { role: 'model', parts: [{ text: 'pong' }] },
      finishReason: 'STOP',
      index: 0
    }],
    modelVersion: 'gemini-2.5-pro'
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
    req: { url: '/v1beta/models/gemini-2.5-pro:generateContent', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: {
      model: 'gemini-2.5-pro',
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }]
    },
    routeKey: 'POST /v1beta/models/gemini-2.5-pro:generateContent',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 'native-thread-1', clientProtocol: 'gemini_generate_content' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        passthroughCalled = true;
        throw new Error('should_not_call_passthrough');
      },
      fetchGeminiCodeAssistGenerateContent: async (callOptions, _account, requestJson) => {
        seenOptions = callOptions;
        seenRequest = requestJson;
        return payload;
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(passthroughCalled, false);
  assert.equal(seenOptions.clientProtocol, 'gemini_generate_content');
  assert.equal(String(seenOptions.sessionKey || ''), 'native-thread-1');
  assert.ok(seenOptions.geminiSessionIdMap instanceof Map);
  assert.deepEqual(seenRequest.contents, [{ role: 'user', parts: [{ text: 'ping' }] }]);
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.body), JSON.stringify(payload));
  assert.equal(state.metrics.totalSuccess, 1);
});

test('Gemini Code Assist generateContent stream retries another account when upstream returns no assistant content', async () => {
  const res = createResCapture();
  const accounts = [
    { id: 'a1', provider: 'agy', email: 'empty@example.com', accessToken: 'tok-empty', authType: 'oauth-personal', cooldownUntil: 0 },
    { id: 'a2', provider: 'agy', email: 'ok@example.com', accessToken: 'tok-ok', authType: 'oauth-personal', cooldownUntil: 0 }
  ];
  const state = {
    accounts: { agy: accounts },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const attemptedAccountIds = [];
  const failureCalls = [];
  const successAccountIds = [];

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1beta/models/gemini-3-flash-agent:streamGenerateContent', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: {
      model: 'gemini-3-flash-agent',
      contents: [{ role: 'user', parts: [{ text: 'compact' }] }]
    },
    routeKey: 'POST /v1beta/models/gemini-3-flash-agent:streamGenerateContent',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      sessionKey: 'compact-thread-1',
      clientProtocol: 'gemini_stream_generate_content'
    },
    deps: {
      chooseServerAccount: chooseAvailableAccount,
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistGenerateContentStream: async function* (_requestOptions, account) {
        attemptedAccountIds.push(account.id);
        if (account.id === 'a1') {
          yield {
            model: 'gemini-3-flash-agent',
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 }
          };
          return;
        }
        yield {
          model: 'gemini-3-flash-agent',
          candidates: [{ content: { parts: [{ text: 'compact summary' }] }, finishReason: 'STOP' }]
        };
      },
      fetchGeminiCodeAssistGenerateContent: async () => {
        throw new Error('should_not_call_buffered_generateContent');
      },
      markProxyAccountFailure: (...args) => failureCalls.push(args),
      markProxyAccountSuccess: (account) => successAccountIds.push(account.id),
      appendProxyRequestLog: () => {}
    }
  });

  const body = String(res.body);
  assert.deepEqual(attemptedAccountIds, ['a1', 'a2']);
  assert.equal(failureCalls.length, 0);
  assert.deepEqual(successAccountIds, ['a2']);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-aih-server-account-id'], 'a2');
  assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/i);
  assert.match(body, /compact summary/);
  assert.equal(state.metrics.totalSuccess, 1);
  assert.equal(state.metrics.totalFailures, 0);
});

test('upstream passthrough uses direct AGY Anthropic adapter for Claude client messages', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      agy: [{ id: 'a1', provider: 'agy', email: 'agy@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let passthroughCalled = false;
  let openAIAdapterCalled = false;

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-4-6-thinking', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      sessionKey: 'agy-claude-thread-1',
      providerProtocolRoute: AGY_ANTHROPIC_MESSAGES_ROUTE
    },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        passthroughCalled = true;
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        openAIAdapterCalled = true;
        throw new Error('should_not_call_openai_chat_adapter');
      },
      fetchCodeAssistAnthropicMessage: async (callOptions) => {
        assert.equal(callOptions.provider, 'agy');
        assert.equal(String(callOptions.sessionKey || ''), 'agy-claude-thread-1');
        assert.ok(callOptions.geminiSessionIdMap instanceof Map);
        assert.equal(callOptions.geminiSessionIdMap, state.agySessionIdMap);
        return {
          id: 'msg_agy_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(passthroughCalled, false);
  assert.equal(openAIAdapterCalled, false);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).id, 'msg_agy_1');
  assert.equal(state.metrics.totalSuccess, 1);
});

test('direct AGY Anthropic adapter retries another account for model-scoped quota', async () => {
  const res = createResCapture();
  const accounts = [
    { id: 'a1', provider: 'agy', email: 'agy1@example.com', accessToken: 'tok-1', authType: 'oauth-personal' },
    { id: 'a2', provider: 'agy', email: 'agy2@example.com', accessToken: 'tok-2', authType: 'oauth-personal' }
  ];
  const state = {
    accounts: { agy: accounts },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const attemptedAccountIds = [];
  let failureCalls = 0;

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-opus-4.6-thinking', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      providerProtocolRoute: AGY_ANTHROPIC_MESSAGES_ROUTE,
      sourceClientProtocol: 'gemini_generate_content'
    },
    deps: {
      chooseServerAccount: (pool, _cursorState, _cursorKey, selectionOptions = {}) => (
        pool.find((account) => !selectionOptions.excludeIds.has(String(account.id)))
        || null
      ),
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_openai_chat_adapter');
      },
      fetchCodeAssistAnthropicMessage: async (_callOptions, account) => {
        attemptedAccountIds.push(account.id);
        if (account.id === 'a1') {
          const err = new Error(
            'HTTP 429 {"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 26s."}}'
          );
          err.code = 'HTTP_429';
          throw err;
        }
        return {
          id: 'msg_agy_retry_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4.6-thinking',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      },
      markProxyAccountFailure: () => {
        failureCalls += 1;
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(attemptedAccountIds, ['a1', 'a2']);
  // Quota-exhausted is now recorded as a model-scoped cooldown (so the scheduler
  // backs off that model) while the account stays usable and the retry succeeds.
  assert.ok(failureCalls >= 1);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).id, 'msg_agy_retry_1');
  assert.equal(state.metrics.totalSuccess, 1);
});

test('direct AGY Anthropic adapter retries another account for model capacity without blocking account', async () => {
  const res = createResCapture();
  const accounts = [
    { id: 'a1', provider: 'agy', email: 'agy1@example.com', accessToken: 'tok-1', authType: 'oauth-personal', cooldownUntil: 0 },
    { id: 'a2', provider: 'agy', email: 'agy2@example.com', accessToken: 'tok-2', authType: 'oauth-personal', cooldownUntil: 0 }
  ];
  const state = {
    accounts: { agy: accounts },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const attemptedAccountIds = [];
  let failureCalls = 0;
  const failureOptions = [];

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-opus-4.6-thinking', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      providerProtocolRoute: AGY_ANTHROPIC_MESSAGES_ROUTE,
      sourceClientProtocol: 'anthropic_messages'
    },
    deps: {
      chooseServerAccount: chooseAvailableAccount,
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_openai_chat_adapter');
      },
      fetchCodeAssistAnthropicMessage: async (_callOptions, account) => {
        attemptedAccountIds.push(account.id);
        if (account.id === 'a1') {
          const err = new Error(
            'HTTP 429 {"error":{"message":"No capacity available for model claude-opus-4.6-thinking on the server"}}'
          );
          err.code = 'HTTP_429';
          throw err;
        }
        return {
          id: 'msg_agy_model_capacity_retry_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4.6-thinking',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      },
      markProxyAccountFailure: (_a, _r, _c, _t, opts) => {
        failureCalls += 1;
        failureOptions.push(opts || null);
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(attemptedAccountIds, ['a1', 'a2']);
  // Model capacity records a model-scoped cooldown but never an account-wide one.
  assert.ok(failureCalls >= 1);
  // Regression guard: applyFailurePolicyToAccount must pass { scope:'model', model }
  // through to the (persist-wrapped) markProxyAccountFailure — dropping it would
  // silently turn the cooldown account-wide.
  assert.ok(failureOptions.every((o) => o && o.scope === 'model' && o.model));
  assert.equal(Number(accounts[0].cooldownUntil || 0), 0);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).id, 'msg_agy_model_capacity_retry_1');
  assert.equal(state.metrics.totalSuccess, 1);
});

test('direct AGY Anthropic adapter retries another account for unsupported location', async () => {
  const res = createResCapture();
  const accounts = [
    { id: 'a1', provider: 'agy', email: 'blocked@example.com', accessToken: 'tok-1', authType: 'oauth-personal', cooldownUntil: 0 },
    { id: 'a2', provider: 'agy', email: 'ok@example.com', accessToken: 'tok-2', authType: 'oauth-personal', cooldownUntil: 0 }
  ];
  const state = {
    accounts: { agy: accounts },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const attemptedAccountIds = [];
  const failureReasons = [];
  const failureOptions = [];

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      providerProtocolRoute: AGY_ANTHROPIC_MESSAGES_ROUTE,
      sourceClientProtocol: 'anthropic_messages'
    },
    deps: {
      chooseServerAccount: chooseAvailableAccount,
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_openai_chat_adapter');
      },
      fetchCodeAssistAnthropicMessage: async (_callOptions, account) => {
        attemptedAccountIds.push(account.id);
        if (account.id === 'a1') {
          const err = new Error(
            'HTTP 400 {"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}'
          );
          err.code = 'HTTP_400';
          throw err;
        }
        return {
          id: 'msg_agy_location_retry_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      },
      markProxyAccountFailure: (_account, reason, cooldownMs, _threshold, opts) => {
        failureReasons.push({ reason, cooldownMs });
        failureOptions.push(opts || null);
        accounts[0].cooldownUntil = Date.now() + Math.max(1000, Number(cooldownMs) || 0);
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(attemptedAccountIds, ['a1', 'a2']);
  assert.equal(failureReasons[0].reason, 'location_unsupported');
  assert.equal(failureReasons[0].cooldownMs >= 24 * 60 * 60 * 1000, true);
  assert.deepEqual(failureOptions, [null]);
  assert.equal(accounts[0].cooldownUntil > Date.now(), true);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).id, 'msg_agy_location_retry_1');
  assert.equal(state.metrics.totalSuccess, 1);
});

test('direct AGY Anthropic adapter covers full Code Assist pool when capacity retry exceeds configured attempts', async () => {
  const res = createResCapture();
  const accounts = [
    { id: 'a1', provider: 'agy', email: 'agy1@example.com', accessToken: 'tok-1', authType: 'oauth-personal', cooldownUntil: 0 },
    { id: 'a2', provider: 'agy', email: 'agy2@example.com', accessToken: 'tok-2', authType: 'oauth-personal', cooldownUntil: 0 },
    { id: 'a3', provider: 'agy', email: 'agy3@example.com', accessToken: 'tok-3', authType: 'oauth-personal', cooldownUntil: 0 },
    { id: 'a4', provider: 'agy', email: 'agy4@example.com', accessToken: 'tok-4', authType: 'oauth-personal', cooldownUntil: 0 }
  ];
  const state = {
    strategy: 'round-robin',
    accounts: { agy: accounts },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const attemptedAccountIds = [];
  const retryLogs = [];
  let failureCalls = 0;

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: true
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-opus-4.6-thinking', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      providerProtocolRoute: AGY_ANTHROPIC_MESSAGES_ROUTE,
      sourceClientProtocol: 'anthropic_messages'
    },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_openai_chat_adapter');
      },
      fetchCodeAssistAnthropicMessage: async (_callOptions, account) => {
        attemptedAccountIds.push(account.id);
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
      appendProxyRequestLog: (entry) => {
        retryLogs.push(entry);
      }
    }
  });

  assert.deepEqual(attemptedAccountIds, ['a1', 'a2', 'a3', 'a4']);
  // Each account's model gets a model-scoped cooldown as the pool is exhausted.
  assert.ok(failureCalls >= 1);
  assert.equal(res.statusCode, 429);
  assert.equal(retryLogs.filter((entry) => entry.kind === 'account_retry_failure').length, 4);
  assert.deepEqual(
    retryLogs
      .filter((entry) => entry.kind === 'account_retry_failure')
      .map((entry) => entry.maxAttempts),
    [4, 4, 4, 4]
  );
});

test('direct AGY Anthropic adapter retries another OAuth account on not-found model responses', async () => {
  const res = createResCapture();
  const accounts = [
    { id: 'a1', provider: 'agy', email: 'agy1@example.com', accessToken: 'tok-1', authType: 'oauth-personal', cooldownUntil: 0 },
    { id: 'a2', provider: 'agy', email: 'agy2@example.com', accessToken: 'tok-2', authType: 'oauth-personal', cooldownUntil: 0 }
  ];
  const state = {
    strategy: 'round-robin',
    accounts: { agy: accounts },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const attemptedAccountIds = [];
  const retryLogs = [];
  let failureCalls = 0;
  let successCalls = 0;

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: true
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-opus-4-6-thinking', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      providerProtocolRoute: AGY_ANTHROPIC_MESSAGES_ROUTE,
      sourceClientProtocol: 'anthropic_messages'
    },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_openai_chat_adapter');
      },
      fetchCodeAssistAnthropicMessage: async (_callOptions, account) => {
        attemptedAccountIds.push(account.id);
        if (account.id === 'a1') {
          const err = new Error('HTTP 404 {"error":{"message":"Requested entity was not found."}}');
          err.code = 'HTTP_404';
          throw err;
        }
        return {
          id: 'msg_agy_not_found_retry_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6-thinking',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      },
      markProxyAccountFailure: () => {
        failureCalls += 1;
      },
      markProxyAccountSuccess: () => {
        successCalls += 1;
      },
      appendProxyRequestLog: (entry) => {
        retryLogs.push(entry);
      }
    }
  });

  assert.deepEqual(attemptedAccountIds, ['a1', 'a2']);
  assert.equal(failureCalls, 0);
  assert.equal(successCalls, 1);
  assert.equal(Number(accounts[0].cooldownUntil || 0), 0);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).id, 'msg_agy_not_found_retry_1');
  assert.equal(retryLogs.filter((entry) => entry.kind === 'account_retry_failure').length, 1);
});

test('upstream passthrough requires route metadata for direct AGY Anthropic adapter', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      agy: [{ id: 'a1', provider: 'agy', email: 'agy@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let rawPassthroughCalled = false;
  let directAdapterCalled = false;

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-4-6-thinking', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/messages',
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
        rawPassthroughCalled = true;
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          arrayBuffer: async () => Buffer.from('{"raw":true}')
        };
      },
      fetchCodeAssistAnthropicMessage: async () => {
        directAdapterCalled = true;
        throw new Error('should_not_call_direct_adapter_without_route_metadata');
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(directAdapterCalled, false);
  assert.equal(rawPassthroughCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.body), '{"raw":true}');
});

test('upstream passthrough keeps direct AGY Anthropic adapter when Claude client adds beta query', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      agy: [{ id: 'a1', provider: 'agy', email: 'agy@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let directAdapterCalled = false;

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/messages?beta=true', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-4-6-thinking', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      providerProtocolRoute: AGY_ANTHROPIC_MESSAGES_ROUTE,
      sourceClientProtocol: 'gemini_generate_content',
      protocolAdapterPath: ['gemini2claudeAdapter'],
      providerProtocolPlan: AGY_GEMINI_TO_ANTHROPIC_PLAN
    },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_openai_chat_adapter');
      },
      fetchCodeAssistAnthropicMessage: async (requestOptions) => {
        assert.equal(requestOptions.sourceClientProtocol, 'gemini_generate_content');
        assert.equal(requestOptions.clientProtocol, 'anthropic_messages');
        assert.deepEqual(requestOptions.protocolAdapterPath, ['gemini2claudeAdapter']);
        assert.deepEqual(requestOptions.providerProtocolPlan, AGY_GEMINI_TO_ANTHROPIC_PLAN);
        directAdapterCalled = true;
        return {
          id: 'msg_agy_beta_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(directAdapterCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).id, 'msg_agy_beta_1');
  assert.equal(state.metrics.totalSuccess, 1);
});

test('direct AGY Anthropic adapter streams tool_use SSE for Claude client messages', async () => {
  const res = createResCapture();
  const requestLogs = [];
  const state = {
    accounts: {
      agy: [{ id: 'a1', provider: 'agy', email: 'agy@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: true
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-4-6-thinking', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      providerProtocolRoute: AGY_ANTHROPIC_MESSAGES_ROUTE,
      sourceClientProtocol: 'gemini_generate_content',
      protocolAdapterPath: ['gemini2claudeAdapter'],
      providerProtocolPlan: AGY_GEMINI_TO_ANTHROPIC_PLAN
    },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_openai_chat_adapter');
      },
      fetchCodeAssistAnthropicMessageStream: async function* (requestOptions) {
        assert.equal(requestOptions.sourceClientProtocol, 'gemini_generate_content');
        assert.deepEqual(requestOptions.protocolAdapterPath, ['gemini2claudeAdapter']);
        assert.deepEqual(requestOptions.providerProtocolPlan, AGY_GEMINI_TO_ANTHROPIC_PLAN);
        requestOptions.appendGeminiCodeAssistDiagnostic({
          clientProtocol: 'anthropic_messages',
          sourceClientProtocol: requestOptions.sourceClientProtocol,
          requestProtocol: 'anthropic_messages_direct',
          upstreamProtocol: 'gemini_code_assist_generate_content',
          requestAdapter: 'claude2agyAdapter',
          responseAdapter: 'agy2claudeAdapter',
          protocolAdapterPath: requestOptions.protocolAdapterPath,
          providerProtocolPlan: requestOptions.providerProtocolPlan,
          streamToolDiagnostics: [{
            type: 'tool_call_arguments_closed_incomplete_json',
            id: 'toolu_read_incomplete',
            name: 'Read',
            argumentLength: 13
          }]
        });
        yield { type: 'message_start', id: 'msg_stream_1', model: 'claude-4-6-thinking', created: 1770000000 };
        yield { type: 'tool_call_start', index: 0, id: 'toolu_bash_1', name: 'Bash' };
        yield { type: 'tool_call_delta', index: 0, id: 'toolu_bash_1', name: 'Bash', delta: '{"command":"pwd"}' };
        yield { type: 'tool_call_done', index: 0, id: 'toolu_bash_1', name: 'Bash' };
        yield { type: 'message_stop', finishReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
      },
      fetchCodeAssistAnthropicMessage: async () => {
        throw new Error('should_not_call_buffered_anthropic_adapter');
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: (entry) => requestLogs.push(entry)
    }
  });

  const body = String(res.body);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/i);
  assert.match(body, /event: content_block_start/);
  assert.match(body, /"type":"tool_use","id":"toolu_bash_1","name":"Bash"/);
  assert.match(body, /"partial_json":"\{\\"command\\":\\"pwd\\"\}"/);
  assert.match(body, /"stop_reason":"tool_use"/);
  assert.equal(state.metrics.totalSuccess, 1);
  assert.equal(requestLogs[0].geminiCodeAssistClientProtocol, 'anthropic_messages');
  assert.equal(requestLogs[0].geminiCodeAssistSourceClientProtocol, 'gemini_generate_content');
  assert.equal(requestLogs[0].geminiCodeAssistRequestProtocol, 'anthropic_messages_direct');
  assert.equal(requestLogs[0].geminiCodeAssistUpstreamProtocol, 'gemini_code_assist_generate_content');
  assert.equal(requestLogs[0].geminiCodeAssistRequestAdapter, 'claude2agyAdapter');
  assert.equal(requestLogs[0].geminiCodeAssistResponseAdapter, 'agy2claudeAdapter');
  assert.deepEqual(requestLogs[0].geminiCodeAssistProtocolAdapterPath, ['gemini2claudeAdapter']);
  assert.deepEqual(requestLogs[0].geminiCodeAssistProviderProtocolPlan, AGY_GEMINI_TO_ANTHROPIC_PLAN);
  assert.deepEqual(requestLogs[0].geminiCodeAssistStreamToolDiagnostics, [{
    type: 'tool_call_arguments_closed_incomplete_json',
    id: 'toolu_read_incomplete',
    name: 'Read',
    argumentLength: 13
  }]);
});

test('direct AGY Anthropic stream retries another account when upstream returns no assistant content', async () => {
  const res = createResCapture();
  const accounts = [
    { id: 'a1', provider: 'agy', email: 'empty@example.com', accessToken: 'tok-empty', authType: 'oauth-personal', cooldownUntil: 0 },
    { id: 'a2', provider: 'agy', email: 'ok@example.com', accessToken: 'tok-ok', authType: 'oauth-personal', cooldownUntil: 0 }
  ];
  const state = {
    accounts: { agy: accounts },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, providerFailures: {}, providerSuccess: {} }
  };
  const attemptedAccountIds = [];
  const failureCalls = [];
  const successAccountIds = [];

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from('{"x":"y"}'),
    requestJson: { model: 'claude-4-6-thinking', stream: true, messages: [{ role: 'user', content: 'summarize' }] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: {
      providerProtocolRoute: AGY_ANTHROPIC_MESSAGES_ROUTE,
      sourceClientProtocol: 'gemini_generate_content',
      protocolAdapterPath: ['gemini2claudeAdapter'],
      providerProtocolPlan: AGY_GEMINI_TO_ANTHROPIC_PLAN
    },
    deps: {
      chooseServerAccount: chooseAvailableAccount,
      pushMetricError: () => {},
      writeJson: (r, code, body) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(body));
      },
      fetchWithTimeout: async () => {
        throw new Error('should_not_call_raw_passthrough');
      },
      fetchGeminiCodeAssistChatCompletion: async () => {
        throw new Error('should_not_call_openai_chat_adapter');
      },
      fetchCodeAssistAnthropicMessageStream: async function* (_requestOptions, account) {
        attemptedAccountIds.push(account.id);
        yield { type: 'message_start', id: `msg_${account.id}`, model: 'claude-4-6-thinking', created: 1770000000 };
        if (account.id === 'a1') {
          yield { type: 'message_stop', finishReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 0 } };
          return;
        }
        yield { type: 'content_delta', contentType: 'text', text: 'compact summary' };
        yield { type: 'message_stop', finishReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } };
      },
      fetchCodeAssistAnthropicMessage: async () => {
        throw new Error('should_not_call_buffered_anthropic_adapter');
      },
      markProxyAccountFailure: (...args) => failureCalls.push(args),
      markProxyAccountSuccess: (account) => successAccountIds.push(account.id),
      appendProxyRequestLog: () => {}
    }
  });

  const body = String(res.body);
  assert.deepEqual(attemptedAccountIds, ['a1', 'a2']);
  assert.equal(failureCalls.length, 0);
  assert.deepEqual(successAccountIds, ['a2']);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-aih-server-account-id'], 'a2');
  assert.match(body, /event: message_start/);
  assert.match(body, /"text":"compact summary"/);
  assert.match(body, /event: message_stop/);
  assert.equal(state.metrics.totalSuccess, 1);
  assert.equal(state.metrics.totalFailures, 0);
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

test('AGY Code Assist stream keeps tool_calls finish when STOP arrives after tool chunk', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      agy: [{ id: 'agy1', email: 'agy@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
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
    requestJson: { model: 'claude-opus-4.6-thinking', stream: true, messages: [{ role: 'user', content: 'read a file' }] },
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
          model: 'claude-opus-4.6-thinking',
          candidates: [{ content: { parts: [] } }],
          toolCallsByCandidate: [[{
            id: 'call_read',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"file_path":"/tmp/example.txt"}'
            }
          }]]
        };
        yield {
          model: 'claude-opus-4.6-thinking',
          candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          toolCallsByCandidate: [[]]
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  const body = String(res.body);
  assert.equal(res.statusCode, 200);
  assert.match(body, /"tool_calls":\[\{"index":0,"id":"call_read","type":"function"/);
  assert.match(body, /"name":"Read"/);
  assert.match(body, /\\"file_path\\":\\"\/tmp\/example\.txt\\"/);
  assert.match(body, /"finish_reason":"tool_calls"/);
  assert.doesNotMatch(body, /"finish_reason":"stop"/);
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

test('AGY Code Assist stream fallback forces tool_calls finish when buffered payload says stop', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      agy: [{ id: 'agy1', email: 'agy@example.com', accessToken: 'tok', authType: 'oauth-personal' }]
    },
    cursors: { agy: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleUpstreamPassthrough({
    options: {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
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
    requestJson: { model: 'claude-opus-4.6-thinking', stream: true, messages: [{ role: 'user', content: 'read a file' }] },
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
        model: 'claude-opus-4.6-thinking',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_read',
              type: 'function',
              function: { name: 'Read', arguments: '{"file_path":"/tmp/example.txt"}' }
            }]
          },
          finish_reason: 'stop'
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
  assert.match(body, /"tool_calls":\[\{"index":0,"id":"call_read","type":"function"/);
  assert.match(body, /"finish_reason":"tool_calls"/);
  assert.doesNotMatch(body, /"finish_reason":"stop"/);
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
        callOptions.appendGeminiCodeAssistDiagnostic({
          requestSummary: {
            messageCount: 1,
            assistantToolCallCount: 0,
            toolResultCount: 0
          },
          responseToolCalls: [{
            candidateIndex: 0,
            name: 'lookup',
            argumentLength: 2,
            argKeys: [],
            emptyArgs: true
          }],
          responseFinishReasons: ['STOP']
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
  assert.deepEqual(requestLogs[0].geminiCodeAssistRequestSummary, {
    messageCount: 1,
    assistantToolCallCount: 0,
    toolResultCount: 0
  });
  assert.deepEqual(requestLogs[0].geminiCodeAssistResponseToolCalls, [{
    candidateIndex: 0,
    name: 'lookup',
    argumentLength: 2,
    argKeys: [],
    emptyArgs: true
  }]);
  assert.deepEqual(requestLogs[0].geminiCodeAssistResponseFinishReasons, ['STOP']);
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
  const failureScopes = [];

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
      markProxyAccountFailure: (_a, _r, _c, _t, opts) => {
        failureCalls += 1;
        failureScopes.push((opts && opts.scope) || 'account');
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 429);
  // Model capacity now cools the (account, model) tuple so the scheduler backs
  // off this model, but it must NEVER cool the whole account.
  assert.ok(failureCalls >= 1);
  assert.ok(failureScopes.every((scope) => scope === 'model'));
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
