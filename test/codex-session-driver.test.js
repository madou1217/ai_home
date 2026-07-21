'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mapCodexAppServerMessage } = require('../lib/server/codex-app-server-canonical');
const { createCodexDriverEntry } = require('../lib/server/chat-runtime/codex-session-driver');
const {
  createNativeInteractionId
} = require('../lib/server/chat-runtime/native-interaction-id');

const NATIVE_THREAD_ID = '019f-native-thread';

function interactionId(requestId) {
  return createNativeInteractionId({
    provider: 'codex',
    sessionId: 'session-1',
    nativeThreadId: NATIVE_THREAD_ID,
    nativeRequestId: String(requestId)
  });
}

test('Codex driver reuses resident client and persists mapped native events', async () => {
  const fixture = createFixture({ approvalMode: 'plan' });
  const turn = fixture.entry.driver.startTurn(turnContext({
    model: 'gpt-5.3-codex', reasoningEffort: 'high'
  }));
  await nextTask();

  assert.deepEqual(fixture.client.methods(), ['model/list', 'thread/start', 'turn/start']);
  assert.deepEqual(fixture.client.params('thread/start'), {
    approvalPolicy: 'untrusted', sandbox: 'workspace-write', cwd: '/repo'
  });
  assert.equal(
    fixture.client.params('turn/start').collaborationMode.mode,
    'plan'
  );
  assert.equal(
    fixture.client.params('turn/start').collaborationMode.settings.reasoning_effort,
    'high'
  );
  assert.equal(fixture.client.params('turn/start').clientUserMessageId, 'run-1');
  assert.deepEqual(fixture.nativeTurnAnchors, [{
    clientUserMessageId: 'run-1',
    nativeTurnId: 'native-turn-1',
    runId: 'run-1'
  }]);

  fixture.client.notify('turn/started', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'inProgress' }
  });
  fixture.client.notify('item/started', {
    threadId: NATIVE_THREAD_ID,
    turnId: 'native-turn-1',
    item: { id: 'message-1', type: 'agentMessage', text: '' }
  });
  fixture.client.notify('item/agentMessage/delta', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', itemId: 'message-1', delta: 'hello'
  });
  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });

  assert.deepEqual(await turn, { status: 'completed' });
  assert.deepEqual(fixture.events.map((event) => event.type), [
    'timeline.item.started',
    'timeline.item.delta'
  ]);
  assert.equal(fixture.events[0].turnId, 'turn-1');
  assert.equal(fixture.events[0].payload.item.turnId, 'turn-1');
  assert.equal(fixture.events[0].payload.item.detail.model, 'gpt-5.3-codex');
  assert.equal(Object.hasOwn(fixture.events[0].payload, 'providerTurnId'), false);
  assert.deepEqual(fixture.events[1].payload, {
    itemId: 'message-1',
    chunk: 'hello'
  });
  assert.deepEqual(fixture.bound, [NATIVE_THREAD_ID]);
});

test('Codex terminal settlement waits for the native turn anchor to persist', async () => {
  const persistence = deferred();
  const fixture = createFixture({
    persistNativeTurnAnchor: () => persistence.promise
  });
  const turn = fixture.entry.driver.startTurn(turnContext());
  await nextTask();

  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  let settled = false;
  turn.finally(() => { settled = true; });
  await nextTask();

  assert.equal(settled, false);
  persistence.resolve();
  assert.equal((await turn).status, 'completed');
});

test('Codex native turn anchor persistence failure fails the turn', async () => {
  const persistence = deferred();
  const fixture = createFixture({
    persistNativeTurnAnchor: () => persistence.promise
  });
  const turn = fixture.entry.driver.startTurn(turnContext());
  await nextTask();

  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  const failure = new Error('anchor persistence failed');
  failure.code = 'chat_turn_anchor_persistence_failed';
  const rejected = assert.rejects(
    turn,
    (error) => error === failure
  );
  persistence.reject(failure);

  await rejected;
});

