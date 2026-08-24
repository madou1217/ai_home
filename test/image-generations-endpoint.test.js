'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleImageGenerations,
  __private: {
    buildImageGenerationRegistry,
    renderImageGenerationResponse,
    resolveEligibleImageAccounts,
    resolveImageCapabilityError,
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

test('handleImageGenerations preserves an explicit provider routing hint', async () => {
  let capturedRequest;
  const ctx = makeCtx({
    requestJson: {
      provider: 'codex',
      model: 'gemini-3.1-flash-image',
      prompt: 'a cat'
    },
    deps: {
      resolveGatewayProvider: (input) => {
        capturedRequest = input.requestJson;
        return { provider: 'agy' };
      }
    }
  });
  await handleImageGenerations(ctx);
  assert.deepEqual(capturedRequest, {
    provider: 'codex',
    model: 'gemini-3.1-flash-image'
  });
});

test('image capability filtering keeps only accounts whose strategy supports the requested mask', () => {
  const registry = buildImageGenerationRegistry({});
  const oauth = { accountRef: 'acct_oauth', provider: 'codex', accessToken: 'oauth' };
  const apiKey = {
    accountRef: 'acct_key',
    provider: 'codex',
    authType: 'api-key',
    apiKey: 'key',
    openaiBaseUrl: 'https://api.example/v1'
  };
  const request = {
    mode: 'edit',
    model: 'gpt-image-2',
    prompt: 'replace the sky',
    n: 1,
    responseFormat: 'b64_json',
    images: [{ mimeType: 'image/png', data: PNG_BASE64 }],
    mask: { mimeType: 'image/png', data: PNG_BASE64 }
  };
  const eligible = resolveEligibleImageAccounts([oauth, apiKey], registry, 'codex', request);
  assert.deepEqual(eligible.pool.map((account) => account.accountRef), ['acct_key']);
});

test('native image capabilities reject controls that would otherwise be silently dropped', () => {
  const registry = buildImageGenerationRegistry({});
  const strategy = registry.resolve('codex', {
    accountRef: 'acct_oauth',
    provider: 'codex',
    accessToken: 'oauth'
  });
  const base = {
    mode: 'edit',
    model: 'gpt-image-2',
    prompt: 'edit',
    n: 1,
    responseFormat: 'b64_json',
    images: [{ mimeType: 'image/png', data: PNG_BASE64 }]
  };
  assert.equal(resolveImageCapabilityError(strategy, { ...base, mask: base.images[0] }).code, 'unsupported_image_mask');
  assert.equal(resolveImageCapabilityError(strategy, {
    ...base,
    images: Array.from({ length: 6 }, () => base.images[0])
  }).code, 'unsupported_image_input_count');
  assert.equal(resolveImageCapabilityError(strategy, { ...base, background: 'transparent' }), null);
  assert.equal(resolveImageCapabilityError(strategy, { ...base, n: 2 }), null);
  assert.equal(resolveImageCapabilityError(strategy, { ...base, size: '1024x1024' }), null);
  assert.equal(resolveImageCapabilityError(strategy, { ...base, quality: 'high' }), null);
  assert.equal(resolveImageCapabilityError(strategy, { ...base, outputFormat: 'webp' }).code, 'unsupported_image_output_format');
  assert.equal(resolveImageCapabilityError(strategy, { ...base, outputCompression: 80 }).code, 'unsupported_image_output_compression');
  assert.equal(resolveImageCapabilityError(strategy, { ...base, moderation: 'low' }).code, 'unsupported_image_moderation');

  const agyStrategy = registry.resolve('agy', {
    accountRef: 'acct_agy_oauth',
    provider: 'agy',
    accessToken: 'oauth'
  });
  assert.equal(resolveImageCapabilityError(agyStrategy, {
    ...base,
    model: 'gemini-3.1-flash-image',
    mask: base.images[0]
  }).code, 'unsupported_image_mask');
  assert.equal(resolveImageCapabilityError(agyStrategy, {
    ...base,
    model: 'gemini-3.1-flash-image',
    background: 'transparent'
  }).code, 'unsupported_image_background');
  assert.equal(resolveImageCapabilityError(agyStrategy, {
    ...base,
    model: 'gemini-3.1-flash-image',
    outputFormat: 'webp'
  }).code, 'unsupported_image_output_format');
  assert.equal(resolveImageCapabilityError(agyStrategy, {
    ...base,
    model: 'gemini-3.1-flash-image',
    outputFormat: 'webp',
    outputCompression: 80
  }).code, 'unsupported_image_output_format');
  assert.equal(resolveImageCapabilityError(agyStrategy, {
    ...base,
    model: 'gemini-3.1-flash-image',
    moderation: 'low'
  }).code, 'unsupported_image_moderation');

  const grokStrategy = registry.resolve('grok', {
    accountRef: 'acct_grok_oauth',
    provider: 'grok',
    accessToken: 'oauth'
  });
  assert.equal(resolveImageCapabilityError(grokStrategy, {
    ...base,
    mode: 'generation',
    model: 'grok-imagine-image',
    images: undefined,
    quality: 'low'
  }).code, 'unsupported_image_quality');
  assert.equal(resolveImageCapabilityError(grokStrategy, {
    ...base,
    mode: 'generation',
    model: 'grok-imagine-image-2.0',
    images: undefined,
    quality: 'medium'
  }), null);
  assert.equal(resolveImageCapabilityError(grokStrategy, {
    ...base,
    model: 'grok-imagine-image-2.0',
    images: Array.from({ length: 4 }, () => base.images[0])
  }).code, 'unsupported_image_input_count');
});

test('handleImageGenerations renders a successful b64_json response and records accounting', async () => {
  const ctx = makeCtx();
  assert.equal(await handleImageGenerations(ctx), true);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(ctx.res.headers['x-aih-server-provider'], 'agy');
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

test('图片请求在选定账号后使用该账号的出口选项', async () => {
  const resolvedInputs = [];
  let strategyOptions = null;
  const ctx = makeCtx({
    options: {
      logRequests: true,
      proxyUrl: 'http://global-proxy.example:7890',
      noProxy: 'global.example'
    },
    deps: {
      async resolveAccountEgressRequestOptions(input) {
        resolvedInputs.push(input);
        return {
          ok: true,
          bound: true,
          options: {
            ...input.options,
            proxyUrl: 'http://127.0.0.1:23101',
            noProxy: 'localhost,127.0.0.1,::1'
          }
        };
      },
      async fetchGeminiCodeAssistGenerateContent(options) {
        strategyOptions = options;
        return {
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] } }],
          usageMetadata: { totalTokenCount: 7 },
          model: 'gemini-3.1-flash-image'
        };
      }
    }
  });

  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(resolvedInputs.length, 1);
  assert.equal(resolvedInputs[0].provider, 'agy');
  assert.equal(resolvedInputs[0].accountRef, 'acct_a');
  assert.equal(strategyOptions.proxyUrl, 'http://127.0.0.1:23101');
  assert.equal(strategyOptions.noProxy, 'localhost,127.0.0.1,::1');
});

