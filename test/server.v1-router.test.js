const test = require('node:test');
const assert = require('node:assert/strict');
const { handleV1Request } = require('../lib/server/v1-router');

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk = '') { this.body = String(chunk); }
  };
}

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
