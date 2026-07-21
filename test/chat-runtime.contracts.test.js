'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAT_EVENT_SCHEMA,
  COMMAND_TYPES,
  EVENT_TYPES,
  EVENT_ENVELOPE_FIELDS,
  SESSION_STATES,
  SNAPSHOT_FIELDS,
  TIMELINE_KINDS,
  ChatRuntimeError,
  normalizeCommand,
  normalizeEvent,
  normalizeSnapshot,
  normalizeTimelineItem
} = require('../lib/server/chat-runtime/contracts');

test('chat runtime exposes the canonical v1 contract vocabulary', () => {
  assert.equal(CHAT_EVENT_SCHEMA, 'aih.chat.event.v1');
  assert.equal(COMMAND_TYPES.has('turn.submit'), true);
  assert.equal(COMMAND_TYPES.has('approval.decide'), true);
  assert.equal(EVENT_TYPES.has('timeline.item.started'), true);
  assert.equal(EVENT_TYPES.has('interaction.updated'), true);
  assert.equal(EVENT_TYPES.has('stream.error'), true);
  assert.equal(SESSION_STATES.has('waiting_input'), true);
  assert.equal(TIMELINE_KINDS.has('tool'), true);
  assert.equal(TIMELINE_KINDS.has('approval'), true);
  assert.deepEqual(EVENT_ENVELOPE_FIELDS, [
    'schema', 'eventId', 'sessionId', 'seq', 'type', 'at',
    'turnId', 'runId', 'itemId', 'source', 'payload'
  ]);
  assert.deepEqual(SNAPSHOT_FIELDS, [
    'sessionId', 'state', 'throughSeq', 'runtimeBinding',
    'capabilitySnapshot', 'activeTurn', 'policy', 'queue', 'interactions', 'timeline',
    'timelineHasMore', 'timelineNextBefore'
  ]);
});

test('normalizeCommand returns a detached canonical command', () => {
  const payload = {
    content: 'hello', model: ' gpt-5.3-codex ', reasoningEffort: ' high '
  };
  const command = normalizeCommand({
    commandId: ' cmd-1 ',
    sessionId: ' session-1 ',
    type: 'turn.submit',
    payload
  });

  assert.deepEqual(command, {
    commandId: 'cmd-1',
    sessionId: 'session-1',
    type: 'turn.submit',
    payload: { content: 'hello', model: 'gpt-5.3-codex', reasoningEffort: 'high' }
  });
  assert.notEqual(command.payload, payload);
});

test('turn submit rejects empty optional model controls', () => {
  for (const payload of [
    { content: 'hello', model: ' ' },
    { content: 'hello', reasoningEffort: '' }
  ]) {
    assert.throws(() => normalizeCommand({
      commandId: 'turn-invalid-model', sessionId: 'session-1',
      type: 'turn.submit', payload
    }), (error) => error.code === 'chat_turn_model_control_invalid');
  }
});

test('turn submit accepts session attachment identities and supports image-only turns', () => {
  const command = normalizeCommand({
    commandId: 'turn-images', sessionId: 'session-1', type: 'turn.submit',
    payload: { content: ' ', attachmentIds: [' attachment-1 ', 'attachment-2'] }
  });
  assert.deepEqual(command.payload, {
    content: '', attachmentIds: ['attachment-1', 'attachment-2']
  });
  assert.throws(() => normalizeCommand({
    commandId: 'turn-duplicate-image', sessionId: 'session-1', type: 'turn.submit',
    payload: { content: 'inspect', attachmentIds: ['attachment-1', 'attachment-1'] }
  }), (error) => error.code === 'chat_attachment_ids_duplicate');
  assert.throws(() => normalizeCommand({
    commandId: 'turn-empty', sessionId: 'session-1', type: 'turn.submit',
    payload: { content: '', attachmentIds: [] }
  }), (error) => error.code === 'chat_turn_content_required');
});

test('turn submit reserves run and turn identities for the server', () => {
  for (const key of ['runId', 'turnId']) {
    assert.throws(() => normalizeCommand({
      commandId: `turn-client-${key}`,
      sessionId: 'session-1',
      type: 'turn.submit',
      payload: { content: 'hello', [key]: 'caller-controlled-id' }
    }), (error) => (
      error.code === 'chat_turn_identity_client_controlled'
      && error.details.key === key
    ));
  }
});

