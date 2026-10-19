'use strict';

// 免费模型互备（2026-10-18）：上游常常是**单个**免费模型挂掉（deepseek 连续 500、glm 503
// 「Endpoint is unavailable」，其余照常 200）。所选模型 5xx 时换账号清单里另一个免费模型接着答。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFreeModelHealth,
  fetchWithFreeModelFallback,
  listFreeFallbackCandidates
} = require('../lib/server/opencode-free-model-fallback');
const { isOpenCodeFreeModelId } = require('../lib/server/opencode-free-models');
const { openCodeFreeHttpTransport } = require('../lib/server/upstream-endpoints-transport-opencode-free-http');

const ACCOUNT_REF = 'acct_44444444444444444444';
const ACCOUNT_MODELS = [
  'opencode/deepseek-v4.1-flash-free',
  'opencode/glm-5.3',
  'opencode/beam-free',
  'opencode/glm-5.3-flash-free',
  'opencode/big-pickle',
  'opencode/space-bunny-free'
];

function httpError(status, body = '') {
  const error = new Error(`HTTP ${status}`);
  error.code = `HTTP_${status}`;
  error.statusCode = status;
  error.responseBody = body;
  return error;
}

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

// ── 免费判定 ────────────────────────────────────────────────────────────────

test('free models are recognised by the -free suffix or a zero Zen price, never by a paid price', () => {
  assert.equal(isOpenCodeFreeModelId('opencode/deepseek-v4.1-flash-free'), true);
  // big-pickle 不带后缀，但目录里 Zen 价格为 0（opencode 选模型界面标 Free）。
  assert.equal(isOpenCodeFreeModelId('opencode/big-pickle'), true);
  assert.equal(isOpenCodeFreeModelId('big-pickle'), true);
  assert.equal(isOpenCodeFreeModelId('opencode/glm-5.3'), false);
  // 点名 Go 命名空间 = 要付费通道，价格规则不适用。
  assert.equal(isOpenCodeFreeModelId('opencode-go/big-pickle'), false);
  assert.equal(isOpenCodeFreeModelId(''), false);
});

test('the price rule only trusts the Zen provider entry', () => {
  const reader = {
    resolveEntry: ({ id }) => (id === 'opencode/zero-elsewhere'
      ? { providerId: 'someone-else', cost: { input: 0, output: 0 } }
      : null)
  };
  assert.equal(isOpenCodeFreeModelId('opencode/zero-elsewhere', { modelsDevReader: reader }), false);
});

// ── 候选 ────────────────────────────────────────────────────────────────────

test('candidates are the other free models of the account, in list order', () => {
  const candidates = listFreeFallbackCandidates({
    requestedModel: 'opencode/deepseek-v4.1-flash-free',
    accountModels: ACCOUNT_MODELS,
    provider: 'opencode',
    accountRef: ACCOUNT_REF,
    health: createFreeModelHealth()
  });
  assert.deepEqual(candidates, [
    'opencode/beam-free',
    'opencode/glm-5.3-flash-free',
    'opencode/big-pickle',
    'opencode/space-bunny-free'
  ]);
});

test('candidates skip models known to be down, models the user disabled, and prefer recent successes', () => {
  const health = createFreeModelHealth();
  health.markUnavailable('opencode/glm-5.3-flash-free');
  health.markAvailable('opencode/space-bunny-free');
  const candidates = listFreeFallbackCandidates({
    requestedModel: 'deepseek-v4.1-flash-free',
    accountModels: ACCOUNT_MODELS.map((id) => ({ id })),
    provider: 'opencode',
    accountRef: ACCOUNT_REF,
    modelCatalogSettings: { accountModels: [{ id: 'opencode/beam-free', provider: 'opencode', accountRef: ACCOUNT_REF, enabled: false }] },
    health
  });
  assert.deepEqual(candidates, ['opencode/space-bunny-free', 'opencode/big-pickle']);
});

test('a request carrying images only falls back to models that can see images', () => {
  const candidates = listFreeFallbackCandidates({
    requestedModel: 'opencode/glm-5.3-flash-free',
    accountModels: ACCOUNT_MODELS,
    requestJson: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] },
    provider: 'opencode',
    health: createFreeModelHealth(),
    supportsVision: (id) => id === 'opencode/space-bunny-free'
  });
  assert.deepEqual(candidates, ['opencode/space-bunny-free']);
});

