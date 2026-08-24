'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeImageGenerationResult } = require('../lib/server/image-generation-output');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('image generation output normalizes verified base64 images and HTTP urls', () => {
  const result = normalizeImageGenerationResult({
    images: [
      { b64_json: `  ${PNG_BASE64}\n`, mimeType: 'image/png', revised_prompt: 'A refined prompt' },
      { url: 'https://cdn.example/image.png', revised_prompt: 'A remote prompt' }
    ]
  });

  assert.deepEqual(result.images, [
    { b64_json: PNG_BASE64, mimeType: 'image/png', revised_prompt: 'A refined prompt' },
    { url: 'https://cdn.example/image.png', revised_prompt: 'A remote prompt' }
  ]);
});

test('image generation output rejects empty data entries and fake base64 payloads', () => {
  assert.throws(
    () => normalizeImageGenerationResult({ images: [{}] }),
    (error) => error.code === 'image_output_missing' && error.statusCode === 502
  );
  assert.throws(
    () => normalizeImageGenerationResult({ images: [{ b64_json: 'Zh==' }] }),
    (error) => error.code === 'invalid_image_output' && error.statusCode === 502
  );
  assert.throws(
    () => normalizeImageGenerationResult({ images: [{ b64_json: 'aGVsbG8=' }] }),
    (error) => error.code === 'invalid_image_output' && error.statusCode === 502
  );
});

test('image generation output rejects unsafe or malformed image urls', () => {
  for (const url of ['file:///tmp/image.png', 'data:image/png;base64,AAAA', 'https://user:pass@cdn.example/a.png']) {
    assert.throws(
      () => normalizeImageGenerationResult({ images: [{ url }] }),
      (error) => error.code === 'invalid_image_output_url' && error.statusCode === 502
    );
  }
});
