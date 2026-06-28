'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ackSessionEvents,
  applyEventSeq,
  clearSessionEventAcks,
  getSessionEventAck,
  normalizeSessionAckPayload
} = require('../lib/server/control-plane-device-session-event-store');
const {
  appendNativeChatRunEvent,
  readNativeChatRunEvents,
  registerNativeChatRun,
  unregisterNativeChatRun
} = require('../lib/server/native-chat-run-store');

test('session event seq is derived from cursor without duplicating resume windows', () => {
  const events = applyEventSeq([
    { type: 'assistant_text', text: 'one' },
    { cursor: '9', type: 'assistant_text', text: 'two' },
    { seq: '10', type: 'assistant_text', text: 'three' }
  ], 10);

  assert.deepEqual(events.map((event) => [event.seq, event.cursor, event.text]), [
    [8, 8, 'one'],
    [9, 9, 'two'],
    [10, 10, 'three']
  ]);
});

test('session ack payload accepts session refs and consumer ids', () => {
  assert.deepEqual(normalizeSessionAckPayload({
    sessionRef: 'sess_0123456789abcdefabcd',
    seq: 12,
    clientId: 'phone'
  }), {
    sessionId: 'sess_0123456789abcdefabcd',
    cursor: 12,
    consumerId: 'phone'
  });
});

test('session ack payload preserves explicit zero cursor', () => {
  assert.deepEqual(normalizeSessionAckPayload({
    sessionId: 'run-zero-cursor',
    cursor: 0,
    seq: 12,
    consumerId: 'phone'
  }), {
    sessionId: 'run-zero-cursor',
    cursor: 0,
    consumerId: 'phone'
  });
});

test('session event ack store keeps the highest cursor per consumer', () => {
  clearSessionEventAcks();

  const first = ackSessionEvents({
    sessionId: 'run-ack-1',
    cursor: 7,
    consumerId: 'phone'
  }, { nowMs: 1000 });
  const stale = ackSessionEvents({
    sessionId: 'run-ack-1',
    cursor: 3,
    consumerId: 'phone'
  }, { nowMs: 2000 });

  assert.deepEqual(first, {
    accepted: true,
    sessionId: 'run-ack-1',
    consumerId: 'phone',
    cursor: 7,
    ackedAt: 1000
  });
  assert.deepEqual(stale, {
    accepted: true,
    sessionId: 'run-ack-1',
    consumerId: 'phone',
    cursor: 7,
    ackedAt: 1000,
    stale: true
  });
  assert.deepEqual(getSessionEventAck('run-ack-1', 'phone'), first);
});

test('native chat run events expose seq and resume after cursor without duplication', () => {
  const runId = 'run-event-seq-1';
  registerNativeChatRun({
    runId,
    provider: 'codex',
    events: []
  });
  try {
    appendNativeChatRunEvent(runId, { type: 'assistant_text', text: 'one' });
    appendNativeChatRunEvent(runId, { type: 'assistant_text', text: 'two' });

    const first = readNativeChatRunEvents(runId, { cursor: 0, limit: 10 });
    assert.deepEqual(first.events.map((event) => [event.seq, event.cursor, event.text]), [
      [1, 1, 'one'],
      [2, 2, 'two']
    ]);

    const resumed = readNativeChatRunEvents(runId, { cursor: 1, limit: 10 });
    assert.deepEqual(resumed.events.map((event) => [event.seq, event.cursor, event.text]), [
      [2, 2, 'two']
    ]);
    assert.equal(resumed.cursor, 2);
  } finally {
    unregisterNativeChatRun(runId);
  }
});