test('handleImageGenerations forwards normalized image controls to the selected strategy', async () => {
  let capturedPayload;
  const account = {
    accountRef: 'acct_key',
    provider: 'codex',
    authType: 'api-key',
    apiKey: 'key',
    openaiBaseUrl: 'https://api.example/v1'
  };
  const ctx = makeCtx({
    state: {
      accounts: { codex: [account] },
      metrics: { totalSuccess: 0, totalFailures: 0 }
    },
    requestJson: {
      provider: 'codex',
      model: 'gpt-image-2',
      prompt: 'a cat',
      n: 2,
      size: '1024x1024',
      quality: 'high',
      response_format: 'url'
    },
    deps: {
      resolveGatewayProvider: () => ({ provider: 'codex' }),
      chooseServerAccount: (pool) => pool[0],
      fetchWithTimeout: async (url, init) => {
        capturedPayload = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: [{ url: 'https://cdn.example/generated.png' }] });
          }
        };
      }
    }
  });
  await handleImageGenerations(ctx);
  assert.deepEqual(capturedPayload, {
    model: 'gpt-image-2',
    prompt: 'a cat',
    n: 2,
    size: '1024x1024',
    quality: 'high',
    response_format: 'url'
  });
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(JSON.parse(ctx.res.body).data[0].url, 'https://cdn.example/generated.png');
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

