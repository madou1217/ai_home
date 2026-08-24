'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isImageMultipartContentType,
  parseImageMultipartRequest
} = require('../lib/server/image-generation-multipart');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function encodeFormData(formData) {
  const request = new Request('http://localhost/v1/images/edits', {
    method: 'POST',
    body: formData
  });
  return {
    contentType: request.headers.get('content-type'),
    body: Buffer.from(await request.arrayBuffer())
  };
}

test('image multipart parser converts the OpenAI edits form into the canonical JSON shape', async () => {
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('provider', 'codex');
  form.append('prompt', 'replace the sky');
  form.append('n', '2');
  form.append('quality', 'high');
  form.append('background', 'transparent');
  form.append('output_format', 'webp');
  form.append('output_compression', '72');
  form.append('moderation', 'low');
  form.append('image', new File([PNG_BYTES], 'source.png', { type: 'image/png' }));
  form.append('mask', new File([PNG_BYTES], 'mask.png', { type: 'image/png' }));
  const encoded = await encodeFormData(form);

  assert.equal(isImageMultipartContentType(encoded.contentType), true);
  const parsed = await parseImageMultipartRequest(encoded.body, encoded.contentType);
  assert.equal(parsed.model, 'gpt-image-2');
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.prompt, 'replace the sky');
  assert.equal(parsed.n, '2');
  assert.equal(parsed.quality, 'high');
  assert.equal(parsed.background, 'transparent');
  assert.equal(parsed.output_format, 'webp');
  assert.equal(parsed.output_compression, '72');
  assert.equal(parsed.moderation, 'low');
  assert.equal(parsed.images.length, 1);
  assert.match(parsed.images[0], /^data:image\/png;base64,/);
  assert.match(parsed.mask, /^data:image\/png;base64,/);
});

test('image multipart parser preserves ordered multi-image edit inputs', async () => {
  const multi = new FormData();
  multi.append('model', 'gpt-image-2');
  multi.append('prompt', 'edit');
  multi.append('image[]', new File([PNG_BYTES], 'one.png', { type: 'image/png' }));
  multi.append('image[]', new File([PNG_BYTES], 'two.png', { type: 'image/png' }));
  const multiEncoded = await encodeFormData(multi);
  const parsed = await parseImageMultipartRequest(multiEncoded.body, multiEncoded.contentType);
  assert.equal(parsed.images.length, 2);
  assert.match(parsed.images[0], /^data:image\/png;base64,/);
  assert.match(parsed.images[1], /^data:image\/png;base64,/);
});

test('image multipart parser rejects more than sixteen images and non-PNG masks', async () => {
  const tooMany = new FormData();
  tooMany.append('model', 'gpt-image-2');
  tooMany.append('prompt', 'edit');
  Array.from({ length: 17 }).forEach((_, index) => {
    tooMany.append('image[]', new File([PNG_BYTES], `${index}.png`, { type: 'image/png' }));
  });
  const tooManyEncoded = await encodeFormData(tooMany);
  await assert.rejects(
    parseImageMultipartRequest(tooManyEncoded.body, tooManyEncoded.contentType),
    (error) => error.code === 'invalid_image_count'
  );

  const jpegMask = new FormData();
  jpegMask.append('model', 'gpt-image-2');
  jpegMask.append('prompt', 'edit');
  jpegMask.append('image', new File([PNG_BYTES], 'source.png', { type: 'image/png' }));
  jpegMask.append('mask', new File([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], 'mask.jpg', { type: 'image/jpeg' }));
  const maskEncoded = await encodeFormData(jpegMask);
  await assert.rejects(
    parseImageMultipartRequest(maskEncoded.body, maskEncoded.contentType),
    (error) => error.code === 'invalid_image_mask_mime'
  );
});