test('Codex plan mode uses the native catalog default without a WebUI model override', async () => {
  const fixture = createFixture({ approvalMode: 'plan', defaultModel: 'gpt-native-default' });
  const turn = fixture.entry.driver.startTurn(turnContext({ reasoningEffort: 'high' }));
  await nextTask();

  assert.equal(fixture.client.params('turn/start').model, 'gpt-native-default');
  assert.deepEqual(fixture.client.params('turn/start').collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-native-default',
      reasoning_effort: 'high',
      developer_instructions: null
    }
  });

  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await turn;
});

test('Codex driver sends uploaded images as native localImage inputs', async () => {
  const fixture = createFixture();
  const turn = fixture.entry.driver.startTurn({
    ...turnContext({ content: '' }),
    imagePaths: ['/tmp/shot.png', '/tmp/diagram.jpg']
  });
  await nextTask();

  assert.deepEqual(fixture.client.params('turn/start').input, [
    { type: 'text', text: '' },
    { type: 'localImage', path: '/tmp/shot.png' },
    { type: 'localImage', path: '/tmp/diagram.jpg' }
  ]);

  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await turn;
});

test('Codex turn fails closed when the native model catalog is empty', async () => {
  const fixture = createFixture({ approvalMode: 'plan', modelEntries: [] });
  await assert.rejects(
    fixture.entry.driver.startTurn(turnContext()),
    (error) => error.code === 'codex_native_model_catalog_empty' && error.statusCode === 502
  );
  assert.deepEqual(fixture.client.methods(), ['model/list']);
});

test('Codex driver bridges approvals and questions with native response shapes', async () => {
  const fixture = createFixture({ approvalMode: 'confirm' });
  const turn = fixture.entry.driver.startTurn(turnContext());
  await nextTask();

  fixture.client.requestFromServer(7, 'item/commandExecution/requestApproval', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', itemId: 'shell-1',
    command: 'npm test', availableDecisions: ['accept']
  });
  await fixture.entry.handlers['approval.decide'](handlerContext('approval.decide', {
    interactionId: interactionId(7), revision: 1, choiceId: 'choice-0'
  }, fixture.store));
  fixture.client.requestFromServer(7, 'item/commandExecution/requestApproval', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', itemId: 'shell-1',
    command: 'npm test', availableDecisions: ['accept']
  });

  fixture.client.requestFromServer(8, 'item/tool/requestUserInput', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', itemId: 'question-1',
    questions: [{
      id: 'target', question: 'Target?',
      options: [
        { label: 'web', description: 'Browser' },
        { label: 'desktop', description: 'Native app' }
      ]
    }]
  });
  await fixture.entry.handlers['interaction.answer'](handlerContext('interaction.answer', {
    interactionId: interactionId(8), revision: 1,
    action: 'submit',
    answer: { target: ['web', 'desktop'] }
  }, fixture.store));
  await nextTask();

  assert.deepEqual(fixture.client.responses, [
    { id: 7, result: { decision: 'accept' } },
    { id: 7, result: { decision: 'accept' } },
    { id: 8, result: { answers: { target: { answers: ['web', 'desktop'] } } } }
  ]);
  assert.deepEqual(fixture.decisionOrder, [
    `validate:${interactionId(7)}`, 'native:7', `store:${interactionId(7)}`, 'native:7',
    `validate:${interactionId(8)}`, 'native:8', `store:${interactionId(8)}`
  ]);
  assert.deepEqual(fixture.events.map((event) => event.type), [
    'interaction.requested', 'interaction.requested'
  ]);

  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await turn;
});