test('handleImageGenerations records unknown strategy failures with the actual provider', async () => {
  let picks = 0;
  const ctx = makeCtx({
    deps: {
      chooseServerAccount: () => {
        picks += 1;
        return picks === 1 ? { accountRef: 'acct_a', email: 'a@example.com', provider: 'agy' } : null;
      },
      fetchGeminiCodeAssistGenerateContent: async () => {
        throw new Error('strategy exploded');
      }
    }
  });
  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 502);
  assert.equal(JSON.parse(ctx.res.body).error.code, 'upstream_failed');
  assert.equal(ctx.state.metrics.totalFailures, 1);
  assert.equal(ctx.calls.failure.length, 1);
  assert.equal(ctx.calls.failure[0].code, 'strategy exploded');
  assert.equal(ctx.calls.failure[0].account.accountRef, 'acct_a');
  // access log + per-attempt diagnostic + final failure summary
  assert.equal(ctx.calls.logs.length, 3);
  const attemptDiag = ctx.calls.logs.find((entry) => entry.attempt === 1);
  assert.ok(attemptDiag, 'per-attempt diagnostic should be recorded');
  assert.equal(attemptDiag.provider, 'agy');
  assert.equal(attemptDiag.policyKind, 'unknown_error');
  assert.equal(attemptDiag.maxAttempts, 3);
});

test('handleImageGenerations retries the next account without cooling it after a network failure', async () => {
  const ctx = makeCtx({
    deps: {
      chooseServerAccount: (() => {
        let idx = 0;
        const accounts = [
          { accountRef: 'acct_a', email: 'a@example.com', provider: 'agy' },
          { accountRef: 'acct_b', email: 'b@example.com', provider: 'agy' }
        ];
        return () => (idx < accounts.length ? accounts[idx++] : null);
      })(),
      fetchGeminiCodeAssistGenerateContent: async (options, account) => {
        if (account.accountRef === 'acct_a') {
          const error = new Error('socket hang up');
          error.code = 'ECONNRESET';
          throw error;
        }
        return {
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] } }],
          usageMetadata: { totalTokenCount: 7 },
          model: 'gemini-3.1-flash-image'
        };
      }
    }
  });
  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(JSON.parse(ctx.res.body).data.length, 1);
  assert.equal(ctx.calls.failure.length, 0);
  assert.equal(ctx.calls.success.length, 1);
  assert.equal(ctx.calls.success[0].accountRef, 'acct_b');
  const diag = ctx.calls.logs.find((entry) => entry.policyKind === 'network_error' && entry.attempt === 1);
  assert.ok(diag, 'per-attempt diagnostic should be recorded');
  assert.equal(diag.provider, 'agy');
  assert.equal(diag.accountRef, 'acct_a');
});

test('handleImageGenerations retries the next account after an upstream auth rejection', async () => {
  const accounts = [
    {
      accountRef: 'acct_stale',
      provider: 'codex',
      authType: 'api-key',
      apiKey: 'stale-key',
      openaiBaseUrl: 'https://api.example/v1'
    },
    {
      accountRef: 'acct_healthy',
      provider: 'codex',
      authType: 'api-key',
      apiKey: 'healthy-key',
      openaiBaseUrl: 'https://api.example/v1'
    }
  ];
  const ctx = makeCtx({
    state: {
      accounts: { codex: accounts },
      metrics: { totalSuccess: 0, totalFailures: 0 }
    },
    requestJson: { provider: 'codex', model: 'gpt-image-2', prompt: 'p' },
    deps: {
      resolveGatewayProvider: () => ({ provider: 'codex' }),
      chooseServerAccount: (pool, _state, _routeKey, selection = {}) => {
        const excluded = selection.excludeAccountRefs || new Set();
        return pool.find((account) => !excluded.has(account.accountRef)) || null;
      },
      fetchWithTimeout: async (_url, init) => {
        const accountRef = init.headers['x-aih-account-ref'];
        if (accountRef === 'acct_stale') {
          return {
            ok: false,
            status: 401,
            async text() {
              return JSON.stringify({ error: { message: 'token expired' } });
            }
          };
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] });
          }
        };
      }
    }
  });

  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.calls.failure.length, 1);
  assert.equal(ctx.calls.failure[0].account.accountRef, 'acct_stale');
  assert.equal(ctx.calls.success.length, 1);
  assert.equal(ctx.calls.success[0].accountRef, 'acct_healthy');
  const authDiagnostic = ctx.calls.logs.find((entry) => entry.accountRef === 'acct_stale');
  assert.ok(authDiagnostic);
  assert.equal(authDiagnostic.policyKind, 'auth_invalid');
  assert.equal(authDiagnostic.retryable, true);
});

