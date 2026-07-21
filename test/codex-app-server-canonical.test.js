'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { EVENT_TYPES, normalizeEvent } = require('../lib/server/chat-runtime/contracts');
const {
  mapCodexAppServerMessage: mapNativeMessage
} = require('../lib/server/codex-app-server-canonical');
const {
  createNativeInteractionId
} = require('../lib/server/chat-runtime/native-interaction-id');

const SESSION_ID = 'session-1';

function mapCodexAppServerMessage(value) {
  return mapNativeMessage(value, { sessionId: SESSION_ID });
}

function interactionId(requestId, threadId = 'thread-1') {
  return createNativeInteractionId({
    provider: 'codex',
    sessionId: SESSION_ID,
    nativeThreadId: threadId,
    nativeRequestId: String(requestId)
  });
}

function message(method, params, id) {
  const value = { jsonrpc: '2.0', method, params };
  if (id !== undefined) value.id = id;
  return value;
}

test('maps every terminal Codex turn status to the canonical lifecycle', () => {
  const cases = [
    ['completed', 'turn.completed'],
    ['failed', 'turn.failed'],
    ['interrupted', 'turn.interrupted']
  ];
  const started = mapCodexAppServerMessage(message('turn/started', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'inProgress', startedAt: 10 }
  }));

  assert.deepEqual(started, {
    type: 'turn.started',
    turnId: 'turn-1',
    payload: { threadId: 'thread-1', status: 'inProgress', startedAt: 10 }
  });
  for (const [status, type] of cases) {
    const event = mapCodexAppServerMessage(message('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1', status, error: status === 'failed' ? { message: 'boom' } : null,
        startedAt: 10, completedAt: 12, durationMs: 2000
      }
    }));
    assert.equal(event.type, type);
    assert.equal(event.turnId, 'turn-1');
    assert.equal(event.payload.status, status);
    assert.deepEqual(event.payload.error, status === 'failed'
      ? { code: 'codex_turn_failed', message: 'boom' }
      : null);
    assert.equal(EVENT_TYPES.has(event.type), true);
  }
});

test('redacts native provider diagnostics before canonical events leave the adapter', () => {
  const turn = mapCodexAppServerMessage(message('turn/completed', {
    threadId: 'thread-1',
    turn: {
      id: 'turn-1', status: 'failed',
      error: {
        code: 'codex_model_rejected',
        message: 'Authorization: Bearer native-turn-secret',
        details: { accessToken: 'nested-native-secret' }
      }
    }
  }));
  const stream = mapCodexAppServerMessage(message('error', {
    message: 'X-API-Key=stream-native-secret upstream unavailable'
  }));

  assert.deepEqual(turn.payload.error, {
    code: 'codex_model_rejected',
    message: 'Authorization: Bearer [redacted]'
  });
  assert.deepEqual(stream, {
    type: 'stream.error',
    payload: {
      error: 'codex_app_server_error',
      message: 'X-API-Key=[redacted] upstream unavailable',
      retryable: false
    }
  });
  assert.doesNotMatch(
    JSON.stringify([turn, stream]),
    /native-turn-secret|nested-native-secret|stream-native-secret/
  );
});

test('maps Codex retry notifications from their native nested error shape', () => {
  const retrying = mapCodexAppServerMessage(message('error', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    error: {
      message: 'Authorization: Bearer native-retry-secret; upstream unavailable',
      codexErrorInfo: { type: 'response_too_large' },
      additionalDetails: { accessToken: 'must-not-leak' }
    },
    willRetry: true
  }));
  const terminal = mapCodexAppServerMessage(message('error', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    error: { message: 'request rejected' },
    willRetry: false
  }));

  assert.deepEqual(retrying, {
    type: 'stream.error',
    payload: {
      error: 'codex_app_server_error',
      message: 'Authorization: Bearer [redacted]; upstream unavailable',
      retryable: true
    }
  });
  assert.deepEqual(terminal, {
    type: 'stream.error',
    payload: {
      error: 'codex_app_server_error',
      message: 'request rejected',
      retryable: false
    }
  });
  assert.doesNotMatch(JSON.stringify(retrying), /native-retry-secret|must-not-leak|codexErrorInfo/);
});