test('Codex driver selects response adapters by native request method', async () => {
  const fixture = createFixture({ approvalMode: 'confirm' });
  const turn = fixture.entry.driver.startTurn(turnContext());
  await nextTask();

  const requestedPermissions = { network: { enabled: true } };
  fixture.client.requestFromServer(20, 'item/permissions/requestApproval', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', itemId: 'permissions-1',
    permissions: requestedPermissions
  });
  await fixture.entry.handlers['approval.decide'](handlerContext('approval.decide', {
    interactionId: interactionId(20), revision: 1,
    choiceId: 'choice-2'
  }, fixture.store));
  fixture.client.requestFromServer(20, 'item/permissions/requestApproval', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', itemId: 'permissions-1',
    permissions: requestedPermissions
  });

  fixture.client.requestFromServer(21, 'item/permissions/requestApproval', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', itemId: 'permissions-2',
    permissions: requestedPermissions
  });
  await fixture.entry.handlers['approval.decide'](handlerContext('approval.decide', {
    interactionId: interactionId(21), revision: 1,
    choiceId: 'choice-3'
  }, fixture.store));

  fixture.client.requestFromServer(22, 'mcpServer/elicitation/request', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', mode: 'form',
    message: 'Account?', requestedSchema: {
      type: 'object', properties: { email: { type: 'string' } }, required: ['email']
    }
  });
  await fixture.entry.handlers['interaction.answer'](handlerContext('interaction.answer', {
    interactionId: interactionId(22), revision: 1, action: 'submit',
    answer: { email: 'user@example.com' }
  }, fixture.store));

  fixture.client.requestFromServer(23, 'mcpServer/elicitation/request', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', mode: 'url', message: 'Authorize?',
    url: 'https://example.com/oauth', elicitationId: 'auth-23'
  });
  await fixture.entry.handlers['interaction.answer'](handlerContext('interaction.answer', {
    interactionId: interactionId(23), revision: 1, action: 'cancel'
  }, fixture.store));

  assert.deepEqual(fixture.client.responses.slice(-5), [
    {
      id: 20,
      result: {
        permissions: { network: { enabled: true } },
        scope: 'session'
      }
    },
    {
      id: 20,
      result: { permissions: { network: { enabled: true } }, scope: 'session' }
    },
    { id: 21, result: { permissions: {}, scope: 'turn' } },
    {
      id: 22,
      result: { action: 'accept', content: { email: 'user@example.com' }, _meta: null }
    },
    { id: 23, result: { action: 'cancel', content: null, _meta: null } }
  ]);

  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await turn;
});

test('Codex handlers expose native steer, compact, prewarm and typed fail-closed paths', async () => {
  const fixture = createFixture({
    nativeSessionId: NATIVE_THREAD_ID,
    approvalMode: 'bypass'
  });
  assert.deepEqual(
    await fixture.entry.handlers['runtime.prewarm'](handlerContext('runtime.prewarm', {})),
    { ready: true, provider: 'codex', runtimeScope: 'codex:account-1' }
  );
  assert.deepEqual(fixture.client.methods(), ['model/list']);

  const turn = fixture.entry.driver.startTurn(turnContext());
  await nextTask();
  await fixture.entry.handlers['turn.intervene'](handlerContext('turn.intervene', {
    mode: 'steer_current', content: 'focus on tests'
  }));
  assert.deepEqual(fixture.client.params('turn/steer'), {
    threadId: NATIVE_THREAD_ID,
    expectedTurnId: 'native-turn-1',
    input: [{ type: 'text', text: 'focus on tests' }]
  });
  assert.throws(
    () => fixture.entry.handlers['turn.intervene'](handlerContext('turn.intervene', {
      mode: 'after_tool_boundary', content: 'later'
    })),
    (error) => error.code === 'codex_intervene_mode_unsupported' && error.statusCode === 422
  );

  await fixture.entry.driver.interruptTurn(turnContext());
  assert.deepEqual(fixture.client.params('turn/interrupt'), {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1'
  });
  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'interrupted' }
  });
  await turn;

  await fixture.entry.handlers['slash.execute'](handlerContext('slash.execute', {
    name: 'compact'
  }));
  assert.deepEqual(fixture.client.params('thread/compact/start'), {
    threadId: NATIVE_THREAD_ID
  });
  assert.throws(
    () => fixture.entry.handlers['slash.execute'](handlerContext('slash.execute', {
      name: 'future-command'
    })),
    (error) => error.code === 'codex_slash_command_unsupported'
  );
});

