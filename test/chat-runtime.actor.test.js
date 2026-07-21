'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createCodexHandlers } = require('../lib/server/chat-runtime/codex-session-command-port');
const { SessionActor } = require('../lib/server/chat-runtime/session-actor');
const { getAppStateDbPath } = require('../lib/server/app-state-store');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const {
  approvalPayload,
  questionPayload
} = require('./chat-runtime-interaction-fixtures');

function createFixture(t, options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-actor-'));
  let nextId = 0;
  const store = openChatRuntimeStore({
    fs,
    aiHomeDir,
    DatabaseSync,
    clock: () => 2000 + nextId,
    idFactory: (prefix) => `${prefix}-${++nextId}`
  });
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  const actor = new SessionActor({
    sessionId: session.sessionId,
    store,
    idFactory: (prefix) => `${prefix}-${++nextId}`,
    ...options
  });
  t.after(() => {
    actor.dispose();
    store.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return { actor, aiHomeDir, session, store };
}

function installRejectTrigger(aiHomeDir, name, type) {
  const db = new DatabaseSync(getAppStateDbPath(aiHomeDir));
  db.exec(`
    CREATE TRIGGER ${name}
    BEFORE INSERT ON chat_runtime_events
    WHEN NEW.type = '${type}'
    BEGIN SELECT RAISE(ABORT, 'reject_event'); END
  `);
  db.close();
}

function command(sessionId, commandId, type, payload = {}) {
  return { sessionId, commandId, type, payload };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function interactionEvents(store, sessionId, type) {
  return store.listEvents(sessionId).filter((event) => event.type === type);
}

function interactionAnswerEvents(store, sessionId) {
  return interactionEvents(store, sessionId, 'timeline.item.completed')
    .filter((event) => event.payload.item.detail.phase === 'interaction_answer');
}

function secretQuestionPayload({ includeTarget = false } = {}) {
  const fields = [{
    id: 'token', label: 'Token?', type: 'text', required: false,
    allowOther: false, secret: true
  }];
  if (includeTarget) fields.push({
    id: 'target', label: 'Target?', type: 'text', required: false,
    allowOther: false, secret: false
  });
  return questionPayload({ fields, answerShape: 'answers', confirmUnanswered: true });
}

test('SessionActor mailbox executes injected handlers in command order', async (t) => {
  const gate = deferred();
  const order = [];
  const { actor, session } = createFixture(t, {
    handlers: {
      'runtime.prewarm': async ({ command: current }) => {
        order.push(`start:${current.payload.label}`);
        if (current.payload.label === 'first') await gate.promise;
        order.push(`end:${current.payload.label}`);
        return { ready: true };
      }
    }
  });

  const first = actor.dispatch(command(session.sessionId, 'command-1', 'runtime.prewarm', {
    label: 'first'
  }));
  const second = actor.dispatch(command(session.sessionId, 'command-2', 'runtime.prewarm', {
    label: 'second'
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['start:first']);

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
});

test('SessionActor reads provider composer catalog through its focused port', async (t) => {
  const expected = {
    models: [{ id: 'gpt-5.6-sol', supportedEfforts: ['medium', 'high'] }],
    defaultModel: 'gpt-5.6-sol'
  };
  const { actor } = createFixture(t, {
    composerCatalog: async () => expected
  });

  assert.deepEqual(await actor.readComposerCatalog(), expected);
});

test('SessionActor executes an idempotent command only once', async (t) => {
  let calls = 0;
  const { actor, session } = createFixture(t, {
    handlers: {
      'runtime.prewarm': async () => {
        calls += 1;
        return { ready: true };
      }
    }
  });
  const input = command(session.sessionId, 'command-once', 'runtime.prewarm');

  const first = await actor.dispatch(input);
  const duplicate = await actor.dispatch(input);

  assert.equal(calls, 1);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.result, { ready: true });
});

test('interaction resolution remains claimed until an asynchronous provider response completes', async (t) => {
  const nativeResponse = deferred();
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      decideApproval: () => nativeResponse.promise
    })
  });
  store.createInteraction({
    interactionId: 'approval-async', sessionId: session.sessionId,
    itemId: 'approval-item-async', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });

  const response = actor.dispatch(command(
    session.sessionId,
    'approval-command-async',
    'approval.decide',
    { interactionId: 'approval-async', revision: 1, choiceId: 'choice-0' }
  ));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.interactions.get('approval-async').state, 'resolving');
  assert.equal(interactionEvents(store, session.sessionId, 'interaction.resolved').length, 0);

  nativeResponse.resolve({ responded: true });
  await response;
  assert.equal(store.interactions.get('approval-async').state, 'answered');
  assert.equal(interactionEvents(store, session.sessionId, 'interaction.resolved').length, 1);
});

