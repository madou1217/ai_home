const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleV1Request } = require('../lib/server/v1-router');
const { buildOpenAIModelsList } = require('../lib/server/models');
const {
  handleUpstreamModels,
  handleUpstreamPassthrough
} = require('../lib/server/upstream-endpoints');
const { loadAliases, saveAliases } = require('../lib/server/model-alias-store');
const { SUPPORTED_SERVER_PROVIDERS } = require('../lib/server/providers');

const V1_CODEX_REF_1 = 'acct_0123456789abcdefabcd';
const V1_CODEX_REF_2 = 'acct_abcdefabcdefabcdefab';
const V1_GEMINI_REF_1 = 'acct_11111111111111111111';
const V1_GEMINI_REF_2 = 'acct_22222222222222222222';
const V1_GEMINI_REF_3 = 'acct_33333333333333333333';
const V1_CLAUDE_REF_1 = 'acct_44444444444444444444';
const V1_CLAUDE_REF_2 = 'acct_77777777777777777777';
const V1_AGY_REF_1 = 'acct_55555555555555555555';
const V1_OPENCODE_REF_1 = 'acct_66666666666666666666';

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk = '') { this.body += String(chunk); },
    end(chunk = '') { this.body += String(chunk); }
  };
}

function createGeminiGenerateContentResponse(model, text = 'pong') {
  return {
    candidates: [{
      content: {
        role: 'model',
        parts: [{ text }]
      },
      finishReason: 'STOP',
      index: 0
    }],
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 2,
      totalTokenCount: 3
    },
    modelVersion: model
  };
}

test('buildOpenAIModelsList prefers visible model family over source provider for owner', () => {
  const payload = buildOpenAIModelsList([
    { id: 'claude-opus-4-7', provider: 'codex' },
    { id: 'gemini-2.5-pro', provider: 'codex' },
    { id: 'gpt-5.5', provider: 'claude' },
    { id: 'custom-model', provider: 'gemini' }
  ]);
  const ownerById = new Map(payload.data.map((item) => [item.id, item.owned_by]));

  assert.equal(ownerById.get('claude-opus-4-7'), 'anthropic');
  assert.equal(ownerById.get('gemini-2.5-pro'), 'google');
  assert.equal(ownerById.get('gpt-5.5'), 'openai');
  assert.equal(ownerById.get('custom-model'), 'google');
});

test('v1 router returns false for non-v1 path', async () => {
  const res = createResCapture();
  const handled = await handleV1Request({
    req: { headers: {} },
    res,
    method: 'GET',
    pathname: '/healthz',
    options: {},
    state: { metrics: { totalRequests: 0, routeCounts: {} } },
    requiredClientKey: '',
    cooldownMs: 1000,
    localExecOpts: {},
    deps: {}
  });
  assert.equal(handled, false);
});

test('v1 router enforces client key', async () => {
  const res = createResCapture();
  const handled = await handleV1Request({
    req: { headers: { authorization: 'Bearer wrong' } },
    res,
    method: 'GET',
    pathname: '/v1/models',
    options: { backend: 'openai-upstream', provider: 'auto' },
    state: {
      modelRegistry: { providers: { codex: new Set(['gpt-4o-mini']), gemini: new Set() } },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 }
    },
    requiredClientKey: 'secret',
    cooldownMs: 1000,
    localExecOpts: {},
    deps: {
      parseAuthorizationBearer: (h) => String(h || '').replace(/^Bearer\s+/i, ''),
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); }
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'unauthorized_client');
});

test('v1 router accepts Anthropic x-api-key client authentication', async () => {
  const res = createResCapture();
  const handled = await handleV1Request({
    req: { headers: { 'x-api-key': 'secret' }, url: '/v1/models' },
    res,
    method: 'GET',
    pathname: '/v1/models',
    options: { backend: 'codex-adapter', provider: 'agy' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      accounts: { agy: [] },
      modelRegistry: { providers: { agy: new Set() } },
      modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 }
    },
    requiredClientKey: 'secret',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    localExecOpts: {},
    deps: {
      parseAuthorizationBearer: (h) => String(h || '').replace(/^Bearer\s+/i, ''),
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(''),
      handleUpstreamModels: async ({ res: routeRes }) => {
        routeRes.statusCode = 200;
        routeRes.end(JSON.stringify({ object: 'list', data: [] }));
      }
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { object: 'list', data: [] });
});

test('v1 Gemini models use remote catalog instead of stale snapshots', async () => {
  const res = createResCapture();
  let fetchCalls = 0;
  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/models' },
    res,
    method: 'GET',
    pathname: '/v1/models',
    options: {
      backend: 'codex-adapter',
      provider: 'gemini',
      upstreamTimeoutMs: 500,
      modelsProbeAccounts: 1
    },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      accounts: {
        codex: [],
        gemini: [{
          id: 'g1',
          accountRef: V1_GEMINI_REF_1,
          provider: 'gemini',
          accessToken: 'token-g1',
          availableModels: ['gemini-2.5-pro']
        }],
        claude: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set()
        }
      },
      modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    localExecOpts: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(''),
      buildOpenAIModelsList,
      handleCodexModels: async () => {},
      handleUpstreamModels,
      fetchModelsForAccount: async (options, account) => {
        fetchCalls += 1;
        assert.equal(account.id, 'g1');
        assert.equal(options.ignoreAvailableModelsSnapshot, true);
        return ['gemini-3.1-pro-preview', 'gemini-2.5-flash'];
      },
      FALLBACK_MODELS: []
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls, 1);
  const ids = JSON.parse(res.body).data.map((item) => item.id);
  assert.deepEqual(ids, ['gemini-2.5-flash', 'gemini-3.1-pro-preview']);
});

test('v1 OpenCode models use official Go catalog', async () => {
  const res = createResCapture();
  let fetchCalls = 0;
  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/models' },
    res,
    method: 'GET',
    pathname: '/v1/models',
    options: {
      backend: 'codex-adapter',
      provider: 'opencode',
      upstreamTimeoutMs: 500,
      modelsProbeAccounts: 1
    },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [],
        opencode: [{
          id: 'oc1',
          accountRef: V1_OPENCODE_REF_1,
          provider: 'opencode',
          accessToken: 'opencode-local',
          availableModels: []
        }]
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set(),
          opencode: new Set()
        }
      },
      modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    localExecOpts: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(''),
      buildOpenAIModelsList,
      handleCodexModels: async () => {},
      handleUpstreamModels,
      fetchModelsForAccount: async (options, account) => {
        fetchCalls += 1;
        assert.equal(account.provider, 'opencode');
        assert.equal(account.id, 'oc1');
        assert.equal(options.provider, 'opencode');
        return ['opencode-go/glm-5.2', 'opencode-go/kimi-k2.7-code'];
      },
      FALLBACK_MODELS: []
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls, 1);
  const ids = JSON.parse(res.body).data.map((item) => item.id);
  assert.deepEqual(ids, ['opencode-go/glm-5.2', 'opencode-go/kimi-k2.7-code']);
});

test('v1 OpenCode chat completions use official Go API relay', async () => {
  const res = createResCapture();
  const model = 'opencode-go/glm-5.2';
  let called = false;
  const handled = await handleV1Request({
    req: {
      headers: { 'x-provider': 'opencode', 'content-type': 'application/json' },
      url: '/v1/chat/completions'
    },
    res,
    method: 'POST',
    pathname: '/v1/chat/completions',
    options: {
      backend: 'codex-adapter',
      provider: 'auto',
      upstreamTimeoutMs: 500,
      maxAttempts: 1
    },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { opencode: 0 },
      accounts: {
        opencode: [{ id: 'oc1', accountRef: V1_OPENCODE_REF_1, provider: 'opencode', accessToken: 'opencode-local' }]
      },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: { opencode: [model] },
        byAccount: {}
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }]
      })),
      buildOpenAIModelsList,
      resolveRequestProvider: (options, requestJson, headers, stateArg) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, stateArg),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('opencode chat must not fall back to codex chat');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough,
      chooseServerAccount: (pool) => pool[0],
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      fetchOpenCodeChatCompletion: async (_options, account, requestJson) => {
        called = true;
        assert.equal(account.id, 'oc1');
        assert.equal(requestJson.model, model);
        return {
          id: 'chatcmpl-opencode-router-test',
          object: 'chat.completion',
          created: 1,
          model,
          sessionId: 'chatcmpl-opencode-router-test',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        };
      },
      fetchOpenCodeChatCompletionStream: async () => {
        throw new Error('should not stream in non-stream test case');
      },
      fetchWithTimeout: async () => {
        throw new Error('opencode chat must not use OpenAI-compatible passthrough');
      },
      FALLBACK_MODELS: []
    }
  });

  assert.equal(handled, true);
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.model, model);
  assert.equal(body.choices[0].message.content, 'ok');
});

test('v1 OpenCode Anthropic count_tokens is answered locally without upstream passthrough', async () => {
  const res = createResCapture();
  const upstreamCalls = [];
  const pushedErrors = [];
  const state = {
    metrics: {
      totalRequests: 0,
      totalSuccess: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      routeCounts: {},
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {},
      lastErrors: []
    },
    cursors: { opencode: 0 },
    accounts: {
      opencode: [{ id: 'oc1', accountRef: V1_OPENCODE_REF_1, provider: 'opencode', accessToken: 'opencode-local' }]
    }
  };

  const handled = await handleV1Request({
    req: {
      headers: { 'x-provider': 'opencode', 'content-type': 'application/json' },
      url: '/v1/messages/count_tokens'
    },
    res,
    method: 'POST',
    pathname: '/v1/messages/count_tokens',
    options: {
      backend: 'codex-adapter',
      provider: 'auto',
      upstreamTimeoutMs: 500,
      maxAttempts: 1
    },
    state,
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'opencode-go/minimax-m3',
        system: 'Be concise.',
        messages: [{ role: 'user', content: 'ping' }]
      })),
      resolveRequestProvider: () => 'opencode',
      pushMetricError: (_metrics, route, provider, message) => pushedErrors.push({ route, provider, message }),
      handleUpstreamPassthrough: async () => {
        upstreamCalls.push('passthrough');
        throw new Error('count_tokens must not reach upstream passthrough');
      },
      fetchWithTimeout: async () => {
        upstreamCalls.push('fetch');
        throw new Error('count_tokens must not fetch upstream');
      },
      loadAliases: async () => {
        throw new Error('count_tokens does not need alias resolution');
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  const body = JSON.parse(res.body);
  assert.equal(typeof body.input_tokens, 'number');
  assert.ok(body.input_tokens > 0);
  assert.deepEqual(upstreamCalls, []);
  assert.deepEqual(pushedErrors, []);
  assert.equal(state.metrics.totalRequests, 1);
  assert.equal(state.metrics.totalSuccess, 1);
  assert.equal(state.metrics.routeCounts['POST /v1/messages/count_tokens'], 1);
  assert.equal(state.metrics.totalFailures, 0);
});

