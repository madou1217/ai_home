const test = require('node:test');
const assert = require('node:assert/strict');

const { humanizeUpstreamError } = require('../lib/server/webui-chat-routes-utils');

const NO_ACCOUNT = JSON.stringify({
  ok: false,
  error: 'no_available_account',
  detail: 'no available zcode account can serve model glm-5.3'
});

test('zcode 的 no_available_account 不再引导补凭据，改指 API Key 账号或其他 provider', () => {
  const msg = humanizeUpstreamError(NO_ACCOUNT, { status: 400, model: 'glm-5.3', provider: 'zcode' });
  assert.match(msg, /zcode OAuth 账号不支持推理调用/);
  assert.match(msg, /API Key/);
  // OAuth 计划账号本就不做 relay，「补全凭据」是误导
  assert.doesNotMatch(msg, /补全/);
  assert.doesNotMatch(msg, /no_available_account/);
});

test('其他 provider 的 no_available_account 文案保持不变', () => {
  const raw = JSON.stringify({
    ok: false,
    error: 'no_available_account',
    detail: 'no available codex account can serve model gpt-5.5'
  });
  const msg = humanizeUpstreamError(raw, { status: 400, model: 'gpt-5.5', provider: 'codex' });
  assert.match(msg, /请在「账号」页补全该 server 上的账号凭据/);
  assert.match(msg, /gpt-5\.5/);
});

test('缺省 provider 时 no_available_account 仍走通用文案', () => {
  const msg = humanizeUpstreamError(NO_ACCOUNT, { status: 400 });
  assert.match(msg, /请在「账号」页补全该 server 上的账号凭据/);
});

test('zcode 的其他错误码不受分支影响', () => {
  const msg = humanizeUpstreamError(JSON.stringify({ error: 'rate_limited', detail: '429' }), {
    status: 429,
    provider: 'zcode'
  });
  assert.match(msg, /限流/);
});
