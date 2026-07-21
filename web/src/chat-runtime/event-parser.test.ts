import assert from 'node:assert/strict';
import test from 'node:test';

import { parseChatRuntimeEvent } from './event-parser';

test('event parser accepts the canonical schema and matching sequence', () => {
  const parsed = parseChatRuntimeEvent(JSON.stringify(event()), 'session-1');

  assert.equal(parsed.schema, 'aih.chat.event.v1');
  assert.equal(parsed.sessionId, 'session-1');
  assert.equal(parsed.seq, 3);
});

test('event parser rejects foreign schemas, sessions, and stored sequence zero', () => {
  const cases = [
    [{ ...event(), schema: 'provider.private.v1' }, 'chat_runtime_event_schema_invalid'],
    [{ ...event(), sessionId: 'session-2' }, 'chat_runtime_session_mismatch'],
    [{ ...event(), seq: 0 }, 'chat_runtime_event_seq_invalid'],
  ] as const;

  cases.forEach(([value, code]) => {
    assert.throws(() => parseChatRuntimeEvent(JSON.stringify(value), 'session-1'), new RegExp(code));
  });
});

test('snapshot reset validates the payload session and through sequence', () => {
  const reset = {
    ...event(),
    seq: 6,
    type: 'session.snapshot.reset',
    payload: snapshot('session-1', 6),
  };
  assert.equal(parseChatRuntimeEvent(JSON.stringify(reset), 'session-1').seq, 6);

  assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
    ...reset,
    payload: snapshot('session-2', 6),
  }), 'session-1'), /chat_runtime_session_mismatch/);

  assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
    ...reset,
    payload: snapshot('session-1', 7),
  }), 'session-1'), /chat_runtime_snapshot_cursor_mismatch/);
});

test('timeline delta preserves only the canonical channel descriptor', () => {
  const channels = ['summary', 'content', 'plan', 'output', 'diff', 'progress'] as const;

  channels.forEach((channel, index) => {
    const parsed = parseChatRuntimeEvent(JSON.stringify({
      ...event(),
      turnId: 'turn-1',
      type: 'timeline.item.delta',
      payload: { itemId: 'item-1', chunk: 'delta', detail: { channel, index } },
    }), 'session-1');
    assert.equal(parsed.type, 'timeline.item.delta');
    if (parsed.type !== 'timeline.item.delta') assert.fail('expected timeline delta');
    assert.deepEqual(parsed.payload.detail, { channel, index });
  });

  for (const detail of [
    { channel: 'provider_private' },
    { channel: 'summary', index: -1 },
    { channel: 'summary', index: '0' },
    { channel: 'summary', method: 'item/reasoning/textDelta' },
  ]) {
    assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
      ...event(),
      type: 'timeline.item.delta',
      payload: { itemId: 'item-1', chunk: 'delta', detail },
    }), 'session-1'), /chat_runtime_timeline_delta_detail_invalid/);
  }
});

test('timeline lifecycle and delta payloads reject provider-private fields', () => {
  const item = timelineItem('turn-1');
  const events = [
    {
      ...event(), type: 'timeline.item.delta',
      payload: { itemId: item.id, chunk: 'delta', providerTurnId: 'native-turn' },
    },
    ...(['timeline.item.started', 'timeline.item.updated', 'timeline.item.completed'] as const)
      .map((type) => ({
        ...event(), type, payload: { item, providerTurnId: 'native-turn' },
      })),
  ];

  events.forEach((input) => {
    assert.throws(
      () => parseChatRuntimeEvent(JSON.stringify(input), 'session-1'),
      /chat_runtime_timeline_payload_invalid/,
    );
  });
});

test('timeline lifecycle requires matching event and item turn identities', () => {
  const matching = parseChatRuntimeEvent(JSON.stringify({
    ...event(),
    turnId: 'turn-1',
    type: 'timeline.item.started',
    payload: { item: timelineItem('turn-1') },
  }), 'session-1');
  assert.equal(matching.type, 'timeline.item.started');

  assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
    ...event(),
    turnId: 'turn-1',
    type: 'timeline.item.started',
    payload: { item: timelineItem('native-turn') },
  }), 'session-1'), /chat_runtime_timeline_turn_mismatch/);
});

test('runtime capability events reject provider-private capability arrays', () => {
  const base = {
    ...event(),
    type: 'session.runtime.bound',
    payload: {
      capabilitySnapshot: {
        capabilities: { 'interaction.plan_confirmation': { support: 'emulated' } },
        slashCommands: ['compact'],
        turnInterveneModes: ['steer_current'],
      },
    },
  };
  assert.equal(
    parseChatRuntimeEvent(JSON.stringify(base), 'session-1').type,
    'session.runtime.bound',
  );
  assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
    ...base,
    payload: { capabilitySnapshot: { interactions: ['approval'] } },
  }), 'session-1'), /chat_runtime_capabilities_shape_invalid/);
});

