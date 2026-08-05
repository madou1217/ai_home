'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
  isOpenAIResponseEnvelope,
  unwrapOpenAIResponseEnvelope,
  unwrapOpenAIResponseEnvelopeBuffer,
  unwrapUpstreamEnvelopeBody
} = require('../lib/server/openai-response-envelope');

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'zai/glm-5.2',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
};

test('detects the {data,success} transport envelope around a completion', () => {
  assert.equal(isOpenAIResponseEnvelope({ data: COMPLETION, success: true }), true);
  assert.deepEqual(unwrapOpenAIResponseEnvelope({ data: COMPLETION, success: true }), COMPLETION);
});

test('detects the envelope around a model list payload', () => {
  const list = { object: 'list', data: [{ id: 'cline-free/glm-5.2', object: 'model' }] };
  assert.equal(isOpenAIResponseEnvelope({ data: list, success: true }), true);
  assert.deepEqual(unwrapOpenAIResponseEnvelope({ data: list, success: true }), list);
});

test('leaves a canonical OpenAI completion untouched', () => {
  assert.equal(isOpenAIResponseEnvelope(COMPLETION), false);
  assert.equal(unwrapOpenAIResponseEnvelope(COMPLETION), COMPLETION);
});

test('never unwraps a canonical payload that merely carries a success flag', () => {
  // `data` here is the model list array of a real payload, not a nested body.
  const listWithFlag = { object: 'list', data: [{ id: 'm', object: 'model' }], success: true };
  assert.equal(isOpenAIResponseEnvelope(listWithFlag), false);
  assert.equal(unwrapOpenAIResponseEnvelope(listWithFlag), listWithFlag);

  const completionWithFlag = { ...COMPLETION, success: true };
  assert.equal(isOpenAIResponseEnvelope(completionWithFlag), false);
});

test('requires an OpenAI-shaped data field, not just a success flag', () => {
  [
    { data: { hello: 'world' }, success: true },
    { data: 'text', success: true },
    { data: null, success: true },
    { success: false },
    { data: COMPLETION },
    null,
    'text',
    [COMPLETION]
  ].forEach((payload) => {
    assert.equal(isOpenAIResponseEnvelope(payload), false, `unexpected envelope: ${JSON.stringify(payload)}`);
  });
});

test('buffer unwrap rewrites wrapped bytes and preserves everything else byte-identically', () => {
  const wrapped = Buffer.from(JSON.stringify({ data: COMPLETION, success: true }), 'utf8');
  assert.deepEqual(JSON.parse(unwrapOpenAIResponseEnvelopeBuffer(wrapped).toString('utf8')), COMPLETION);

  const plain = Buffer.from(JSON.stringify(COMPLETION), 'utf8');
  assert.equal(unwrapOpenAIResponseEnvelopeBuffer(plain), plain);

  const sse = Buffer.from('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', 'utf8');
  assert.equal(unwrapOpenAIResponseEnvelopeBuffer(sse), sse);

  const error = Buffer.from(JSON.stringify({ error: { message: 'nope', type: 'invalid_request_error' } }), 'utf8');
  assert.equal(unwrapOpenAIResponseEnvelopeBuffer(error), error);

  const garbage = Buffer.from('<html>502</html>', 'utf8');
  assert.equal(unwrapOpenAIResponseEnvelopeBuffer(garbage), garbage);

  assert.equal(unwrapOpenAIResponseEnvelopeBuffer(Buffer.alloc(0)).length, 0);
  assert.equal(unwrapOpenAIResponseEnvelopeBuffer(null), null);
});

test('passthrough entry point returns null when nothing needed rewriting', () => {
  const plain = Buffer.from(JSON.stringify(COMPLETION), 'utf8');
  assert.equal(unwrapUpstreamEnvelopeBody(plain, ''), null);
  assert.equal(unwrapUpstreamEnvelopeBody(Buffer.from('not json', 'utf8'), ''), null);
  assert.equal(unwrapUpstreamEnvelopeBody(Buffer.alloc(0), ''), null);
  assert.equal(unwrapUpstreamEnvelopeBody(null, ''), null);
});

test('passthrough entry point decodes a gzipped envelope before unwrapping', () => {
  const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify({ data: COMPLETION, success: true }), 'utf8'));
  const rewritten = unwrapUpstreamEnvelopeBody(gzipped, 'gzip');
  assert.ok(Buffer.isBuffer(rewritten));
  // The rewritten body is plain UTF-8, so the caller must drop content-encoding.
  assert.deepEqual(JSON.parse(rewritten.toString('utf8')), COMPLETION);
});

test('passthrough entry point still unwraps when content-encoding misdescribes a plain body', () => {
  // decodeResponseBuffer is tolerant: a mislabelled but readable body decodes to
  // itself, so the envelope is still recognized rather than forwarded wrapped.
  const notGzip = Buffer.from(JSON.stringify({ data: COMPLETION, success: true }), 'utf8');
  const rewritten = unwrapUpstreamEnvelopeBody(notGzip, 'br');
  assert.ok(Buffer.isBuffer(rewritten));
  assert.deepEqual(JSON.parse(rewritten.toString('utf8')), COMPLETION);
});

test('passthrough entry point forwards an undecodable binary body untouched', () => {
  const binary = Buffer.from([0x00, 0x9c, 0xff, 0x01, 0x7f, 0xfe, 0x80, 0x13]);
  assert.equal(unwrapUpstreamEnvelopeBody(binary, 'gzip'), null);
  assert.equal(unwrapUpstreamEnvelopeBody(binary, ''), null);
});