test('question answer becomes visible only after the asynchronous provider accepts it', async (t) => {
  const nativeResponse = deferred();
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      answerInteraction: () => nativeResponse.promise
    })
  });
  store.createInteraction({
    interactionId: 'question-answer-async',
    sessionId: session.sessionId,
    itemId: 'question-answer-item-async',
    kind: 'question',
    revision: 1,
    payload: questionPayload()
  });

  const response = actor.dispatch(command(
    session.sessionId,
    'question-answer-command-async',
    'interaction.answer',
    {
      interactionId: 'question-answer-async',
      revision: 1,
      action: 'submit',
      answer: { answer: '我什么都不选' }
    }
  ));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.interactions.get('question-answer-async').state, 'resolving');
  assert.equal(interactionAnswerEvents(store, session.sessionId).length, 0);

  nativeResponse.resolve({ responded: true });
  await response;
  assert.equal(store.interactions.get('question-answer-async').state, 'answered');
  assert.equal(interactionAnswerEvents(store, session.sessionId).length, 1);
  assert.equal(
    interactionAnswerEvents(store, session.sessionId)[0].payload.item.content,
    '我什么都不选'
  );
});

test('asynchronous provider rejection releases the interaction claim without resolving it', async (t) => {
  const nativeResponse = deferred();
  const failure = new Error('provider response failed');
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      decideApproval: () => nativeResponse.promise
    })
  });
  store.createInteraction({
    interactionId: 'approval-async-failed', sessionId: session.sessionId,
    itemId: 'approval-item-async-failed', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });

  const response = actor.dispatch(command(
    session.sessionId,
    'approval-command-async-failed',
    'approval.decide',
    {
      interactionId: 'approval-async-failed', revision: 1,
      choiceId: 'choice-1'
    }
  ));
  const rejected = assert.rejects(response, (error) => error === failure);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.interactions.get('approval-async-failed').state, 'resolving');

  nativeResponse.reject(failure);
  await rejected;
  const interaction = store.interactions.get('approval-async-failed');
  assert.equal(interaction.state, 'pending');
  assert.equal(interaction.resolution, undefined);
  assert.deepEqual(interactionEvents(store, session.sessionId, 'interaction.updated')
    .map((event) => event.payload.interaction.state), ['resolving', 'pending']);
  assert.equal(interactionEvents(store, session.sessionId, 'interaction.resolved').length, 0);
});

test('duplicate and stale interaction claims fail before a second provider response', async (t) => {
  const nativeResponse = deferred();
  let nativeSends = 0;
  const { session, store } = createFixture(t);
  const handlers = createCodexHandlers({
    decideApproval() {
      nativeSends += 1;
      return nativeResponse.promise;
    }
  });
  store.createInteraction({
    interactionId: 'approval-claimed', sessionId: session.sessionId,
    itemId: 'approval-item-claimed', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });
  const context = (revision) => ({
    sessionId: session.sessionId,
    command: { payload: {
      interactionId: 'approval-claimed', revision, choiceId: 'choice-0'
    } },
    store
  });

  const first = handlers['approval.decide'](context(1));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    handlers['approval.decide'](context(1)),
    (error) => error.code === 'stale_interaction' && error.statusCode === 409
  );
  await assert.rejects(
    handlers['approval.decide'](context(2)),
    (error) => error.code === 'stale_interaction' && error.statusCode === 409
  );

  assert.equal(nativeSends, 1);
  assert.equal(store.interactions.get('approval-claimed').state, 'resolving');
  nativeResponse.resolve({ responded: true });
  await first;
  assert.equal(store.interactions.get('approval-claimed').state, 'answered');
});

