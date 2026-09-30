'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { decodeCodexRequestBody, withoutBodyEncoding } = require('../lib/server/codex-http-request-body');
const { handleV1Request } = require('../lib/server/v1-router');

for (const [encoding, encode] of [['identity', value => value], ['gzip', zlib.gzipSync], ['zstd', zlib.zstdCompressSync]]) {
  test(`Codex ${encoding} decoding retains the payload and bounds output`, () => {
    const payload = Buffer.from('{ "model":"alias", "opaque":9007199254740993 }');
    const body = encode(payload);
    assert.deepEqual(decodeCodexRequestBody(body, { 'content-encoding': encoding }), payload);
    assert.throws(() => decodeCodexRequestBody(encode(Buffer.alloc(1024 * 1024, 32)), { 'content-encoding': encoding }, 4096), { code: 'invalid_request_body' });
  });
}

test('malformed and unsupported compression fail closed', () => {
  for (const encoding of ['gzip', 'zstd', 'br', 'gzip, zstd', 'constructor', 'toString', '__proto__']) {
    assert.throws(() => decodeCodexRequestBody(Buffer.from('not encoded'), { 'content-encoding': encoding }), { code: 'invalid_request_body' });
  }
});

test('decoded routing headers preserve cancellation without mutating the original request', () => {
  const request = new EventEmitter();
  request.headers = { 'content-encoding': 'gzip', 'content-length': '17', 'x-account-ref': 'fixture' };
  const decoded = withoutBodyEncoding(request);
  let aborted = false;
  decoded.on('aborted', () => { aborted = true; });
  request.emit('aborted');
  assert.equal(aborted, true);
  assert.equal(decoded.headers['content-encoding'], undefined);
  assert.equal(decoded.headers['content-length'], undefined);
  assert.equal(decoded.headers['x-account-ref'], 'fixture');
  assert.equal(request.headers['content-encoding'], 'gzip');
});

for (const [encoding, encode] of [['gzip', zlib.gzipSync], ['zstd', zlib.zstdCompressSync]]) {
  test(`Node Responses route decodes ${encoding} before model selection and removes encoding from rewritten requests`, async () => {
    const request = new EventEmitter();
    request.headers = { 'content-encoding': encoding, 'content-type': 'application/json' };
    request.url = '/v1/responses';
    const payload = { model: 'gpt-5.4', input: 'compressed fixture' };
    let captured;
    const response = { setHeader() {}, end() {} };
    await handleV1Request({ req: request, res: response, method: 'POST', pathname: '/v1/responses',
      options: { backend: 'codex-adapter', provider: 'codex' },
      state: { metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 } }, requestMeta: {},
      deps: { readRequestBody: async () => encode(Buffer.from(JSON.stringify(payload))),
        handleCodexChatCompletions: async context => { captured = context; } } });
    assert.deepEqual(captured.requestJson, payload);
    assert.equal(captured.req.headers['content-encoding'], undefined);
    assert.equal(typeof captured.req.on, 'function');
    assert.equal(request.headers['content-encoding'], encoding);
  });
}