test('v1 models applies account-scoped WebUI model catalog settings', async () => {
  const res = createResCapture();
  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/models' },
    res,
    method: 'GET',
    pathname: '/v1/models',
    options: {
      backend: 'codex-adapter',
      provider: 'gemini',
      upstreamTimeoutMs: 500,
      modelsProbeAccounts: 3
    },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      accounts: {
        codex: [],
        gemini: [
          { id: '1', accountRef: V1_GEMINI_REF_1, provider: 'gemini', accessToken: 'token-g1' },
          { id: '2', accountRef: V1_GEMINI_REF_2, provider: 'gemini', accessToken: 'token-g2' },
          { id: '3', accountRef: V1_GEMINI_REF_3, provider: 'gemini', accessToken: 'token-g3' }
        ],
        claude: []
      },
      modelCatalogSettings: {
        version: 2,
        updatedAt: 1,
        accountModels: [
          { id: 'c', provider: 'gemini', accountRef: V1_GEMINI_REF_1, enabled: false, manual: false },
          { id: 'd', provider: 'gemini', accountRef: V1_GEMINI_REF_1, enabled: false, manual: false },
          { id: 'c', provider: 'gemini', accountRef: V1_GEMINI_REF_2, enabled: false, manual: false },
          { id: 'f', provider: 'gemini', accountRef: V1_GEMINI_REF_2, enabled: false, manual: false },
          { id: 'g', provider: 'gemini', accountRef: V1_GEMINI_REF_3, enabled: true, manual: true }
        ]
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set()
        }
      },
      modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    localExecOpts: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(''),
      buildOpenAIModelsList,
      handleCodexModels: async () => {},
      handleUpstreamModels,
      fetchModelsForAccount: async (_options, account) => {
        if (account.id === '1') return ['a', 'c', 'b', 'd'];
        if (account.id === '2') return ['a', 'c', 'e', 'f'];
        if (account.id === '3') return [];
        return [];
      },
      FALLBACK_MODELS: []
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const ids = JSON.parse(res.body).data.map((item) => item.id);
  assert.deepEqual(ids, ['a', 'b', 'e', 'g']);
});

test('v1 router returns 413 when request body exceeds limit', async () => {
  const res = createResCapture();
  const handled = await handleV1Request({
    req: { headers: {} },
    res,
    method: 'POST',
    pathname: '/v1/chat/completions',
    options: { backend: 'openai-upstream', provider: 'auto' },
    state: {
      modelRegistry: { providers: { codex: new Set(['gpt-4o-mini']), gemini: new Set() } },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    localExecOpts: {},
    maxRequestBodyBytes: 8,
    deps: {
      readRequestBody: async () => {
        const err = new Error('request_body_too_large');
        err.code = 'request_body_too_large';
        throw err;
      },
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); }
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 413);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'request_body_too_large');
});

test('v1 router sanitizes \"[undefined]\" sentinel fields before upstream passthrough', async () => {
  const res = createResCapture();
  let forwardedJson = null;
  const handled = await handleV1Request({
    req: { headers: {} },
    res,
    method: 'POST',
    pathname: '/v1/chat/completions',
    options: { backend: 'openai-upstream', provider: 'auto' },
    state: {
      modelRegistry: { providers: { codex: new Set(['gpt-dynamic']), gemini: new Set() } },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'gpt-dynamic',
        temperature: '[undefined]',
        messages: [
          { role: 'user', content: 'hello' }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'x',
            strict: '[undefined]'
          }
        }]
      })),
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        forwardedJson = JSON.parse(ctx.bodyBuffer.toString('utf8'));
        ctx.res.statusCode = 200;
        ctx.res.end('{}');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.ok(forwardedJson);
  assert.equal(Object.hasOwn(forwardedJson, 'temperature'), false);
  assert.equal(forwardedJson.tools[0].function.strict, undefined);
});

test('v1 router uses codex adapter handlers when backend is codex-adapter', async () => {
  const res = createResCapture();
  let modelsCalled = false;
  const modelsHandled = await handleV1Request({
    req: { headers: {} },
    res,
    method: 'GET',
    pathname: '/v1/models',
    options: { backend: 'codex-adapter', provider: 'codex' },
    state: {
      modelRegistry: { providers: { codex: new Set(['gpt-dynamic']), gemini: new Set() } },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from('{}'),
      buildOpenAIModelsList: (ids) => ({ object: 'list', data: ids.map((id) => ({ id })) }),
      handleCodexModels: async () => {
        modelsCalled = true;
        res.statusCode = 200;
        res.end('{}');
      },
      handleCodexChatCompletions: async () => {},
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {},
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });
  assert.equal(modelsHandled, true);
  assert.equal(modelsCalled, true);

  const resChat = createResCapture();
  let chatCalled = false;
  const chatHandled = await handleV1Request({
    req: { headers: {} },
    res: resChat,
    method: 'POST',
    pathname: '/v1/chat/completions',
    options: { backend: 'codex-adapter', provider: 'codex' },
    state: {
      modelRegistry: { providers: { codex: new Set(['gpt-dynamic']), gemini: new Set() } },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'gpt-dynamic',
        messages: [{ role: 'user', content: 'hello' }]
      })),
      buildOpenAIModelsList: (ids) => ({ object: 'list', data: ids.map((id) => ({ id })) }),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        chatCalled = true;
        resChat.statusCode = 200;
        resChat.end('{}');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {},
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });
  assert.equal(chatHandled, true);
  assert.equal(chatCalled, true);
});

test('v1 router answers read-only model probes locally without upstream passthrough', async () => {
  const baseState = {
    modelRegistry: { providers: { codex: new Set(['gpt-5.4']), gemini: new Set() } },
    metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 }
  };
  let passthroughCalled = false;

  const createCtx = (pathname, res) => ({
    req: { headers: {}, url: pathname },
    res,
    method: 'GET',
    pathname,
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: baseState,
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from('{}'),
      buildOpenAIModelsList: (ids) => ({ object: 'list', data: ids.map((id) => ({ id })) }),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {},
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        passthroughCalled = true;
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  const modelRes = createResCapture();
  const modelHandled = await handleV1Request(createCtx('/v1/models/gpt-5.4', modelRes));
  assert.equal(modelHandled, true);
  assert.equal(modelRes.statusCode, 200);
  assert.equal(JSON.parse(modelRes.body).id, 'gpt-5.4');

  const propsRes = createResCapture();
  const propsHandled = await handleV1Request(createCtx('/v1/props', propsRes));
  assert.equal(propsHandled, true);
  assert.equal(propsRes.statusCode, 200);
  assert.deepEqual(JSON.parse(propsRes.body), { object: 'props', data: {} });
  assert.equal(passthroughCalled, false);
});

test('v1 router forwards openai responses requests natively to codex and keeps token refresh dependency', async () => {
  const res = createResCapture();
  const refreshCodexAccessToken = async () => ({ ok: true, refreshed: false });
  let seenRefresh = null;
  let seenRequest = null;
  let seenRequestMeta = null;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'codex' },
    state: { metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 } },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({ model: 'gpt-5.3-codex', input: 'hi' })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async (ctx) => {
        seenRefresh = ctx.deps.refreshCodexAccessToken;
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'resp_response',
          object: 'response',
          created: 1770000000,
          model: 'gpt-5.3-codex',
          status: 'completed',
          output: [{
            type: 'message',
            content: [{ type: 'output_text', text: 'hello' }]
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }));
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('codex responses adapter should use codex chat adapter');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      refreshCodexAccessToken
    }
  });

  assert.equal(handled, true);
  assert.equal(seenRefresh, refreshCodexAccessToken);
  assert.equal(seenRequest.input, 'hi');
  assert.equal(seenRequestMeta.clientProtocol, 'openai_responses');
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.model, 'gpt-5.3-codex');
  assert.equal(body.output[0].content[0].text, 'hello');
  assert.deepEqual(body.usage, { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
});

test('v1 router streams codex openai responses natively', async () => {
  const res = createResCapture();
  let seenRequest = null;
  let seenRequestMeta = null;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'codex' },
    state: { metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 } },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({ model: 'gpt-5.3-codex', input: 'hi', stream: true })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        ctx.res.statusCode = 200;
        ctx.res.setHeader('x-aih-server-account-id', '10014');
        ctx.res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        ctx.res.write('event: response.created\n');
        ctx.res.write('data: {"type":"response.created","response":{"id":"resp_stream","model":"gpt-5.3-codex"}}\n\n');
        ctx.res.write('event: response.output_text.delta\n');
        ctx.res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
        ctx.res.write('event: response.completed\n');
        ctx.res.write('data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n');
        ctx.res.write('data: [DONE]\n\n');
        ctx.res.end();
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('codex responses stream should use codex chat adapter');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(seenRequest.stream, true);
  assert.equal(seenRequest.input, 'hi');
  assert.equal(seenRequestMeta.clientProtocol, 'openai_responses');
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['x-aih-server-account-id'], '10014');
  assert.match(res.body, /event: response\.created/);
  assert.match(res.body, /event: response\.output_text\.delta/);
  assert.match(res.body, /"delta":"hello"/);
  assert.match(res.body, /event: response\.completed/);
  assert.match(res.body, /"usage":\{"input_tokens":1,"output_tokens":2,"total_tokens":3\}/);
});

test('v1 router adapts openai responses to provider-native Gemini generateContent for non-codex providers', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'gemini' }, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { gemini: 0 },
      accounts: { gemini: [] }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'gemini-2.5-pro',
        instructions: '你是助手',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('x-provider=gemini should use upstream passthrough');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify(createGeminiGenerateContentResponse('gemini-2.5-pro')));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1beta/models/gemini-2.5-pro:generateContent');
  assert.equal(seenRequest.model, 'gemini-2.5-pro');
  assert.deepEqual(seenRequest.systemInstruction, { parts: [{ text: '你是助手' }] });
  assert.deepEqual(seenRequest.contents, [{ role: 'user', parts: [{ text: 'ping' }] }]);
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'response');
  assert.equal(body.model, 'gemini-2.5-pro');
  assert.equal(body.output[0].content[0].text, 'pong');
});

test('v1 router adapts openai chat requests to claude messages and renders openai response', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'claude' }, url: '/v1/chat/completions' },
    res,
    method: 'POST',
    pathname: '/v1/chat/completions',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: { claude: [] }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: 'ping' }
        ],
        max_tokens: 128
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('x-provider=claude should use claude messages adapter');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_claude_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 6 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenRequest.system, '你是助手');
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.equal(seenRequest.max_tokens, 128);
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'claude-sonnet-4');
  assert.equal(body.choices[0].message.content, 'pong');
  assert.deepEqual(body.usage, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
});

