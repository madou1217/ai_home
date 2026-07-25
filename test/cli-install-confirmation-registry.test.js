'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCliInstallConfirmationRegistry
} = require('../lib/server/cli-install-confirmation-registry');

test('cli install confirmation automatically confirms when countdown expires', async () => {
  let timerCallback = null;
  const registry = createCliInstallConfirmationRegistry({
    now: () => 1_000,
    randomUUID: () => 'confirmation-timeout',
    setTimeout(callback) {
      timerCallback = callback;
      return 1;
    },
    clearTimeout() {}
  });

  const confirmation = registry.create({ provider: 'claude', timeoutMs: 10_000 });
  assert.equal(confirmation.confirmationId, 'confirmation-timeout');
  assert.equal(confirmation.expiresAt, 11_000);
  assert.equal(registry.has(confirmation.confirmationId), true);

  timerCallback();
  assert.deepEqual(await confirmation.decision, {
    confirmationId: 'confirmation-timeout',
    provider: 'claude',
    decision: 'confirm',
    source: 'timeout',
    resolvedAt: 1_000
  });
  assert.equal(registry.has(confirmation.confirmationId), false);
});

test('cli install confirmation accepts only the first user decision', async () => {
  let clearedTimer = null;
  const registry = createCliInstallConfirmationRegistry({
    now: () => 2_000,
    randomUUID: () => 'confirmation-cancel',
    setTimeout() {
      return 7;
    },
    clearTimeout(timer) {
      clearedTimer = timer;
    }
  });
  const confirmation = registry.create({ provider: 'gemini' });

  const outcome = registry.decide(confirmation.confirmationId, 'cancel', 'user');
  assert.equal(outcome.decision, 'cancel');
  assert.equal(outcome.source, 'user');
  assert.equal(clearedTimer, 7);
  assert.equal(registry.decide(confirmation.confirmationId, 'confirm', 'user'), null);
  assert.equal((await confirmation.decision).decision, 'cancel');
});
