'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCodexImageGenerationStrategy,
  __private: { extractCodexImageOutput, readCodexErrorDetail }
} = require('../lib/server/image-generation-codex');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BASE64 = PNG_DATA_URL.split(',')[1];

function okResponse(json) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(json);
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
  return { codexBaseUrl: 'https://chatgpt.com/backend-api', ...overrides };
}

test('codex strategy posts a Responses payload with the image_generation tool', async () => {
  let captured;
  const strategy = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init, timeoutMs, extra) => {
      captured = { url, init, timeoutMs, extra };
      return okResponse({
        model: 'gpt-image-1',
        output: [{ type: 'image', url: 'https://cdn.example/x.png', mime_type: 'image/png' }],
        usage: { total_tokens: 11, input_tokens: 3, output_tokens: 8 }
      });
    }),
    refreshCodexAccessToken: async () => {}
  });

  const out = await strategy.generate({
    mode: 'generation',
    model: 'gpt-image-1',
    prompt: 'a cat',
    account: codexAccount(),
    options: codexOptions()
  });

  assert.match(captured.url, /\/responses$/);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.authorization, 'Bearer tok-codex');
  assert.equal(captured.init.headers['chatgpt-account-id'], 'chatgpt-1');
  const payload = JSON.parse(captured.init.body);
  assert.equal(payload.model, 'gpt-image-1');
  assert.deepEqual(payload.input, [{ role: 'user', content: [{ type: 'input_text', text: 'a cat' }] }]);
  assert.deepEqual(payload.tools, [{ type: 'image_generation', name: 'image_generation' }]);
  // wire-only params must never be forwarded
  assert.equal('n' in payload, false);
  assert.equal('size' in payload, false);
  assert.equal('quality' in payload, false);

  assert.deepEqual(out.images, [{ url: 'https://cdn.example/x.png', mimeType: 'image/png' }]);
  assert.equal(out.usageInput.usage.total_tokens, 11);
  assert.equal(out.usageInput.model, 'gpt-image-1');
});

test('codex strategy appends input_image part for edits', async () => {
  let captured;
  const strategy = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init) => {
      captured = JSON.parse(init.body);
      return okResponse({ output: [{ type: 'image', data: PNG_BASE64, mime_type: 'image/png' }] });
    })
  });

  const out = await strategy.generate({
    mode: 'edit',
    model: 'gpt-image-1',
    prompt: 'make it red',
    image: { mimeType: 'image/png', data: PNG_BASE64 },
    account: codexAccount(),
    options: codexOptions()
  });

  assert.deepEqual(captured.input[0].content, [
    { type: 'input_text', text: 'make it red' },
    { type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}` }
  ]);
  assert.deepEqual(out.images, [{ b64_json: PNG_BASE64, mimeType: 'image/png' }]);
});

test('codex strategy forwards best-effort token refresh before the call', async () => {
  let refreshed = false;
  const strategy = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ output: [{ type: 'image', data: PNG_BASE64 }] })),
    refreshCodexAccessToken: async () => {
      refreshed = true;
    }
  });
  await strategy.generate({ mode: 'generation', model: 'gpt-image-1', prompt: 'p', account: codexAccount(), options: codexOptions() });
  assert.equal(refreshed, true);
});

test('codex strategy fails closed on missing token, loopback url and transport', async () => {
  const noToken = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ output: [] }))
  });
  await assert.rejects(
    noToken.generate({ mode: 'generation', model: 'gpt-image-1', prompt: 'p', account: codexAccount({ accessToken: undefined }), options: codexOptions() }),
    (error) => error.code === 'invalid_access_token' && error.statusCode === 400
  );

  const loopback = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ output: [] }))
  });
  await assert.rejects(
    loopback.generate({
      mode: 'generation',
      model: 'gpt-image-1',
      prompt: 'p',
      account: codexAccount({ apiKeyMode: true, openaiBaseUrl: 'http://127.0.0.1:9527' }),
      options: { port: 9527 }
    }),
    (error) => error.code === 'infinite_loop_detected' && error.statusCode === 502
  );

  const noTransport = createCodexImageGenerationStrategy({});
  await assert.rejects(
    noTransport.generate({ mode: 'generation', model: 'gpt-image-1', prompt: 'p', account: codexAccount(), options: codexOptions() }),
    (error) => error.code === 'codex_transport_unavailable' && error.statusCode === 500
  );
});

test('codex strategy maps upstream errors and empty output', async () => {
  const upstream = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => errResponse(401, { error: { message: 'unauthorized' } }))
  });
  await assert.rejects(
    upstream.generate({ mode: 'generation', model: 'gpt-image-1', prompt: 'p', account: codexAccount(), options: codexOptions() }),
    (error) => error.code === 'upstream_failed'
      && error.statusCode === 401
      && error.message === 'unauthorized'
      && error.upstreamBody === '{"error":{"message":"unauthorized"}}'
  );

  const empty = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ output: [] }))
  });
  await assert.rejects(
    empty.generate({ mode: 'generation', model: 'gpt-image-1', prompt: 'p', account: codexAccount(), options: codexOptions() }),
    (error) => error.code === 'upstream_failed'
  );

  const network = createCodexImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => {
      throw new Error('ECONNREFUSED');
    })
  });
  await assert.rejects(
    network.generate({ mode: 'generation', model: 'gpt-image-1', prompt: 'p', account: codexAccount(), options: codexOptions() }),
    (error) => error.code === 'upstream_failed' && error.statusCode === 502
  );
});

test('codex strategy gates models through isImageGenerationModel', () => {
  const strategy = createCodexImageGenerationStrategy({});
  assert.equal(strategy.supportsModel('gpt-image-1'), true);
  assert.equal(strategy.supportsModel('nano-banana'), true);
  assert.equal(strategy.supportsModel('codex-mini'), false);
});

test('extractCodexImageOutput walks nested tool_call outputs', () => {
  const output = [
    { type: 'message', content: [{ type: 'output_text', text: 'here you go' }] },
    {
      type: 'function_call',
      id: 'fc_1',
      name: 'image_generation',
      arguments: '{"prompt":"a cat"}',
      response: {
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'image', url: 'https://cdn.example/nested.png', mime_type: 'image/png' }
        ]
      }
    }
  ];
  assert.deepEqual(extractCodexImageOutput(output), [
    { url: 'https://cdn.example/nested.png', mimeType: 'image/png' }
  ]);
});

test('extractCodexImageOutput handles tool_call with flat output array', () => {
  const output = [
    { type: 'tool_call', output: [{ type: 'image', data: PNG_BASE64 }] }
  ];
  assert.deepEqual(extractCodexImageOutput(output), [{ b64_json: PNG_BASE64 }]);
});

test('readCodexErrorDetail falls back to status text', () => {
  assert.equal(readCodexErrorDetail(500, { error: { message: 'boom' } }), 'boom');
  assert.equal(readCodexErrorDetail(500, { error: { detail: 'd' } }), 'd');
  assert.equal(readCodexErrorDetail(500, {}), 'upstream returned HTTP 500');
});