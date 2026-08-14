'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideTransientPoolRetry } = require('../lib/server/request-pool-retry-policy');

function eligible(overrides = {}) {
  return decideTransientPoolRetry({
    provider: 'agy',
    codeAssistProvider: true,
    pinnedAccount: false,
    retryUsed: false,
    responseStarted: false,
    attemptedAccountRefs: ['agy-1', 'agy-2'],
    pendingAccountRefs: ['agy-1', 'agy-2'],
    immediateFailureRecorded: false,
    elapsedMs: 1000,
    requestBudgetMs: 30_000,
    delayMs: 500,
    ...overrides
  });
}

test('allows one bounded retry only for a fully ambiguous Code Assist pool', () => {
  assert.deepEqual(eligible(), { retry: true, delayMs: 500, allowModelCooled: true });
});

test('rejects pinned, mixed-failure, partial-pool, streamed, and exhausted-budget requests', () => {
  assert.equal(eligible({ pinnedAccount: true }).retry, false);
  assert.equal(eligible({ immediateFailureRecorded: true }).retry, false);
  assert.equal(eligible({ pendingAccountRefs: ['agy-1'] }).retry, false);
  assert.equal(eligible({ responseStarted: true }).retry, false);
  assert.equal(eligible({ retryUsed: true }).retry, false);
  assert.equal(eligible({ elapsedMs: 29_800 }).retry, false);
});