test('handleImageGenerations skips a local missing token and uses the next Codex account', async () => {
  const accounts = [
    { accountRef: 'acct_missing', provider: 'codex' },
    { accountRef: 'acct_healthy', provider: 'codex', accessToken: 'oauth-token' }
  ];
  let upstreamCalls = 0;
  const ctx = makeCtx({
    options: { logRequests: true, codexBaseUrl: 'https://chatgpt.com/backend-api/codex' },
    state: {
      accounts: { codex: accounts },
      metrics: { totalSuccess: 0, totalFailures: 0 }
    },
    requestJson: { provider: 'codex', model: 'gpt-image-2', prompt: 'p' },
    deps: {
      resolveGatewayProvider: () => ({ provider: 'codex' }),
      chooseServerAccount: (pool, _state, _routeKey, selection = {}) => {
        const excluded = selection.excludeAccountRefs || new Set();
        return pool.find((account) => !excluded.has(account.accountRef)) || null;
      },
      fetchWithTimeout: async () => {
        upstreamCalls += 1;
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] });
          }
        };
      }
    }
  });

  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(upstreamCalls, 1);
  assert.equal(ctx.calls.failure.length, 1);
  assert.equal(ctx.calls.failure[0].account.accountRef, 'acct_missing');
  assert.equal(ctx.calls.success.length, 1);
  assert.equal(ctx.calls.success[0].accountRef, 'acct_healthy');
  const diagnostic = ctx.calls.logs.find((entry) => entry.accountRef === 'acct_missing');
  assert.ok(diagnostic);
  assert.equal(diagnostic.policyKind, 'auth_invalid');
});

test('handleImageGenerations does not rotate accounts for a structured safety rejection', async () => {
  const accounts = [
    {
      accountRef: 'acct_first',
      provider: 'codex',
      authType: 'api-key',
      apiKey: 'first-key',
      openaiBaseUrl: 'https://api.example/v1'
    },
    {
      accountRef: 'acct_second',
      provider: 'codex',
      authType: 'api-key',
      apiKey: 'second-key',
      openaiBaseUrl: 'https://api.example/v1'
    }
  ];
  let upstreamCalls = 0;
  const ctx = makeCtx({
    state: {
      accounts: { codex: accounts },
      metrics: { totalSuccess: 0, totalFailures: 0 }
    },
    requestJson: { provider: 'codex', model: 'gpt-image-2', prompt: 'p' },
    deps: {
      resolveGatewayProvider: () => ({ provider: 'codex' }),
      chooseServerAccount: (pool, _state, _routeKey, selection = {}) => {
        const excluded = selection.excludeAccountRefs || new Set();
        return pool.find((account) => !excluded.has(account.accountRef)) || null;
      },
      fetchWithTimeout: async () => {
        upstreamCalls += 1;
        return {
          ok: false,
          status: 403,
          async text() {
            return JSON.stringify({
              error: {
                code: 'sensitive_words_detected',
                message: 'request rejected'
              }
            });
          }
        };
      }
    }
  });

  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 403);
  assert.equal(upstreamCalls, 1);
  assert.equal(ctx.calls.failure.length, 0);
  assert.equal(ctx.calls.success.length, 0);
  const diagnostic = ctx.calls.logs.find((entry) => entry.policyKind === 'safety_rejected');
  assert.ok(diagnostic);
  assert.equal(diagnostic.provider, 'codex');
  assert.equal(diagnostic.accountRef, 'acct_first');
  assert.equal(diagnostic.retryable, false);
});