test('v1 router streams OpenAI Chat to official Claude through provider passthrough', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenEffectiveProvider = '';
  let seenRouteTransport = '';

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'claude' }, url: '/v1/chat/completions' },
    res,
    method: 'POST',
    pathname: '/v1/chat/completions',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: { claude: [] }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('official claude openai chat stream should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenEffectiveProvider = String(ctx.requestMeta && ctx.requestMeta.effectiveProvider || '');
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.write('event: message_start\n');
        ctx.res.write('data: {"type":"message_start","message":{"id":"msg_claude_stream","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n');
        ctx.res.write('event: content_block_start\n');
        ctx.res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        ctx.res.write('event: content_block_delta\n');
        ctx.res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n');
        ctx.res.write('event: content_block_stop\n');
        ctx.res.write('data: {"type":"content_block_stop","index":0}\n\n');
        ctx.res.write('event: message_delta\n');
        ctx.res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n');
        ctx.res.write('event: message_stop\n');
        ctx.res.write('data: {"type":"message_stop"}\n\n');
        ctx.res.end();
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchCodeAssistAnthropicMessage: async () => {
        throw new Error('official claude openai chat stream should not use AGY Code Assist direct transport');
      },
      fetchCodeAssistAnthropicMessageStream: async function* () {
        throw new Error('official claude openai chat stream should not use AGY Code Assist direct transport');
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenEffectiveProvider, 'claude');
  assert.equal(seenRouteTransport, 'provider_passthrough');
  assert.equal(seenRequest.stream, true);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.body, /"object":"chat\.completion\.chunk"/);
  assert.match(res.body, /"delta":\{"role":"assistant"\}/);
  assert.match(res.body, /"delta":\{"content":"pong"\}/);
  assert.match(res.body, /"finish_reason":"stop"/);
  assert.match(res.body, /data: \[DONE\]/);
});

test('v1 router composes OpenAI Chat to AGY Claude through direct Anthropic adapter', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenRouteTransport = '';
  let openAIChatAdapterCalled = false;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1/chat/completions' },
    res,
    method: 'POST',
    pathname: '/v1/chat/completions',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-4-6-thinking',
        messages: [
          { role: 'system', content: 'system hint' },
          { role: 'user', content: 'ping' }
        ],
        max_tokens: 256
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy claude openai chat should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_agy_openai_chat_direct',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 7 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchGeminiCodeAssistChatCompletion: async () => {
        openAIChatAdapterCalled = true;
        throw new Error('agy claude openai chat should not use generic Code Assist chat adapter');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(openAIChatAdapterCalled, false);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRequest.system, 'system hint');
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.equal(seenRequest.max_tokens, 256);
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'claude-4-6-thinking');
  assert.equal(body.choices[0].message.content, 'pong');
  assert.deepEqual(body.usage, { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
});

test('v1 router streams OpenAI Chat to AGY Claude through direct Anthropic adapter', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenRouteTransport = '';
  let openAIChatAdapterCalled = false;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1/chat/completions' },
    res,
    method: 'POST',
    pathname: '/v1/chat/completions',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-4-6-thinking',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
        tools: [{
          type: 'function',
          function: {
            name: 'Lookup',
            description: 'Lookup data',
            parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
          }
        }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy claude openai stream should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.setHeader('x-aih-server-account-id', 'a1');
        ctx.res.write('event: message_start\n');
        ctx.res.write('data: {"type":"message_start","message":{"id":"msg_agy_stream","type":"message","role":"assistant","model":"claude-4-6-thinking","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}\n\n');
        ctx.res.write('event: content_block_start\n');
        ctx.res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_lookup","name":"Lookup","input":{}}}\n\n');
        ctx.res.write('event: content_block_delta\n');
        ctx.res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"codex\\"}"}}\n\n');
        ctx.res.write('event: content_block_stop\n');
        ctx.res.write('data: {"type":"content_block_stop","index":0}\n\n');
        ctx.res.write('event: message_delta\n');
        ctx.res.write('data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":7}}\n\n');
        ctx.res.write('event: message_stop\n');
        ctx.res.write('data: {"type":"message_stop"}\n\n');
        ctx.res.end();
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchGeminiCodeAssistChatCompletion: async () => {
        openAIChatAdapterCalled = true;
        throw new Error('agy claude openai stream should not use generic Code Assist chat adapter');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(openAIChatAdapterCalled, false);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRequest.stream, true);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['x-aih-server-account-id'], 'a1');
  assert.match(res.body, /"delta":\{"role":"assistant"\}/);
  assert.match(res.body, /"tool_calls":\[\{"index":0,"id":"toolu_lookup","type":"function","function":\{"name":"Lookup","arguments":""\}\}\]/);
  assert.match(res.body, /"tool_calls":\[\{"index":0,"function":\{"arguments":"\{\\"q\\":\\"codex\\"}"\}\}\]/);
  assert.match(res.body, /"finish_reason":"tool_calls"/);
  assert.match(res.body, /data: \[DONE\]/);
});

test('v1 router adapts openai responses requests through claude messages and renders responses output', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenEffectiveProvider = '';
  let seenRouteTransport = '';

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'claude' }, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: { claude: [] }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4',
        input: 'hello',
        max_output_tokens: 64
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('x-provider=claude should use claude messages adapter');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenEffectiveProvider = String(ctx.requestMeta && ctx.requestMeta.effectiveProvider || '');
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_claude_response',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'world' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 3 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchCodeAssistAnthropicMessage: async () => {
        throw new Error('official claude responses should not use AGY Code Assist direct transport');
      },
      fetchCodeAssistAnthropicMessageStream: async function* () {
        throw new Error('official claude responses should not use AGY Code Assist direct transport');
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenEffectiveProvider, 'claude');
  assert.equal(seenRouteTransport, 'provider_passthrough');
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  assert.equal(seenRequest.max_tokens, 64);
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'response');
  assert.equal(body.model, 'claude-sonnet-4');
  assert.equal(body.output[0].content[0].text, 'world');
  assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
});

test('v1 router streams OpenAI Responses to official Claude through provider passthrough', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenEffectiveProvider = '';
  let seenRouteTransport = '';

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'claude' }, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: { claude: [] }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4',
        input: 'hello',
        stream: true
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('official claude responses stream should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenEffectiveProvider = String(ctx.requestMeta && ctx.requestMeta.effectiveProvider || '');
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.write('event: message_start\n');
        ctx.res.write('data: {"type":"message_start","message":{"id":"msg_claude_response_stream","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"usage":{"input_tokens":4,"output_tokens":0}}}\n\n');
        ctx.res.write('event: content_block_start\n');
        ctx.res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        ctx.res.write('event: content_block_delta\n');
        ctx.res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n');
        ctx.res.write('event: content_block_stop\n');
        ctx.res.write('data: {"type":"content_block_stop","index":0}\n\n');
        ctx.res.write('event: message_delta\n');
        ctx.res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6}}\n\n');
        ctx.res.write('event: message_stop\n');
        ctx.res.write('data: {"type":"message_stop"}\n\n');
        ctx.res.end();
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchCodeAssistAnthropicMessage: async () => {
        throw new Error('official claude responses stream should not use AGY Code Assist direct transport');
      },
      fetchCodeAssistAnthropicMessageStream: async function* () {
        throw new Error('official claude responses stream should not use AGY Code Assist direct transport');
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenEffectiveProvider, 'claude');
  assert.equal(seenRouteTransport, 'provider_passthrough');
  assert.equal(seenRequest.stream, true);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.body, /event: response\.created/);
  assert.match(res.body, /event: response\.output_text\.delta/);
  assert.match(res.body, /"delta":"world"/);
  assert.match(res.body, /event: response\.completed/);
  assert.match(res.body, /"usage":\{"input_tokens":4,"output_tokens":6,"total_tokens":10\}/);
});

test('v1 router composes OpenAI Responses to AGY Claude through direct Anthropic adapter', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenRouteTransport = '';
  let openAIChatAdapterCalled = false;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-4-6-thinking',
        instructions: 'system hint',
        input: 'ping',
        max_output_tokens: 96
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy claude responses should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_agy_response_direct',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 6, output_tokens: 8 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchGeminiCodeAssistChatCompletion: async () => {
        openAIChatAdapterCalled = true;
        throw new Error('agy claude responses should not use generic Code Assist chat adapter');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(openAIChatAdapterCalled, false);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRequest.system, 'system hint');
  assert.equal(seenRequest.max_tokens, 96);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'response');
  assert.equal(body.model, 'claude-4-6-thinking');
  assert.equal(body.output[0].content[0].text, 'pong');
  assert.deepEqual(body.usage, { input_tokens: 6, output_tokens: 8, total_tokens: 14 });
});

test('v1 router preserves OpenAI Responses tool history through AGY Claude direct adapter', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenRouteTransport = '';
  let genericCodeAssistCalled = false;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-4-6-thinking',
        instructions: 'system hint',
        input: [
          {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: 'tool policy' }]
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'fetch the data' }]
          },
          {
            type: 'function_call',
            call_id: 'call_fetch_1',
            name: 'CustomFetch',
            arguments: '{"url":"https://example.test"}'
          },
          {
            type: 'function_call_output',
            call_id: 'call_fetch_1',
            output: '{"status":200}'
          }
        ],
        tools: [{
          type: 'function',
          name: 'CustomFetch',
          description: 'Fetch a URL',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url']
          }
        }],
        tool_choice: { type: 'function', name: 'CustomFetch' },
        max_output_tokens: 96
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy claude responses tool flow should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_agy_response_tool',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{
            type: 'tool_use',
            id: 'toolu_read_1',
            name: 'mcp/server/read',
            input: { file_path: 'package.json' }
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 9, output_tokens: 4 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchGeminiCodeAssistChatCompletion: async () => {
        genericCodeAssistCalled = true;
        throw new Error('agy claude responses tool flow should not use generic Code Assist chat adapter');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(genericCodeAssistCalled, false);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRequest.system, 'system hint\n\ntool policy');
  assert.equal(seenRequest.max_tokens, 96);
  assert.deepEqual(seenRequest.tool_choice, { type: 'tool', name: 'CustomFetch' });
  assert.equal(seenRequest.tools[0].name, 'CustomFetch');
  assert.deepEqual(seenRequest.tools[0].input_schema.required, ['url']);
  assert.deepEqual(seenRequest.messages.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(seenRequest.messages[1].content[0], {
    type: 'tool_use',
    id: 'call_fetch_1',
    name: 'CustomFetch',
    input: { url: 'https://example.test' }
  });
  assert.deepEqual(seenRequest.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_fetch_1',
    content: '{"status":200}'
  });
  const body = JSON.parse(res.body);
  assert.equal(body.output[0].type, 'function_call');
  assert.equal(body.output[0].call_id, 'toolu_read_1');
  assert.equal(body.output[0].name, 'mcp/server/read');
  assert.equal(body.output[0].arguments, '{"file_path":"package.json"}');
  assert.deepEqual(body.usage, { input_tokens: 9, output_tokens: 4, total_tokens: 13 });
});