test('normalizeCommand rejects unsupported commands with a typed error', () => {
  assert.throws(
    () => normalizeCommand({
      commandId: 'cmd-2',
      sessionId: 'session-1',
      type: 'provider.magic'
    }),
    (error) => {
      assert.equal(error instanceof ChatRuntimeError, true);
      assert.equal(error.code, 'unsupported_chat_command');
      assert.equal(error.statusCode, 422);
      return true;
    }
  );
});

test('command payload vocabulary rejects legacy steer and approval aliases', () => {
  assert.throws(() => normalizeCommand({
    commandId: 'command-1',
    sessionId: 'session-1',
    type: 'turn.intervene',
    payload: { mode: 'current', content: 'change' }
  }), (error) => error.code === 'invalid_turn_intervene_mode');
  assert.throws(() => normalizeCommand({
    commandId: 'command-2',
    sessionId: 'session-1',
    type: 'approval.decide',
    payload: { interactionId: 'approval-1', decision: 'approved' }
  }), (error) => error.code === 'approval_native_decision_not_allowed');
  assert.throws(() => normalizeCommand({
    commandId: 'command-legacy-approval',
    sessionId: 'session-1',
    type: 'approval.decide',
    payload: { interactionId: 'approval-1', decision: 'allow' }
  }), (error) => error.code === 'approval_native_decision_not_allowed');
  assert.throws(() => normalizeCommand({
    commandId: 'command-missing-interaction',
    sessionId: 'session-1',
    type: 'interaction.answer',
    payload: { revision: 1, answer: 'yes' }
  }), (error) => error.code === 'chat_interaction_id_required');
  assert.throws(() => normalizeCommand({
    commandId: 'command-missing-question-action',
    sessionId: 'session-1',
    type: 'interaction.answer',
    payload: { interactionId: 'question-1', revision: 1, answer: 'yes' }
  }), (error) => error.code === 'invalid_question_action');
  assert.throws(() => normalizeCommand({
    commandId: 'command-invalid-question-action',
    sessionId: 'session-1',
    type: 'interaction.answer',
    payload: { interactionId: 'question-1', revision: 1, action: 'accept' }
  }), (error) => error.code === 'invalid_question_action');

  const move = normalizeCommand({
    commandId: 'command-3',
    sessionId: 'session-1',
    type: 'queue.move',
    payload: { queueId: 'queue-1', beforeQueueId: 'queue-2' }
  });
  assert.deepEqual(move.payload, { queueId: 'queue-1', beforeQueueId: 'queue-2' });
});

test('canonical interaction commands preserve explicit actions and decision variants', () => {
  const question = normalizeCommand({
    commandId: 'question-command',
    sessionId: 'session-1',
    type: 'interaction.answer',
    payload: {
      interactionId: 'question-1', revision: 2, action: 'submit', answer: { target: 'web' }
    }
  });
  const permission = normalizeCommand({
    commandId: 'permission-command',
    sessionId: 'session-1',
    type: 'approval.decide',
    payload: {
      interactionId: 'permission-1', revision: 3,
      choiceId: 'choice-2'
    }
  });
  const amendment = normalizeCommand({
    commandId: 'execpolicy-command',
    sessionId: 'session-1',
    type: 'approval.decide',
    payload: {
      interactionId: 'command-approval-1', revision: 1,
      choiceId: 'choice-1'
    }
  });

  assert.deepEqual(question.payload, {
    interactionId: 'question-1', revision: 2, action: 'submit', answer: { target: 'web' }
  });
  assert.equal(permission.payload.choiceId, 'choice-2');
  assert.equal(amendment.payload.choiceId, 'choice-1');
  assert.throws(() => normalizeCommand({
    commandId: 'approval-native-decision-forbidden',
    sessionId: 'session-1',
    type: 'approval.decide',
    payload: {
      interactionId: 'permission-1', revision: 3,
      decision: { kind: 'accept' }
    }
  }), (error) => error.code === 'approval_native_decision_not_allowed');
  assert.throws(() => normalizeCommand({
    commandId: 'approval-choice-empty',
    sessionId: 'session-1',
    type: 'approval.decide',
    payload: {
      interactionId: 'permission-1', revision: 3,
      choiceId: ''
    }
  }), (error) => error.code === 'chat_approval_choice_id_required');
  assert.throws(() => normalizeCommand({
    commandId: 'approval-wire-field-forbidden',
    sessionId: 'session-1',
    type: 'approval.decide',
    payload: {
      interactionId: 'permission-1', revision: 3,
      choiceId: 'choice-0', nativeDecision: 'accept'
    }
  }), (error) => error.code === 'invalid_approval_command_payload');
});

