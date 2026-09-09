'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLlmApiImageGenerationStrategy } = require('../lib/server/image-generation-llm-api');
const { __private: { resolveImageCapabilityError } } = require('../lib/server/image-generation-executor');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const account = { provider: 'codex', apiKeyMode: true, accountRef: 'acct_image', apiKey: 'test-key', openaiBaseUrl: 'https://example.com/api/v1' };
const input = { mode: 'generation', model: 'gpt-image-2', prompt: 'a blue circle', n: 1, account, options: {} };
const result = { status: 'succeeded', b64_json: PNG, mime_type: 'image/png', model: 'gpt-image-2', usage: { total_tokens: 12 } };
const response = (json = result, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(json) });

test('llm-api encodes required JSON fields, dimensions and format; decodes root image and usage', async () => {
  let calls = 0;
  const strategy = createLlmApiImageGenerationStrategy({
    fetchWithTimeout: async (url, init, timeout, extra) => {
      calls += 1;
      assert.equal(url, 'https://example.com/api/v1/images/generations');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer test-key');
      assert.equal(init.headers['content-type'], 'application/json');
      assert.equal(init.headers['x-client-type'], 'custom-client');
      assert.equal(init.headers['x-aih-account-ref'], 'acct_image');
      assert.equal(timeout, 600000);
      assert.equal(extra.proxyUrl, 'http://proxy.test:8080');
      assert.deepEqual(JSON.parse(init.body), {
        model: 'gpt-image-2', prompt: 'a blue circle',
        purpose: 'Generate an image for the API client',
        width: 1536, height: 1024, output_format: 'webp', metadata: {}
      });
      return response();
    }
  });
  const out = await strategy.generate({
    ...input, size: '1536x1024', outputFormat: 'webp', responseFormat: 'url',
    account: { ...account, upstreamHeaders: { 'x-client-type': 'custom-client', 'content-type': 'bad/type' } },
    options: { proxyUrl: 'http://proxy.test:8080', upstreamTimeoutMs: 1000 }
  });
  assert.equal(calls, 1);
  assert.deepEqual(out.images, [{ b64_json: PNG, mimeType: 'image/png' }]);
  assert.equal(out.usageInput.usage.total_tokens, 12);
  assert.equal(out.usageInput.model, 'gpt-image-2');
});

test('llm-api edits send ordered JSON images and a mask for both client input forms', async () => {
  const images = [{ mimeType: 'image/png', data: PNG }, { mimeType: 'image/webp', data: 'd2VicA==' }];
  const strategy = createLlmApiImageGenerationStrategy({
    fetchWithTimeout: async (url, init) => {
      assert.equal(url, 'https://example.com/api/v1/images/edits');
      assert.equal(init.headers['content-type'], 'application/json');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.images, images.map((img) => ({ image_url: `data:${img.mimeType};base64,${img.data}` })));
      assert.deepEqual(body.mask, { ...body.images[0], input_image_id: 'image_1' });
      assert.equal(body.width, 1024);
      assert.equal(body.height, 1024);
      assert.equal(body.output_format, 'png');
      assert.equal(body.size, undefined);
      return response();
    }
  });
  await strategy.generate({ ...input, mode: 'edit', images, mask: images[0] });
});

test('llm-api size boundaries/defaults are enforced before sending', async () => {
  const sizes = [];
  const strategy = createLlmApiImageGenerationStrategy({ fetchWithTimeout: async (_url, init) => {
    const body = JSON.parse(init.body);
    sizes.push([body.width, body.height]);
    return response();
  } });
  for (const size of [undefined, 'auto', '64x4096', '4096x64']) await strategy.generate({ ...input, size });
  assert.deepEqual(sizes, [[1024, 1024], [1024, 1024], [64, 4096], [4096, 64]]);
  for (const size of ['63x1024', '1024x4097', 'foo', '1.5x1024']) {
    await assert.rejects(strategy.generate({ ...input, size }), { code: 'unsupported_image_size' });
  }
  assert.equal(sizes.length, 4);
  assert.equal(strategy.supportsModel('gpt-image-1'), false);
  await assert.rejects(strategy.generate({ ...input, model: 'gpt-image-1' }), { code: 'unsupported_model_for_images' });
});

test('llm-api capabilities reject unsupported controls instead of dropping them', () => {
  const strategy = createLlmApiImageGenerationStrategy();
  const cases = [
    [{ quality: 'high' }, 'unsupported_image_quality'],
    [{ n: 2 }, 'unsupported_image_count'],
    [{ background: 'transparent' }, 'unsupported_image_background'],
    [{ outputCompression: 80 }, 'unsupported_image_output_compression'],
    [{ moderation: 'low' }, 'unsupported_image_moderation'],
    [{ images: Array(17).fill({}) }, 'unsupported_image_input_count']
  ];
  for (const [fields, code] of cases) {
    assert.equal(resolveImageCapabilityError(strategy, { ...input, ...fields }).code, code);
  }
  assert.equal(resolveImageCapabilityError(strategy, { ...input, mode: 'edit', images: Array(16).fill({}), mask: {}, outputFormat: 'png' }), null);
});

test('llm-api preserves HTTP failures and never retries in the transport', async () => {
  for (const status of [400, 429, 500]) {
    let calls = 0;
    const strategy = createLlmApiImageGenerationStrategy({ fetchWithTimeout: async () => {
      calls += 1;
      return response({ error: { message: 'upstream diagnostic', code: 'IMAGE_ERROR' } }, status);
    } });
    await assert.rejects(strategy.generate(input), (error) => {
      assert.equal(error.statusCode, status);
      assert.equal(error.code, 'upstream_failed');
      assert.equal(error.message, 'upstream diagnostic');
      assert.match(error.upstreamBody, /IMAGE_ERROR/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('llm-api shares key, loop, byte-limit guards and rejects invalid success envelopes', async () => {
  let calls = 0;
  const strategy = createLlmApiImageGenerationStrategy({ fetchWithTimeout: async () => { calls += 1; return response(); } });
  await assert.rejects(strategy.generate({ ...input, account: { ...account, apiKey: '' } }), { code: 'invalid_access_token' });
  await assert.rejects(strategy.generate({ ...input, account: { ...account, openaiBaseUrl: 'http://127.0.0.1:9527/v1' }, options: { port: 9527 } }), { code: 'infinite_loop_detected' });
  assert.equal(calls, 0);
  await assert.rejects(strategy.generate({ ...input, options: { imageGenMaxResponseBytes: 32 } }), { code: 'upstream_response_too_large' });
  for (const json of [{}, { ...result, status: 'failed' }, { ...result, b64_json: '' }, { data: [{ b64_json: PNG }] }]) {
    const invalid = createLlmApiImageGenerationStrategy({ fetchWithTimeout: async () => response(json) });
    await assert.rejects(invalid.generate(input), { code: 'upstream_failed' });
  }
});
