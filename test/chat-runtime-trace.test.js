'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHAT_RUNTIME_TRACE_STAGES,
  ChatRuntimeTrace
} = require('../lib/server/chat-runtime-trace');

test('chat runtime trace records the fixed latency stages once', () => {
  const trace = new ChatRuntimeTrace({
    provider: 'codex',
    sessionId: 'session-1',
    startedAt: 100
  }, {
    randomUUID: () => 'trace-1',
    now: () => 100
  });

  trace.mark('commandPersisted', { at: 120 });
  trace.mark('commandPersisted', { at: 140 });
  trace.mark('firstProviderEvent', { at: 180, runtimeId: 'runtime-1' });
  trace.mark('firstVisibleItem', { at: 190 });

  const snapshot = trace.snapshot();
  assert.equal(snapshot.traceId, 'trace-1');
  assert.deepEqual(snapshot.stages.map((item) => item.stage), [
    'requestAccepted',
    'commandPersisted',
    'firstProviderEvent',
    'firstVisibleItem'
  ]);
  assert.equal(snapshot.stages[1].at, 120);
  assert.equal(snapshot.durations.firstVisibleItemMs, 90);
  assert.equal(snapshot.durations.providerToVisibleMs, 10);
});

test('chat runtime trace exposes the complete stage contract', () => {
  assert.deepEqual(CHAT_RUNTIME_TRACE_STAGES, [
    'requestAccepted',
    'commandPersisted',
    'actorDequeued',
    'runtimeAcquired',
    'authReady',
    'sessionBound',
    'turnSubmitted',
    'firstProviderEvent',
    'firstVisibleItem',
    'firstTextDelta',
    'completed'
  ]);
});

test('chat runtime trace rejects unknown stages', () => {
  const trace = new ChatRuntimeTrace({}, { now: () => 1 });
  assert.throws(
    () => trace.mark('providerStarted', { at: 2 }),
    (error) => error && error.code === 'invalid_chat_runtime_trace_stage'
  );
});

test('chat runtime trace drops sensitive and unstructured attributes', () => {
  const trace = new ChatRuntimeTrace({
    provider: 'claude',
    prompt: 'secret prompt',
    apiKey: 'secret token',
    headers: { authorization: 'secret' },
    warm: true
  }, { now: () => 10 });

  trace.mark('completed', {
    at: 20,
    status: 'completed',
    messages: ['secret response'],
    token: 'secret token'
  });

  const serialized = JSON.stringify(trace.snapshot());
  assert.match(serialized, /claude/);
  assert.match(serialized, /completed/);
  assert.doesNotMatch(serialized, /secret/);
  assert.doesNotMatch(serialized, /prompt|apiKey|authorization|messages|token/);
});