test('normalizeEvent supplies the schema and validates typed timeline data', () => {
  const event = normalizeEvent({
    eventId: 'event-3',
    sessionId: 'session-1',
    seq: 3,
    type: 'timeline.item.started',
    turnId: 'turn-1',
    itemId: 'item-1',
    source: { provider: 'codex', runtimeId: 'runtime-1' },
    payload: {
      item: {
        id: 'item-1',
        kind: 'reasoning',
        createdAt: 123,
        status: 'running',
        content: 'checking',
        detail: {}
      }
    },
    at: 123
  });

  assert.deepEqual(event, {
    schema: CHAT_EVENT_SCHEMA,
    eventId: 'event-3',
    sessionId: 'session-1',
    seq: 3,
    type: 'timeline.item.started',
    at: 123,
    turnId: 'turn-1',
    itemId: 'item-1',
    source: { provider: 'codex', runtimeId: 'runtime-1' },
    payload: {
      item: {
        id: 'item-1',
        kind: 'reasoning',
        createdAt: 123,
        status: 'running',
        content: 'checking',
        detail: {}
      }
    }
  });
});

test('normalizeEvent closes timeline payloads and rejects conflicting turn identities', () => {
  const draft = {
    eventId: 'event-timeline-boundary',
    sessionId: 'session-1',
    seq: 1,
    type: 'timeline.item.completed',
    turnId: 'turn-1',
    itemId: 'item-1',
    source: { provider: 'codex', runtimeId: 'runtime-1' },
    payload: {
      providerTurnId: 'native-turn-1',
      item: {
        id: 'item-1',
        turnId: 'turn-1',
        kind: 'message',
        createdAt: 123,
        status: 'completed',
        content: 'done',
        detail: { role: 'assistant' }
      }
    },
    at: 123
  };

  assert.deepEqual(normalizeEvent(draft).payload, {
    item: draft.payload.item
  });
  assert.throws(
    () => normalizeEvent({
      ...draft,
      payload: {
        item: { ...draft.payload.item, turnId: 'native-turn-1' }
      }
    }),
    (error) => error.code === 'timeline_turn_id_mismatch'
  );
});

test('normalizeEvent preserves only canonical timeline delta detail', () => {
  const event = normalizeEvent({
    eventId: 'event-delta-boundary',
    sessionId: 'session-1',
    seq: 1,
    type: 'timeline.item.delta',
    turnId: 'turn-1',
    itemId: 'item-1',
    source: { provider: 'codex', runtimeId: 'runtime-1' },
    payload: {
      itemId: 'item-1',
      chunk: 'checking',
      detail: { channel: 'summary', index: 0, providerPrivate: true },
      providerTurnId: 'native-turn-1'
    },
    at: 123
  });

  assert.deepEqual(event.payload, {
    itemId: 'item-1',
    chunk: 'checking',
    detail: { channel: 'summary', index: 0 }
  });
  assert.throws(() => normalizeEvent({
    ...event,
    payload: {
      itemId: 'item-1',
      chunk: 'checking',
      detail: { channel: 'provider_private' }
    }
  }), (error) => error.code === 'unknown_timeline_delta_channel');
});

test('normalizeEvent fails closed for unknown event types', () => {
  assert.throws(
    () => normalizeEvent({
      eventId: 'event-1',
      sessionId: 'session-1',
      seq: 1,
      type: 'provider_private_delta',
      at: 123,
      source: { provider: 'codex', runtimeId: 'runtime-1' },
      payload: {}
    }),
    (error) => {
      assert.equal(error.code, 'unknown_chat_event_type');
      assert.equal(error.statusCode, 422);
      assert.deepEqual(error.details, { type: 'provider_private_delta' });
      return true;
    }
  );
});