test('maps assistant and reasoning deltas without marker strings', () => {
  const assistant = mapCodexAppServerMessage(message('item/agentMessage/delta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'hello'
  }));
  const reasoning = mapCodexAppServerMessage(message('item/reasoning/textDelta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1',
    delta: 'check', contentIndex: 2
  }));

  assert.deepEqual(assistant, {
    type: 'timeline.item.delta', turnId: 'turn-1', itemId: 'msg-1',
    payload: { itemId: 'msg-1', chunk: 'hello' }
  });
  assert.deepEqual(reasoning, {
    type: 'timeline.item.delta', turnId: 'turn-1', itemId: 'reason-1',
    payload: { itemId: 'reason-1', chunk: 'check', detail: { channel: 'content', index: 2 } }
  });
  assert.doesNotMatch(JSON.stringify([assistant, reasoning]), /:::tool/);
});

test('maps current MCP progress and turn diff notifications to typed timeline events', () => {
  const progress = mapCodexAppServerMessage(message('item/mcpToolCall/progress', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'mcp-1',
    message: 'Reading documentation', delta: 'deprecated-field'
  }));
  const diff = mapCodexAppServerMessage(message('turn/diff/updated', {
    threadId: 'thread-1', turnId: 'turn-1', diff: 'diff --git a/a.js b/a.js\n'
  }));

  assert.equal(progress.payload.chunk, 'Reading documentation');
  assert.deepEqual(progress.payload.detail, { channel: 'progress' });
  assert.equal(diff.type, 'timeline.item.updated');
  assert.equal(diff.itemId, 'codex-diff:turn-1');
  assert.equal(diff.payload.item.kind, 'diff');
  assert.equal(diff.payload.item.turnId, 'turn-1');
  assert.equal(diff.payload.item.detail.patch, 'diff --git a/a.js b/a.js\n');
});

test('maps completed messages, shell commands, file changes and generic tools to typed items', () => {
  const fixtures = [
    [{ type: 'agentMessage', id: 'msg-1', text: 'done', phase: 'final_answer' }, 'message'],
    [{
      type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd: '/repo',
      status: 'completed', aggregatedOutput: 'ok', exitCode: 0
    }, 'shell'],
    [{
      type: 'fileChange', id: 'patch-1', status: 'completed',
      changes: [{ path: 'a.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }]
    }, 'file_change'],
    [{
      type: 'mcpToolCall', id: 'tool-1', server: 'docs', tool: 'search',
      status: 'failed', arguments: { q: 'api' }, error: { message: 'offline' }
    }, 'tool']
  ];

  for (const [item, kind] of fixtures) {
    const event = mapCodexAppServerMessage(message('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 123, item
    }));
    assert.equal(event.type, 'timeline.item.completed');
    assert.equal(event.payload.item.kind, kind);
    assert.equal(event.payload.item.id, item.id);
    assert.equal(EVENT_TYPES.has(event.type), true);
  }

  const shell = mapCodexAppServerMessage(message('item/completed', {
    turnId: 'turn-1', completedAtMs: 123,
    item: fixtures[1][0]
  })).payload.item;
  assert.equal(shell.detail.command, 'npm test');
  assert.equal(shell.detail.cwd, '/repo');
  assert.equal(shell.detail.output, 'ok');
  assert.equal(shell.detail.exitCode, 0);
  assert.equal(shell.detail.callId, 'cmd-1');
  assert.equal(Object.hasOwn(shell.detail, 'processId'), false);

  const file = mapCodexAppServerMessage(message('item/completed', {
    turnId: 'turn-1', completedAtMs: 123,
    item: fixtures[2][0]
  })).payload.item;
  assert.equal(file.detail.diff, '@@ -1 +1 @@');

  const tool = mapCodexAppServerMessage(message('item/completed', {
    turnId: 'turn-1', completedAtMs: 123,
    item: fixtures[3][0]
  })).payload.item;
  assert.equal(tool.status, 'failed');
  assert.equal(tool.detail.callId, 'tool-1');
  assert.deepEqual(tool.detail.input, { q: 'api' });
  assert.deepEqual(tool.detail.result, { message: 'offline' });
  assert.equal(Object.hasOwn(tool.detail, 'exitCode'), false);
});

test('maps command and file approvals to pending canonical interactions', () => {
  const command = mapCodexAppServerMessage(message(
    'item/commandExecution/requestApproval',
    {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', approvalId: 'callback-1',
      startedAtMs: 123, environmentId: 'environment-1',
      command: 'rm out.txt', cwd: '/repo',
      commandActions: [{ type: 'delete', path: 'out.txt' }],
      networkApprovalContext: { host: 'example.com' },
      additionalPermissions: { network: { enabled: true } },
      proposedExecpolicyAmendment: ['rm', 'out.txt'],
      proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }],
      availableDecisions: ['accept', 'decline']
    },
    0
  ));
  const file = mapCodexAppServerMessage(message(
    'item/fileChange/requestApproval',
    {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'patch-1',
      startedAtMs: 456, reason: 'write', grantRoot: '/repo'
    },
    'request-2'
  ));

  assert.equal(command.type, 'interaction.requested');
  assert.equal(command.payload.interaction.kind, 'approval');
  assert.equal(command.payload.interaction.interactionId, interactionId(0));
  assert.deepEqual(command.payload.interaction.payload.presentation, {
    title: 'Run command?',
    detail: 'rm out.txt',
    annotations: [
      { label: 'Working directory', value: '/repo' },
      { label: 'Environment', value: 'environment-1' }
    ]
  });
  assert.deepEqual(command.payload.interaction.payload.choices, [
    { id: 'choice-0', label: 'Allow once', intent: 'accept' },
    { id: 'choice-1', label: 'Decline and continue', intent: 'deny' }
  ]);
  assert.deepEqual(file.payload.interaction.payload.presentation, {
    title: 'Apply file changes?',
    description: 'write',
    annotations: [{ label: 'Requested root', value: '/repo' }]
  });
  assert.equal(file.payload.interaction.payload.choices.length, 4);
  assert.doesNotMatch(
    JSON.stringify([command, file]),
    /requestId|threadId|availableDecisions|grantRoot|commandActions/
  );
});

