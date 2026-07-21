import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSessionSnapshot, parseTimelineItem } from './snapshot-parser';
import type { ChatRuntimeCommand, TimelineItemKind } from './types';

const VALID_DETAILS: ReadonlyArray<readonly [TimelineItemKind, object]> = [
  ['message', { role: 'assistant', phase: 'final', model: 'gpt-5.3-codex' }],
  ['reasoning', { summary: 'short', segments: ['one', 'two'] }],
  ['plan', { state: 'proposed', steps: [
    { step: 'inspect', status: 'completed' },
    { step: 'change', status: 'in_progress' },
  ] }],
  ['tool', { name: 'view_image', callId: 'call-1', exitCode: 0, server: 'local' }],
  ['shell', { command: 'npm test', cwd: '/repo', output: 'ok', exitCode: 0, actions: [] }],
  ['diff', { paths: ['a.ts'], patch: '@@' }],
  ['file_change', { callId: 'call-2', changes: [{ path: 'a.ts' }], diff: '@@' }],
  ['terminal', { stream: 'stdout', terminalId: 'term-1', artifactId: 'artifact-1' }],
  ['question', { interactionId: 'question-1', options: ['yes'], answered: false }],
  ['approval', { interactionId: 'approval-1', action: 'write', decision: 'allow' }],
  ['subagent', { agentId: 'agent-1', state: 'running' }],
  ['command', { commandId: 'command-1', command: '/compact' }],
  ['attachment', { name: 'input.png', mimeType: 'image/png', url: '/artifact/input' }],
  ['artifact', { artifactId: 'artifact-1', name: 'result.txt', mimeType: 'text/plain', size: 2 }],
  ['notice', { level: 'warning' }],
  ['error', { code: 'failed', retryable: true }],
];

test('timeline parser validates every canonical detail kind', () => {
  VALID_DETAILS.forEach(([kind, detail], index) => {
    const item = parseTimelineItem({
      id: `item-${index}`, kind, status: 'completed', createdAt: index, detail,
    });
    assert.equal(item.kind, kind);
    assert.deepEqual(item.detail, detail);
  });
});

test('timeline parser rejects missing required detail fields and provider-private shapes', () => {
  const invalid = [
    ['message', {}], ['tool', {}], ['shell', { input: { command: 'pwd' } }],
    ['file_change', { path: 'a.ts', operation: 'update' }], ['question', {}],
    ['approval', { interactionId: 'approval-1' }], ['subagent', {}], ['command', {}],
    ['attachment', { name: 'a' }], ['artifact', { artifactId: 'a' }],
    ['notice', {}], ['error', {}],
  ];
  invalid.forEach(([kind, detail], index) => {
    assert.throws(() => parseTimelineItem({
      id: `invalid-${index}`, kind, status: 'completed', createdAt: index, detail,
    }), /chat_runtime_timeline_detail_/);
  });
});

test('snapshot parser freezes timeline cursors and stable capability maps', () => {
  const parsed = parseSessionSnapshot(snapshot({
    capabilitySnapshot: {
      revision: 'rev-1', capturedAt: 1,
      capabilities: {
        'mode.plan': { support: 'native' },
        'turn.interrupt': { support: 'native', alternatives: ['turn.stop'] },
        'turn.queue': { support: 'emulated' },
      },
      slashCommands: ['compact'],
      turnInterveneModes: ['steer_current'],
    },
  }), 'session-1');

  assert.equal(parsed.timelineHasMore, true);
  assert.equal(parsed.timelineNextBefore, 'item-1');
  assert.equal(parsed.capabilitySnapshot?.capabilities?.['turn.interrupt']?.support, 'native');
  assert.deepEqual(parsed.capabilitySnapshot?.slashCommands, ['compact']);
  assert.deepEqual(parsed.capabilitySnapshot?.turnInterveneModes, ['steer_current']);

  assert.throws(() => parseSessionSnapshot(snapshot({
    capabilitySnapshot: { interactions: ['approval'], turnInterveneModes: ['steer_current'] },
  }), 'session-1'), /chat_runtime_capabilities_shape_invalid/);
  assert.throws(() => parseSessionSnapshot({
    ...snapshot(), timelineHasMore: undefined,
  }, 'session-1'), /chat_runtime_snapshot_timeline_has_more_invalid/);
});