test('interaction commands cannot claim an interaction owned by another session', async (t) => {
  let nativeSends = 0;
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      decideApproval() {
        nativeSends += 1;
        return { responded: true };
      }
    })
  });
  const other = store.createSession({
    sessionId: 'session-other', provider: 'codex', executionAccountRef: 'account-1'
  });
  store.createInteraction({
    interactionId: 'approval-other-session', sessionId: other.sessionId,
    itemId: 'approval-item-other-session', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });

  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'approval-command-other-session',
    'approval.decide',
    {
      interactionId: 'approval-other-session', revision: 1,
      choiceId: 'choice-0'
    }
  )), (error) => error.code === 'stale_interaction' && error.statusCode === 409);

  assert.equal(nativeSends, 0);
  assert.equal(store.interactions.get('approval-other-session').state, 'pending');
});

test('native interaction failure leaves the database pending without a resolved event', async (t) => {
  let nativeSends = 0;
  const failure = Object.assign(new Error('disconnected'), {
    code: 'codex_app_server_disconnected', statusCode: 503
  });
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      decideApproval() { nativeSends += 1; throw failure; }
    })
  });
  const interaction = store.createInteraction({
    interactionId: 'approval-failed', sessionId: session.sessionId,
    itemId: 'approval-item-failed', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });

  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'approval-command-failed',
    'approval.decide',
    {
      interactionId: interaction.interactionId, revision: 1,
      choiceId: 'choice-0'
    }
  )), (error) => error.code === failure.code && error.statusCode === 503);

  assert.equal(nativeSends, 1);
  assert.equal(store.interactions.get(interaction.interactionId).state, 'pending');
  assert.equal(interactionEvents(store, session.sessionId, 'interaction.resolved').length, 0);
});

test('successful interaction response resolves once and duplicate command ids never resend', async (t) => {
  let nativeSends = 0;
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      decideApproval() {
        nativeSends += 1;
        return { interactionId: 'approval-once', revision: 1, responded: true };
      }
    })
  });
  store.createInteraction({
    interactionId: 'approval-once', sessionId: session.sessionId,
    itemId: 'approval-item-once', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });
  const input = command(session.sessionId, 'approval-command-once', 'approval.decide', {
    interactionId: 'approval-once', revision: 1, choiceId: 'choice-0'
  });

  const first = await actor.dispatch(input);
  const duplicate = await actor.dispatch(input);
  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'approval-command-retry',
    'approval.decide',
    {
      interactionId: 'approval-once', revision: 1,
      choiceId: 'choice-0'
    }
  )), (error) => error.code === 'stale_interaction' && error.statusCode === 409);

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(nativeSends, 1);
  assert.equal(store.interactions.get('approval-once').state, 'answered');
  assert.equal(interactionEvents(store, session.sessionId, 'interaction.resolved').length, 1);
});

test('interaction kind conflicts fail before any native response', async (t) => {
  let nativeSends = 0;
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      decideApproval() { nativeSends += 1; return { responded: true }; }
    })
  });
  store.createInteraction({
    interactionId: 'question-kind', sessionId: session.sessionId,
    itemId: 'question-item-kind', kind: 'question', revision: 1,
    payload: questionPayload()
  });

  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'approval-command-wrong-kind',
    'approval.decide',
    {
      interactionId: 'question-kind', revision: 1,
      choiceId: 'choice-0'
    }
  )), (error) => (
    error.code === 'chat_interaction_kind_mismatch' && error.statusCode === 409
  ));

  assert.equal(nativeSends, 0);
  assert.equal(store.interactions.get('question-kind').state, 'pending');
  assert.equal(interactionEvents(store, session.sessionId, 'interaction.resolved').length, 0);
});