test('maps permissions approval using only the public permission profile', () => {
  const permissions = {
    network: { enabled: true },
    fileSystem: { read: ['/repo'], write: ['/repo/output'] }
  };
  const event = mapCodexAppServerMessage(message(
    'item/permissions/requestApproval',
    {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'permissions-1',
      environmentId: 'environment-1', startedAtMs: 123, cwd: '/repo',
      reason: 'Allow the requested workspace access', permissions
    },
    21
  ));

  assert.equal(event.payload.interaction.interactionId, interactionId(21));
  assert.deepEqual(event.payload.interaction.payload.presentation, {
    title: 'Grant permissions?',
    description: 'Allow the requested workspace access',
    detail: JSON.stringify(permissions, null, 2),
    annotations: [
      { label: 'Working directory', value: '/repo' },
      { label: 'Environment', value: 'environment-1' }
    ]
  });
  assert.deepEqual(
    event.payload.interaction.payload.choices.map(({ intent }) => intent),
    ['accept', 'accept', 'accept', 'deny']
  );
  assert.doesNotMatch(
    JSON.stringify(event),
    /requestId|threadId|"permissions"\s*:|"method"\s*:/
  );
});

test('maps MCP form elicitation to a canonical question without private metadata', () => {
  const requestedSchema = {
    type: 'object',
    properties: { email: { type: 'string', format: 'email' } },
    required: ['email']
  };
  const event = mapCodexAppServerMessage(message(
    'mcpServer/elicitation/request',
    {
      threadId: 'thread-1', turnId: 'turn-1', serverName: 'accounts',
      mode: 'form', message: 'Which account should be used?', requestedSchema,
      _meta: { privateToken: 'must-not-leak' }
    },
    'elicitation-1'
  ));

  assert.deepEqual(event.payload.interaction.payload, {
    presentation: {
      title: 'Input required',
      message: 'Which account should be used?'
    },
    fields: [{
      id: 'email', label: 'email', type: 'text', required: true,
      allowOther: false, secret: false
    }],
    actions: ['submit', 'decline', 'cancel'],
    answerShape: 'object',
    confirmUnanswered: false
  });
  assert.doesNotMatch(
    JSON.stringify(event),
    /accounts|privateToken|must-not-leak|requestedSchema|requestId|threadId/
  );
});

test('maps question requests, request resolution and unknown methods observably', () => {
  const question = mapCodexAppServerMessage(message('item/tool/requestUserInput', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'question-1',
    questions: [{ id: 'choice', question: 'Continue?' }], autoResolutionMs: null
  }, 3));
  const resolved = mapCodexAppServerMessage(message('serverRequest/resolved', {
    threadId: 'thread-1', requestId: 3
  }));
  const unknown = mapCodexAppServerMessage(message('future/event', {
    value: 42,
    token: 'must-not-leak'
  }));

  assert.equal(question.type, 'interaction.requested');
  assert.equal(question.payload.interaction.kind, 'question');
  assert.deepEqual(question.payload.interaction.payload.actions, ['submit']);
  assert.deepEqual(question.payload.interaction.payload.fields, [
    {
      id: 'choice', label: 'Continue?', type: 'text', required: false,
      allowOther: false, secret: false
    }
  ]);
  assert.deepEqual(resolved, {
    type: 'interaction.resolved',
    payload: { interactionId: interactionId(3) }
  });
  assert.equal(unknown.type, 'stream.error');
  assert.deepEqual(unknown.payload, {
    error: 'unsupported_codex_app_server_method',
    message: 'Unsupported Codex app-server event',
    retryable: false
  });
  assert.doesNotMatch(
    JSON.stringify(unknown),
    /future\/event|must-not-leak|"method"\s*:|"paramKeys"\s*:/
  );
});