// ── 依次重发 ────────────────────────────────────────────────────────────────

test('a 5xx on the chosen model is answered by the next free model, and the chosen one is remembered as down', async () => {
  const health = createFreeModelHealth();
  const tried = [];
  const served = await fetchWithFreeModelFallback(async (model) => {
    tried.push(model);
    if (model === 'opencode/deepseek-v4.1-flash-free') throw httpError(500);
    return `answer from ${model}`;
  }, { requestedModel: 'opencode/deepseek-v4.1-flash-free', candidates: ['opencode/beam-free', 'opencode/big-pickle'], health });
  assert.deepEqual(tried, ['opencode/deepseek-v4.1-flash-free', 'opencode/beam-free']);
  assert.equal(served.model, 'opencode/beam-free');
  assert.equal(served.result, 'answer from opencode/beam-free');
  assert.equal(health.isUnavailable('deepseek-v4.1-flash-free'), true);
});

test('a model known to be down is tried last, and is used again once its TTL has passed', async () => {
  const clock = fakeClock();
  const health = createFreeModelHealth({ now: clock.now, ttlMs: 60_000 });
  health.markUnavailable('opencode/deepseek-v4.1-flash-free');
  const tried = [];
  const fetchForModel = async (model) => { tried.push(model); return model; };
  const input = { requestedModel: 'opencode/deepseek-v4.1-flash-free', candidates: ['opencode/beam-free'], health };
  assert.equal((await fetchWithFreeModelFallback(fetchForModel, input)).model, 'opencode/beam-free');
  clock.advance(60_001);
  assert.equal((await fetchWithFreeModelFallback(fetchForModel, input)).model, 'opencode/deepseek-v4.1-flash-free');
  assert.deepEqual(tried, ['opencode/beam-free', 'opencode/deepseek-v4.1-flash-free']);
});

test('failures that are not about the model are not papered over by switching models', async () => {
  for (const status of [429, 403, 401, 400]) {
    const tried = [];
    await assert.rejects(fetchWithFreeModelFallback(async (model) => {
      tried.push(model);
      throw httpError(status);
    }, { requestedModel: 'opencode/deepseek-v4.1-flash-free', candidates: ['opencode/beam-free'], health: createFreeModelHealth() }),
    (error) => error.statusCode === status);
    assert.deepEqual(tried, ['opencode/deepseek-v4.1-flash-free'], `status ${status}`);
  }
});

test('a candidate that rejects the request is skipped; one hitting an account/egress limit stops the chain', async () => {
  const health = createFreeModelHealth();
  const served = await fetchWithFreeModelFallback(async (model) => {
    if (model === 'opencode/deepseek-v4.1-flash-free') throw httpError(503);
    if (model === 'opencode/beam-free') throw httpError(400, 'reasoning_effort');
    return model;
  }, { requestedModel: 'opencode/deepseek-v4.1-flash-free', candidates: ['opencode/beam-free', 'opencode/big-pickle'], health });
  assert.equal(served.model, 'opencode/big-pickle');
  // 400 只说明它不合适这次请求，不算挂掉。
  assert.equal(health.isUnavailable('opencode/beam-free'), false);

  const tried = [];
  await assert.rejects(fetchWithFreeModelFallback(async (model) => {
    tried.push(model);
    if (model === 'opencode/deepseek-v4.1-flash-free') throw httpError(500);
    throw httpError(429);
  }, { requestedModel: 'opencode/deepseek-v4.1-flash-free', candidates: ['opencode/beam-free', 'opencode/big-pickle'], health: createFreeModelHealth() }),
  (error) => error.statusCode === 429);
  assert.deepEqual(tried, ['opencode/deepseek-v4.1-flash-free', 'opencode/beam-free']);
});

test('when every model is down the error reported is the chosen model\'s own', async () => {
  await assert.rejects(fetchWithFreeModelFallback(async (model) => {
    throw httpError(model === 'opencode/deepseek-v4.1-flash-free' ? 500 : 503);
  }, { requestedModel: 'opencode/deepseek-v4.1-flash-free', candidates: ['opencode/beam-free'], health: createFreeModelHealth() }),
  (error) => error.statusCode === 500);
});

