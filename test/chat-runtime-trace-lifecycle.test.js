'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ChatRuntimeTraceLifecycle
} = require('../lib/server/chat-runtime-trace-lifecycle');

test('turn trace remains active through provider visibility and terminal settlement', () => {
  const emitted = [];
  const traces = [];
  const lifecycle = new ChatRuntimeTraceLifecycle({
    traceFactory: () => {
      const trace = createTrace();
      traces.push(trace);
      return trace;
    },
    traceSink: (snapshot) => emitted.push(snapshot)
  });
  const trace = lifecycle.start({
    commandId: 'command-1', provider: 'codex', sessionId: 'session-1'
  });

  lifecycle.markCommandPersisted('command-1');
  trace.bindRun('run-1');
  trace.mark('turnSubmitted');
  trace.observeProviderEvent({
    type: 'timeline.item.started', runId: 'run-1',
    payload: { item: { kind: 'message', detail: { role: 'assistant' } } }
  });
  trace.observeProviderEvent({
    type: 'timeline.item.delta', runId: 'run-1',
    payload: { itemId: 'message-1', chunk: 'hello' }
  });

  assert.equal(emitted.length, 0);
  assert.deepEqual(traces[0].snapshot().marks, [
    'commandPersisted', 'turnSubmitted', 'firstProviderEvent'
  ]);
  lifecycle.observePublishedEvent({
    type: 'timeline.item.started', runId: 'run-1',
    payload: { item: { kind: 'message', detail: { role: 'assistant' } } }
  });
  lifecycle.observePublishedEvent({
    type: 'timeline.item.delta', runId: 'run-1',
    payload: { itemId: 'message-1', chunk: 'hello' }
  });
  lifecycle.observePublishedEvent({
    type: 'turn.completed', runId: 'run-1', payload: { state: 'idle' }
  });
  lifecycle.observePublishedEvent({
    type: 'turn.completed', runId: 'run-1', payload: { state: 'idle' }
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].runId, 'run-1');
  assert.deepEqual(emitted[0].marks, [
    'commandPersisted',
    'turnSubmitted',
    'firstProviderEvent',
    'firstVisibleItem',
    'firstTextDelta',
    'completed'
  ]);
});

test('non-turn and failed command traces finish without a run binding', () => {
  const emitted = [];
  const lifecycle = new ChatRuntimeTraceLifecycle({
    traceFactory: () => createTrace(),
    traceSink: (snapshot) => emitted.push(snapshot)
  });
  const completed = lifecycle.start({ commandId: 'prewarm-1' });
  const failed = lifecycle.start({ commandId: 'prewarm-2' });

  completed.finish({ status: 'completed' });
  failed.finish({ status: 'failed', errorCode: 'runtime_unavailable' });

  assert.deepEqual(emitted.map((snapshot) => snapshot.details), [
    { status: 'completed' },
    { status: 'failed', errorCode: 'runtime_unavailable' }
  ]);
});

function createTrace() {
  const marks = [];
  let completedDetails = null;
  return {
    mark(stage, details = {}) {
      if (!marks.includes(stage)) marks.push(stage);
      if (stage === 'completed') completedDetails = details;
    },
    snapshot() {
      return { marks: [...marks], details: completedDetails };
    }
  };
}