test('snapshot parser preserves canonical active turn recovery anchors', () => {
  const activeTurn = {
    turnId: 'turn-1', runId: 'run-1', clientUserMessageId: 'message-1',
    nativeTurnId: 'native-turn-1', state: 'running',
  };
  const parsed = parseSessionSnapshot(snapshot({
    state: 'running', activeTurn,
  }), 'session-1');
  assert.deepEqual(parsed.activeTurn, activeTurn);

  assert.throws(() => parseSessionSnapshot(snapshot({
    state: 'running', activeTurn: { ...activeTurn, nativeTurnId: 1 },
  }), 'session-1'), /chat_runtime_active_native_turn_id_invalid/);
});

test('snapshot parser validates the stable runtime binding fields', () => {
  const runtimeBinding = {
    provider: 'codex', runtimeId: 'codex:account-1', nativeSessionId: 'thread-1',
    fingerprint: 'fingerprint-1', version: '1.2.3', runtimeGeneration: 2,
  };
  const parsed = parseSessionSnapshot(snapshot({ runtimeBinding }), 'session-1');
  assert.deepEqual(parsed.runtimeBinding, runtimeBinding);
  assert.deepEqual(
    parseSessionSnapshot(snapshot({ runtimeBinding: {} }), 'session-1').runtimeBinding,
    {},
  );

  const invalid = [
    { runtimeId: 1 },
    { nativeSessionId: '' },
    { fingerprint: null },
    { version: {} },
    { provider: [] },
    { runtimeGeneration: 1.5 },
  ];
  invalid.forEach((runtimeBinding) => {
    assert.throws(
      () => parseSessionSnapshot(snapshot({ runtimeBinding }), 'session-1'),
      /chat_runtime_binding_/,
    );
  });
});

test('snapshot parser validates canonical question actions', () => {
  const actions = ['submit', 'decline', 'cancel'];
  const parsed = parseSessionSnapshot(snapshot({
    interactions: [questionInteraction(questionPayload({ actions }))],
  }), 'session-1');
  const [interaction] = parsed.interactions;

  assert.equal(interaction.kind, 'question');
  if (interaction.kind !== 'question') assert.fail('expected question interaction');
  assert.deepEqual(interaction.payload.actions, actions);
  assert.equal(interaction.payload.presentation.message, 'Continue?');
});

test('snapshot parser rejects missing, empty, and unknown question actions', () => {
  const invalidPayloads = [
    questionPayload({ actions: undefined }),
    questionPayload({ actions: [] }),
    questionPayload({ actions: ['submit', 'escape'] }),
  ];
  invalidPayloads.forEach((payload) => {
    assert.throws(
      () => parseSessionSnapshot(snapshot({
        interactions: [questionInteraction(payload)],
      }), 'session-1'),
      /chat_runtime_question_action/,
    );
  });
});

test('interaction answer command distinguishes submit from dismissal actions', () => {
  const identity = { interactionId: 'question-1', revision: 1 };
  const submit = answerCommand({ ...identity, action: 'submit', answer: { target: ['web'] } });
  const decline = answerCommand({ ...identity, action: 'decline' });
  const cancel = answerCommand({ ...identity, action: 'cancel' });
  assert.deepEqual([submit.payload.action, decline.payload.action, cancel.payload.action], [
    'submit', 'decline', 'cancel',
  ]);

  // @ts-expect-error submit requires an answer.
  const missingAnswer: ChatRuntimeCommand<'interaction.answer'> = answerCommand({
    ...identity, action: 'submit',
  });
  // @ts-expect-error decline must not carry an answer.
  const declinedAnswer: ChatRuntimeCommand<'interaction.answer'> = answerCommand({ ...identity, action: 'decline', answer: 'ignored' });
  void [missingAnswer, declinedAnswer];
});

function answerCommand(
  payload: ChatRuntimeCommand<'interaction.answer'>['payload'],
): ChatRuntimeCommand<'interaction.answer'> {
  return { commandId: 'command-1', sessionId: 'session-1', type: 'interaction.answer', payload };
}

function questionInteraction(payload: Record<string, unknown>) {
  return {
    interactionId: 'question-1', sessionId: 'session-1', itemId: 'item-1',
    kind: 'question', revision: 1, payload, state: 'pending', createdAt: 1, updatedAt: 1,
  };
}

function questionPayload(overrides: Record<string, unknown> = {}) {
  return {
    presentation: { title: 'Question', message: 'Continue?' },
    fields: [{
      id: 'target', label: 'Target', type: 'text', required: false,
      allowOther: false, secret: false,
    }],
    actions: ['submit'], answerShape: 'answers', confirmUnanswered: true,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1', state: 'idle', throughSeq: 0, policy: {},
    queue: [], interactions: [], timeline: [], timelineHasMore: true,
    timelineNextBefore: 'item-1', ...overrides,
  };
}