test('invalid question identities fail before secret answers can enter durable commands', async (t) => {
  let nativeSends = 0;
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      answerInteraction() { nativeSends += 1; return { responded: true }; }
    })
  });
  const other = store.createSession({
    sessionId: 'session-secret-other', provider: 'codex', executionAccountRef: 'account-1'
  });
  store.createInteraction({
    interactionId: 'question-secret-other-session', sessionId: other.sessionId,
    itemId: 'question-secret-other-item', kind: 'question', revision: 1,
    payload: secretQuestionPayload()
  });
  store.createInteraction({
    interactionId: 'question-secret-wrong-kind', sessionId: session.sessionId,
    itemId: 'question-secret-wrong-kind-item', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });
  store.createInteraction({
    interactionId: 'question-secret-stale', sessionId: session.sessionId,
    itemId: 'question-secret-stale-item', kind: 'question', revision: 1,
    payload: secretQuestionPayload()
  });
  const cases = [
    ['missing', 'question-secret-missing', 1, 'stale_interaction'],
    ['other-session', 'question-secret-other-session', 1, 'stale_interaction'],
    ['wrong-kind', 'question-secret-wrong-kind', 1, 'chat_interaction_kind_mismatch'],
    ['stale', 'question-secret-stale', 2, 'stale_interaction'],
  ];

  for (const [suffix, interactionId, revision, expectedCode] of cases) {
    const commandId = `question-secret-invalid-${suffix}`;
    await assert.rejects(actor.dispatch(command(
      session.sessionId,
      commandId,
      'interaction.answer',
      {
        interactionId,
        revision,
        action: 'submit',
        answer: { token: ['never-persist-this-secret'] }
      }
    )), (error) => error.code === expectedCode);
    assert.equal(store.getCommand(commandId), null);
  }

  assert.equal(nativeSends, 0);
  assert.doesNotMatch(JSON.stringify([
    store.listEvents(session.sessionId),
    store.listEvents(other.sessionId)
  ]), /never-persist-this-secret/);
});

test('provider failure persists only the redacted secret command projection', async (t) => {
  const providerFailure = Object.assign(new Error(
    'native response failed Authorization: Bearer provider-error-secret'
  ), {
    code: 'codex_app_server_disconnected', statusCode: 503
  });
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      answerInteraction() { throw providerFailure; }
    })
  });
  store.createInteraction({
    interactionId: 'question-secret-provider-failure',
    sessionId: session.sessionId,
    itemId: 'question-secret-provider-failure-item',
    kind: 'question',
    revision: 1,
    payload: secretQuestionPayload()
  });

  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'question-secret-provider-failure-command',
    'interaction.answer',
    {
      interactionId: 'question-secret-provider-failure',
      revision: 1,
      action: 'submit',
      answer: { token: ['never-persist-provider-secret'] }
    }
  )), (error) => error === providerFailure);

  assert.deepEqual(
    store.getCommand('question-secret-provider-failure-command').payload.answer,
    { token: ['[secret]'] }
  );
  assert.equal(store.interactions.get('question-secret-provider-failure').state, 'pending');
  assert.equal(interactionAnswerEvents(store, session.sessionId).length, 0);
  assert.deepEqual(store.getCommand('question-secret-provider-failure-command').result, {
    code: 'codex_app_server_disconnected',
    message: 'native response failed Authorization: Bearer [redacted]',
    statusCode: 503
  });
  assert.doesNotMatch(JSON.stringify([
    store.getCommand('question-secret-provider-failure-command'),
    store.interactions.get('question-secret-provider-failure'),
    store.listEvents(session.sessionId)
  ]), /never-persist-provider-secret|provider-error-secret/);
});

