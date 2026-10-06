const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ZCODE_QUOTA_BUSINESS_CODE,
  parseZcodeBusinessError,
  detectUpstreamBusinessFailure,
  isZcodeBalanceEnvelopeOk,
  describeZcodeBalanceEnvelope,
  isZcodeBalanceParameterErrorCode
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

test('isZcodeBalanceEnvelopeOk settles the code:200 conflict for the balance domain', () => {
  // balance 域：code:200 是防御性接受的历史成功码（带不带 msg 均可）。
  assert.equal(isZcodeBalanceEnvelopeOk({ code: 0, msg: '', data: {} }), true);
  assert.equal(isZcodeBalanceEnvelopeOk({ code: 200, msg: 'x', data: {} }), true);
  assert.equal(isZcodeBalanceEnvelopeOk({ code: '200', data: {} }), true);
  assert.equal(isZcodeBalanceEnvelopeOk({ data: {} }), true, 'code 缺省视为成功');
  assert.equal(isZcodeBalanceEnvelopeOk({ success: true, code: 0, data: {} }), true);
  // 推理域的 parseZcodeBusinessError 对同一信封判失败（无载荷键 + code≠0）——
  // 两域差异由「两域判错规则」注释固化，此处锁住双方行为不漂移。
  assert.deepEqual(parseZcodeBusinessError({ code: 200, msg: 'x' }), { code: 200, message: 'x' });
  // balance 域的失败面。
  assert.equal(isZcodeBalanceEnvelopeOk({ success: false, code: 0 }), false);
  assert.equal(isZcodeBalanceEnvelopeOk({ code: 1005, msg: 'exceed quota limit' }), false);
  assert.equal(isZcodeBalanceEnvelopeOk({ code: 3001, msg: 'bad parameter' }), false);
  assert.equal(isZcodeBalanceEnvelopeOk(null), false);
  assert.equal(isZcodeBalanceEnvelopeOk('nope'), false);
});

test('describeZcodeBalanceEnvelope keeps the verbatim code-msg detail format', () => {
  assert.equal(describeZcodeBalanceEnvelope({ code: 1005, msg: 'exceed quota limit' }), '1005 exceed quota limit');
  assert.equal(describeZcodeBalanceEnvelope({ code: '3001', message: 'bad param' }), '3001 bad param');
  assert.equal(describeZcodeBalanceEnvelope({ code: 0 }), '0');
  assert.equal(describeZcodeBalanceEnvelope(null), '');
});

test('isZcodeBalanceParameterErrorCode singles out 3001 across numeric and string forms', () => {
  assert.equal(isZcodeBalanceParameterErrorCode('3001'), true);
  assert.equal(isZcodeBalanceParameterErrorCode(3001), true);
  assert.equal(isZcodeBalanceParameterErrorCode('1005'), false);
  assert.equal(isZcodeBalanceParameterErrorCode(undefined), false);
});
