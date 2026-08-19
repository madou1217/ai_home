'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleImageGenerations,
  __private: {
    renderImageGenerationResponse,
    resolveBlobBaseUrl,
    writeImageGenerationError,
    IMAGE_PATHNAMES
  }
} = require('../lib/server/image-generations-endpoint');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');
const { getImageBlob } = require('../lib/server/image-blob-store');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(raw) {
      this.body = raw;
    }
  };
}

function makeCtx(overrides = {}) {
  const metrics = { totalSuccess: 0, totalFailures: 0 };
  const calls = { usage: [], success: [], failure: [], logs: [], metricErrors: [] };
  const res = makeRes();
  const deps = {
    chooseServerAccount: () => ({ accountRef: 'acct_a', email: 'a@example.com', provider: 'agy' }),
    pushMetricError: (m, route, provider, entry) => calls.metricErrors.push({ m, route, provider, entry }),
    writeJson: (r, status, body) => {
      r.statusCode = status;
      r.body = JSON.stringify(body);
    },
    fetchGeminiCodeAssistGenerateContent: async () => ({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] } }],
      usageMetadata: { totalTokenCount: 7 },
      model: 'gemini-3.1-flash-image'
    }),
    markProxyAccountFailure: (account, code) => calls.failure.push({ account, code }),
    markProxyAccountSuccess: (account) => calls.success.push(account),
    appendProxyRequestLog: (entry) => calls.logs.push(entry),
    recordModelUsage: async (usage) => calls.usage.push(usage),
    resolveGatewayProvider: () => ({ provider: 'agy' })
  };
  const base = {
    req: { headers: { host: '127.0.0.1:9527' } },
    res,
    method: 'POST',
    pathname: '/v1/images/generations',
    options: { logRequests: true },
    state: {
      accounts: { agy: [{ accountRef: 'acct_a', email: 'a@example.com', provider: 'agy' }] },
      metrics
    },
    requestJson: { model: 'gemini-3.1-flash-image', prompt: 'a cat' },
    routeKey: 'images/generations',
    requestStartedAt: Date.now(),
    cooldownMs: 5000,
    requestMeta: { requestId: 'req_1', sessionKey: 'ses_1' },
    deps
  };
  return { ...base, calls, ...overrides, deps: { ...deps, ...(overrides.deps || {}) } };
}

test('handleImageGenerations returns false for non-image routes', async () => {
  const ctx = makeCtx({ method: 'GET', pathname: '/v1/models' });
  assert.equal(await handleImageGenerations(ctx), false);
  assert.equal(ctx.res.statusCode, 0);
});

test('handleImageGenerations rejects invalid requests with OpenAI error envelope', async () => {
  const ctx = makeCtx({ requestJson: { prompt: 'no model' } });
  assert.equal(await handleImageGenerations(ctx), true);
  const body = JSON.parse(ctx.res.body);
  assert.equal(ctx.res.statusCode, 400);
  assert.equal(body.error.code, 'model_required');
  assert.equal(body.error.type, 'invalid_request_error');
  assert.ok(body.error.message.length > 0);
  assert.equal(ctx.state.metrics.totalFailures, 1);
  assert.equal(ctx.calls.metricErrors.length, 1);
});

test('handleImageGenerations fails closed when gateway router yields no provider', async () => {
  const ctx = makeCtx({
    deps: { resolveGatewayProvider: () => ({ statusCode: 503, error: 'no_available_account', detail: 'nothing healthy' }) }
  });
  await handleImageGenerations(ctx);
  const body = JSON.parse(ctx.res.body);
  assert.equal(ctx.res.statusCode, 503);
  assert.equal(body.error.code, 'no_available_account');
});

test('handleImageGenerations fails when the provider pool is empty or selection fails', async () => {
  const emptyPool = makeCtx({ state: { accounts: {}, metrics: { totalSuccess: 0, totalFailures: 0 } } });
  await handleImageGenerations(emptyPool);
  assert.equal(emptyPool.res.statusCode, 503);

  const noSelection = makeCtx({ deps: { chooseServerAccount: () => null } });
  await handleImageGenerations(noSelection);
  assert.equal(noSelection.res.statusCode, 503);
});

test('handleImageGenerations rejects unsupported providers and unsupported models', async () => {
  const unsupportedProvider = makeCtx({
    state: {
      accounts: { claude: [{ accountRef: 'acct_c', provider: 'claude' }] },
      metrics: { totalSuccess: 0, totalFailures: 0 }
    },
    deps: { resolveGatewayProvider: () => ({ provider: 'claude' }) }
  });
  await handleImageGenerations(unsupportedProvider);
  assert.equal(unsupportedProvider.res.statusCode, 400);
  assert.equal(JSON.parse(unsupportedProvider.res.body).error.code, 'unsupported_image_provider');

  const unsupportedModel = makeCtx({ requestJson: { model: 'gemini-3.1-pro-high', prompt: 'p' } });
  await handleImageGenerations(unsupportedModel);
  assert.equal(unsupportedModel.res.statusCode, 400);
  assert.equal(JSON.parse(unsupportedModel.res.body).error.code, 'unsupported_model_for_images');
});