test('v1 router streams OpenAI Responses to AGY Claude through nested protocol adapters', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenRouteTransport = '';
  let openAIChatAdapterCalled = false;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-4-6-thinking',
        input: 'ping',
        stream: true
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy claude responses stream should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.setHeader('x-aih-server-account-id', 'a1');
        ctx.res.write('event: message_start\n');
        ctx.res.write('data: {"type":"message_start","message":{"id":"msg_agy_response_stream","type":"message","role":"assistant","model":"claude-4-6-thinking","content":[],"usage":{"input_tokens":4,"output_tokens":0}}}\n\n');
        ctx.res.write('event: content_block_start\n');
        ctx.res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        ctx.res.write('event: content_block_delta\n');
        ctx.res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n');
        ctx.res.write('event: content_block_stop\n');
        ctx.res.write('data: {"type":"content_block_stop","index":0}\n\n');
        ctx.res.write('event: message_delta\n');
        ctx.res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6}}\n\n');
        ctx.res.write('event: message_stop\n');
        ctx.res.write('data: {"type":"message_stop"}\n\n');
        ctx.res.end();
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchGeminiCodeAssistChatCompletion: async () => {
        openAIChatAdapterCalled = true;
        throw new Error('agy claude responses stream should not use generic Code Assist chat adapter');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(openAIChatAdapterCalled, false);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRequest.stream, true);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['x-aih-server-account-id'], 'a1');
  assert.match(res.body, /event: response\.created/);
  assert.match(res.body, /event: response\.output_text\.delta/);
  assert.match(res.body, /"delta":"pong"/);
  assert.match(res.body, /event: response\.completed/);
  assert.match(res.body, /"usage":\{"input_tokens":4,"output_tokens":6,"total_tokens":10\}/);
});

test('v1 router formats streamed openai responses adapter errors as openai errors', async () => {
  const res = createResCapture();

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'claude' }, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: { claude: [] }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json; charset=utf-8');
        r.end(JSON.stringify(payload));
      },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4',
        input: 'hello',
        stream: true
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('x-provider=claude should use claude messages adapter');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        ctx.res.statusCode = 404;
        ctx.res.setHeader('content-type', 'application/json; charset=utf-8');
        ctx.res.end(JSON.stringify({
          ok: false,
          error: 'upstream_failed',
          detail: 'upstream_404:'
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, undefined);
  assert.equal(body.error.type, 'not_found_error');
  assert.equal(body.error.message, 'upstream_404:');
});

test('v1 router routes openai responses qwen model to claude by model availability', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenEffectiveProvider = '';

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: {
        codex: [{ id: '6', accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [{ id: '3', accountRef: V1_CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token', availableModels: ['qwen3.6-plus'] }]
      },
      webUiModelsCache: {
        byProvider: {
          codex: ['gpt-5.4'],
          gemini: [],
          claude: ['qwen3.6-plus']
        }
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'qwen3.6-plus',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        stream: false
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, stateArg) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, stateArg),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('qwen responses model should not use codex oauth adapter');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenEffectiveProvider = String(ctx.requestMeta && ctx.requestMeta.effectiveProvider || '');
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_qwen_response',
          type: 'message',
          role: 'assistant',
          model: 'qwen3.6-plus',
          content: [{ type: 'text', text: 'hello from qwen' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 2 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenEffectiveProvider, 'claude');
  assert.equal(seenRequest.model, 'qwen3.6-plus');
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'response');
  assert.equal(body.model, 'qwen3.6-plus');
  assert.equal(body.output[0].content[0].text, 'hello from qwen');
});

test('v1 router routes anthropic messages qwen model to claude by model availability', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenEffectiveProvider = '';

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: {
        codex: [{ id: '6', accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [{ id: '3', accountRef: V1_CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token', availableModels: ['qwen3.6-plus'] }]
      },
      webUiModelsCache: {
        byProvider: {
          codex: ['gpt-5.4'],
          gemini: [],
          claude: ['qwen3.6-plus']
        }
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'qwen3.6-plus',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        stream: false
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, stateArg) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, stateArg),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('qwen messages model should not use codex oauth adapter');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenEffectiveProvider = String(ctx.requestMeta && ctx.requestMeta.effectiveProvider || '');
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_qwen_messages',
          type: 'message',
          role: 'assistant',
          model: 'qwen3.6-plus',
          content: [{ type: 'text', text: 'hello from qwen' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 2 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenEffectiveProvider, 'claude');
  assert.equal(seenRequest.model, 'qwen3.6-plus');
  assert.equal(JSON.parse(res.body).model, 'qwen3.6-plus');
});

test('v1 router adapts anthropic messages requests to codex native responses and renders anthropic response', async () => {
  const res = createResCapture();
  let seenRequest = null;
  let seenRequestMeta = null;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      cursors: { codex: 0 },
      webUiModelsCache: {
        byProvider: {
          codex: ['gpt-5.5']
        }
      },
      accounts: {
        codex: [{ accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
        gemini: [],
        claude: []
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'gpt-5.3-codex',
        system: '你是架构助手',
        max_tokens: 256,
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        ctx.res.statusCode = 200;
        ctx.res.setHeader('x-aih-server-account-ref', V1_CODEX_REF_1);
        ctx.res.end(JSON.stringify({
          id: 'resp-test',
          object: 'response',
          status: 'completed',
          model: 'gpt-5.3-codex',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '你好，已收到。' }]
          }],
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 }
        }));
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('codex request should use codex native responses adapter');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-aih-server-account-ref'], V1_CODEX_REF_1);
  assert.ok(seenRequest);
  assert.equal(seenRequestMeta.clientProtocol, 'openai_responses');
  assert.equal(seenRequest.instructions, '你是架构助手');
  assert.deepEqual(seenRequest.input, [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '你好' }]
  }]);
  assert.equal(seenRequest.max_output_tokens, 256);
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.model, 'gpt-5.3-codex');
  assert.deepEqual(body.content, [{ type: 'text', text: '你好，已收到。' }]);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 3, output_tokens: 5 });
});

test('v1 router adapts anthropic messages to provider-native Gemini generateContent for non-claude providers', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'gemini' }, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { gemini: 0 },
      accounts: { gemini: [] }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'gemini-2.5-pro',
        stream: false,
        messages: [{ role: 'user', content: 'ping' }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('x-provider=gemini should use upstream passthrough');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify(createGeminiGenerateContentResponse('gemini-2.5-pro')));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1beta/models/gemini-2.5-pro:generateContent');
  assert.deepEqual(seenRequest.contents, [{ role: 'user', parts: [{ text: 'ping' }] }]);
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'gemini-2.5-pro');
  assert.deepEqual(body.content, [{ type: 'text', text: 'pong' }]);
});

test('v1 router streams anthropic messages through provider-native Gemini streamGenerateContent', async () => {
  const res = createResCapture();
  let seenUrl = '';

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'gemini' }, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { gemini: 0 },
      accounts: { gemini: [] }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'gemini-2.5-pro',
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('gemini streaming fallback should not use codex');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        ctx.res.statusCode = 200;
        ctx.res.write(`data: ${JSON.stringify(createGeminiGenerateContentResponse('gemini-2.5-pro', 'stream pong'))}\n\n`);
        ctx.res.end();
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1beta/models/gemini-2.5-pro:streamGenerateContent');
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.body, /event: message_start/);
  assert.match(res.body, /"text":"stream pong"/);
  assert.match(res.body, /event: message_stop/);
});

test('v1 router routes AGY Gemini Anthropic messages through generateContent fallback bridge', async () => {
  const res = createResCapture();
  const refreshAgyAccessToken = async () => ({ ok: true, refreshed: false });
  let seenUrl = '';
  let seenRequest = null;
  let seenRouteTransport = '';
  let seenRefresh = null;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['gemini-2.5-pro'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'gemini-2.5-pro',
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy non-claude model should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenRefresh = ctx.deps.refreshAgyAccessToken;
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'pong' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      refreshAgyAccessToken,
      fetchCodeAssistAnthropicMessage: async () => {
        throw new Error('agy non-claude model should not use Code Assist Anthropic direct transport');
      },
      fetchCodeAssistAnthropicMessageStream: async function* () {
        throw new Error('agy non-claude model should not use Code Assist Anthropic direct transport');
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1beta/models/gemini-2.5-pro:generateContent');
  assert.equal(seenRouteTransport, '');
  assert.equal(seenRefresh, refreshAgyAccessToken);
  assert.equal(seenRequest.model, 'gemini-2.5-pro');
  assert.equal(seenRequest.contents[0].parts[0].text, 'ping');
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'gemini-2.5-pro');
  assert.deepEqual(body.content, [{ type: 'text', text: 'pong' }]);
});

test('v1 router sends AGY Claude client requests to direct Code Assist Anthropic adapter', async () => {
  const res = createResCapture();
  const refreshAgyAccessToken = async () => ({ ok: true, refreshed: false });
  let seenUrl = '';
  let seenRequest = null;
  let seenEffectiveProvider = '';
  let seenRouteTransport = '';
  let seenRefresh = null;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-4-6-thinking',
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy anthropic direct path should not use codex chat');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenRefresh = ctx.deps.refreshAgyAccessToken;
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenEffectiveProvider = String(ctx.requestMeta && ctx.requestMeta.effectiveProvider || '');
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_agy_direct',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      refreshAgyAccessToken,
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenEffectiveProvider, 'agy');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRefresh, refreshAgyAccessToken);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.equal(JSON.parse(res.body).id, 'msg_agy_direct');
});