test('a client that went away stops the chain', async () => {
  const controller = new AbortController();
  const tried = [];
  await assert.rejects(fetchWithFreeModelFallback(async (model) => {
    tried.push(model);
    controller.abort();
    throw httpError(500);
  }, { requestedModel: 'opencode/deepseek-v4.1-flash-free', candidates: ['opencode/beam-free'], health: createFreeModelHealth(), signal: controller.signal }));
  assert.deepEqual(tried, ['opencode/deepseek-v4.1-flash-free']);
});

test('the number of fallback models per request is bounded', async () => {
  const tried = [];
  await assert.rejects(fetchWithFreeModelFallback(async (model) => {
    tried.push(model);
    throw httpError(500);
  }, { requestedModel: 'm0-free', candidates: ['m1-free', 'm2-free', 'm3-free', 'm4-free'], health: createFreeModelHealth(), maxFallbacks: 2 }));
  assert.deepEqual(tried, ['m0-free', 'm1-free', 'm2-free']);
});

// ── 接入免费 HTTP 通道 ──────────────────────────────────────────────────────

function buildTransportCtx({ fetchFreeChat }) {
  const usage = [];
  const logs = [];
  const headers = {};
  const written = {};
  const ctx = {
    options: { logRequests: true },
    state: {
      metrics: { totalTimeouts: 0, totalFailures: 0, providerFailures: {} },
      webUiModelsCache: { byAccount: { [ACCOUNT_REF]: ACCOUNT_MODELS } }
    },
    res: { setHeader: (name, value) => { headers[name.toLowerCase()] = value; }, end: (raw) => { written.body = String(raw); } },
    requestJson: { model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 60000,
    requestMeta: { requestId: 'req-fallback' },
    deps: { fetchOpenCodeZenFreeChatCompletion: fetchFreeChat, freeModelHealth: createFreeModelHealth() },
    provider: 'opencode',
    streamRequested: false,
    recordAccountSuccess: () => {},
    recordAccountFailure: () => { throw new Error('no account failure expected'); },
    upstreamFailureRecorder: { record: () => {} },
    diagnosticMaxAttempts: () => 1,
    fetchWithTimeout: async () => { throw new Error('unexpected'); },
    recordModelUsage: (entry) => usage.push(entry),
    appendProxyRequestLog: (entry) => logs.push(entry),
    control: { attempt: 0, setLastError: () => {} },
    account: { accountRef: ACCOUNT_REF, provider: 'opencode' },
    accountEgressSource: '',
    attemptUpstreamTimeoutMs: 1000,
    attemptMutable: {}
  };
  return { ctx, usage, logs, headers, written };
}

test('the free HTTP transport answers from another free model when the chosen one is down, and says so', async () => {
  const upstreamModels = [];
  const { ctx, usage, logs, headers, written } = buildTransportCtx({
    fetchFreeChat: async (_options, _account, requestJson) => {
      upstreamModels.push(requestJson.model);
      if (requestJson.model === 'opencode/deepseek-v4.1-flash-free') throw httpError(500);
      return {
        id: 'x',
        object: 'chat.completion',
        model: requestJson.model.replace(/^opencode\//, ''),
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
      };
    }
  });
  const action = await openCodeFreeHttpTransport.run(ctx);
  assert.deepEqual(action, { action: 'return' });
  assert.deepEqual(upstreamModels, ['opencode/deepseek-v4.1-flash-free', 'opencode/beam-free']);
  assert.equal(ctx.res.statusCode, 200);
  assert.match(written.body, /"OK"/);
  assert.equal(headers['x-aih-model-fallback'], 'opencode/deepseek-v4.1-flash-free->opencode/beam-free');
  const success = logs.find((entry) => entry.status === 200);
  assert.equal(success.opencodeFreeModelFallback, 'opencode/deepseek-v4.1-flash-free->opencode/beam-free');
  // 用量记到实际服务的模型上；调用方的请求对象不被改写。
  assert.equal(usage.length, 1);
  assert.equal(usage[0].model, 'opencode/beam-free');
  assert.equal(ctx.requestJson.model, 'opencode/deepseek-v4.1-flash-free');
});

// 2026-10-18：opencode 客户端发的是流式请求（glm 503「Endpoint is unavailable」时整轮失败）。
// 流式通道的上游失败发生在拿到响应头之前（还没向客户端写字节），必须同样换模型接着答。
test('a streaming request whose chosen model returns 503 is answered by the next free model', async () => {
  const upstreamModels = [];
  const { ctx, usage, logs, headers } = buildTransportCtx({ fetchFreeChat: async () => { throw new Error('non-stream path must not be used'); } });
  const chunks = [];
  ctx.streamRequested = true;
  ctx.requestJson = { ...ctx.requestJson, stream: true };
  ctx.res = {
    headersSent: false,
    writableEnded: false,
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    writeHead() { this.headersSent = true; return this; },
    flushHeaders() { this.headersSent = true; },
    write(chunk) { this.headersSent = true; chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk) chunks.push(String(chunk)); this.writableEnded = true; },
    on() { return this; },
    once() { return this; }
  };
  ctx.deps.fetchOpenCodeZenFreeChatCompletionStream = async (_options, _account, requestJson) => {
    upstreamModels.push(requestJson.model);
    if (requestJson.model === 'opencode/deepseek-v4.1-flash-free') throw httpError(503);
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\ndata: [DONE]\n\n';
    return { ok: true, status: 200, body: require('node:stream').Readable.from([Buffer.from(sse)]) };
  };
  const action = await openCodeFreeHttpTransport.run(ctx);
  assert.deepEqual(action, { action: 'return' });
  assert.deepEqual(upstreamModels, ['opencode/deepseek-v4.1-flash-free', 'opencode/beam-free']);
  assert.match(chunks.join(''), /"content":"OK"/);
  assert.equal(headers['x-aih-model-fallback'], 'opencode/deepseek-v4.1-flash-free->opencode/beam-free');
  const success = logs.find((entry) => entry.status === 200 && !entry.error);
  assert.ok(success, 'a successful stream is logged');
  assert.equal(success.opencodeFreeModelFallback, 'opencode/deepseek-v4.1-flash-free->opencode/beam-free');
  assert.equal(success.opencodeFreeModelFailures, 'opencode/deepseek-v4.1-flash-free:503');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].model, 'opencode/beam-free');
});