test('Codex driver explicitly exits sticky Plan mode at the next idle turn boundary', async () => {
  let policy = { approvalMode: 'plan' };
  const fixture = createFixture({
    nativeSessionId: NATIVE_THREAD_ID,
    approvalMode: 'bypass',
    getSessionPolicy: () => policy
  });

  const first = fixture.entry.driver.startTurn(turnContext());
  await nextTask();
  assert.deepEqual(fixture.client.params('thread/resume'), {
    threadId: NATIVE_THREAD_ID,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    excludeTurns: true
  });
  assert.equal(fixture.client.params('turn/start').collaborationMode.mode, 'plan');
  assert.equal(fixture.client.params('turn/start').approvalPolicy, 'untrusted');
  assert.deepEqual(fixture.client.params('turn/start').sandboxPolicy, {
    type: 'workspaceWrite'
  });
  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await first;

  policy = { approvalMode: 'confirm' };
  const second = fixture.entry.driver.startTurn(turnContext());
  await nextTask();
  assert.equal(fixture.client.params('turn/start').collaborationMode.mode, 'default');
  assert.equal(fixture.client.params('turn/start').approvalPolicy, 'untrusted');
  assert.deepEqual(fixture.client.params('turn/start').sandboxPolicy, {
    type: 'workspaceWrite'
  });
  assert.equal(fixture.client.params('turn/start').effort, 'medium');
  assert.equal(fixture.client.methods().filter((method) => method === 'model/list').length, 1);
  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await second;
});

test('interaction revision conflict wins before any native response', async () => {
  const fixture = createFixture();
  const turn = fixture.entry.driver.startTurn(turnContext());
  await nextTask();
  fixture.client.requestFromServer(10, 'item/fileChange/requestApproval', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', itemId: 'change-1'
  });
  fixture.store.validateInteraction = () => {
    const error = new Error('stale_interaction');
    error.code = 'stale_interaction';
    error.statusCode = 409;
    throw error;
  };

  await assert.rejects(
    fixture.entry.handlers['approval.decide'](handlerContext('approval.decide', {
      interactionId: interactionId(10), revision: 2, choiceId: 'choice-3'
    }, fixture.store)),
    (error) => error.code === 'stale_interaction'
  );
  assert.deepEqual(fixture.client.responses, []);
  assert.equal(fixture.store.state, 'pending');
  assert.equal(fixture.store.resolvedEvents, 0);
  assert.equal(fixture.store.resolutions.length, 0);

  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await turn;
});

test('native response false or throw never resolves the interaction store', async () => {
  for (const nativeResponse of ['false', 'throw']) {
    const fixture = createFixture({ nativeResponse });
    const turn = fixture.entry.driver.startTurn(turnContext());
    await nextTask();
    fixture.client.requestFromServer(11, 'item/fileChange/requestApproval', {
      threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1', itemId: `change-${nativeResponse}`
    });

    await assert.rejects(
      fixture.entry.handlers['approval.decide'](handlerContext('approval.decide', {
        interactionId: interactionId(11), revision: 1, choiceId: 'choice-0'
      }, fixture.store)),
      (error) => error.code === 'codex_app_server_disconnected' && error.statusCode === 503
    );
    assert.equal(fixture.store.state, 'pending');
    assert.equal(fixture.store.resolvedEvents, 0);
    assert.equal(fixture.store.resolutions.length, 0);
    assert.equal(fixture.client.responseAttempts.length, 1);

    fixture.client.notify('turn/completed', {
      threadId: NATIVE_THREAD_ID,
      turn: { id: 'native-turn-1', status: 'completed' }
    });
    await turn;
  }
});