test('secret question answers reach the provider but remain masked in durable state', async (t) => {
  let nativeAnswer;
  let nativeSends = 0;
  const { actor, session, store } = createFixture(t, {
    handlers: createCodexHandlers({
      answerInteraction(payload) {
        nativeSends += 1;
        nativeAnswer = structuredClone(payload.answer);
        return { responded: true };
      }
    })
  });
  store.createInteraction({
    interactionId: 'question-secret',
    sessionId: session.sessionId,
    itemId: 'question-secret-item',
    kind: 'question',
    revision: 1,
    payload: secretQuestionPayload({ includeTarget: true })
  });

  const firstInput = command(
    session.sessionId,
    'question-secret-command',
    'interaction.answer',
    {
      interactionId: 'question-secret',
      revision: 1,
      action: 'submit',
      answer: { token: ['top-secret'], target: ['web'] }
    }
  );
  const first = await actor.dispatch(firstInput);
  const sameSecretRetry = await actor.dispatch(firstInput);
  const differentSecretRetry = await actor.dispatch(command(
    session.sessionId,
    'question-secret-command',
    'interaction.answer',
    {
      interactionId: 'question-secret',
      revision: 1,
      action: 'submit',
      answer: { token: ['different-secret'], target: ['web'] }
    }
  ));

  assert.equal(first.duplicate, false);
  assert.equal(sameSecretRetry.duplicate, true);
  assert.equal(differentSecretRetry.duplicate, true);
  assert.deepEqual(sameSecretRetry.result, first.result);
  assert.deepEqual(differentSecretRetry.result, first.result);
  assert.equal(nativeSends, 1);
  assert.deepEqual(nativeAnswer, { token: ['top-secret'], target: ['web'] });
  assert.deepEqual(store.getCommand('question-secret-command').payload.answer, {
    token: ['[secret]'], target: ['web']
  });
  assert.deepEqual(store.interactions.get('question-secret').resolution.answer, {
    token: ['[secret]'], target: ['web']
  });
  assert.doesNotMatch(JSON.stringify([
    store.getCommand('question-secret-command'),
    store.interactions.get('question-secret'),
    store.listEvents(session.sessionId),
    durableInteractionJson(store)
  ]), /top-secret|different-secret/);
});

function durableInteractionJson(store) {
  return {
    commands: store.context.db.prepare(`
      SELECT payload_json, result_json FROM chat_runtime_commands
    `).all(),
    interactions: store.context.db.prepare(`
      SELECT payload_json, resolution_json FROM chat_runtime_interactions
    `).all(),
    events: store.context.db.prepare(`
      SELECT source_json, payload_json FROM chat_runtime_events
    `).all()
  };
}

test('generic policy and queue handlers compose with provider handlers', async (t) => {
  const { actor, session, store } = createFixture(t, {
    handlers: { 'runtime.prewarm': () => ({ providerReady: true }) }
  });

  const policy = await actor.dispatch(command(
    session.sessionId,
    'policy-command',
    'session.policy.set',
    { key: 'approvalMode', value: 'ask' }
  ));
  const first = await actor.dispatch(command(
    session.sessionId,
    'queue-command-1',
    'queue.add',
    { content: 'first', policy: 'after_turn' }
  ));
  const second = await actor.dispatch(command(
    session.sessionId,
    'queue-command-2',
    'queue.add',
    { content: 'second', policy: 'after_turn' }
  ));
  await actor.dispatch(command(session.sessionId, 'queue-edit', 'queue.edit', {
    queueId: second.result.queueId,
    content: 'edited'
  }));
  await actor.dispatch(command(session.sessionId, 'queue-move', 'queue.move', {
    queueId: second.result.queueId,
    beforeQueueId: first.result.queueId
  }));
  await actor.dispatch(command(session.sessionId, 'queue-remove', 'queue.remove', {
    queueId: first.result.queueId
  }));
  const prewarm = await actor.dispatch(command(
    session.sessionId,
    'prewarm-command',
    'runtime.prewarm'
  ));

  assert.deepEqual(policy.result.policy, { approvalMode: 'ask' });
  assert.deepEqual(store.getSession(session.sessionId).policy, { approvalMode: 'ask' });
  assert.deepEqual(store.listQueue(session.sessionId).map((item) => item.payload.content), [
    'edited'
  ]);
  assert.deepEqual(prewarm.result, { providerReady: true });
});

