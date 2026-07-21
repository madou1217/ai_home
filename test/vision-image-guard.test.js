'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { guardNonVisionImagePayload } = require('../lib/server/vision-image-guard');
const { getImageBlob, resetImageBlobStore } = require('../lib/server/image-blob-store');

const PNG_B64 = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const dataUri = `data:image/png;base64,${PNG_B64}`;

test('strips inline OpenAI image for a non-vision model and stashes a retrievable blob', () => {
  resetImageBlobStore();
  const req = {
    model: 'glm-4.6',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: dataUri } }
    ] }]
  };
  const result = guardNonVisionImagePayload(req);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.count, 1);

  const parts = req.messages[0].content;
  assert.strictEqual(parts[0].type, 'text');
  assert.strictEqual(parts[1].type, 'text', 'image part replaced by a text placeholder');
  const id = /\/v1\/blobs\/([a-f0-9]+)/.exec(parts[1].text)[1];
  assert.ok(getImageBlob(id), 'placeholder blob id resolves to stored bytes');
});

test('strips Anthropic base64 image blocks too', () => {
  resetImageBlobStore();
  const req = {
    model: 'deepseek-v3.2',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }
    ] }]
  };
  const result = guardNonVisionImagePayload(req);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(req.messages[0].content[0].type, 'text');
});

test('is a no-op for a vision-capable model', () => {
  const req = {
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] }]
  };
  assert.strictEqual(guardNonVisionImagePayload(req).changed, false);
  assert.strictEqual(req.messages[0].content[0].type, 'image_url', 'payload untouched');
});

test('is a no-op when there are no image parts', () => {
  const req = { model: 'glm-4.6', messages: [{ role: 'user', content: 'plain text' }] };
  assert.strictEqual(guardNonVisionImagePayload(req).changed, false);
});

test('same image bytes yield a stable blob id across turns', () => {
  resetImageBlobStore();
  const mk = () => ({ model: 'glm-4.6', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] }] });
  const a = mk(); guardNonVisionImagePayload(a);
  const b = mk(); guardNonVisionImagePayload(b);
  const idA = /\/v1\/blobs\/([a-f0-9]+)/.exec(a.messages[0].content[0].text)[1];
  const idB = /\/v1\/blobs\/([a-f0-9]+)/.exec(b.messages[0].content[0].text)[1];
  assert.strictEqual(idA, idB);
});