test('runtime projection events share canonical runtime binding validation', () => {
  const runtimeBinding = {
    runtimeId: 'codex:account-1', nativeSessionId: 'thread-1',
    fingerprint: 'fingerprint-1', version: '1.2.3', runtimeGeneration: 2,
  };
  const parsed = parseChatRuntimeEvent(JSON.stringify({
    ...event(), type: 'runtime.prewarm.ready', payload: { runtimeBinding },
  }), 'session-1');
  assert.equal(parsed.type, 'runtime.prewarm.ready');
  if (parsed.type !== 'runtime.prewarm.ready') assert.fail('expected runtime ready');
  assert.deepEqual(parsed.payload.runtimeBinding, runtimeBinding);

  assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
    ...event(), type: 'session.runtime.bound',
    payload: { runtimeBinding: { runtimeGeneration: '2' } },
  }), 'session-1'), /chat_runtime_binding_generation_invalid/);
});

test('live question interactions share canonical action validation', () => {
  const actions = ['submit', 'decline', 'cancel'];
  const parsed = parseChatRuntimeEvent(
    JSON.stringify(interactionEvent(questionPayload({ actions }))),
    'session-1',
  );
  assert.equal(parsed.type, 'interaction.requested');
  if (parsed.type !== 'interaction.requested') assert.fail('expected question interaction');
  const interaction = parsed.payload.interaction;
  assert.equal(interaction.kind, 'question');
  if (interaction.kind !== 'question') assert.fail('expected question interaction');
  assert.deepEqual(interaction.payload.actions, actions);

  [
    questionPayload({ actions: undefined }),
    questionPayload({ actions: ['submit', 'escape'] }),
  ].forEach((payload) => {
    assert.throws(
      () => parseChatRuntimeEvent(JSON.stringify(interactionEvent(payload)), 'session-1'),
      /chat_runtime_question_action/,
    );
  });
});

test('interaction updates accept the canonical resolving state', () => {
  const source = interactionEvent(questionPayload());
  source.type = 'interaction.updated';
  source.payload.interaction.state = 'resolving';

  const parsed = parseChatRuntimeEvent(JSON.stringify(source), 'session-1');

  assert.equal(parsed.type, 'interaction.updated');
  if (parsed.type !== 'interaction.updated') assert.fail('expected interaction update');
  assert.equal(parsed.payload.interaction.state, 'resolving');
});

test('queue events reuse the complete canonical queue entry shape', () => {
  const entry = queueEntry();
  const parsed = parseChatRuntimeEvent(JSON.stringify({
    ...event(), type: 'queue.item.added', payload: { entry },
  }), 'session-1');
  assert.equal(parsed.type, 'queue.item.added');
  if (parsed.type !== 'queue.item.added') assert.fail('expected queue item');
  assert.deepEqual(parsed.payload.entry, entry);

  for (const field of ['commandId', 'position', 'policy', 'payload', 'status', 'createdAt', 'updatedAt']) {
    const malformed = { ...entry } as Record<string, unknown>;
    delete malformed[field];
    assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
      ...event(), type: 'queue.item.updated', payload: { entry: malformed },
    }), 'session-1'), /chat_runtime_queue_/);
  }
});

test('queue move validates its optional destination identity', () => {
  const moved = parseChatRuntimeEvent(JSON.stringify({
    ...event(), type: 'queue.item.moved',
    payload: { queueId: 'queue-1', beforeQueueId: 'queue-2' },
  }), 'session-1');
  assert.equal(moved.type, 'queue.item.moved');

  assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
    ...event(), type: 'queue.item.moved',
    payload: { queueId: 'queue-1', beforeQueueId: 2 },
  }), 'session-1'), /chat_runtime_queue_before_id_invalid/);
});

test('prewarm failure requires a canonical error code', () => {
  const failed = parseChatRuntimeEvent(JSON.stringify({
    ...event(), type: 'runtime.prewarm.failed', payload: { error: 'runtime_failed' },
  }), 'session-1');
  assert.equal(failed.type, 'runtime.prewarm.failed');

  for (const payload of [{}, { error: { code: 'runtime_failed' } }]) {
    assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
      ...event(), type: 'runtime.prewarm.failed', payload,
    }), 'session-1'), /chat_runtime_prewarm_error_invalid/);
  }
});