test('queue dispatch leases the selected item and starts it exactly once', async (t) => {
  const run = deferred();
  const starts = [];
  const { actor, session, store } = createFixture(t, {
    driver: {
      startTurn(context) {
        starts.push(context.command.payload.content);
        return run.promise;
      }
    }
  });
  const first = store.enqueue(session.sessionId, {
    commandId: 'queue-add-1', policy: 'after_turn', payload: { content: 'first' }
  });
  const second = store.enqueue(session.sessionId, {
    commandId: 'queue-add-2', policy: 'after_turn', payload: { content: 'second' }
  });
  const dispatch = command(session.sessionId, 'queue-dispatch', 'queue.dispatch', {
    queueId: second.queueId
  });

  const started = await actor.dispatch(dispatch);
  assert.equal(started.result.queueId, second.queueId);
  assert.deepEqual(starts, ['second']);
  assert.equal(store.queue.get(second.queueId).status, 'running');
  assert.equal(store.queue.get(first.queueId).status, 'queued');
  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'queue-dispatch-active',
    'queue.dispatch'
  )), (error) => error.code === 'chat_turn_already_active' && error.statusCode === 409);
  assert.equal(store.queue.get(first.queueId).status, 'queued');

  run.resolve({ text: 'done' });
  await actor.waitForIdle();
  const duplicate = await actor.dispatch(dispatch);

  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(starts, ['second']);
  assert.equal(store.queue.get(second.queueId).status, 'completed');
  assert.equal(store.queue.get(first.queueId).status, 'queued');
  assert.equal(store.listEvents(session.sessionId).filter((event) => (
    event.type === 'queue.item.dispatched' && event.payload.entry.queueId === second.queueId
  )).length, 1);
});

test('failed turn begin clears the in-memory run before the provider starts', async (t) => {
  let starts = 0;
  const { actor, aiHomeDir, session, store } = createFixture(t, {
    driver: {
      startTurn() {
        starts += 1;
        return Promise.resolve({ text: 'must not start' });
      }
    }
  });
  installRejectTrigger(aiHomeDir, 'reject_turn_queued', 'turn.queued');

  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'turn-begin-failure',
    'turn.submit',
    { content: 'do not start' }
  )), /reject_event/);

  assert.equal(starts, 0);
  assert.equal(actor.turn.active, null);
  assert.equal(store.getSession(session.sessionId).state, 'idle');
  assert.equal(store.getSession(session.sessionId).activeTurn, undefined);
});

test('provider settlement is watched before running phase persistence', async (t) => {
  const run = deferred();
  const failure = new Error('running phase persistence failed');
  const { actor, session, store } = createFixture(t, {
    driver: { startTurn: () => run.promise }
  });
  const transitionTurnPhase = store.transitionTurnPhase;
  store.transitionTurnPhase = (sessionId, input) => {
    if (input.event.type === 'turn.started') {
      assert.ok(actor.turn.active.settlement instanceof Promise);
      throw failure;
    }
    return transitionTurnPhase.call(store, sessionId, input);
  };

  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'turn-running-failure',
    'turn.submit',
    { content: 'keep watching' }
  )), (error) => error === failure);
  assert.ok(actor.turn.active.settlement instanceof Promise);

  run.resolve({ text: 'watched' });
  await actor.waitForIdle();

  assert.equal(actor.turn.active, null);
  assert.equal(store.getSession(session.sessionId).state, 'idle');
  assert.deepEqual(store.listEvents(session.sessionId)
    .filter((event) => event.type.startsWith('turn.'))
    .map((event) => event.type), ['turn.queued', 'turn.completed']);
});

test('failed interrupt persistence never reaches the provider or changes settlement', async (t) => {
  const run = deferred();
  let interrupts = 0;
  const { actor, aiHomeDir, session, store } = createFixture(t, {
    driver: {
      startTurn: () => run.promise,
      interruptTurn: async () => { interrupts += 1; }
    }
  });
  await actor.dispatch(command(
    session.sessionId,
    'turn-before-interrupt-failure',
    'turn.submit',
    { content: 'continue normally' }
  ));
  installRejectTrigger(
    aiHomeDir,
    'reject_interrupt_requested',
    'turn.interrupt.requested'
  );

  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'interrupt-persistence-failure',
    'turn.interrupt',
    { reason: 'user_stop' }
  )), /reject_event/);

  assert.equal(interrupts, 0);
  assert.equal(store.getSession(session.sessionId).state, 'running');
  run.resolve({ text: 'completed normally' });
  await actor.waitForIdle();
  assert.equal(store.listEvents(session.sessionId).at(-1).type, 'turn.completed');
});

