'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createClaudeRetryObserver,
  findHttpStatus
} = require('../lib/cli/services/pty/claude-retry-observer');

test('Claude retry observer parses split retry frames and deduplicates terminal redraws', () => {
  const events = [];
  const observer = createClaudeRetryObserver({ onRetry: (event) => events.push(event) });

  observer.observe('429 balance exhausted · Retry');
  observer.observe('ing in 3s · attempt 3/10');
  observer.observe('\r429 balance exhausted · Retrying in 3s · attempt 3/10\u001b[K');
  observer.observe('\r500 unavailable · Retrying in 1.5s · attempt 4/10\u001b[K');

  assert.deepEqual(events, [
    { attempt: 3, maxAttempts: 10, retryAfterMs: 3000, status: 429 },
    { attempt: 4, maxAttempts: 10, retryAfterMs: 1500, status: 500 }
  ]);
});

test('Claude retry observer reassembles split ANSI control sequences', () => {
  const events = [];
  const observer = createClaudeRetryObserver({ onRetry: (event) => events.push(event) });

  observer.observe('429 balance exhausted · Retrying\u001b[');
  observer.observe('31m in 9s · attempt 5/10\u001b[0m');

  assert.deepEqual(events, [
    { attempt: 5, maxAttempts: 10, retryAfterMs: 9000, status: 429 }
  ]);
});

test('Claude retry observer accepts TUI text separated only by cursor positioning', () => {
  const events = [];
  const observer = createClaudeRetryObserver({ onRetry: (event) => events.push(event) });

  observer.observe(
    '429\u001b[8G[1113]\u001b[16Gbalance exhausted\u001b[36G·\u001b[38GRetrying\u001b[47Gin\u001b[50G9s'
    + '\u001b[53G·\u001b[55Gattempt\u001b[63G5/10'
  );

  assert.deepEqual(events, [
    { attempt: 5, maxAttempts: 10, retryAfterMs: 9000, status: 429 }
  ]);
});

test('Claude retry observer follows in-place attempt updates without emitting countdown redraws', () => {
  const events = [];
  const observer = createClaudeRetryObserver({ onRetry: (event) => events.push(event) });

  observer.observe(
    '\u001b[H\r\u001b[17B✻\u001b[3GAPI error · Retrying\u001b[24Gin\u001b[27G1s'
    + '\u001b[30G·\u001b[32Gattempt\u001b[40G1/10'
  );
  observer.observe('\u001b[H\r\u001b[26C\u001b[17B0');
  observer.observe('\u001b[H\r\u001b[26C\u001b[17B2\u001b[40G2');
  observer.observe('\u001b[H\r\u001b[26C\u001b[17B1');

  assert.deepEqual(events, [
    { attempt: 1, maxAttempts: 10, retryAfterMs: 1000, status: undefined },
    { attempt: 2, maxAttempts: 10, retryAfterMs: 2000, status: undefined }
  ]);
});

test('Claude retry observer emits the same attempt numbers again for a later turn', () => {
  const events = [];
  const observer = createClaudeRetryObserver({ onRetry: (event) => events.push(event) });

  observer.observe('429 first turn · Retrying in 1s · attempt 1/10');
  observer.observe('\r429 first turn redraw · Retrying in 1s · attempt 1/10\u001b[K');
  observer.observe('\r429 first turn · Retrying in 2s · attempt 2/10\u001b[K');
  observer.observe('\r\u001b[K');
  observer.observe('429 second turn · Retrying in 1s · attempt 1/10');

  assert.deepEqual(events, [
    { attempt: 1, maxAttempts: 10, retryAfterMs: 1000, status: 429 },
    { attempt: 2, maxAttempts: 10, retryAfterMs: 2000, status: 429 },
    { attempt: 1, maxAttempts: 10, retryAfterMs: 1000, status: 429 }
  ]);
});

test('findHttpStatus returns only the nearest HTTP failure status', () => {
  assert.equal(findHttpStatus('attempt 3 status 429'), 429);
  assert.equal(findHttpStatus('wait 3 seconds'), undefined);
});
