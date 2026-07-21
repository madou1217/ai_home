'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createNativeInteractionId
} = require('../lib/server/chat-runtime/native-interaction-id');

function identity(overrides = {}) {
  return {
    provider: 'codex',
    sessionId: 'session-1',
    nativeThreadId: 'thread-1',
    nativeRequestId: 'request-sensitive-7',
    ...overrides
  };
}

test('native interaction IDs are deterministic, opaque, and scoped by the full identity tuple', () => {
  const first = createNativeInteractionId(identity());

  assert.equal(createNativeInteractionId(identity()), first);
  assert.match(first, /^interaction-codex-[a-f0-9]{64}$/);
  assert.equal(first.includes('session-1'), false);
  assert.equal(first.includes('thread-1'), false);
  assert.equal(first.includes('request-sensitive-7'), false);

  for (const changed of [
    { provider: 'claude' },
    { sessionId: 'session-2' },
    { nativeThreadId: 'thread-2' },
    { nativeRequestId: '8' }
  ]) {
    assert.notEqual(createNativeInteractionId(identity(changed)), first);
  }
});

test('native interaction IDs cannot collide through delimiter-shaped tuple values', () => {
  assert.notEqual(
    createNativeInteractionId(identity({ sessionId: 'a:b', nativeThreadId: 'c' })),
    createNativeInteractionId(identity({ sessionId: 'a', nativeThreadId: 'b:c' }))
  );
});

test('native interaction IDs reject incomplete identity tuples', () => {
  for (const key of ['provider', 'sessionId', 'nativeThreadId', 'nativeRequestId']) {
    assert.throws(
      () => createNativeInteractionId(identity({ [key]: '' })),
      (error) => error.code === 'native_interaction_identity_incomplete'
    );
  }
});
