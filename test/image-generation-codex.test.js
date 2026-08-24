'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCodexImageGenerationStrategy,
  __private: {
    buildCodexImagePayload,
    buildCodexImageUrl,
    readCodexErrorDetail
  }
} = require('../lib/server/image-generation-codex');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BASE64 = PNG_DATA_URL.split(',')[1];

function okResponse(json) {
  return {
    ok: true,
    status: 200,
    async text() {
      return typeof json === 'string' ? json : JSON.stringify(json);
    }
  };
}

function errResponse(status, json) {
  return {
    ok: false,
    status,
    async text() {
      return JSON.stringify(json);
    }
  };
}

function makeFetch(handler) {
  return async (url, init, timeoutMs, extra) => handler(url, init, timeoutMs, extra);
}

function codexAccount(overrides = {}) {
  return {
    accountRef: 'acct_c',
    provider: 'codex',
    accessToken: 'tok-codex',
    upstreamAccountId: 'chatgpt-1',
    ...overrides
  };
}

// OAuth codex accounts resolve their upstream through options.codexBaseUrl.
function codexOptions(overrides = {}) {
  return { codexBaseUrl: 'https://chatgpt.com/backend-api/codex', ...overrides };
}

test('codex strategy posts a direct Images generation request for gpt-image-2', async () => {
  let captured;
  const strategy = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init, timeoutMs, extra) => {
      captured = { url, init, timeoutMs, extra };
      return okResponse({
        data: [{ b64_json: PNG_BASE64, revised_prompt: 'A refined cat prompt' }],
        usage: { total_tokens: 11, input_tokens: 3, output_tokens: 8 }
      });
    }),
    refreshCodexAccessToken: async () => {}
  });

  const out = await strategy.generate({
    mode: 'generation',
    model: 'gpt-image-2',
    prompt: 'a cat',
    n: 2,
    size: '1536x1024',
    quality: 'high',
    background: 'opaque',
    account: codexAccount(),
    options: codexOptions(),
    requestMeta: { requestId: 'turn_1' }
  });

  assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/images/generations');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.authorization, 'Bearer tok-codex');
  assert.equal(captured.init.headers['chatgpt-account-id'], 'chatgpt-1');
  assert.equal(captured.init.headers.originator, 'codex_cli_rs');
  assert.equal(captured.init.headers['x-codex-image-turn-id'], 'turn_1');
  assert.equal(captured.init.headers.accept, 'application/json');
  assert.deepEqual(JSON.parse(captured.init.body), {
    prompt: 'a cat',
    background: 'opaque',
    model: 'gpt-image-2',
    n: 2,
    quality: 'high',
    size: '1536x1024'
  });

  assert.deepEqual(out.images, [{ b64_json: PNG_BASE64, revised_prompt: 'A refined cat prompt' }]);
  assert.equal(out.usageInput.usage.total_tokens, 11);
  assert.equal(out.usageInput.model, 'gpt-image-2');
});

test('codex strategy posts ordered edit references through the direct Images edit endpoint', async () => {
  let captured;
  const strategy = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return okResponse({ data: [{ b64_json: PNG_BASE64 }] });
    })
  });

  const out = await strategy.generate({
    mode: 'edit',
    model: 'gpt-image-2',
    prompt: 'make it red',
    images: [
      { mimeType: 'image/png', data: PNG_BASE64 },
      { mimeType: 'image/webp', data: 'd2VicA==' }
    ],
    background: 'transparent',
    quality: 'medium',
    size: '1024x1024',
    account: codexAccount(),
    options: codexOptions()
  });

  assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/images/edits');
  assert.deepEqual(captured.body, {
    images: [
      { image_url: `data:image/png;base64,${PNG_BASE64}` },
      { image_url: 'data:image/webp;base64,d2VicA==' }
    ],
    prompt: 'make it red',
    background: 'transparent',
    model: 'gpt-image-2',
    quality: 'medium',
    size: '1024x1024'
  });
  assert.deepEqual(out.images, [{ b64_json: PNG_BASE64 }]);
});

test('Codex direct Images helpers use current endpoint and default controls', () => {
  assert.equal(
    buildCodexImageUrl('https://chatgpt.com/backend-api/codex/', 'generation'),
    'https://chatgpt.com/backend-api/codex/images/generations'
  );
  assert.deepEqual(buildCodexImagePayload({
    mode: 'generation',
    prompt: 'p'
  }), {
    prompt: 'p',
    background: 'auto',
    model: 'gpt-image-2',
    quality: 'auto',
    size: 'auto'
  });
});

