'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ChatRuntimeEventHub } = require('../lib/server/chat-runtime-event-hub');

test('chat runtime event hub publishes only to the matching session', () => {
  const hub = new ChatRuntimeEventHub();
  const received = [];
  hub.subscribe('session-1', (event) => received.push(event));
  hub.publish({ sessionId: 'session-2', seq: 1 });
  hub.publish({ sessionId: 'session-1', seq: 2 });

  assert.deepEqual(received, [{ sessionId: 'session-1', seq: 2 }]);
  assert.equal(hub.listenerCount('session-1'), 1);
});

test('chat runtime event hub isolates listener failures', () => {
  const hub = new ChatRuntimeEventHub();
  let healthyCalls = 0;
  hub.subscribe('session-1', () => {
    throw new Error('listener failed');
  });
  hub.subscribe('session-1', () => {
    healthyCalls += 1;
  });

  assert.equal(hub.publish({ sessionId: 'session-1', seq: 1 }), 2);
  assert.equal(healthyCalls, 1);
});

test('chat runtime event hub unsubscribe is idempotent', () => {
  const hub = new ChatRuntimeEventHub();
  let calls = 0;
  const unsubscribe = hub.subscribe('session-1', () => {
    calls += 1;
  });

  unsubscribe();
  unsubscribe();
  hub.publish({ sessionId: 'session-1', seq: 1 });

  assert.equal(calls, 0);
  assert.equal(hub.listenerCount('session-1'), 0);
});

test('chat runtime event hub rejects events without a session id', () => {
  const hub = new ChatRuntimeEventHub();
  assert.throws(
    () => hub.publish({ seq: 1 }),
    (error) => error && error.code === 'chat_runtime_event_session_required'
  );
});
