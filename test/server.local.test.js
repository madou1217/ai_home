const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRetriableLocalError,
  getLocalFailureCooldownMs
} = require('../lib/server/local');

test('local errors: usage limit is not retriable', () => {
  const msg = 'ERROR: You\'ve hit your usage limit. Upgrade to Plus to continue using Codex.';
  assert.equal(isRetriableLocalError(msg), false);
});

test('local errors: timeout remains retriable', () => {
  assert.equal(isRetriableLocalError('codex_exec_timeout'), true);
});

test('local failure cooldown: usage limit gets long cooldown', () => {
  const base = 60_000;
  const msg = 'ERROR: You\'ve hit your usage limit. Upgrade to Plus to continue using Codex.';
  const cooldownMs = getLocalFailureCooldownMs(msg, base);
  assert.equal(cooldownMs >= 24 * 60 * 60 * 1000, true);
});

test('local failure cooldown: parse try-again timestamp when present', () => {
  const futureMs = Date.now() + 2 * 60 * 60 * 1000;
  const dateText = new Date(futureMs).toUTCString();
  const msg = `ERROR: You've hit your usage limit. try again at ${dateText}.`;
  const cooldownMs = getLocalFailureCooldownMs(msg, 60_000);
  assert.equal(cooldownMs > 60_000, true);
});