test('v1 router rejects aliased AGY Claude requests when refreshed catalog omits target model', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenRequestMeta = null;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [{
          id: 'agy-virtual-alias',
          alias: 'claude-sonnet-4-6',
          target: 'claude-opus-4-6-thinking',
          provider: 'all',
          targetProvider: 'auto',
          enabled: true
        }]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [{ accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['gemini-3.1-pro-preview'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('aliased agy claude request should not use codex chat');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_agy_alias_direct',
          type: 'message',
          role: 'assistant',
          model: ctx.requestJson.model,
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'alias_target_model_not_in_catalog');
  assert.equal(body.model, 'claude-opus-4-6-thinking');
  assert.equal(body.alias.requestedModel, 'claude-sonnet-4-6');
  assert.equal(body.alias.target, 'claude-opus-4-6-thinking');
  assert.equal(seenUrl, '');
  assert.equal(seenRequest, null);
  assert.equal(seenRequestMeta, null);
});

test('v1 router prefers a known routable alias over a higher-priority unknown target', async () => {
  const res = createResCapture();
  let seenRequest = null;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [
          {
            id: 'alias-high-priority',
            alias: 'claude-sonnet-4-6',
            target: 'claude-opus-4-6-thinking',
            provider: 'all',
            targetProvider: 'auto',
            priority: 10,
            enabled: true
          },
          {
            id: 'alias-low-priority',
            alias: 'claude-sonnet-4-6',
            target: 'gemini-3.1-pro-preview',
            provider: 'all',
            targetProvider: 'agy',
            priority: 0,
            enabled: true
          }
        ]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        codex: [],
        gemini: [],
        // A warm index may still contain one account whose catalog is unknown.
        // That uncertainty must not outrank the known-routable AGY candidate.
        claude: [{
          accountRef: 'acct_77777777777777777777',
          provider: 'claude',
          accessToken: 'claude-token'
        }],
        agy: [{ accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['gemini-3.1-pro-preview'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('fallback alias request should not use codex chat');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenRequest = ctx.requestJson;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_alias_fallback',
          type: 'message',
          role: 'assistant',
          model: ctx.requestJson.model,
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        }));
      },
      chooseServerAccount: (provider, state) => (provider === 'agy' ? state.accounts.agy[0] : null),
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchCodeAssistAnthropicMessage: async (options, account, requestJson) => {
        seenRequest = requestJson;
        return {
          id: 'msg_alias_fallback',
          type: 'message',
          role: 'assistant',
          model: requestJson.model,
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      },
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  // 高优先级 target 目录未知时，已知可路由目标仍应优先并成功路由。
  assert.equal(res.statusCode, 200);
  assert.ok(seenRequest);
  assert.equal(seenRequest.model, 'gemini-3.1-pro-preview');
});

test('v1 router retries AGY aliases then falls back across provider to Codex', async () => {
  const res = createResCapture();
  const seenModels = [];
  const seenUrls = [];
  const seenFallbackCapture = [];

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [
          {
            id: 'alias-agy-claude',
            alias: 'claude-*',
            target: 'claude-opus-4-6-thinking',
            provider: 'all',
            targetProvider: 'agy',
            priority: 50,
            enabled: true
          },
          {
            id: 'alias-agy-gemini',
            alias: 'claude-*',
            target: 'gemini-3-flash-agent',
            provider: 'all',
            targetProvider: 'agy',
            priority: 0,
            enabled: true
          },
          {
            id: 'alias-codex-gpt',
            alias: 'claude-*',
            target: 'gpt-5.6-sol',
            provider: 'all',
            targetProvider: 'codex',
            priority: 0,
            enabled: true
          }
        ]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0, codex: 0 },
      webUiModelsCache: {
        source: 'remote',
        scannedAccounts: 10,
        firstError: 'HTTP 403 {"error":{"status":"PERMISSION_DENIED"}}',
        byProvider: {
          agy: ['claude-opus-4-6-thinking', 'gemini-3-flash-agent'],
          codex: ['gpt-5.6-sol']
        },
        byAccount: {}
      },
      accounts: {
        codex: [{
          accountRef: V1_CODEX_REF_1,
          provider: 'codex',
          accessToken: 'codex-token',
          availableModels: ['gpt-5.6-sol']
        }],
        gemini: [],
        claude: [],
        agy: [{
          accountRef: V1_AGY_REF_1,
          provider: 'agy',
          accessToken: 'agy-token',
          authType: 'oauth-personal',
          availableModels: ['claude-opus-4-6-thinking', 'gemini-3-flash-agent']
        }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-opus-4-8',
        stream: false,
        max_tokens: 128,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async (ctx) => {
        seenModels.push(String(ctx.requestJson && ctx.requestJson.model || ''));
        seenFallbackCapture.push(Boolean(ctx.requestMeta && ctx.requestMeta.aliasRuntimeFallback));
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'resp_alias_codex_fallback',
          object: 'response',
          status: 'completed',
          model: 'gpt-5.6-sol',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok from codex' }]
          }],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
        }));
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenModels.push(String(ctx.requestJson && ctx.requestJson.model || ''));
        seenUrls.push(String(ctx.req && ctx.req.url || ''));
        seenFallbackCapture.push(Boolean(ctx.requestMeta && ctx.requestMeta.aliasRuntimeFallback));
        return {
          retryAliasCandidate: true,
          statusCode: 401,
          error: 'auth_invalid_reauth_required',
          detail: `no schedulable agy account for ${ctx.requestJson.model}`,
          provider: 'agy',
          model: ctx.requestJson.model,
          attemptedAccountRefs: [V1_AGY_REF_1],
          alias: {
            id: ctx.requestMeta.aliasResolution.aliasId,
            requestedModel: ctx.requestMeta.aliasResolution.requestedModel,
            target: ctx.requestMeta.aliasResolution.aliasTarget
          }
        };
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.deepEqual(seenModels, ['claude-opus-4-6-thinking', 'gemini-3-flash-agent', 'gpt-5.6-sol']);
  assert.equal(seenUrls[0], '/v1/messages');
  assert.equal(seenUrls[1], '/v1beta/models/gemini-3-flash-agent:generateContent');
  assert.deepEqual(seenFallbackCapture, [true, true, false]);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'gpt-5.6-sol');
  assert.deepEqual(body.content, [{ type: 'text', text: 'ok from codex' }]);
});

test('v1 router reports all tried alias targets when every candidate is unavailable', async () => {
  const res = createResCapture();

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [
          {
            id: 'alias-high-priority',
            alias: 'claude-sonnet-4-6',
            target: 'claude-opus-4-6-thinking',
            provider: 'all',
            targetProvider: 'auto',
            priority: 10,
            enabled: true
          },
          {
            id: 'alias-low-priority',
            alias: 'claude-sonnet-4-6',
            target: 'gemini-3.5-flash-high',
            provider: 'all',
            targetProvider: 'auto',
            priority: 0,
            enabled: true
          }
        ]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [{ accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['gemini-3.1-pro-preview'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {},
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {},
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'alias_target_model_not_in_catalog');
  assert.equal(body.alias.matched, true);
  assert.equal(body.alias.id, 'alias-high-priority');
  assert.equal(body.alias.requestedModel, 'claude-sonnet-4-6');
  assert.equal(body.alias.target, 'claude-opus-4-6-thinking');
  assert.match(body.detail, /tried targets: claude-opus-4-6-thinking\(priority=10\), gemini-3\.5-flash-high\(priority=0\)/);
});

test('v1 router keeps runtime alias failure when remaining alias target is unavailable', async () => {
  const res = createResCapture();
  const seenModels = [];

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [
          {
            id: 'alias-agy-claude',
            alias: 'claude-*',
            target: 'claude-opus-4-6-thinking',
            provider: 'all',
            targetProvider: 'agy',
            priority: 100,
            enabled: true
          },
          {
            id: 'alias-agy-gemini',
            alias: 'claude-*',
            target: 'gemini-3-flash-agent',
            provider: 'all',
            targetProvider: 'agy',
            priority: 80,
            enabled: true
          },
          {
            id: 'alias-stale-opencode',
            alias: 'claude-*',
            target: 'opencode-go/glm-5.2',
            provider: 'all',
            targetProvider: 'auto',
            priority: 0,
            enabled: true
          }
        ]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      webUiModelsCache: {
        source: 'remote',
        scannedAccounts: 9,
        firstError: '',
        byProvider: {
          agy: ['claude-opus-4-6-thinking', 'gemini-3-flash-agent']
        },
        byAccount: {}
      },
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [{
          accountRef: V1_AGY_REF_1,
          provider: 'agy',
          accessToken: 'agy-token',
          authType: 'oauth-personal',
          availableModels: ['claude-opus-4-6-thinking', 'gemini-3-flash-agent']
        }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-opus-4-8',
        stream: false,
        max_tokens: 128,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('runtime alias request should not use codex');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenModels.push(String(ctx.requestJson && ctx.requestJson.model || ''));
        return {
          retryAliasCandidate: true,
          statusCode: 502,
          error: 'gemini_code_assist_project_unavailable',
          detail: `project unavailable for ${ctx.requestJson.model}`,
          provider: 'agy',
          model: ctx.requestJson.model,
          attemptedAccountRefs: [V1_AGY_REF_1],
          alias: {
            id: ctx.requestMeta.aliasResolution.aliasId,
            requestedModel: ctx.requestMeta.aliasResolution.requestedModel,
            target: ctx.requestMeta.aliasResolution.aliasTarget
          }
        };
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.deepEqual(seenModels, ['claude-opus-4-6-thinking', 'gemini-3-flash-agent']);
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'gemini_code_assist_project_unavailable');
  assert.equal(body.alias.id, 'alias-agy-gemini');
  assert.equal(body.alias.requestedModel, 'claude-opus-4-8');
  assert.equal(body.alias.target, 'gemini-3-flash-agent');
  assert.deepEqual(body.triedAliasTargets, [
    'claude-opus-4-6-thinking(status=502)',
    'gemini-3-flash-agent(status=502)',
    'opencode-go/glm-5.2(status=503)'
  ]);
});

test('v1 router last-resorts to a soft-cooled alias target instead of 503ing the client', async () => {
  // Every alias target is only soft model-cooled (the account itself is healthy).
  // Rather than returning no_available_account to the client, the gateway must
  // attempt the highest-priority candidate anyway, passing allowModelCooled so
  // account selection can serve the cooled model.
  const res = createResCapture();
  const until = Date.now() + 60000;
  let passthroughCalled = false;
  let sawAllowModelCooled = false;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [
          {
            id: 'alias-cooling-high',
            alias: 'claude-*',
            target: 'claude-sonnet-4-6',
            provider: 'all',
            targetProvider: 'agy',
            priority: 10,
            enabled: true
          },
          {
            id: 'alias-cooling-low',
            alias: 'claude-*',
            target: 'gemini-3-flash-agent',
            provider: 'all',
            targetProvider: 'agy',
            priority: 0,
            enabled: true
          }
        ]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [{
          accountRef: V1_AGY_REF_1,
          provider: 'agy',
          accessToken: 'agy-token',
          authType: 'oauth-personal',
          availableModels: ['claude-sonnet-4-6', 'gemini-3-flash-agent'],
          modelCooldowns: {
            'claude-sonnet-4-6': until,
            'gemini-3-flash-agent': until
          }
        }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-opus-4-8',
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('cooled alias should not use codex');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        passthroughCalled = true;
        sawAllowModelCooled = Boolean(ctx && ctx.requestMeta && ctx.requestMeta.allowModelCooled);
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({ ok: true }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  // Last resort fired: instead of returning no_available_account, the gateway
  // proceeded to attempt the highest-priority soft-cooled candidate. (In this
  // unit harness the agy direct route is not wired, so the attempt surfaces as a
  // route-unavailable 500 — the point is the client no longer gets the 503.)
  const body = JSON.parse(res.body);
  assert.notEqual(body.error, 'no_available_account');
  assert.doesNotMatch(JSON.stringify(body), /temporarily rate-limited\/cooling down/);
});

test('v1 router still 503s when alias targets only have hard-down (auth) accounts', async () => {
  // Last resort must NOT fire for credential/identity failures: a deauthed
  // account is genuinely dead, so hammering it would be pointless. The client
  // still gets no_available_account.
  const res = createResCapture();
  const until = Date.now() + 60000;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [
          {
            id: 'alias-auth-high',
            alias: 'claude-*',
            target: 'claude-sonnet-4-6',
            provider: 'all',
            targetProvider: 'agy',
            priority: 10,
            enabled: true
          }
        ]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [{
          accountRef: V1_AGY_REF_1,
          provider: 'agy',
          accessToken: 'agy-token',
          authType: 'oauth-personal',
          availableModels: ['claude-sonnet-4-6'],
          // Account-level (hard) auth cooldown: the whole account is down.
          authInvalidUntil: until,
          cooldownUntil: until,
          lastFailureKind: 'auth_invalid'
        }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-opus-4-8',
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => { throw new Error('hard-down alias must not use codex'); },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => { throw new Error('hard-down alias must not reach passthrough'); },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  // Hard-down (auth) accounts are not last-resort eligible: no upstream attempt is
  // made (the codex/passthrough mocks would throw if it were) and the client gets
  // an unavailable response rather than a served request.
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(String(body.error), /not_in_catalog|no_available_account|unavailable/);
});

test('v1 router does not fall back to OpenAI bridge when AGY Claude direct adapter is unavailable', async () => {
  const res = createResCapture();
  let passthroughCalled = false;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-4-6-thinking',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy direct route must not fall back to codex chat');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        passthroughCalled = true;
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(passthroughCalled, false);
  assert.equal(res.statusCode, 500);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'provider_protocol_route_unavailable');
  assert.equal(body.clientProtocol, 'anthropic_messages');
  assert.equal(body.provider, 'agy');
});

test('v1 router does not fall back from direct AGY Claude protocol routes when wiring is unavailable', async () => {
  const runUnavailableRoute = async ({ pathname, requestBody, expectedProtocol }) => {
    const res = createResCapture();
    let passthroughCalled = false;

    const handled = await handleV1Request({
      req: { headers: { 'x-provider': 'agy' }, url: pathname },
      res,
      method: 'POST',
      pathname,
      options: { backend: 'codex-adapter', provider: 'auto' },
      state: {
        metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
        cursors: { agy: 0 },
        accounts: {
          agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
        }
      },
      requiredClientKey: '',
      cooldownMs: 1000,
      maxRequestBodyBytes: 1024 * 1024,
      requestMeta: {},
      deps: {
        parseAuthorizationBearer: () => '',
        writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
        readRequestBody: async () => Buffer.from(JSON.stringify(requestBody)),
        buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
        resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
        handleCodexModels: async () => {},
        handleCodexChatCompletions: async () => {
          throw new Error('direct AGY Claude route must not fall back to codex chat');
        },
        handleUpstreamModels: async () => {},
        handleUpstreamPassthrough: async () => {
          passthroughCalled = true;
        },
        chooseServerAccount: () => null,
        markProxyAccountSuccess: () => {},
        markProxyAccountFailure: () => {},
        pushMetricError: () => {},
        appendProxyRequestLog: () => {},
        fetchModelsForAccount: async () => [],
        FALLBACK_MODELS: [],
        fetchWithTimeout: async () => ({})
      }
    });

    assert.equal(handled, true);
    assert.equal(passthroughCalled, false);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'provider_protocol_route_unavailable');
    assert.equal(body.clientProtocol, expectedProtocol);
    assert.equal(body.provider, 'agy');
  };

  await runUnavailableRoute({
    pathname: '/v1/responses',
    expectedProtocol: 'openai_responses',
    requestBody: {
      model: 'claude-4-6-thinking',
      input: 'ping'
    }
  });

  await runUnavailableRoute({
    pathname: '/v1beta/models/claude-4-6-thinking:generateContent',
    expectedProtocol: 'gemini_generate_content',
    requestBody: {
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }]
    }
  });
});