test('handleImageGenerations preserves AGY HTTP 429 status and retries the next account', async () => {
  const accounts = [
    { accountRef: 'acct_limited', provider: 'agy' },
    { accountRef: 'acct_healthy', provider: 'agy' }
  ];
  let upstreamCalls = 0;
  const ctx = makeCtx({
    state: {
      accounts: { agy: accounts },
      metrics: { totalSuccess: 0, totalFailures: 0 }
    },
    deps: {
      chooseServerAccount: (pool, _state, _routeKey, selection = {}) => {
        const excluded = selection.excludeAccountRefs || new Set();
        return pool.find((account) => !excluded.has(account.accountRef)) || null;
      },
      fetchGeminiCodeAssistGenerateContent: async (_options, account) => {
        upstreamCalls += 1;
        if (account.accountRef === 'acct_limited') {
          const error = new Error('rate limited');
          error.code = 'HTTP_429';
          throw error;
        }
        return {
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] } }],
          usageMetadata: { totalTokenCount: 7 },
          model: 'gemini-3.1-flash-image'
        };
      }
    }
  });

  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(upstreamCalls, 2);
  assert.equal(ctx.calls.success.length, 1);
  assert.equal(ctx.calls.success[0].accountRef, 'acct_healthy');
  const diagnostic = ctx.calls.logs.find((entry) => entry.accountRef === 'acct_limited');
  assert.ok(diagnostic);
  assert.equal(diagnostic.provider, 'agy');
  assert.equal(diagnostic.status, 429);
  assert.equal(diagnostic.policyKind, 'rate_limited');
  assert.equal(diagnostic.retryable, true);
});

test('handleImageGenerations does not retry non-retryable errors', async () => {
  let picks = 0;
  const account = {
    accountRef: 'acct_key',
    provider: 'codex',
    authType: 'api-key',
    apiKey: 'key',
    openaiBaseUrl: 'https://api.example/v1'
  };
  const ctx = makeCtx({
    requestJson: { provider: 'codex', model: 'gpt-image-2', prompt: 'p' },
    state: {
      accounts: { codex: [account] },
      metrics: { totalSuccess: 0, totalFailures: 0 }
    },
    deps: {
      resolveGatewayProvider: () => ({ provider: 'codex' }),
      chooseServerAccount: () => {
        picks += 1;
        return picks === 1 ? account : null;
      },
      fetchWithTimeout: async () => {
        return {
          ok: false,
          status: 400,
          async text() {
            return JSON.stringify({ error: { message: 'unsupported param' } });
          }
        };
      }
    }
  });
  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 400);
  assert.equal(picks, 1, 'no second account should be picked');
});

test('handleImageGenerations caps retries via imageGenMaxAttempts', async () => {
  let picks = 0;
  const ctx = makeCtx({
    options: { logRequests: true, imageGenMaxAttempts: 1 },
    deps: {
      chooseServerAccount: () => {
        picks += 1;
        return picks === 1 ? { accountRef: 'acct_a', email: 'a@example.com', provider: 'agy' } : null;
      },
      fetchGeminiCodeAssistGenerateContent: async () => {
        throw new Error('socket hang up');
      }
    }
  });
  await handleImageGenerations(ctx);

  assert.equal(ctx.res.statusCode, 502);
  assert.equal(picks, 1);
  assert.equal(ctx.calls.failure.length, 1);
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
    [
      { b64_json: 'YWJj', mimeType: 'image/png', revised_prompt: 'first prompt' },
      { url: 'https://x/y.png', revised_prompt: 'second prompt' }
    ],
    { responseFormat: 'b64_json' }
  );
  assert.deepEqual(out.data, [
    { b64_json: 'YWJj', revised_prompt: 'first prompt' },
    { url: 'https://x/y.png', revised_prompt: 'second prompt' }
  ]);
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