test('codex strategy forwards best-effort token refresh before the call', async () => {
  let refreshed = false;
  const strategy = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ data: [{ b64_json: PNG_BASE64 }] })),
    refreshCodexAccessToken: async () => {
      refreshed = true;
    }
  });
  await strategy.generate({ mode: 'generation', model: 'gpt-image-2', prompt: 'p', account: codexAccount(), options: codexOptions() });
  assert.equal(refreshed, true);
});

test('codex strategy fails closed on missing token, loopback url and transport', async () => {
  const noToken = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ data: [] }))
  });
  await assert.rejects(
    noToken.generate({ mode: 'generation', model: 'gpt-image-2', prompt: 'p', account: codexAccount({ accessToken: undefined }), options: codexOptions() }),
    (error) => error.code === 'invalid_access_token' && error.statusCode === 400
  );

  let loopbackCalls = 0;
  const loopback = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => {
      loopbackCalls += 1;
      return okResponse({ data: [] });
    })
  });
  for (const openaiBaseUrl of [
    'http://127.0.0.1:9527',
    'http://[::1]:9527',
    'http://[2002:7f00:1::]:9527'
  ]) {
    await assert.rejects(
      loopback.generate({
        mode: 'generation',
        model: 'gpt-image-2',
        prompt: 'p',
        account: codexAccount({ apiKeyMode: true, openaiBaseUrl }),
        options: { port: 9527 }
      }),
      (error) => error.code === 'infinite_loop_detected' && error.statusCode === 502
    );
  }
  assert.equal(loopbackCalls, 0);

  const noTransport = createCodexImageGenerationStrategy({});
  await assert.rejects(
    noTransport.generate({ mode: 'generation', model: 'gpt-image-2', prompt: 'p', account: codexAccount(), options: codexOptions() }),
    (error) => error.code === 'codex_transport_unavailable' && error.statusCode === 500
  );
});

test('codex strategy maps upstream errors and empty output', async () => {
  const upstream = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => errResponse(401, { error: { message: 'unauthorized' } }))
  });
  await assert.rejects(
    upstream.generate({ mode: 'generation', model: 'gpt-image-2', prompt: 'p', account: codexAccount(), options: codexOptions() }),
    (error) => error.code === 'upstream_failed'
      && error.statusCode === 401
      && error.message === 'unauthorized'
      && error.upstreamBody === '{"error":{"message":"unauthorized"}}'
  );

  const empty = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ data: [] }))
  });
  await assert.rejects(
    empty.generate({ mode: 'generation', model: 'gpt-image-2', prompt: 'p', account: codexAccount(), options: codexOptions() }),
    (error) => error.code === 'upstream_failed'
  );

  const network = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => {
      throw new Error('ECONNREFUSED');
    })
  });
  await assert.rejects(
    network.generate({ mode: 'generation', model: 'gpt-image-2', prompt: 'p', account: codexAccount(), options: codexOptions() }),
    (error) => error.code === 'upstream_failed' && error.statusCode === 502
  );
});

test('codex strategy rejects an upstream body larger than the configured byte cap', async () => {
  let cancelled = false;
  const strategy = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'content-length' ? '128' : null;
        }
      },
      body: {
        async cancel() {
          cancelled = true;
        }
      },
      async text() {
        return JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] });
      }
    }))
  });

  await assert.rejects(
    strategy.generate({
      mode: 'generation',
      model: 'gpt-image-2',
      prompt: 'x',
      account: codexAccount(),
      options: codexOptions({ imageGenMaxResponseBytes: 64 })
    }),
    (error) => error.code === 'upstream_response_too_large' && error.statusCode === 502
  );
  assert.equal(cancelled, true);
});

test('codex strategy only accepts Codex-owned image model intents', () => {
  const strategy = createCodexImageGenerationStrategy({});
  assert.equal(strategy.supportsModel('gpt-image-1'), false);
  assert.equal(strategy.supportsModel('gpt-image-2'), true);
  assert.equal(strategy.supportsModel('nano-banana'), false);
  assert.equal(strategy.supportsModel('grok-imagine-image-2.0'), false);
  assert.equal(strategy.supportsModel('codex-mini'), false);
});

test('readCodexErrorDetail falls back to status text', () => {
  assert.equal(readCodexErrorDetail(500, { error: { message: 'boom' } }), 'boom');
  assert.equal(readCodexErrorDetail(500, { error: { detail: 'd' } }), 'd');
  assert.equal(readCodexErrorDetail(500, {}), 'upstream returned HTTP 500');
});