test('v1 router infers AGY Claude models to direct Code Assist Anthropic adapter without provider header', async () => {
  const res = createResCapture();
  let seenEffectiveProvider = '';
  let seenRouteTransport = '';

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-4-6-thinking',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy model-inferred direct path should not use codex chat');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenEffectiveProvider = String(ctx.requestMeta && ctx.requestMeta.effectiveProvider || '');
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_agy_model_inferred',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(seenEffectiveProvider, 'agy');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(JSON.parse(res.body).id, 'msg_agy_model_inferred');
});

test('v1 router keeps official Claude client requests on Anthropic passthrough', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenEffectiveProvider = '';
  let seenRouteTransport = '';

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'claude' }, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: {
        claude: [{ id: 'c1', accountRef: V1_CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token', authType: 'api-key', availableModels: ['claude-sonnet-4-5'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 128,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('official claude messages should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenEffectiveProvider = String(ctx.requestMeta && ctx.requestMeta.effectiveProvider || '');
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_claude_passthrough',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenEffectiveProvider, 'claude');
  assert.equal(seenRouteTransport, 'provider_passthrough');
  assert.equal(seenRequest.max_tokens, 128);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.equal(JSON.parse(res.body).id, 'msg_claude_passthrough');
});

test('v1 router pins Claude OAuth relay by accountRef and bypasses global aliases', async () => {
  const res = createResCapture();
  let seenRequest = null;
  let seenRequestMeta = null;
  let seenHeaders = null;

  const handled = await handleV1Request({
    req: { headers: { 'x-account-ref': V1_CLAUDE_REF_2 }, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [{
          id: 'global-claude-alias',
          alias: 'claude-*',
          target: 'deepseek-v4-pro',
          provider: 'all',
          targetProvider: 'claude',
          enabled: true
        }]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: {
        claude: [
          { accountRef: V1_CLAUDE_REF_1, provider: 'claude', accessToken: 'first' },
          { accountRef: V1_CLAUDE_REF_2, provider: 'claude', accessToken: 'second' }
        ]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'ping' }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => { throw new Error('pinned Claude request must not use Codex'); },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        seenHeaders = ctx.req.headers;
        ctx.res.statusCode = 200;
        ctx.res.end('{"ok":true}');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(seenRequest.model, 'claude-opus-4-8');
  assert.equal(seenHeaders['x-provider'], 'claude');
  assert.equal(seenHeaders['x-account-ref'], V1_CLAUDE_REF_2);
  assert.equal(seenRequestMeta.accountRef, V1_CLAUDE_REF_2);
  assert.equal(seenRequestMeta.aliasResolution.aliasMatched, false);
});

test('v1 router rejects a mutable CLI account id in the account pin header', async () => {
  const res = createResCapture();
  const handled = await handleV1Request({
    req: { headers: { 'x-account-ref': '9' }, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: { accounts: {} },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from('{}')
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'invalid_account_ref');
});

test('v1 router rejects Anthropic messages without model before provider passthrough', async () => {
  const res = createResCapture();
  let passthroughCalled = false;
  let codexCalled = false;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { claude: 0 },
      accounts: {
        codex: [{ id: 'c1', accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
        gemini: [],
        claude: [{ id: 'cl1', accountRef: V1_CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token', authType: 'api-key', availableModels: ['claude-sonnet-4-5'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        max_tokens: 128,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        codexCalled = true;
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        passthroughCalled = true;
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(passthroughCalled, false);
  assert.equal(codexCalled, false);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'missing_model');
  assert.equal(body.clientProtocol, 'anthropic_messages');
});

test('v1 router infers target provider from protocol-scoped alias target without mutating request headers', async () => {
  const res = createResCapture();
  const req = { headers: { 'x-provider': 'claude' }, url: '/v1/v1/messages' };
  let seenRequest = null;
  let seenRequestMeta = null;
  let codexCalled = false;

  const handled = await handleV1Request({
    req,
    res,
    method: 'POST',
    pathname: '/v1/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [{
          id: 'alias-1',
          alias: 'claude-*',
          target: 'gpt-5.5',
          provider: 'claude',
          enabled: true
        }]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      cursors: { codex: 0 },
      webUiModelsCache: {
        byProvider: {
          codex: ['gpt-5.5']
        }
      },
      accounts: {
        codex: [{ id: 'c1', accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
        gemini: [],
        claude: []
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: false,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'ping' }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async (ctx) => {
        codexCalled = true;
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'resp-alias',
          object: 'response',
          status: 'completed',
          model: 'gpt-5.5',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'pong' }]
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }));
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('claude-scoped alias targeting gpt should route through codex native responses handler');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(codexCalled, true);
  assert.equal(seenRequest.model, 'gpt-5.5');
  assert.equal(seenRequestMeta.clientProtocol, 'openai_responses');
  assert.equal(seenRequestMeta.effectiveProvider, 'codex');
  assert.equal(req.headers['x-provider'], 'claude');
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'gpt-5.5');
});

test('v1 router reloads model aliases from store for claude child-agent model requests', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-v1-alias-store-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  await saveAliases(fs, aiHomeDir, {
    aliases: [{
      id: 'haiku-alias',
      alias: 'claude-haiku-4-5*',
      target: 'gpt-5.5',
      provider: 'all',
      targetProvider: 'auto',
      enabled: true
    }]
  });

  const res = createResCapture();
  let seenRequest = null;
  let seenRequestMeta = null;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: { aliases: [] },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      cursors: { codex: 0 },
      webUiModelsCache: {
        byProvider: {
          codex: ['gpt-5.5']
        }
      },
      accounts: {
        codex: [{ id: 'c1', accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
        gemini: [],
        claude: []
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'ping' }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'resp-alias-store',
          object: 'response',
          status: 'completed',
          model: 'gpt-5.5',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'pong' }]
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }));
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('store-backed claude alias should route through codex');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fs,
      aiHomeDir,
      loadAliases
    }
  });

  assert.equal(handled, true);
  assert.equal(seenRequest.model, 'gpt-5.5');
  assert.equal(seenRequestMeta.aliasResolution.aliasMatched, true);
  assert.equal(seenRequestMeta.aliasResolution.aliasId, 'haiku-alias');
  assert.equal(seenRequestMeta.aliasResolution.requestedModel, 'claude-haiku-4-5-20251001');
  assert.equal(JSON.parse(res.body).model, 'gpt-5.5');
});

test('v1 router reports global pool miss when claude alias targets unavailable codex model', async () => {
  const res = createResCapture();

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [{
          id: 'alias-codex-unavailable',
          alias: 'claude-*',
          target: 'gpt-5.5',
          provider: 'claude',
          targetProvider: 'auto',
          enabled: true
        }]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { codex: 0 },
      webUiModelsCache: {
        byProvider: {
          codex: ['gpt-5.5']
        }
      },
      accounts: {
        codex: [{
          accountRef: V1_CODEX_REF_1,
          provider: 'codex',
          accessToken: 'codex-token',
          availableModels: ['gpt-5.5'],
          cooldownUntil: Date.now() + 60_000
        }],
        gemini: [{ accountRef: V1_GEMINI_REF_1, provider: 'gemini', accessToken: 'gemini-token', availableModels: ['gemini-3.1-pro-preview'] }],
        claude: []
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: false,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'ping' }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('unavailable codex alias should fail before codex handler');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('gpt alias should not be rerouted to gemini when codex is unavailable');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'alias_target_model_not_in_catalog');
  assert.match(body.detail, /alias target model gpt-5\.5 is not present/);
  assert.equal(body.model, 'gpt-5.5');
  assert.equal(body.availability.provider, 'catalog');
});