test('handleImageGenerations renders a successful b64_json response and records accounting', async () => {
  const ctx = makeCtx();
  assert.equal(await handleImageGenerations(ctx), true);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(ctx.res.headers['x-aih-server-account-ref'], 'acct_a');
  const body = JSON.parse(ctx.res.body);
  assert.ok(Number.isInteger(body.created));
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].b64_json, PNG_BASE64);

  assert.equal(ctx.state.metrics.totalSuccess, 1);
  assert.equal(ctx.calls.success.length, 1);
  assert.equal(ctx.calls.logs.length, 1);
  assert.equal(ctx.calls.logs[0].route, 'images/generations');
  assert.equal(ctx.calls.logs[0].status, 200);
  assert.equal(ctx.calls.usage.length, 1);
  assert.equal(ctx.calls.usage[0].provider, 'agy');
  assert.equal(ctx.calls.usage[0].accountRef, 'acct_a');
  assert.equal(ctx.calls.usage[0].model, 'gemini-3.1-flash-image');
  assert.equal(ctx.calls.usage[0].sourceKind, 'server_image_generation');
  assert.equal(ctx.calls.usage[0].usageFormat, 'gemini');
});

test('handleImageGenerations renders blob urls for response_format=url', async () => {
  const ctx = makeCtx({ requestJson: { model: 'gemini-3.1-flash-image', prompt: 'a cat', response_format: 'url' } });
  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 200);
  const body = JSON.parse(ctx.res.body);
  assert.equal(body.data.length, 1);
  const match = /^http:\/\/127\.0\.0\.1:9527\/v1\/blobs\/([0-9a-f]{32})$/.exec(body.data[0].url);
  assert.ok(match, `unexpected url: ${body.data[0].url}`);
  const blob = getImageBlob(match[1]);
  assert.ok(blob, 'blob should be retrievable');
  assert.deepEqual([...blob.bytes], [...Buffer.from(PNG_BASE64, 'base64')]);
});

test('handleImageGenerations marks account failure and returns 502 on strategy errors', async () => {
  const ctx = makeCtx({
    deps: {
      fetchGeminiCodeAssistGenerateContent: async () => {
        throw new Error('socket hang up');
      }
    }
  });
  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 502);
  assert.equal(JSON.parse(ctx.res.body).error.code, 'upstream_failed');
  assert.equal(ctx.state.metrics.totalFailures, 1);
  assert.equal(ctx.calls.failure.length, 1);
  assert.equal(ctx.calls.failure[0].code, 'upstream_failed');
  assert.equal(ctx.calls.failure[0].account.accountRef, 'acct_a');
});

test('handleImageGenerations skips failure accounting for non-cooldown codes', async () => {
  const ctx = makeCtx({
    requestJson: { model: 'gemini-3.1-pro-high', prompt: 'p' },
    state: {
      accounts: { codex: [{ accountRef: 'acct_c', provider: 'codex' }] },
      metrics: { totalSuccess: 0, totalFailures: 0 }
    },
    deps: { resolveGatewayProvider: () => ({ provider: 'codex' }) }
  });
  await handleImageGenerations(ctx);
  assert.equal(ctx.res.statusCode, 400);
  assert.equal(ctx.calls.failure.length, 0, 'client-side 400 must not cool down the account');
});

test('renderImageGenerationResponse maps b64_json, url and empty inputs', () => {
  const out = renderImageGenerationResponse(
    [{ b64_json: 'YWJj', mimeType: 'image/png' }, { url: 'https://x/y.png' }],
    { responseFormat: 'b64_json' }
  );
  assert.deepEqual(out.data, [{ b64_json: 'YWJj' }, { url: 'https://x/y.png' }]);
  assert.ok(Number.isInteger(out.created));

  const empty = renderImageGenerationResponse(undefined, { responseFormat: 'b64_json' });
  assert.deepEqual(empty.data, []);
});

test('renderImageGenerationResponse stores remote-format images as local blobs', () => {
  const out = renderImageGenerationResponse(
    [{ b64_json: Buffer.from('hi').toString('base64'), mimeType: 'image/png' }],
    { responseFormat: 'url', baseUrl: 'http://h:1' }
  );
  const match = /^http:\/\/h:1\/v1\/blobs\/([0-9a-f]{32})$/.exec(out.data[0].url);
  assert.ok(match);
});

test('resolveBlobBaseUrl prefers the request Host header', () => {
  assert.equal(resolveBlobBaseUrl({ headers: { host: '192.168.1.5:9000' } }, { host: '0.0.0.0', port: 9999 }), 'http://192.168.1.5:9000');
  assert.equal(resolveBlobBaseUrl({ headers: {} }, { host: '0.0.0.0', port: 9527 }), 'http://0.0.0.0:9527');
  assert.equal(resolveBlobBaseUrl({ headers: {} }, {}), 'http://127.0.0.1:9527');
});

test('writeImageGenerationError emits the OpenAI error envelope', () => {
  const res = makeRes();
  const calls = [];
  writeImageGenerationError(res, (r, status, body) => {
    r.statusCode = status;
    calls.push(body);
  }, new ImageGenerationError(429, 'rate_limited', 'slow down'));
  assert.equal(res.statusCode, 429);
  assert.deepEqual(calls[0], {
    error: { message: 'slow down', type: 'invalid_request_error', code: 'rate_limited' }
  });
});

test('IMAGE_PATHNAMES covers generations and edits', () => {
  assert.deepEqual([...IMAGE_PATHNAMES].sort(), ['/v1/images/edits', '/v1/images/generations']);
});