test('unsupported native requests stay transient and receive JSON-RPC method-not-found', async () => {
  const fixture = createFixture();
  const turn = fixture.entry.driver.startTurn(turnContext());
  await nextTask();

  fixture.client.requestFromServer(99, 'item/future/requestApproval', {
    threadId: NATIVE_THREAD_ID, turnId: 'native-turn-1'
  });
  await nextTask();

  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.transientEvents[0].type, 'stream.error');
  assert.equal(
    fixture.transientEvents[0].payload.error,
    'unsupported_codex_app_server_method'
  );
  assert.equal(typeof fixture.transientEvents[0].payload.message, 'string');
  assert.deepEqual(fixture.client.errors, [{
    id: 99,
    code: -32601,
    message: 'unsupported server request: item/future/requestApproval'
  }]);
  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await turn;
});

test('retryable native errors stay transient and do not terminate the canonical turn', async () => {
  const fixture = createFixture();
  const turn = fixture.entry.driver.startTurn(turnContext());
  await nextTask();

  fixture.client.notify('error', {
    threadId: NATIVE_THREAD_ID,
    turnId: 'native-turn-1',
    error: { message: 'stream disconnected' },
    willRetry: true
  });
  await nextTask();

  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.transientEvents.map(({ eventId, ...event }) => event), [{
    type: 'stream.error',
    turnId: 'turn-1',
    runId: 'run-1',
    payload: {
      error: 'codex_app_server_error',
      message: 'stream disconnected',
      retryable: true
    }
  }]);
  fixture.client.notify('item/agentMessage/delta', {
    threadId: NATIVE_THREAD_ID,
    turnId: 'native-turn-1',
    itemId: 'message-1',
    delta: 'recovered'
  });
  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  assert.equal((await turn).status, 'completed');
  assert.equal(fixture.events.some((event) => event.type === 'timeline.item.delta'), true);
});

test('known no-op notifications remain observable to trace without entering persistence', async () => {
  const fixture = createFixture();
  const turn = fixture.entry.driver.startTurn(turnContext());
  await nextTask();

  fixture.client.notify('thread/tokenUsage/updated', {
    threadId: NATIVE_THREAD_ID,
    turnId: 'native-turn-1',
    tokenUsage: { total: 42 }
  });
  await nextTask();

  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.transientEvents, []);
  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  assert.equal((await turn).status, 'completed');
});

test('Codex recovery captures replayed pending requests before exposing the active turn', async () => {
  const replayParams = {
    threadId: NATIVE_THREAD_ID,
    turnId: 'native-turn-recovered',
    itemId: 'change-recovered',
    changes: { path: 'src/a.js' }
  };
  const fixture = createFixture({
    nativeSessionId: NATIVE_THREAD_ID,
    replayOnResume: {
      id: 31,
      method: 'item/fileChange/requestApproval',
      params: replayParams
    }
  });
  const pending = persistedInteraction(
    31,
    'item/fileChange/requestApproval',
    replayParams
  );

  const recovered = await fixture.entry.driver.recoverTurn(recoveryContext([pending]));
  await fixture.entry.handlers['approval.decide'](handlerContext('approval.decide', {
    interactionId: pending.interactionId,
    revision: 1,
    choiceId: 'choice-0'
  }, fixture.store));

  assert.deepEqual(fixture.client.methods(), ['thread/resume']);
  assert.equal(fixture.client.params('thread/resume').excludeTurns, undefined);
  assert.equal(recovered.nativeTurnId, 'native-turn-recovered');
  assert.deepEqual(fixture.client.responses, [{ id: 31, result: { decision: 'accept' } }]);
  assert.deepEqual(fixture.events, []);

  fixture.client.notify('turn/completed', {
    threadId: NATIVE_THREAD_ID,
    turn: { id: 'native-turn-recovered', status: 'completed' }
  });
  assert.equal((await recovered.done).status, 'completed');
});

