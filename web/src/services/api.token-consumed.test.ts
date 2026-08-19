import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchAccountsWatchPayload } from './api.ts';

test('dispatchAccountsWatchPayload routes token-consumed events to onTokenConsumed', () => {
  const received: any[] = [];
  dispatchAccountsWatchPayload({
    type: 'token-consumed',
    provider: 'codex',
    accountRef: 'acct_live_1',
    model: 'gpt-5.6-terra',
    tokens: { input: 100, output: 50, total: 150 },
    occurredAt: 12_345
  }, {
    onTokenConsumed: (event) => received.push(event)
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].provider, 'codex');
  assert.equal(received[0].accountRef, 'acct_live_1');
  assert.equal(received[0].model, 'gpt-5.6-terra');
  assert.deepEqual(received[0].tokens, { input: 100, output: 50, total: 150 });
  assert.equal(received[0].occurredAt, 12_345);
});

test('dispatchAccountsWatchPayload ignores token-consumed without accountRef', () => {
  const received: any[] = [];
  dispatchAccountsWatchPayload({
    type: 'token-consumed',
    tokens: { total: 100 }
  }, {
    onTokenConsumed: (event) => received.push(event)
  });

  assert.equal(received.length, 0);
});

test('dispatchAccountsWatchPayload normalizes malformed token-consumed tokens to zero', () => {
  const received: any[] = [];
  dispatchAccountsWatchPayload({
    type: 'token-consumed',
    provider: 'codex',
    accountRef: 'acct_live_2',
    tokens: null
  }, {
    onTokenConsumed: (event) => received.push(event)
  });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0].tokens, { input: 0, output: 0, total: 0 });
});