test('transport-only events allow cursor zero without weakening stored events', () => {
  const transport = normalizeEvent({
    eventId: 'stream-error-1',
    sessionId: 'session-1',
    seq: 0,
    type: 'stream.error',
    at: 123,
    source: { provider: 'aih', runtimeId: 'chat-runtime' },
    payload: { code: 'stream_failed' }
  });
  assert.equal(transport.seq, 0);
  assert.throws(() => normalizeEvent({
    ...transport,
    type: 'turn.started'
  }), (error) => error.code === 'chat_event_seq_invalid');
});

test('normalizeTimelineItem rejects provider-private kinds', () => {
  assert.throws(() => normalizeTimelineItem({
    id: 'item-1',
    kind: 'provider_private_tool',
    createdAt: 123,
    status: 'running',
    detail: {}
  }), (error) => {
    assert.equal(error.code, 'unknown_timeline_kind');
    assert.equal(error.statusCode, 422);
    return true;
  });
});

test('normalizeTimelineItem rejects a detail shape that does not match its kind', () => {
  assert.throws(
    () => normalizeTimelineItem({
      id: 'shell-1',
      kind: 'shell',
      createdAt: 1,
      status: 'completed',
      detail: { input: { command: 'npm test' } }
    }),
    (error) => error.code === 'timeline_detail_invalid'
      && error.statusCode === 422
      && error.details.field === 'command'
  );
});

test('normalizeTimelineItem omits legacy null optional process details', () => {
  const shell = normalizeTimelineItem({
    id: 'shell-1',
    kind: 'shell',
    createdAt: 1,
    status: 'completed',
    detail: {
      command: 'npm test',
      output: null,
      exitCode: null,
      processId: null
    }
  });
  const tool = normalizeTimelineItem({
    id: 'tool-1',
    kind: 'tool',
    createdAt: 1,
    status: 'completed',
    detail: { name: 'view_image', exitCode: null }
  });

  assert.deepEqual(shell.detail, { command: 'npm test' });
  assert.deepEqual(tool.detail, { name: 'view_image' });
});

test('normalizeTimelineItem omits blank optional message metadata', () => {
  const message = normalizeTimelineItem({
    id: 'message-1',
    kind: 'message',
    createdAt: 1,
    status: 'completed',
    detail: { role: 'assistant', phase: ' ', model: '' }
  });

  assert.deepEqual(message.detail, { role: 'assistant' });
});

test('normalizeTimelineItem rejects invalid non-null optional process details', () => {
  const invalidDetails = [
    ['tool', { name: 'view_image', exitCode: '0' }],
    ['shell', { command: 'npm test', output: 1 }],
    ['shell', { command: 'npm test', exitCode: 0.5 }],
    ['shell', { command: 'npm test', processId: -1 }]
  ];

  for (const [kind, detail] of invalidDetails) {
    assert.throws(
      () => normalizeTimelineItem({
        id: `${kind}-1`, kind, createdAt: 1, status: 'completed', detail
      }),
      (error) => error.code === 'timeline_detail_invalid' && error.statusCode === 422
    );
  }
});

test('normalizeTimelineItem rejects non-canonical plan steps', () => {
  for (const steps of [
    ['legacy string step'],
    [{ step: 'future', status: 'future' }],
    [{ step: '', status: 'pending' }]
  ]) {
    assert.throws(
      () => normalizeTimelineItem({
        id: 'plan-1',
        kind: 'plan',
        createdAt: 1,
        status: 'running',
        detail: { steps }
      }),
      (error) => error.code === 'timeline_detail_invalid'
        && error.statusCode === 422
        && error.details.field === 'steps'
    );
  }
});

test('normalizeSnapshot guarantees reconnect-safe collections', () => {
  assert.deepEqual(normalizeSnapshot({
    sessionId: 'session-1',
    state: 'idle',
    throughSeq: 4
  }), {
    sessionId: 'session-1',
    state: 'idle',
    throughSeq: 4,
    policy: {},
    queue: [],
    interactions: [],
    timeline: [],
    timelineHasMore: false,
    timelineNextBefore: null
  });
});