test('Codex recovery fails closed when a persisted pending request is not replayed', async () => {
  const fixture = createFixture({
    nativeSessionId: NATIVE_THREAD_ID,
    interactionReplayTimeoutMs: 5
  });
  const pending = persistedInteraction('missing', 'item/fileChange/requestApproval', {
    threadId: NATIVE_THREAD_ID,
    turnId: 'native-turn-missing',
    itemId: 'file-missing'
  });

  await assert.rejects(
    fixture.entry.driver.recoverTurn(recoveryContext([pending])),
    (error) => (
      error.code === 'codex_pending_interaction_replay_missing'
      && error.nativeCleanup === 'interrupted'
    )
  );
  assert.deepEqual(fixture.client.methods(), ['thread/resume', 'turn/interrupt']);
  assert.deepEqual(fixture.client.responseAttempts, []);
});

test('Codex recovery preserves replay failure when native interrupt also fails', async () => {
  const fixture = createFixture({
    nativeSessionId: NATIVE_THREAD_ID,
    interactionReplayTimeoutMs: 5,
    interruptFailure: true
  });

  await assert.rejects(
    fixture.entry.driver.recoverTurn(recoveryContext([persistedInteraction(
      'missing',
      'item/tool/requestUserInput',
      {
        threadId: NATIVE_THREAD_ID,
        turnId: 'native-turn-missing',
        itemId: 'question-missing',
        questions: [{ id: 'missing', question: 'Continue?', options: null }]
      }
    )])),
    (error) => (
      error.code === 'codex_pending_interaction_replay_missing'
      && error.nativeCleanup === 'failed'
    )
  );
  assert.deepEqual(fixture.client.methods(), ['thread/resume', 'turn/interrupt']);
});

function createFixture(overrides = {}) {
  const decisionOrder = [];
  const client = createFakeClient(decisionOrder, overrides);
  const events = [];
  const transientEvents = [];
  const bound = [];
  const nativeTurnAnchors = [];
  const store = {
    resolutions: [], resolvedEvents: 0, state: 'pending',
    validateInteraction(interactionId, input) {
      decisionOrder.push(`validate:${interactionId}`);
      return { interactionId, kind: input.kind, revision: input.revision, state: this.state };
    },
    resolveInteraction(interactionId, input) {
      decisionOrder.push(`store:${interactionId}`);
      this.resolutions.push({ interactionId, input });
      this.resolvedEvents += 1;
      this.state = 'answered';
      return { interactionId, revision: input.revision, state: 'answered' };
    },
    claimInteractionResolution(interactionId, input) {
      const current = this.validateInteraction(interactionId, input);
      this.claim = { interactionId, input };
      this.state = 'resolving';
      return current;
    },
    finishInteractionResolution(claim) {
      return this.resolveInteraction(claim.interactionId, this.claim.input);
    },
    releaseInteractionResolution() {
      this.claim = null;
      this.state = 'pending';
    }
  };
  const session = {
    sessionId: 'session-1', provider: 'codex', executionAccountRef: 'account-1',
    projectPath: '/repo',
    runtimeBinding: overrides.nativeSessionId ? { nativeSessionId: overrides.nativeSessionId } : {},
    policy: { approvalMode: overrides.approvalMode || 'confirm' }
  };
  const runtime = {
    provider: 'codex', runtimeScope: 'codex:account-1', generation: 1,
    version: 'codex-cli test-version', fingerprint: 'runtime-1'
  };
  const entry = createCodexDriverEntry({
    session, runtime,
    clientFactory: () => client,
    getSessionPolicy: overrides.getSessionPolicy,
    eventSink: async (event) => events.push(event),
    transientEventSink: async (event) => transientEvents.push(event),
    onNativeSessionBound: (threadId) => bound.push(threadId),
    onNativeTurnStarted: (anchor) => {
      nativeTurnAnchors.push(anchor);
      return overrides.persistNativeTurnAnchor
        ? overrides.persistNativeTurnAnchor(anchor)
        : undefined;
    },
    interactionReplayTimeoutMs: overrides.interactionReplayTimeoutMs
  });
  return {
    bound, client, decisionOrder, entry, events, nativeTurnAnchors, store, transientEvents
  };
}