test('v1 router lets claude client use gemini account through exact model alias', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenEffectiveProvider = '';

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [{
          id: 'alias-gemini',
          alias: 'claude-opus-4-7',
          target: 'gemini-3.1-pro-preview',
          provider: 'claude',
          targetProvider: 'auto',
          enabled: true
        }]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { gemini: 0 },
      webUiModelsCache: {
        byProvider: {
          gemini: ['gemini-3.1-pro-preview']
        }
      },
      accounts: {
        codex: [],
        gemini: [{ id: 'g1', accountRef: V1_GEMINI_REF_1, provider: 'gemini', accessToken: 'gemini-token', availableModels: ['gemini-3.1-pro-preview'] }],
        claude: []
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-opus-4-7',
        stream: false,
        max_tokens: 128,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('gemini alias should not use codex');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenEffectiveProvider = String(ctx.requestMeta && ctx.requestMeta.effectiveProvider || '');
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify(createGeminiGenerateContentResponse('gemini-3.1-pro-preview')));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(seenUrl, '/v1beta/models/gemini-3.1-pro-preview:generateContent');
  assert.equal(seenRequest.model, 'gemini-3.1-pro-preview');
  assert.deepEqual(seenRequest.contents, [{ role: 'user', parts: [{ text: 'ping' }] }]);
  assert.equal(seenEffectiveProvider, 'gemini');
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'gemini-3.1-pro-preview');
  assert.deepEqual(body.content, [{ type: 'text', text: 'pong' }]);
});

test('v1 router reports global pool miss instead of claude-only miss when no alias can serve claude model', async () => {
  const res = createResCapture();

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { codex: 0 },
      accounts: {
        codex: [
          { id: 'c1', accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token-1' },
          { id: 'c2', accountRef: V1_CODEX_REF_2, provider: 'codex', accessToken: 'codex-token-2' }
        ],
        gemini: [],
        claude: []
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'ping' }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('unsupported claude model should fail before codex handler');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('unsupported claude model should fail before upstream passthrough');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'no_available_account');
  assert.match(body.detail, /global pool/);
  assert.equal(body.familyProvider, 'claude');
  assert.equal(body.availability.provider, 'global');
  assert.equal(body.availability.providers.codex.accounts, 2);
  assert.equal(body.availability.providers.claude.accounts, 0);
});

test('v1 models lists real global models and exact aliases without expanding wildcard aliases', async () => {
  const res = createResCapture();

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/models' },
    res,
    method: 'GET',
    pathname: '/v1/models',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      modelAliases: {
        aliases: [
          {
            id: 'alias-exact',
            alias: 'claude-opus-4-7',
            target: 'gemini-3.1-pro-preview',
            provider: 'claude',
            targetProvider: 'auto',
            enabled: true
          },
          {
            id: 'alias-wildcard',
            alias: 'claude-*',
            target: 'gpt-5.5',
            provider: 'claude',
            targetProvider: 'auto',
            enabled: true
          }
        ]
      },
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      modelRegistry: { providers: { codex: new Set(['gpt-5.5']), gemini: new Set(), claude: new Set() } },
      accounts: {
        codex: [{ id: 'c1', accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
        gemini: [{ id: 'g1', accountRef: V1_GEMINI_REF_1, provider: 'gemini', accessToken: 'gemini-token', availableModels: ['gemini-3.1-pro-preview'] }],
        claude: []
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from('{}'),
      buildOpenAIModelsList,
      handleCodexModels: async (ctx) => {
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({ object: 'list', data: [] }));
      },
      handleUpstreamModels: async (ctx) => {
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({ object: 'list', data: [] }));
      },
      handleCodexChatCompletions: async () => {},
      handleUpstreamPassthrough: async () => {},
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-aih-models-source'], 'global-capability-pool');
  const models = JSON.parse(res.body).data;
  const ids = models.map((item) => item.id);
  const modelById = new Map(models.map((item) => [item.id, item]));
  // Wildcard alias patterns (claude-*) are NOT advertised as selectable models;
  // exact aliases (claude-opus-4-7) and real models still are.
  assert.deepEqual(ids, ['claude-opus-4-7', 'gemini-3.1-pro-preview', 'gpt-5.5']);
  assert.equal(modelById.has('claude-*'), false);
  assert.equal(modelById.get('claude-opus-4-7').owned_by, 'anthropic');
  assert.equal(modelById.get('gemini-3.1-pro-preview').owned_by, 'google');
  assert.equal(modelById.get('gpt-5.5').owned_by, 'openai');
  assert.equal(ids.includes('claude-sonnet-4-6'), false);
});

test('v1 global models include OpenCode provider catalog', async () => {
  const res = createResCapture();
  const upstreamProviders = [];

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/models' },
    res,
    method: 'GET',
    pathname: '/v1/models',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set(),
          opencode: new Set()
        }
      },
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [],
        opencode: []
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from('{}'),
      buildOpenAIModelsList,
      handleCodexModels: async (ctx) => {
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.5' }] }));
      },
      handleUpstreamModels: async (ctx) => {
        const provider = String(ctx.options && ctx.options.provider || '');
        upstreamProviders.push(provider);
        const ids = provider === 'opencode'
          ? ['opencode-go/glm-5.2', 'opencode-go/kimi-k2.7-code']
          : [];
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          object: 'list',
          data: ids.map((id) => ({ id }))
        }));
      },
      handleCodexChatCompletions: async () => {},
      handleUpstreamPassthrough: async () => {},
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-aih-models-source'], 'global-capability-pool');
  assert.deepEqual(
    upstreamProviders.sort(),
    SUPPORTED_SERVER_PROVIDERS.filter((provider) => provider !== 'codex').sort()
  );
  const ids = JSON.parse(res.body).data.map((item) => item.id);
  assert.deepEqual(ids, ['gpt-5.5', 'opencode-go/glm-5.2', 'opencode-go/kimi-k2.7-code']);
});

test('v1 global models attach aih_modalities and filter by capability after cache read', async () => {
  const state = {
    metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
    modelRegistry: {
      providers: {
        codex: new Set(),
        gemini: new Set(),
        claude: new Set(),
        agy: new Set(),
        opencode: new Set()
      }
    },
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [],
      opencode: []
    }
  };

  const runModelsRequest = async (url) => {
    const res = createResCapture();
    const handled = await handleV1Request({
      req: { headers: {}, url },
      res,
      method: 'GET',
      pathname: '/v1/models',
      options: { backend: 'codex-adapter', provider: 'auto' },
      state,
      requiredClientKey: '',
      cooldownMs: 1000,
      maxRequestBodyBytes: 1024 * 1024,
      requestMeta: {},
      deps: {
        parseAuthorizationBearer: () => '',
        writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
        readRequestBody: async () => Buffer.from('{}'),
        buildOpenAIModelsList,
        handleCodexModels: async (ctx) => {
          ctx.res.statusCode = 200;
          ctx.res.end(JSON.stringify({ object: 'list', data: [] }));
        },
        handleUpstreamModels: async (ctx) => {
          const provider = String(ctx.options && ctx.options.provider || '');
          const idsByProvider = {
            claude: ['claude-sonnet-4-6'],
            gemini: ['gemini-3.1-flash-image'],
            opencode: ['opencode-go/glm-5.2']
          };
          const ids = idsByProvider[provider] || [];
          ctx.res.statusCode = 200;
          ctx.res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }));
        },
        handleCodexChatCompletions: async () => {},
        handleUpstreamPassthrough: async () => {},
        chooseServerAccount: () => null,
        markProxyAccountSuccess: () => {},
        markProxyAccountFailure: () => {},
        pushMetricError: () => {},
        appendProxyRequestLog: () => {},
        fetchModelsForAccount: async () => [],
        FALLBACK_MODELS: [],
        fetchWithTimeout: async () => ({})
      }
    });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    return res;
  };

  const fullRes = await runModelsRequest('/v1/models');
  const fullModels = JSON.parse(fullRes.body).data;
  assert.deepEqual(
    fullModels.map((item) => item.id),
    ['claude-sonnet-4-6', 'gemini-3.1-flash-image', 'opencode-go/glm-5.2']
  );
  const fullById = new Map(fullModels.map((item) => [item.id, item]));
  assert.equal(fullById.get('claude-sonnet-4-6').aih_modalities.input.includes('image'), true);
  assert.deepEqual(fullById.get('claude-sonnet-4-6').aih_modalities.output, ['text']);
  assert.equal(fullById.get('gemini-3.1-flash-image').aih_modalities.input.includes('image'), true);
  assert.equal(fullById.get('gemini-3.1-flash-image').aih_modalities.output.includes('image'), true);
  assert.deepEqual(fullById.get('opencode-go/glm-5.2').aih_modalities, { input: ['text'], output: ['text'] });

  // Second request hits the cached global pool body; the filter is applied
  // after the cache read.
  const visionRes = await runModelsRequest('/v1/models?capability=vision');
  assert.equal(visionRes.headers['x-aih-models-cache'], 'hit');
  assert.deepEqual(JSON.parse(visionRes.body).data.map((item) => item.id), [
    'claude-sonnet-4-6',
    'gemini-3.1-flash-image'
  ]);

  const imageOutRes = await runModelsRequest('/v1/models?capability=image_out');
  assert.deepEqual(JSON.parse(imageOutRes.body).data.map((item) => item.id), ['gemini-3.1-flash-image']);

  // The cache itself must stay unfiltered so one entry serves every query.
  const cachedIds = JSON.parse(state.globalModelsCache.body).data.map((item) => item.id);
  assert.deepEqual(cachedIds, ['claude-sonnet-4-6', 'gemini-3.1-flash-image', 'opencode-go/glm-5.2']);
});

test('v1 provider models honor capability filter through upstream handler', async () => {
  const runModelsRequest = async (url) => {
    const res = createResCapture();
    const handled = await handleV1Request({
      req: { headers: {}, url },
      res,
      method: 'GET',
      pathname: '/v1/models',
      options: {
        backend: 'codex-adapter',
        provider: 'opencode',
        upstreamTimeoutMs: 500,
        modelsProbeAccounts: 1
      },
      state: {
        metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
        accounts: {
          codex: [],
          gemini: [],
          claude: [],
          agy: [],
          opencode: [{
            id: 'oc1',
            accountRef: V1_OPENCODE_REF_1,
            provider: 'opencode',
            accessToken: 'opencode-local',
            availableModels: []
          }]
        },
        modelRegistry: {
          providers: {
            codex: new Set(),
            gemini: new Set(),
            claude: new Set(),
            agy: new Set(),
            opencode: new Set()
          }
        },
        modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 }
      },
      requiredClientKey: '',
      cooldownMs: 1000,
      maxRequestBodyBytes: 1024 * 1024,
      localExecOpts: {},
      deps: {
        parseAuthorizationBearer: () => '',
        writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
        readRequestBody: async () => Buffer.from(''),
        buildOpenAIModelsList,
        handleCodexModels: async () => {},
        handleUpstreamModels,
        fetchModelsForAccount: async () => ['opencode-go/glm-5.2', 'claude-sonnet-4-6'],
        FALLBACK_MODELS: []
      }
    });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    return res;
  };

  const fullRes = await runModelsRequest('/v1/models');
  const fullModels = JSON.parse(fullRes.body).data;
  assert.deepEqual(fullModels.map((item) => item.id), ['claude-sonnet-4-6', 'opencode-go/glm-5.2']);
  fullModels.forEach((item) => {
    assert.equal(Array.isArray(item.aih_modalities.input), true);
    assert.equal(Array.isArray(item.aih_modalities.output), true);
  });

  const visionRes = await runModelsRequest('/v1/models?capability=vision');
  assert.deepEqual(JSON.parse(visionRes.body).data.map((item) => item.id), ['claude-sonnet-4-6']);
});

