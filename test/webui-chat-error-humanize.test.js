const test = require('node:test');
const assert = require('node:assert/strict');

const { humanizeUpstreamError } = require('../lib/server/webui-chat-routes');

test('no_available_account 翻译成带模型名的可执行中文提示', () => {
  const raw = JSON.stringify({
    ok: false,
    error: 'no_available_account',
    detail: 'no available codex account can serve model gpt-5.5'
  });
  const msg = humanizeUpstreamError(raw, { status: 400, model: 'gpt-5.5', provider: 'codex' });
  assert.match(msg, /gpt-5\.5/);
  assert.match(msg, /账号/);
  // 绝不把原始 JSON / 错误码直接甩给用户
  assert.doesNotMatch(msg, /no_available_account/);
  assert.doesNotMatch(msg, /[{}]/);
});

test('account_not_configured 翻译成补全登录提示', () => {
  const msg = humanizeUpstreamError(JSON.stringify({ error: 'account_not_configured' }), {
    status: 400,
    provider: 'claude'
  });
  assert.match(msg, /尚未完成配置|补全/);
  assert.doesNotMatch(msg, /account_not_configured/);
});

test('missing_model 提示先选模型', () => {
  const msg = humanizeUpstreamError(JSON.stringify({ error: 'missing_model' }), { status: 400 });
  assert.match(msg, /选择一个模型/);
});

test('未知结构化错误退回 detail/message 文本', () => {
  const msg = humanizeUpstreamError(JSON.stringify({ error: 'weird', detail: '上游超时' }), { status: 502 });
  assert.equal(msg, '上游超时');
});

test('非 JSON 原始文本原样返回', () => {
  assert.equal(humanizeUpstreamError('Bad Gateway', { status: 502 }), 'Bad Gateway');
});

test('空错误体退回 HTTP 状态提示', () => {
  const msg = humanizeUpstreamError('', { status: 500 });
  assert.match(msg, /HTTP 500/);
});