function createFakeClient(decisionOrder, overrides) {
  const calls = [];
  const bindings = new Map();
  return {
    calls, responses: [], responseAttempts: [], errors: [], connected: 0,
    async ensureConnected() { this.connected += 1; return {}; },
    getVerifiedAccountIdentity() {
      return { verified: true, kind: 'oauth', assurance: 'identity' };
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'model/list') {
        return {
          data: Object.prototype.hasOwnProperty.call(overrides, 'modelEntries')
            ? overrides.modelEntries
            : [nativeModel(overrides.defaultModel || 'gpt-5.3-codex')]
        };
      }
      if (method === 'thread/start') return {
        thread: { id: NATIVE_THREAD_ID },
        ...(overrides.omitThreadModel ? {} : { model: overrides.threadModel || 'gpt-5.3-codex' })
      };
      if (method === 'turn/start') return { turn: { id: 'native-turn-1', status: 'inProgress' } };
      if (method === 'thread/resume') {
        if (overrides.replayOnResume) {
          setImmediate(() => this.requestFromServer(
            overrides.replayOnResume.id,
            overrides.replayOnResume.method,
            overrides.replayOnResume.params
          ));
        }
        return {
          ...(overrides.omitThreadModel ? {} : { model: overrides.threadModel || 'gpt-5.3-codex' }),
          thread: {
            id: NATIVE_THREAD_ID,
            turns: [{ id: 'native-turn-recovered', status: 'inProgress', items: [] }]
          }
        };
      }
      if (method === 'turn/interrupt' && overrides.interruptFailure) {
        throw new Error('interrupt failed');
      }
      return {};
    },
    bindTurn(threadId, binding) { bindings.set(threadId, binding); },
    unbindTurn(threadId) { bindings.delete(threadId); },
    respond(id, result) {
      decisionOrder.push(`native:${id}`);
      this.responseAttempts.push({ id, result });
      if (overrides.nativeResponse === 'throw') {
        const error = new Error('disconnected');
        error.code = 'codex_app_server_disconnected';
        error.statusCode = 503;
        throw error;
      }
      if (overrides.nativeResponse === 'false') return false;
      this.responses.push({ id, result });
      return true;
    },
    respondError(id, code, message) { this.errors.push({ id, code, message }); return true; },
    notify(method, params) { bindings.get(params.threadId).onNotification({ method, params }); },
    requestFromServer(id, method, params) {
      bindings.get(params.threadId).onServerRequest({ id, method, params });
    },
    methods: () => calls.map((call) => call.method),
    params: (method) => calls.findLast((call) => call.method === method)?.params
  };
}

function nativeModel(model) {
  return {
    model,
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' }
    ],
    defaultReasoningEffort: 'medium'
  };
}

function turnContext(overrides = {}) {
  return {
    sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1',
    command: { payload: { content: 'do work', ...overrides } }
  };
}

function recoveryContext(pendingInteractions = []) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    activeTurn: {
      turnId: 'turn-1',
      runId: 'run-1',
      clientUserMessageId: 'run-1',
      nativeTurnId: 'native-turn-recovered'
    },
    pendingInteractions
  };
}

function handlerContext(type, payload, store = {}) {
  return { sessionId: 'session-1', command: { type, payload }, store };
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}

function persistedInteraction(requestId, method, params) {
  return mapCodexAppServerMessage({ requestId, id: requestId, method, params }, {
    sessionId: 'session-1'
  }).payload.interaction;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
