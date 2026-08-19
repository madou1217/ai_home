'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAgyGeminiImageGenerationStrategy,
  __private: { DEFAULT_TIMEOUT_MS }
} = require('../lib/server/image-generation-agy-gemini');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BASE64 = PNG_DATA_URL.split(',')[1];

function geminiEnvelope(parts) {
  return {
    candidates: [{ content: { parts } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 }
  };
}

function agyAccount(overrides = {}) {
  return { accountRef: 'acct_a', provider: 'agy', ...overrides };
}

test('agy strategy shapes a native generateContent request for generation', async () => {
  let captured;
  const strategy = createAgyGeminiImageGenerationStrategy({
    fetchGeminiCodeAssistGenerateContent: async (options, account, requestJson, timeoutMs) => {
      captured = { options, account, requestJson, timeoutMs };
      return geminiEnvelope([{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }]);
    }
  });

  const out = await strategy.generate({
    mode: 'generation',
    model: 'gemini-3.1-flash-image',
    prompt: 'a cat',
    account: agyAccount(),
    options: {}
  });

  assert.equal(captured.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(captured.requestJson.model, 'gemini-3.1-flash-image');
  assert.deepEqual(captured.requestJson.contents, [{ role: 'user', parts: [{ text: 'a cat' }] }]);
  assert.deepEqual(captured.requestJson.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  // thinkingConfig must be neutralized: JSON.stringify drops undefined values,
  // so the image model is never asked to narrate first.
  assert.equal(JSON.stringify(captured.requestJson.generationConfig).includes('thinkingConfig'), false);
  assert.deepEqual(out.images, [{ b64_json: PNG_BASE64, mimeType: 'image/png' }]);
  assert.ok(out.usageInput, 'usageInput should be captured');
});

test('agy strategy appends inlineData part for edits', async () => {
  let captured;
  const strategy = createAgyGeminiImageGenerationStrategy({
    fetchGeminiCodeAssistGenerateContent: async (options, account, requestJson) => {
      captured = requestJson;
      return geminiEnvelope([{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }]);
    }
  });

  await strategy.generate({
    mode: 'edit',
    model: 'gemini-3.1-flash-image',
    prompt: 'make it red',
    image: { mimeType: 'image/png', data: PNG_BASE64 },
    account: agyAccount(),
    options: {}
  });

  assert.deepEqual(captured.contents[0].parts, [
    { text: 'make it red' },
    { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }
  ]);
});

test('agy strategy reads images from wrapped response envelopes', async () => {
  const strategy = createAgyGeminiImageGenerationStrategy({
    fetchGeminiCodeAssistGenerateContent: async () => ({
      response: {
        candidates: [{ content: { parts: [{ text: 'x' }, { inlineData: { data: 'aGk=' } }] } }]
      }
    })
  });

  const out = await strategy.generate({
    mode: 'generation',
    model: 'gemini-3.1-flash-image',
    prompt: 'p',
    account: agyAccount(),
    options: {}
  });
  assert.deepEqual(out.images, [{ b64_json: 'aGk=', mimeType: 'image/png' }]);
});

test('agy strategy gates models through isImageGenerationModel', () => {
  const strategy = createAgyGeminiImageGenerationStrategy({});
  assert.equal(strategy.supportsModel('gemini-3.1-flash-image'), true);
  assert.equal(strategy.supportsModel('gemini-3.1-pro-high'), false);
});

test('agy strategy fails closed without transport', async () => {
  const strategy = createAgyGeminiImageGenerationStrategy({});
  await assert.rejects(
    strategy.generate({ mode: 'generation', model: 'gemini-3.1-flash-image', prompt: 'p', account: agyAccount(), options: {} }),
    (error) => error.code === 'agy_transport_unavailable' && error.statusCode === 500
  );
});

test('agy strategy maps transport errors to 502 upstream_failed', async () => {
  const strategy = createAgyGeminiImageGenerationStrategy({
    fetchGeminiCodeAssistGenerateContent: async () => {
      throw new Error('socket hang up');
    }
  });
  await assert.rejects(
    strategy.generate({ mode: 'generation', model: 'gemini-3.1-flash-image', prompt: 'p', account: agyAccount(), options: {} }),
    (error) => error.code === 'upstream_failed' && error.statusCode === 502 && /socket hang up/.test(error.message)
  );
});

test('agy strategy maps NOT_APPLICABLE to 400 and rejects empty output', async () => {
  const notApplicable = createAgyGeminiImageGenerationStrategy({
    fetchGeminiCodeAssistGenerateContent: async () => {
      const error = new Error('not applicable');
      error.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
      throw error;
    }
  });
  await assert.rejects(
    notApplicable.generate({ mode: 'generation', model: 'gemini-3.1-flash-image', prompt: 'p', account: agyAccount(), options: {} }),
    (error) => error.code === 'gemini_code_assist_not_applicable' && error.statusCode === 400
  );

  const empty = createAgyGeminiImageGenerationStrategy({
    fetchGeminiCodeAssistGenerateContent: async () => geminiEnvelope([{ text: 'no image' }])
  });
  await assert.rejects(
    empty.generate({ mode: 'generation', model: 'gemini-3.1-flash-image', prompt: 'p', account: agyAccount(), options: {} }),
    (error) => error.code === 'upstream_failed'
  );
});

test('agy strategy honors upstreamTimeoutMs override above the floor', async () => {
  let captured;
  const strategy = createAgyGeminiImageGenerationStrategy({
    fetchGeminiCodeAssistGenerateContent: async (options, account, requestJson, timeoutMs) => {
      captured = timeoutMs;
      return geminiEnvelope([{ inlineData: { data: 'aGk=' } }]);
    }
  });
  await strategy.generate({
    mode: 'generation',
    model: 'gemini-3.1-flash-image',
    prompt: 'p',
    account: agyAccount(),
    options: { upstreamTimeoutMs: 180000 }
  });
  assert.equal(captured, 180000);
});