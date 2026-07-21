const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadProviderPendingPolicy() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'provider-pending-policy.js'
  )).href;
  return import(modulePath);
}

test('provider pending policy exposes provider-aware thinking text and external pending behavior', async () => {
  const {
    getThinkingStatusText,
    getProcessingStatusText,
    getGeneratingStatusText,
    createRetryCountdown,
    formatRetryCountdownStatus,
    formatRetryStatusText,
    formatStreamFailureText,
    getRetryCountdownDelayMs,
    shouldUseExternalPending,
    normalizePendingStatusText
  } = await loadProviderPendingPolicy();

  assert.equal(getThinkingStatusText('codex'), 'Codex 正在思考...');
  assert.equal(getThinkingStatusText('claude'), '正在思考...');
  assert.equal(getProcessingStatusText(), '正在处理...');
  assert.equal(getGeneratingStatusText(), '正在生成回复...');
  assert.equal(formatRetryStatusText({
    provider: 'claude', attempt: 2, maxAttempts: 10, retryAfterMs: 1079.7,
    status: 429, reason: 'rate_limit'
  }), 'Claude 请求受限，2 秒后重试（2/10）...');
  const countdown = createRetryCountdown({
    provider: 'claude', attempt: 8, maxAttempts: 10, retryAfterMs: 16_000,
    status: 429, reason: 'rate_limit'
  }, 'claude', 100_000);
  assert.deepEqual(countdown, {
    event: {
      provider: 'claude', attempt: 8, maxAttempts: 10, retryAfterMs: 16_000,
      status: 429, reason: 'rate_limit'
    },
    provider: 'claude',
    startedAt: 100_000,
    retryAt: 116_000
  });
  assert.equal(formatRetryCountdownStatus(countdown, 100_000),
    'Claude 请求受限，16 秒后重试（8/10）...');
  assert.equal(formatRetryCountdownStatus(countdown, 101_001),
    'Claude 请求受限，15 秒后重试（8/10）...');
  assert.equal(formatRetryCountdownStatus(countdown, 115_001),
    'Claude 请求受限，1 秒后重试（8/10）...');
  assert.equal(formatRetryCountdownStatus(countdown, 116_000),
    'Claude 请求受限，正在重试（8/10）...');
  assert.equal(getRetryCountdownDelayMs(countdown, 100_250), 750);
  assert.equal(getRetryCountdownDelayMs(countdown, 116_000), null);
  assert.equal(formatStreamFailureText({
    message: 'stream disconnected', retryable: true
  }, 'codex'), 'Codex 正在自动重试：stream disconnected');
  assert.equal(formatStreamFailureText({
    message: 'request rejected', retryable: false
  }, 'codex'), 'request rejected');
  assert.equal(shouldUseExternalPending('codex'), true);
  assert.equal(shouldUseExternalPending('claude'), true);
  assert.equal(shouldUseExternalPending('opencode'), true);
  assert.equal(shouldUseExternalPending('gemini'), false);
  assert.equal(normalizePendingStatusText('Codex 正在思考...', 'codex'), '正在思考中');
  assert.equal(normalizePendingStatusText('正在思考...', 'claude'), '正在思考中');
  assert.equal(normalizePendingStatusText('正在处理...', 'claude'), '正在处理');
});
