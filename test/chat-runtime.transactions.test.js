'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { getAppStateDbPath } = require('../lib/server/app-state-store');
const {
  InteractionResolutionCoordinator
} = require('../lib/server/chat-runtime/interaction-resolution-coordinator');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const {
  approvalPayload,
  questionPayload
} = require('./chat-runtime-interaction-fixtures');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-tx-'));
  let id = 0;
  const options = {
    fs,
    aiHomeDir,
    DatabaseSync,
    clock: () => 3000 + id,
    idFactory: (prefix) => `${prefix}-${++id}`
  };
  const stores = [openChatRuntimeStore(options)];
  t.after(() => {
    stores.forEach((store) => store.close());
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return {
    aiHomeDir,
    options,
    store: stores[0],
    openPeer() {
      const peer = openChatRuntimeStore(options);
      stores.push(peer);
      return peer;
    }
  };
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

function installReleaseRejectTrigger(aiHomeDir) {
  const db = new DatabaseSync(getAppStateDbPath(aiHomeDir));
  db.exec(`
    CREATE TRIGGER reject_interaction_release
    BEFORE UPDATE OF state ON chat_runtime_interactions
    WHEN OLD.state = 'resolving' AND NEW.state = 'pending'
    BEGIN SELECT RAISE(ABORT, 'reject_release'); END
  `);
  db.close();
}

function dropTrigger(aiHomeDir, name) {
  const db = new DatabaseSync(getAppStateDbPath(aiHomeDir));
  db.exec(`DROP TRIGGER ${name}`);
  db.close();
}

function coordinatorFor(store) {
  return new InteractionResolutionCoordinator({
    claim: (interactionId, input) => (
      store.claimInteractionResolution(interactionId, input)
    ),
    finish: (claim) => store.finishInteractionResolution(claim),
    release: (claim) => store.releaseInteractionResolution(claim)
  });
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

test('session row rolls back when its session.created event cannot persist', (t) => {
  const { aiHomeDir, store } = createFixture(t);
  installRejectTrigger(aiHomeDir, 'reject_session_created', 'session.created');

  assert.throws(() => store.createSession({
    sessionId: 'session-rollback',
    provider: 'codex',
    executionAccountRef: 'account-1'
  }), /reject_event|chat_session_id_conflict/);
  assert.equal(store.getSession('session-rollback'), null);
});

test('queue row and sequence roll back when queue event persistence fails', (t) => {
  const { aiHomeDir, store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  installRejectTrigger(aiHomeDir, 'reject_queue_added', 'queue.item.added');

  assert.throws(() => store.enqueue(session.sessionId, {
    commandId: 'command-1',
    policy: 'after_turn',
    payload: { content: 'later' }
  }), /reject_event/);
  assert.deepEqual(store.listQueue(session.sessionId), []);
  assert.equal(store.getSession(session.sessionId).lastEventSeq, 1);
});

test('two store connections allocate one monotonic event sequence', (t) => {
  const { store, openPeer } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  const peer = openPeer();
  const draft = (phase) => ({
    type: 'turn.phase.changed',
    source: { provider: 'codex', runtimeId: 'runtime-1' },
    payload: { phase }
  });

  const second = peer.appendEvent(session.sessionId, draft('thinking'));
  const third = store.appendEvent(session.sessionId, draft('working'));

  assert.equal(second.seq, 2);
  assert.equal(third.seq, 3);
  assert.deepEqual(peer.listEvents(session.sessionId).map((event) => event.seq), [1, 2, 3]);
});

test('interaction resolution is first-writer-wins across store connections', (t) => {
  const { store, openPeer } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  store.createInteraction({
    interactionId: 'approval-1',
    sessionId: session.sessionId,
    itemId: 'approval-item-1',
    kind: 'approval',
    revision: 1,
    payload: approvalPayload()
  });
  const peer = openPeer();

  const winner = peer.resolveInteraction('approval-1', {
    revision: 1,
    resolution: { decision: 'allow' }
  });

  assert.equal(winner.state, 'answered');
  assert.throws(() => store.resolveInteraction('approval-1', {
    revision: 1,
    resolution: { decision: 'deny' }
  }), (error) => error.code === 'stale_interaction' && error.statusCode === 409);
});

test('native interaction success remains durably resolving when final event commit fails', async (t) => {
  const { aiHomeDir, store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  store.createInteraction({
    interactionId: 'approval-native-first',
    sessionId: session.sessionId,
    itemId: 'approval-item-native-first',
    kind: 'approval',
    revision: 1,
    payload: approvalPayload()
  });
  installRejectTrigger(aiHomeDir, 'reject_interaction_resolved', 'interaction.resolved');
  const providerResponse = deferred();
  let nativeResponses = 0;

  const resolution = coordinatorFor(store).resolve(
    'approval-native-first',
    {
      sessionId: session.sessionId,
      revision: 1,
      resolution: { decision: 'allow' }
    },
    async () => { nativeResponses += 1; return providerResponse.promise; }
  );
  const rejected = assert.rejects(resolution, /reject_event/);

  assert.equal(store.interactions.get('approval-native-first').state, 'resolving');
  providerResponse.resolve({ responded: true });
  await rejected;

  assert.equal(nativeResponses, 1);
  assert.equal(store.interactions.get('approval-native-first').state, 'resolving');
  assert.equal(store.listEvents(session.sessionId).some(({ type }) => (
    type === 'interaction.resolved'
  )), false);

  dropTrigger(aiHomeDir, 'reject_interaction_resolved');
  const finalized = store.acknowledgeExternalInteraction('approval-native-first');
  assert.equal(finalized.state, 'answered');
  assert.deepEqual(finalized.resolution, { decision: 'allow' });
  store.acknowledgeExternalInteraction('approval-native-first');
  assert.equal(store.listEvents(session.sessionId).filter(({ type }) => (
    type === 'interaction.resolved'
  )).length, 1);
});

test('answer resolution rolls back when its user timeline event cannot persist', (t) => {
  const { aiHomeDir, store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  store.createInteraction({
    interactionId: 'question-answer-atomic',
    sessionId: session.sessionId,
    itemId: 'question-answer-atomic-item',
    kind: 'question',
    revision: 1,
    payload: questionPayload()
  });
  const claim = store.claimInteractionResolution('question-answer-atomic', {
    sessionId: session.sessionId,
    kind: 'question',
    revision: 1,
    resolution: { action: 'submit', answer: { answer: 'visible after commit' } }
  });
  installRejectTrigger(aiHomeDir, 'reject_answer_timeline', 'timeline.item.completed');

  assert.throws(() => store.finishInteractionResolution(claim), /reject_event/);
  assert.equal(store.interactions.get('question-answer-atomic').state, 'resolving');
  assert.equal(store.listEvents(session.sessionId).some(({ type }) => (
    type === 'interaction.resolved' || type === 'timeline.item.completed'
  )), false);

  dropTrigger(aiHomeDir, 'reject_answer_timeline');
  const answered = store.finishInteractionResolution(claim);
  assert.equal(answered.state, 'answered');
  assert.deepEqual(store.listEvents(session.sessionId).slice(-2).map(({ type }) => type), [
    'interaction.resolved',
    'timeline.item.completed'
  ]);
});

test('external acknowledgement before async effect completion makes finish idempotent', async (t) => {
  const { store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  store.createInteraction({
    interactionId: 'approval-external-race', sessionId: session.sessionId,
    itemId: 'approval-item-external-race', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });
  const providerResponse = deferred();

  const resolution = coordinatorFor(store).resolve(
    'approval-external-race',
    {
      sessionId: session.sessionId,
      revision: 1,
      resolution: { decision: 'allow' }
    },
    () => providerResponse.promise
  );
  const acknowledged = store.acknowledgeExternalInteraction('approval-external-race');
  providerResponse.resolve({ responded: true });

  const result = await resolution;
  assert.equal(acknowledged.state, 'answered');
  assert.equal(result.interaction.state, 'answered');
  assert.deepEqual(result.interaction.resolution, { decision: 'allow' });
  assert.equal(store.listEvents(session.sessionId).filter(({ type }) => (
    type === 'interaction.resolved'
  )).length, 1);
});

test('interaction release failure preserves the native error and resolving claim', async (t) => {
  const { aiHomeDir, store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  store.createInteraction({
    interactionId: 'approval-release-failure',
    sessionId: session.sessionId,
    itemId: 'approval-item-release-failure',
    kind: 'approval',
    revision: 1,
    payload: approvalPayload()
  });
  installReleaseRejectTrigger(aiHomeDir);
  const nativeError = new Error('native response failed');

  await assert.rejects(coordinatorFor(store).resolve(
    'approval-release-failure',
    {
      sessionId: session.sessionId,
      revision: 1,
      resolution: { decision: 'deny' }
    },
    async () => { throw nativeError; }
  ), (error) => error === nativeError);

  const interaction = store.interactions.get('approval-release-failure');
  assert.equal(interaction.state, 'resolving');
  assert.deepEqual(interaction.resolution, { decision: 'deny' });
});

test('external interaction acknowledgement is idempotent for terminal states', (t) => {
  const { store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  store.createInteraction({
    interactionId: 'approval-expired', sessionId: session.sessionId,
    itemId: 'approval-item-expired', kind: 'approval', payload: approvalPayload()
  });
  store.settleTurn(session.sessionId, { event: {
    type: 'turn.completed', turnId: 'turn-1', runId: 'run-1',
    source: { provider: 'codex', runtimeId: 'runtime-1' }, payload: {}
  } });
  const before = store.getSession(session.sessionId).lastEventSeq;

  const expired = store.acknowledgeExternalInteraction('approval-expired');

  assert.equal(expired.state, 'expired');
  assert.equal(store.getSession(session.sessionId).lastEventSeq, before);
  assert.equal(store.acknowledgeExternalInteraction('missing-interaction'), null);
});

test('a specific queue item can be leased exactly once across store connections', (t) => {
  const { store, openPeer } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  const first = store.enqueue(session.sessionId, {
    commandId: 'queue-add-1', policy: 'after_turn', payload: { content: 'first' }
  });
  const second = store.enqueue(session.sessionId, {
    commandId: 'queue-add-2', policy: 'after_turn', payload: { content: 'second' }
  });
  const peer = openPeer();

  const winner = peer.leaseQueueItem(session.sessionId, {
    queueId: second.queueId,
    leaseId: 'lease-winner'
  });
  const loser = store.leaseQueueItem(session.sessionId, {
    queueId: second.queueId,
    leaseId: 'lease-loser'
  });

  assert.equal(winner.queueId, second.queueId);
  assert.equal(loser, null);
  assert.equal(store.queue.get(first.queueId).status, 'queued');
  assert.equal(store.listEvents(session.sessionId).filter((event) => (
    event.type === 'queue.item.dispatched'
  )).length, 1);
});

test('turn settlement rolls queue state and event sequence back as one transaction', (t) => {
  const { aiHomeDir, store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  const item = store.enqueue(session.sessionId, {
    commandId: 'queue-add-1', policy: 'after_turn', payload: { content: 'work' }
  });
  store.leaseQueueItem(session.sessionId, { queueId: item.queueId, leaseId: 'lease-1' });
  store.markQueueRunning(item.queueId, 'lease-1');
  store.setSessionState(session.sessionId, 'running', {
    turnId: 'turn-1', runId: 'run-1', state: 'running'
  });
  const before = store.getSession(session.sessionId).lastEventSeq;
  installRejectTrigger(aiHomeDir, 'reject_turn_completed', 'turn.completed');

  assert.throws(() => store.settleTurn(session.sessionId, {
    queue: {
      queueId: item.queueId,
      leaseId: 'lease-1',
      outcome: 'completed',
      result: { text: 'done' }
    },
    event: {
      type: 'turn.completed',
      turnId: 'turn-1',
      runId: 'run-1',
      source: { provider: 'codex', runtimeId: 'runtime-1' },
      payload: { state: 'idle', result: { text: 'done' } }
    }
  }), /reject_event/);

  assert.equal(store.getSession(session.sessionId).state, 'running');
  assert.equal(store.queue.get(item.queueId).status, 'running');
  assert.equal(store.getSession(session.sessionId).lastEventSeq, before);
  assert.equal(store.listEvents(session.sessionId).some((event) => (
    event.type === 'turn.completed'
  )), false);
});

test('turn begin rolls starting state and queue running back with its event', (t) => {
  const { aiHomeDir, store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  const item = store.enqueue(session.sessionId, {
    commandId: 'queue-add-begin', policy: 'after_turn', payload: { content: 'work' }
  });
  store.leaseQueueItem(session.sessionId, {
    queueId: item.queueId,
    leaseId: 'lease-begin'
  });
  const before = store.getSession(session.sessionId).lastEventSeq;
  installRejectTrigger(aiHomeDir, 'reject_queue_running', 'queue.item.updated');
  const activeTurn = {
    turnId: 'turn-begin',
    runId: 'run-begin',
    clientUserMessageId: 'run-begin',
    state: 'starting'
  };

  assert.throws(() => store.beginTurn(session.sessionId, {
    activeTurn,
    queue: { queueId: item.queueId, leaseId: 'lease-begin' },
    event: {
      type: 'turn.queued',
      turnId: activeTurn.turnId,
      runId: activeTurn.runId,
      source: { provider: 'codex', runtimeId: 'runtime-1' },
      payload: { state: 'starting', activeTurn }
    }
  }), /reject_event/);

  assert.equal(store.getSession(session.sessionId).state, 'idle');
  assert.equal(store.getSession(session.sessionId).activeTurn, undefined);
  assert.equal(store.queue.get(item.queueId).status, 'leased');
  assert.equal(store.getSession(session.sessionId).lastEventSeq, before);
  assert.equal(store.listEvents(session.sessionId).some((event) => (
    event.type === 'turn.queued'
  )), false);
});

test('turn phase transition rolls session state back when its event fails', (t) => {
  const { aiHomeDir, store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  const running = {
    turnId: 'turn-transition', runId: 'run-transition',
    clientUserMessageId: 'run-transition', state: 'running'
  };
  store.setSessionState(session.sessionId, 'running', running);
  const before = store.getSession(session.sessionId).lastEventSeq;
  installRejectTrigger(
    aiHomeDir,
    'reject_interrupt_requested',
    'turn.interrupt.requested'
  );
  const interrupting = { ...running, state: 'interrupting' };

  assert.throws(() => store.transitionTurnPhase(session.sessionId, {
    state: 'interrupting',
    activeTurn: interrupting,
    event: {
      type: 'turn.interrupt.requested',
      turnId: running.turnId,
      runId: running.runId,
      source: { provider: 'codex', runtimeId: 'runtime-1' },
      payload: { state: 'interrupting', activeTurn: interrupting }
    }
  }), /reject_event/);

  assert.equal(store.getSession(session.sessionId).state, 'running');
  assert.deepEqual(store.getSession(session.sessionId).activeTurn, running);
  assert.equal(store.getSession(session.sessionId).lastEventSeq, before);
});

test('queue move rolls back positions when its event cannot persist', (t) => {
  const { aiHomeDir, store } = createFixture(t);
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  const first = store.enqueue(session.sessionId, {
    commandId: 'first', policy: 'after_turn', payload: { content: 'first' }
  });
  const second = store.enqueue(session.sessionId, {
    commandId: 'second', policy: 'after_turn', payload: { content: 'second' }
  });
  installRejectTrigger(aiHomeDir, 'reject_queue_moved', 'queue.item.moved');

  assert.throws(() => store.moveQueueItem(second.queueId, first.queueId), /reject_event/);
  assert.deepEqual(store.listQueue(session.sessionId).map((item) => item.queueId), [
    first.queueId, second.queueId
  ]);
  assert.equal(store.getSession(session.sessionId).lastEventSeq, 3);
});

test('native session adoption is first-writer-wins across store connections', (t) => {
  const { store, openPeer } = createFixture(t);
  const peer = openPeer();
  const input = {
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo/one',
    runtimeBinding: { nativeSessionId: 'thread-shared' }
  };

  const winner = store.resolveSession(input);
  const follower = peer.resolveSession(input);

  assert.equal(winner.status, 'created');
  assert.equal(follower.status, 'adopted');
  assert.equal(follower.session.sessionId, winner.session.sessionId);
  assert.equal(peer.listSessions().length, 1);
  assert.throws(() => peer.createSession({
    ...input,
    sessionId: 'session-duplicate'
  }), (error) => error.code === 'chat_session_id_conflict' && error.statusCode === 409);
});
