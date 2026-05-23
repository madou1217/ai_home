const test = require('node:test');
const assert = require('node:assert/strict');
const { handleV1Request } = require('../lib/server/v1-router');
const { buildOpenAIModelsList } = require('../lib/server/models');
const { handleUpstreamModels } = require('../lib/server/upstream-endpoints');

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

test('v1 router adapts openai responses to openai chat passthrough for non-codex providers', async () => {
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
        ctx.res.end(JSON.stringify({
          id: 'chatcmpl-gemini-response',
          object: 'chat.completion',
          created: 1770000000,
          model: 'gemini-2.5-pro',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop'
          }]
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
  assert.equal(seenUrl, '/v1/chat/completions');
  assert.deepEqual(seenRequest.messages, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: 'ping' }
  ]);
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

test('v1 router adapts openai responses requests through claude messages and renders responses output', async () => {
  const res = createResCapture();
  let seenRequest = null;

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
        seenRequest = ctx.requestJson;
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
      fetchWithTimeout: async () => ({})
    }
  });

  assert.equal(handled, true);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  assert.equal(seenRequest.max_tokens, 64);
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'response');
  assert.equal(body.model, 'claude-sonnet-4');
  assert.equal(body.output[0].content[0].text, 'world');
  assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
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
        codex: [{ id: '6', provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [{ id: '3', provider: 'claude', accessToken: 'claude-token', availableModels: ['qwen3.6-plus'] }]
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
        codex: [{ id: '6', provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [{ id: '3', provider: 'claude', accessToken: 'claude-token', availableModels: ['qwen3.6-plus'] }]
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

test('v1 router adapts anthropic messages requests to codex chat and renders anthropic response', async () => {
  const res = createResCapture();
  let seenRequest = null;

  const handled = await handleV1Request({
    req: { headers: {}, url: '/v1/messages' },
    res,
    method: 'POST',
    pathname: '/v1/messages',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: {
      metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
      cursors: { codex: 0 },
      accounts: {
        codex: [{ id: 'c1', provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
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
      resolveRequestProvider: (options, requestJson, headers) => require('../lib/server/router').resolveRequestProvider(options, requestJson, headers),
      handleCodexModels: async () => {},
      handleCodexChatCompletions: async (ctx) => {
        seenRequest = ctx.requestJson;
        ctx.res.statusCode = 200;
        ctx.res.setHeader('x-aih-server-account-id', '10014');
        ctx.res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1770000000,
          model: 'gpt-5.3-codex',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '你好，已收到。' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
        }));
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('codex request should use codex chat adapter');
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
  assert.equal(res.headers['x-aih-server-account-id'], '10014');
  assert.ok(seenRequest);
  assert.deepEqual(seenRequest.messages, [
    { role: 'system', content: '你是架构助手' },
    { role: 'user', content: '你好' }
  ]);
  assert.equal(seenRequest.max_tokens, 256);
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.model, 'gpt-5.3-codex');
  assert.deepEqual(body.content, [{ type: 'text', text: '你好，已收到。' }]);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 3, output_tokens: 5 });
});

test('v1 router adapts anthropic messages to openai chat passthrough for non-claude providers', async () => {
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
        model: 'claude-sonnet-4',
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
        ctx.res.end(JSON.stringify({
          id: 'chatcmpl-gemini',
          object: 'chat.completion',
          created: 1770000000,
          model: 'gemini-2.5-pro',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop'
          }]
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
  assert.equal(seenUrl, '/v1/chat/completions');
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: 'ping' }]);
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'gemini-2.5-pro');
  assert.deepEqual(body.content, [{ type: 'text', text: 'pong' }]);
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
      accounts: {
        codex: [{ id: 'c1', provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
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
          id: 'chatcmpl-alias',
          object: 'chat.completion',
          created: 1770000000,
          model: 'gpt-5.5',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('claude-scoped alias targeting gpt should route through codex chat handler');
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
  assert.equal(seenRequestMeta.effectiveProvider, 'codex');
  assert.equal(req.headers['x-provider'], 'claude');
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'gpt-5.5');
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
      accounts: {
        codex: [{
          id: 'c1',
          provider: 'codex',
          accessToken: 'codex-token',
          availableModels: ['gpt-5.5'],
          cooldownUntil: Date.now() + 60_000
        }],
        gemini: [{ id: 'g1', provider: 'gemini', accessToken: 'gemini-token', availableModels: ['gemini-3.1-pro-preview'] }],
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
  assert.equal(body.error, 'no_available_account');
  assert.match(body.detail, /no available account in the global pool can serve model gpt-5\.5/);
  assert.equal(body.model, 'gpt-5.5');
  assert.equal(body.familyProvider, 'codex');
  assert.equal(body.availability.providers.codex.accounts, 1);
  assert.equal(body.availability.providers.codex.available, 0);
  assert.equal(body.availability.providers.gemini.available, 1);
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
      accounts: {
        codex: [],
        gemini: [{ id: 'g1', provider: 'gemini', accessToken: 'gemini-token', availableModels: ['gemini-3.1-pro-preview'] }],
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
        ctx.res.end(JSON.stringify({
          id: 'chatcmpl-gemini-alias',
          object: 'chat.completion',
          created: 1770000000,
          model: 'gemini-3.1-pro-preview',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
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
  assert.equal(seenUrl, '/v1/chat/completions');
  assert.equal(seenRequest.model, 'gemini-3.1-pro-preview');
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
          { id: 'c1', provider: 'codex', accessToken: 'codex-token-1' },
          { id: 'c2', provider: 'codex', accessToken: 'codex-token-2' }
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
        codex: [{ id: 'c1', provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
        gemini: [{ id: 'g1', provider: 'gemini', accessToken: 'gemini-token', availableModels: ['gemini-3.1-pro-preview'] }],
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
  assert.deepEqual(ids, ['claude-opus-4-7', 'gpt-5.5']);
  assert.equal(modelById.get('claude-opus-4-7').owned_by, 'anthropic');
  assert.equal(modelById.get('gpt-5.5').owned_by, 'openai');
  assert.equal(ids.includes('gemini-3.1-pro-preview'), false);
  assert.equal(ids.includes('claude-sonnet-4-6'), false);
});

test('v1 router adapts gemini generateContent requests through codex chat and renders gemini response', async () => {
  const res = createResCapture();
  let seenRequest = null;

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
        codex: [{ id: 'c1', provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.3-codex'] }],
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
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'chatcmpl-gemini-via-codex',
          object: 'chat.completion',
          created: 1770000000,
          model: 'gpt-5.3-codex',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '你好，已收到。' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
        }));
      },
      handleUpstreamModels: async () => {},
      handleUpstreamPassthrough: async () => {
        throw new Error('gemini generateContent should use codex adapter by model inference fallback');
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
  assert.deepEqual(seenRequest.messages, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' }
  ]);
  assert.equal(seenRequest.model, 'gpt-5.3-codex');
  assert.equal(seenRequest.max_tokens, 128);
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