test('failed interrupt rollback preserves its provider error and atomic phase', async (t) => {
  const run = deferred();
  const providerError = new Error('interrupt failed');
  const { actor, aiHomeDir, session, store } = createFixture(t, {
    driver: {
      startTurn: () => run.promise,
      interruptTurn: async () => { throw providerError; }
    }
  });
  await actor.dispatch(command(
    session.sessionId,
    'turn-before-rollback-failure',
    'turn.submit',
    { content: 'continue after failed interrupt' }
  ));
  installRejectTrigger(aiHomeDir, 'reject_interrupt_rollback', 'turn.phase.changed');

  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'interrupt-rollback-failure',
    'turn.interrupt',
    { reason: 'user_stop' }
  )), (error) => error === providerError && /reject_event/.test(error.rollbackError.message));

  assert.equal(store.getSession(session.sessionId).state, 'interrupting');
  assert.equal(store.getSession(session.sessionId).activeTurn.state, 'interrupting');
  assert.equal(store.listEvents(session.sessionId).some((event) => (
    event.type === 'turn.phase.changed'
  )), false);

  run.resolve({ text: 'completed after failed interrupt' });
  await actor.waitForIdle();
  assert.equal(actor.turn.active, null);
  assert.equal(store.getSession(session.sessionId).state, 'idle');
  assert.equal(store.listEvents(session.sessionId).at(-1).type, 'turn.completed');
});

test('failed dispatched turn settles only its running queue item', async (t) => {
  const secret = 'turn-provider-secret';
  const { actor, session, store } = createFixture(t, {
    driver: {
      startTurn: () => Promise.reject(Object.assign(
        new Error(`provider failed api_key=${secret}`),
        { code: 'provider_turn_failed' }
      ))
    }
  });
  const item = store.enqueue(session.sessionId, {
    commandId: 'queue-add-1', policy: 'after_turn', payload: { content: 'fail' }
  });

  await actor.dispatch(command(session.sessionId, 'queue-dispatch', 'queue.dispatch'));
  await actor.waitForIdle();

  assert.equal(store.queue.get(item.queueId).status, 'failed');
  assert.equal(store.getSession(session.sessionId).state, 'idle');
  const terminal = store.listEvents(session.sessionId).at(-1);
  assert.equal(terminal.type, 'turn.failed');
  assert.deepEqual(terminal.payload.error, {
    code: 'provider_turn_failed',
    message: 'provider failed api_key=[redacted]'
  });
  assert.deepEqual(store.queue.get(item.queueId).result.error, terminal.payload.error);
  assert.doesNotMatch(JSON.stringify([terminal, store.queue.get(item.queueId)]), new RegExp(secret));
});

