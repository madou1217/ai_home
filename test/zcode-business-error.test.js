const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ZCODE_QUOTA_BUSINESS_CODE,
  parseZcodeBusinessError,
  detectUpstreamBusinessFailure
} = require('../lib/server/zcode-business-error');

// 2026-08-22 12:37:52Z 实际抓到的上游响应体（responseStatus=200，content-length=40）。
const CAPTURED_QUOTA_BODY = '{"code":1005,"msg":"exceed quota limit"}';

test('zcode business error parses the captured 200 quota envelope', () => {
  const parsed = parseZcodeBusinessError(CAPTURED_QUOTA_BODY);
  assert.deepEqual(parsed, { code: ZCODE_QUOTA_BUSINESS_CODE, message: 'exceed quota limit' });
});

test('zcode business error accepts Buffer bodies as delivered by the transport', () => {
  const parsed = parseZcodeBusinessError(Buffer.from(CAPTURED_QUOTA_BODY, 'utf8'));
  assert.equal(parsed && parsed.code, 1005);
});

test('zcode business error ignores a healthy Anthropic messages response', () => {
  const body = JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 10, output_tokens: 2 }
  });
  assert.equal(parseZcodeBusinessError(body), null);
});

test('zcode business error ignores a healthy OpenAI chat completion', () => {
  const body = JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }]
  });
  assert.equal(parseZcodeBusinessError(body), null);
});

// 关键防误伤：成功回包若带 code:0 语义，绝不能被当成业务失败。
test('zcode business error ignores a zero business code', () => {
  assert.equal(parseZcodeBusinessError('{"code":0,"msg":""}'), null);
  assert.equal(parseZcodeBusinessError('{"code":0,"msg":"success"}'), null);
});

test('zcode business error requires both a non-zero code and a message', () => {
  assert.equal(parseZcodeBusinessError('{"code":1005}'), null);
  assert.equal(parseZcodeBusinessError('{"msg":"exceed quota limit"}'), null);
});

test('zcode business error tolerates numeric-string codes', () => {
  const parsed = parseZcodeBusinessError('{"code":"1005","msg":"exceed quota limit"}');
  assert.equal(parsed && parsed.code, 1005);
});

test('zcode business error ignores non-JSON and non-object bodies', () => {
  assert.equal(parseZcodeBusinessError(''), null);
  assert.equal(parseZcodeBusinessError('event: message\ndata: {}\n\n'), null);
  assert.equal(parseZcodeBusinessError('[{"code":1005,"msg":"x"}]'), null);
  assert.equal(parseZcodeBusinessError(null), null);
});

// 通用传输层只按状态码判定成败，这条「2xx 里其实是失败」的规则由本模块持有。
test('detect treats a zcode HTTP 200 quota envelope as a real failure', () => {
  const found = detectUpstreamBusinessFailure({
    provider: 'zcode',
    statusCode: 200,
    body: Buffer.from(CAPTURED_QUOTA_BODY, 'utf8')
  });
  assert.deepEqual(found, { code: 1005, message: 'exceed quota limit' });
});

test('detect leaves healthy zcode 200 responses alone', () => {
  const body = JSON.stringify({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'ok' }] });
  assert.equal(detectUpstreamBusinessFailure({ provider: 'zcode', statusCode: 200, body }), null);
});

// >= 400 已有既定失败路径，这里不能重复判定（否则 detail/分类会被改写）。
test('detect defers to the existing path for error status codes', () => {
  assert.equal(detectUpstreamBusinessFailure({
    provider: 'zcode',
    statusCode: 429,
    body: CAPTURED_QUOTA_BODY
  }), null);
});

test('detect never fires for other providers', () => {
  for (const provider of ['claude', 'codex', 'agy', 'opencode', '']) {
    assert.equal(detectUpstreamBusinessFailure({
      provider,
      statusCode: 200,
      body: CAPTURED_QUOTA_BODY
    }), null, `provider=${provider}`);
  }
});