test('classifies known Codex notifications as exact no-op results', () => {
  const methods = [
    'mcpServer/startupStatus/updated',
    'thread/goal/cleared',
    'thread/settings/updated',
    'thread/status/changed',
    'thread/tokenUsage/updated',
    'item/reasoning/summaryPartAdded',
  ];

  for (const method of methods) {
    assert.deepEqual(
      mapCodexAppServerMessage(message(method, { providerPrivate: 'not-canonical' })),
      { classification: 'known_noop', method, payload: {} }
    );
  }
});

test('projects native hook lifecycle notifications as one canonical tool item', () => {
  const run = {
    id: 'hook-run-1', eventName: 'userPromptSubmit', handlerType: 'command',
    executionMode: 'parallel', scope: 'project', sourcePath: '/repo/.codex/hooks.json',
    source: { type: 'config' }, displayOrder: 1, status: 'running',
    statusMessage: null, startedAt: 120, completedAt: null, durationMs: null,
    entries: []
  };
  const started = mapCodexAppServerMessage(message('hook/started', {
    threadId: 'thread-1', turnId: 'turn-1', run
  }));
  const completed = mapCodexAppServerMessage(message('hook/completed', {
    threadId: 'thread-1', turnId: 'turn-1',
    run: {
      ...run, status: 'completed', statusMessage: 'Hook completed',
      completedAt: 145, durationMs: 25,
      entries: [{ kind: 'context', text: 'Added project context' }]
    }
  }));

  assert.equal(started.type, 'timeline.item.started');
  assert.equal(completed.type, 'timeline.item.completed');
  assert.equal(started.itemId, 'hook-run-1');
  assert.equal(completed.itemId, 'hook-run-1');
  assert.equal(started.payload.item.kind, 'tool');
  assert.equal(started.payload.item.status, 'running');
  assert.equal(completed.payload.item.status, 'completed');
  assert.equal(completed.payload.item.content, 'Hook completed');
  assert.deepEqual(completed.payload.item.detail, {
    name: 'Hook: userPromptSubmit',
    input: {
      executionMode: 'parallel',
      handlerType: 'command',
      scope: 'project',
      sourcePath: '/repo/.codex/hooks.json'
    },
    result: {
      durationMs: 25,
      entries: [{ kind: 'context', text: 'Added project context' }],
      status: 'completed'
    }
  });
});

test('projects thread-scoped native warnings as visible non-error notices', () => {
  const warning = mapCodexAppServerMessage(message('warning', {
    threadId: 'thread-1', message: 'One configured skill was trimmed.'
  }));

  assert.equal(warning.type, 'timeline.item.completed');
  assert.equal(warning.payload.item.kind, 'notice');
  assert.equal(warning.payload.item.status, 'completed');
  assert.equal(warning.payload.item.content, 'One configured skill was trimmed.');
  assert.deepEqual(warning.payload.item.detail, {
    code: 'codex_warning', level: 'warning'
  });
  assert.match(warning.itemId, /^codex-warning:/);
});

test('maps current and deprecated context compaction signals to visible notices', () => {
  const current = mapCodexAppServerMessage(message('item/completed', {
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 123,
    item: { id: 'compaction-1', type: 'contextCompaction' }
  }));
  const deprecated = mapCodexAppServerMessage(message('thread/compacted', {
    threadId: 'thread-1', turnId: 'turn-1'
  }));

  assert.equal(current.type, 'timeline.item.completed');
  assert.equal(current.payload.item.kind, 'notice');
  assert.equal(current.payload.item.content, 'Context compacted');
  assert.deepEqual(deprecated, {
    type: 'timeline.item.completed',
    turnId: 'turn-1',
    itemId: 'codex-compaction:turn-1',
    payload: {
      item: {
        id: 'codex-compaction:turn-1',
        turnId: 'turn-1',
        kind: 'notice',
        createdAt: 0,
        updatedAt: 0,
        status: 'completed',
        content: 'Context compacted',
        detail: { level: 'success', code: 'context_compacted' }
      }
    }
  });
});