test('interrupt reaches an active turn and never drains its queued message', async (t) => {
  const run = deferred();
  const interrupted = [];
  const driver = {
    startTurn() { return run.promise; },
    async interruptTurn(context) { interrupted.push(context.turnId); }
  };
  const { actor, session, store } = createFixture(t, { driver });
  store.enqueue(session.sessionId, {
    commandId: 'queued-command',
    policy: 'after_turn',
    payload: { content: 'do this later' }
  });

  const started = await actor.dispatch(command(
    session.sessionId,
    'turn-command',
    'turn.submit',
    { content: 'long task' }
  ));
  assert.equal(started.result.state, 'running');
  const lifecycle = store.listEvents(session.sessionId).filter((event) => (
    event.type === 'turn.queued' || event.type === 'turn.started'
  ));
  assert.deepEqual(lifecycle.map((event) => event.payload.state), ['starting', 'running']);
  assert.equal(lifecycle.every((event) => event.payload.activeTurn.turnId === started.result.turnId), true);

  await assert.rejects(actor.dispatch(command(
    session.sessionId,
    'second-turn-command',
    'turn.submit',
    { content: 'must not overlap' }
  )), (error) => error.code === 'chat_turn_already_active' && error.statusCode === 409);

  await actor.dispatch(command(
    session.sessionId,
    'interrupt-command',
    'turn.interrupt',
    { reason: 'user_stop' }
  ));
  assert.deepEqual(interrupted, [started.result.turnId]);
  const interruptEvent = store.listEvents(session.sessionId)
    .find((event) => event.type === 'turn.interrupt.requested');
  assert.equal(interruptEvent.payload.state, 'interrupting');
  assert.equal(interruptEvent.payload.activeTurn.state, 'interrupting');
  assert.equal(store.listQueue(session.sessionId)[0].status, 'queued');

  run.reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
  await actor.waitForIdle();
  assert.equal(store.getSession(session.sessionId).state, 'idle');
  assert.equal(store.listQueue(session.sessionId)[0].status, 'queued');
  assert.equal(
    store.listEvents(session.sessionId).some((event) => event.type === 'queue.item.dispatched'),
    false
  );
  assert.equal(
    store.listEvents(session.sessionId).some((event) => event.type === 'turn.interrupted'),
    true
  );
  const terminal = store.listEvents(session.sessionId).find((event) => (
    event.type === 'turn.interrupted'
  ));
  assert.equal(terminal.payload.state, 'idle');
  assert.equal(terminal.payload.activeTurn, undefined);
});

test('completed driver run clears the active turn without publishing provider results', async (t) => {
  const run = deferred();
  const { actor, session, store } = createFixture(t, {
    driver: { startTurn: () => run.promise }
  });
  const settleTurn = store.settleTurn.bind(store);
  store.settleTurn = (sessionId, input) => {
    const settled = settleTurn(sessionId, input);
    assert.equal(store.getSession(sessionId).state, 'idle');
    assert.equal(input.event.payload.state, 'idle');
    return settled;
  };
  const started = await actor.dispatch(command(
    session.sessionId,
    'turn-command',
    'turn.submit',
    { content: 'finish' }
  ));

  assert.equal(store.getSession(session.sessionId).activeTurn.turnId, started.result.turnId);
  run.resolve({
    text: 'done',
    providerTurnId: 'provider-turn-1',
    nativeSessionId: 'provider-session-1'
  });
  await actor.waitForIdle();

  assert.equal(store.getSession(session.sessionId).state, 'idle');
  assert.equal(store.getSession(session.sessionId).activeTurn, undefined);
  const turnEvents = store.listEvents(session.sessionId)
    .filter((event) => event.type.startsWith('turn.'));
  assert.equal(turnEvents[0].payload.activeTurn.state, 'starting');
  assert.equal(turnEvents[1].payload.activeTurn.state, 'running');
  const completed = store.listEvents(session.sessionId).at(-1);
  assert.equal(completed.type, 'turn.completed');
  assert.deepEqual(completed.payload, { state: 'idle' });
});

test('terminal persistence failure never strands a completing in-memory turn', async (t) => {
  const run = deferred();
  const { actor, aiHomeDir, session, store } = createFixture(t, {
    driver: { startTurn: () => run.promise }
  });
  await actor.dispatch(command(
    session.sessionId,
    'turn-terminal-persistence-failure',
    'turn.submit',
    { content: 'finish once' }
  ));
  installRejectTrigger(aiHomeDir, 'reject_turn_completed', 'turn.completed');

  run.resolve({ text: 'done' });
  await actor.waitForIdle();

  assert.equal(actor.turn.active, null);
  assert.equal(store.getSession(session.sessionId).state, 'running');
  assert.equal(store.getSession(session.sessionId).activeTurn.state, 'running');
  assert.equal(store.listEvents(session.sessionId).some((event) => (
    event.payload && event.payload.state === 'completing'
  )), false);
});