// 2026-10-19：opencode 生成标题等内部轮次时自动挑付费小模型（gpt-6-luna）。免费账号没有付费 key，
// 这类请求一天失败 97 次、会话标题永远出不来。真实 opencode 客户端的无工具轮次由免费模型代答。
test('an opencode utility turn on a paid model without a paid key is answered by a free model', async () => {
  const upstreamModels = [];
  const { ctx, usage, headers, written } = buildTransportCtx({
    fetchFreeChat: async (_options, _account, requestJson) => {
      upstreamModels.push(requestJson.model);
      return {
        id: 'x', object: 'chat.completion', model: requestJson.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'A title' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      };
    }
  });
  ctx.requestJson = { model: 'opencode/gpt-6-luna', messages: [{ role: 'user', content: 'Generate a title' }] };
  ctx.requestMeta = { requestId: 'req-title', openCodeNativeClient: true };
  assert.equal(openCodeFreeHttpTransport.matches(ctx), true);
  const action = await openCodeFreeHttpTransport.run(ctx);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(upstreamModels.length, 1);
  assert.notEqual(upstreamModels[0], 'opencode/gpt-6-luna');
  assert.match(upstreamModels[0], /-free$/);
  assert.match(written.body, /A title/);
  assert.equal(headers['x-aih-model-fallback'], `opencode/gpt-6-luna->${upstreamModels[0]}`);
  assert.equal(usage[0].model, upstreamModels[0]);
});

test('paid-model turns the user chose (tools present, or not from opencode) are never substituted', () => {
  const { ctx } = buildTransportCtx({ fetchFreeChat: async () => { throw new Error('unused'); } });
  ctx.requestJson = { model: 'opencode/gpt-6-luna', messages: [], tools: [{ type: 'function', function: { name: 'read' } }] };
  ctx.requestMeta = { openCodeNativeClient: true };
  assert.equal(openCodeFreeHttpTransport.matches(ctx), false, 'a main agent turn keeps the chosen model');
  ctx.requestJson = { model: 'opencode/gpt-6-luna', messages: [] };
  ctx.requestMeta = {};
  assert.equal(openCodeFreeHttpTransport.matches(ctx), false, 'other clients keep the chosen model');
  ctx.requestMeta = { openCodeNativeClient: true };
  ctx.account = { accountRef: ACCOUNT_REF, provider: 'opencode', opencodeGoApiKey: 'sk-paid' };
  assert.equal(openCodeFreeHttpTransport.matches(ctx), false, 'an account with a paid key keeps the paid channel');
});