test('maps the native update_plan checklist notification to one canonical plan item', () => {
  const event = mapCodexAppServerMessage(message('turn/plan/updated', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    explanation: '先验证合同，再实现接线',
    plan: [
      { step: '验证合同', status: 'completed' },
      { step: '实现接线', status: 'inProgress' },
      { step: '运行测试', status: 'pending' }
    ],
    providerPrivate: 'must-not-leak'
  }));

  assert.deepEqual(event, {
    type: 'timeline.item.updated',
    turnId: 'turn-1',
    itemId: 'codex-plan:turn-1',
    payload: {
      item: {
        id: 'codex-plan:turn-1',
        turnId: 'turn-1',
        kind: 'plan',
        createdAt: 0,
        updatedAt: 0,
        status: 'running',
        content: '先验证合同，再实现接线',
        detail: {
          explanation: '先验证合同，再实现接线',
          steps: [
            { step: '验证合同', status: 'completed' },
            { step: '实现接线', status: 'in_progress' },
            { step: '运行测试', status: 'pending' }
          ]
        }
      }
    }
  });
  assert.doesNotMatch(JSON.stringify(event), /must-not-leak/);
  const normalized = normalizeEvent({
    ...event,
    eventId: 'event-plan', sessionId: 'session-1', seq: 1, at: 123,
    source: { provider: 'codex', runtimeId: 'runtime-1' }
  });
  assert.deepEqual(normalized.payload.item.detail.steps, [
    { step: '验证合同', status: 'completed' },
    { step: '实现接线', status: 'in_progress' },
    { step: '运行测试', status: 'pending' }
  ]);
});

test('fails closed on malformed native plan updates without leaking plan payloads', () => {
  const event = mapCodexAppServerMessage(message('turn/plan/updated', {
    threadId: 'thread-1', turnId: 'turn-1',
    plan: [{ step: 'unsafe', status: 'future', token: 'must-not-leak' }]
  }));

  assert.deepEqual(event, {
    type: 'stream.error',
    payload: {
      error: 'invalid_codex_plan_update',
      message: 'Invalid Codex plan update',
      retryable: false
    }
  });
  assert.doesNotMatch(JSON.stringify(event), /unsafe|future|must-not-leak/);
});

test('projects Codex UserInput variants to safe message content and typed inputs', () => {
  const event = mapCodexAppServerMessage(message('item/completed', {
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 123,
    item: {
      type: 'userMessage', id: 'user-1', clientId: 'client-private',
      content: [
        { type: 'text', text: 'Inspect the adapter', text_elements: [{ private: true }] },
        { type: 'image', url: 'https://private.example/image.png', detail: 'high' },
        { type: 'localImage', path: '/private/screenshot.png', detail: 'low' },
        { type: 'skill', name: 'review', path: '/private/SKILL.md' },
        { type: 'mention', name: 'Figma', path: 'app://private-id' },
        { type: 'futurePrivateInput', credential: 'must-not-leak' },
        { type: 'text', text: 'Verify the result', unknown: 'private-text-field' },
        null
      ]
    }
  }));

  assert.equal(
    event.payload.item.content,
    'Inspect the adapter\nVerify the result'
  );
  assert.deepEqual(event.payload.item.detail, {
    role: 'user',
    inputs: [
      { kind: 'image' },
      { kind: 'image' },
      { kind: 'skill', name: 'review' },
      { kind: 'mention', name: 'Figma' }
    ]
  });
  assert.doesNotMatch(
    JSON.stringify(event),
    /private\.example|private\/screenshot|private\/SKILL|private-id|must-not-leak|client-private|private-text-field/
  );
});

test('marks a completed Codex plan without an item status as proposed', () => {
  const event = mapCodexAppServerMessage(message('item/completed', {
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 123,
    item: { type: 'plan', id: 'plan-1', text: 'Inspect\nImplement' }
  }));

  assert.equal(event.payload.item.status, 'completed');
  assert.deepEqual(event.payload.item.detail, { state: 'proposed' });
});

test('emitted timeline intents pass the frozen canonical event normalizer', () => {
  const draft = mapCodexAppServerMessage(message('item/completed', {
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 123,
    item: { type: 'agentMessage', id: 'msg-1', text: 'done' }
  }));

  const event = normalizeEvent({
    ...draft,
    eventId: 'event-1', sessionId: 'session-1', seq: 1, at: 123,
    source: { provider: 'codex', runtimeId: 'runtime-1' }
  });

  assert.equal(event.type, 'timeline.item.completed');
  assert.equal(event.payload.item.kind, 'message');
  assert.equal(event.payload.item.content, 'done');
});