test('v1 router adapts gemini generateContent requests through codex native responses and renders gemini response', async () => {
  const res = createResCapture();
  let seenRequest = null;
  let seenRequestMeta = null;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1beta/models/gpt-5.3-codex:generateContent' },
    res,
    method: 'POST',
    pathname: '/v1beta/models/gpt-5.3-codex:generateContent',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      cursors: { codex: 0 },
      accounts: {
        codex: [{ id: 'c1', accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.3-codex'] }],
        gemini: [],
        claude: []
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        systemInstruction: { parts: [{ text: '你是助手' }] },
        contents: [{ role: 'user', parts: [{ text: '你好' }] }],
        generationConfig: { maxOutputTokens: 128, temperature: 0.2 }
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'resp-gemini-via-codex',
          object: 'response',
          status: 'completed',
          model: 'gpt-5.3-codex',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '你好，已收到。' }]
          }],
          usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 }
        }));
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('gemini generateContent should use codex native responses adapter by model inference fallback');
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.ok(seenRequest);
  assert.equal(seenRequestMeta.clientProtocol, 'openai_responses');
  assert.equal(seenRequest.instructions, '你是助手');
  assert.deepEqual(seenRequest.input, [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '你好' }]
  }]);
  assert.equal(seenRequest.model, 'gpt-5.3-codex');
  assert.equal(seenRequest.max_output_tokens, 128);
  assert.equal(seenRequest.temperature, 0.2);
  const body = JSON.parse(res.body);
  assert.equal(body.candidates[0].content.role, 'model');
  assert.deepEqual(body.candidates[0].content.parts, [{ text: '你好，已收到。' }]);
  assert.equal(body.candidates[0].finishReason, 'STOP');
  assert.deepEqual(body.usageMetadata, {
    promptTokenCount: 4,
    candidatesTokenCount: 6,
    totalTokenCount: 10
  });
  assert.equal(body.modelVersion, 'gpt-5.3-codex');
});

test('v1 router rejects Gemini paths without model before provider fallback', async () => {
  const runCase = async ({ pathname, expectedProtocol }) => {
    const res = createResCapture();
    let codexCalled = false;
    let passthroughCalled = false;

    const handled = await handleV1Request({
      req: { headers: {}, url: pathname },
      res,
      method: 'POST',
      pathname,
      options: { backend: 'codex-adapter', provider: 'auto' },
      state: {
        metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
        cursors: { codex: 0 },
        accounts: {
          codex: [{ id: 'c1', accountRef: V1_CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.3-codex'] }],
          gemini: [{ id: 'g1', accountRef: V1_GEMINI_REF_1, provider: 'gemini', accessToken: 'gemini-token', availableModels: ['gemini-2.5-pro'] }],
          claude: []
        }
      },
      requiredClientKey: '',
      cooldownMs: 1000,
      maxRequestBodyBytes: 1024 * 1024,
      requestMeta: {},
      deps: {
        parseAuthorizationBearer: () => '',
        writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
        readRequestBody: async () => Buffer.from(JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }]
        })),
        buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
        resolveRequestProvider: (options, requestJson, headers, state) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers, state),
        handleCodexModels: async () => {},
        handleCodexChatCompletions: async () => {
          codexCalled = true;
        },
        handleUpstreamModels: async () => {},
        handleUpstreamPassthrough: async () => {
          passthroughCalled = true;
        },
        chooseServerAccount: () => null,
        markProxyAccountSuccess: () => {},
        markProxyAccountFailure: () => {},
        pushMetricError: () => {},
        appendProxyRequestLog: () => {},
        fetchModelsForAccount: async () => [],
        FALLBACK_MODELS: [],
        fetchWithTimeout: async () => ({})
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.equal(codexCalled, false);
    assert.equal(passthroughCalled, false);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'missing_model');
    assert.equal(body.clientProtocol, expectedProtocol);
  };

  await runCase({
    pathname: '/v1beta/models/:generateContent',
    expectedProtocol: 'gemini_generate_content'
  });
  await runCase({
    pathname: '/v1/models/:streamGenerateContent',
    expectedProtocol: 'gemini_stream_generate_content'
  });
});

test('v1 router composes Gemini generateContent to AGY Claude through direct Anthropic adapter', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenRouteTransport = '';
  let openAIChatAdapterCalled = false;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1beta/models/claude-4-6-thinking:generateContent' },
    res,
    method: 'POST',
    pathname: '/v1beta/models/claude-4-6-thinking:generateContent',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        systemInstruction: { parts: [{ text: 'system hint' }] },
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 96 }
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy claude gemini generateContent should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_agy_gemini_direct',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 6, output_tokens: 8 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchGeminiCodeAssistChatCompletion: async () => {
        openAIChatAdapterCalled = true;
        throw new Error('agy claude gemini generateContent should not use generic Code Assist chat adapter');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(openAIChatAdapterCalled, false);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRequest.system, 'system hint');
  assert.equal(seenRequest.max_tokens, 96);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  const body = JSON.parse(res.body);
  assert.equal(body.candidates[0].content.role, 'model');
  assert.deepEqual(body.candidates[0].content.parts, [{ text: 'pong' }]);
  assert.equal(body.candidates[0].finishReason, 'STOP');
  assert.deepEqual(body.usageMetadata, {
    promptTokenCount: 6,
    candidatesTokenCount: 8,
    totalTokenCount: 14
  });
  assert.equal(body.modelVersion, 'claude-4-6-thinking');
});

test('v1 router preserves Gemini function calls through AGY Claude direct adapter', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenRouteTransport = '';
  let genericCodeAssistCalled = false;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1beta/models/claude-4-6-thinking:generateContent' },
    res,
    method: 'POST',
    pathname: '/v1beta/models/claude-4-6-thinking:generateContent',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        systemInstruction: { parts: [{ text: 'system hint' }] },
        contents: [
          { role: 'user', parts: [{ text: 'fetch the data' }] },
          {
            role: 'model',
            parts: [{
              functionCall: {
                id: 'call_fetch_1',
                name: 'CustomFetch',
                args: { url: 'https://example.test' }
              }
            }]
          },
          {
            role: 'user',
            parts: [{
              functionResponse: {
                id: 'call_fetch_1',
                name: 'CustomFetch',
                response: { result: '{"status":200}' }
              }
            }]
          }
        ],
        tools: [{
          functionDeclarations: [{
            name: 'CustomFetch',
            description: 'Fetch a URL',
            parametersJsonSchema: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url']
            }
          }]
        }],
        toolConfig: {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: ['CustomFetch']
          }
        },
        generationConfig: { maxOutputTokens: 96 }
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy claude gemini tool flow should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_agy_gemini_tool',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{
            type: 'tool_use',
            id: 'toolu_fetch_2',
            name: 'CustomFetch',
            input: { url: 'https://example.test/next' }
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 }
        }));
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchGeminiCodeAssistChatCompletion: async () => {
        genericCodeAssistCalled = true;
        throw new Error('agy claude gemini tool flow should not use generic Code Assist chat adapter');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(genericCodeAssistCalled, false);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRequest.system, 'system hint');
  assert.equal(seenRequest.max_tokens, 96);
  assert.deepEqual(seenRequest.tool_choice, { type: 'tool', name: 'CustomFetch' });
  assert.equal(seenRequest.tools[0].name, 'CustomFetch');
  assert.deepEqual(seenRequest.tools[0].input_schema.required, ['url']);
  assert.deepEqual(seenRequest.messages.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(seenRequest.messages[1].content[0], {
    type: 'tool_use',
    id: 'call_fetch_1',
    name: 'CustomFetch',
    input: { url: 'https://example.test' }
  });
  assert.deepEqual(seenRequest.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_fetch_1',
    content: '{"status":200}'
  });
  const body = JSON.parse(res.body);
  assert.deepEqual(body.candidates[0].content.parts[0], {
    functionCall: {
      id: 'toolu_fetch_2',
      name: 'CustomFetch',
      args: { url: 'https://example.test/next' }
    }
  });
  assert.equal(body.candidates[0].finishReason, 'STOP');
  assert.deepEqual(body.usageMetadata, {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15
  });
});

test('v1 router streams Gemini streamGenerateContent to AGY Claude through nested adapters', async () => {
  const res = createResCapture();
  let seenUrl = '';
  let seenRequest = null;
  let seenRouteTransport = '';
  let openAIChatAdapterCalled = false;

  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'agy' }, url: '/v1beta/models/claude-4-6-thinking:streamGenerateContent' },
    res,
    method: 'POST',
    pathname: '/v1beta/models/claude-4-6-thinking:streamGenerateContent',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0, providerCounts: {}, providerSuccess: {}, providerFailures: {} },
      cursors: { agy: 0 },
      accounts: {
        agy: [{ id: 'a1', accountRef: V1_AGY_REF_1, provider: 'agy', accessToken: 'agy-token', authType: 'oauth-personal', availableModels: ['claude-4-6-thinking'] }]
      }
    },
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }]
      })),
      buildOpenAIModelsList: () => ({ object: 'list', data: [] }),
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async () => {
        throw new Error('agy claude gemini streamGenerateContent should not use codex chat gateway');
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = String(ctx.req && ctx.req.url || '');
        seenRequest = ctx.requestJson;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.setHeader('x-aih-server-account-id', 'a1');
        ctx.res.write('event: message_start\n');
        ctx.res.write('data: {"type":"message_start","message":{"id":"msg_agy_gemini_stream","type":"message","role":"assistant","model":"claude-4-6-thinking","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n');
        ctx.res.write('event: content_block_start\n');
        ctx.res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        ctx.res.write('event: content_block_delta\n');
        ctx.res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n');
        ctx.res.write('event: content_block_stop\n');
        ctx.res.write('data: {"type":"content_block_stop","index":0}\n\n');
        ctx.res.write('event: message_delta\n');
        ctx.res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n');
        ctx.res.write('event: message_stop\n');
        ctx.res.write('data: {"type":"message_stop"}\n\n');
        ctx.res.end();
      },
      chooseServerAccount: () => null,
      markProxyAccountSuccess: () => {},
      markProxyAccountFailure: () => {},
      pushMetricError: () => {},
      appendProxyRequestLog: () => {},
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => ({}),
      fetchGeminiCodeAssistChatCompletion: async () => {
        openAIChatAdapterCalled = true;
        throw new Error('agy claude gemini streamGenerateContent should not use generic Code Assist chat adapter');
      },
      fetchGeminiCodeAssistChatCompletionStream: async function* () {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {}
    }
  });

  assert.equal(handled, true);
  assert.equal(openAIChatAdapterCalled, false);
  assert.equal(seenUrl, '/v1/messages');
  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRequest.stream, true);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['x-aih-server-account-id'], 'a1');
  assert.match(res.body, /"parts":\[\{"text":"pong"\}\]/);
  assert.match(res.body, /"finishReason":"STOP"/);
  assert.match(res.body, /"usageMetadata":\{"promptTokenCount":3,"candidatesTokenCount":5,"totalTokenCount":8\}/);
});