test('stream errors reject provider-private details and non-boolean retry flags', () => {
  const parsed = parseChatRuntimeEvent(JSON.stringify({
    ...event(), seq: 0, type: 'stream.error',
    payload: { error: 'runtime_failed', message: 'Runtime failed', retryable: false },
  }), 'session-1');
  assert.equal(parsed.type, 'stream.error');

  for (const payload of [
    { error: 'runtime_failed', message: 'Runtime failed', detail: { method: 'turn/start' } },
    { error: 'runtime_failed', message: 'Runtime failed', retryable: 'false' },
  ]) {
    assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
      ...event(), seq: 0, type: 'stream.error', payload,
    }), 'session-1'), /chat_runtime_stream_error_invalid/);
  }
});

test('recovery events accept their real canonical payloads without invented state', () => {
  const detached = parseChatRuntimeEvent(JSON.stringify({
    ...event(), turnId: 'turn-1', runId: 'run-1',
    type: 'run.detached', payload: { reason: 'server_restart' },
  }), 'session-1');
  const reattached = parseChatRuntimeEvent(JSON.stringify({
    ...event(), turnId: 'turn-1', runId: 'run-1',
    type: 'run.reattached', payload: { state: 'waiting_input' },
  }), 'session-1');
  const lost = parseChatRuntimeEvent(JSON.stringify({
    ...event(), turnId: 'turn-1', runId: 'run-1',
    type: 'run.lost', payload: { error: { code: 'native_run_lost' } },
  }), 'session-1');

  assert.equal(detached.type, 'run.detached');
  assert.equal(reattached.type, 'run.reattached');
  assert.equal(lost.type, 'run.lost');
  assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
    ...event(), type: 'run.detached', payload: {},
  }), 'session-1'), /chat_runtime_run_detached_reason_invalid/);
  assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
    ...event(), type: 'run.lost', payload: { error: 'lost' },
  }), 'session-1'), /chat_runtime_run_lost_error_invalid/);
});

test('live state events parse canonical active turn anchors', () => {
  const activeTurn = {
    turnId: 'turn-1', runId: 'run-1', clientUserMessageId: 'message-1',
    nativeTurnId: 'native-turn-1', state: 'running',
  };
  const parsed = parseChatRuntimeEvent(JSON.stringify({
    ...event(), payload: { state: 'running', activeTurn },
  }), 'session-1');
  assert.equal(parsed.type, 'turn.started');
  if (parsed.type !== 'turn.started') assert.fail('expected turn start');
  assert.deepEqual(parsed.payload.activeTurn, activeTurn);

  assert.throws(() => parseChatRuntimeEvent(JSON.stringify({
    ...event(), payload: {
      state: 'running', activeTurn: { ...activeTurn, clientUserMessageId: 1 },
    },
  }), 'session-1'), /chat_runtime_active_client_message_id_invalid/);

  const terminal = parseChatRuntimeEvent(JSON.stringify({
    ...event(), type: 'turn.completed', payload: { state: 'idle', activeTurn: null },
  }), 'session-1');
  assert.equal(terminal.type, 'turn.completed');
  if (terminal.type !== 'turn.completed') assert.fail('expected turn completion');
  assert.equal(terminal.payload.activeTurn, null);
});

function event() {
  return {
    schema: 'aih.chat.event.v1',
    eventId: 'event-3',
    sessionId: 'session-1',
    seq: 3,
    type: 'turn.started',
    at: 3,
    source: { provider: 'codex', runtimeId: 'runtime-1' },
    payload: {
      state: 'running',
      activeTurn: { turnId: 'turn-1', state: 'running' },
    },
  };
}

function interactionEvent(payload: Record<string, unknown>) {
  return {
    ...event(),
    type: 'interaction.requested',
    payload: {
      interaction: {
        interactionId: 'question-1', sessionId: 'session-1', itemId: 'item-1',
        kind: 'question', revision: 1, payload, state: 'pending', createdAt: 1, updatedAt: 1,
      },
    },
  };
}

function questionPayload(overrides: Record<string, unknown> = {}) {
  return {
    presentation: { title: 'Question' },
    fields: [{
      id: 'target', label: 'Target', type: 'text', required: false,
      allowOther: false, secret: false,
    }],
    actions: ['submit'], answerShape: 'answers', confirmUnanswered: true,
    ...overrides,
  };
}

function queueEntry() {
  return {
    queueId: 'queue-1', sessionId: 'session-1', commandId: 'command-1', position: 0,
    policy: 'after_turn', payload: { content: 'next' }, status: 'queued',
    createdAt: 1, updatedAt: 2,
  };
}

function timelineItem(turnId: string) {
  return {
    id: 'item-1', turnId, kind: 'message', createdAt: 1, status: 'running',
    content: 'hello', detail: { role: 'assistant' },
  };
}

function snapshot(sessionId: string, throughSeq: number) {
  return {
    sessionId,
    state: 'idle',
    throughSeq,
    policy: {},
    queue: [],
    interactions: [],
    timeline: [],
    timelineHasMore: false,
    timelineNextBefore: null,
  };
}
