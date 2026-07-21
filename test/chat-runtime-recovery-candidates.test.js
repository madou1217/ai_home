'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  ChatRuntimeRecoveryCoordinator
} = require('../lib/server/chat-runtime-recovery-coordinator');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const {
  approvalPayload,
  questionPayload
} = require('./chat-runtime-interaction-fixtures');

test('recovery candidates are unbounded, actionable, and unique', (t) => {
  const store = createStore(t);
  const active = createSession(store, 'candidate-active');
  store.setSessionState(active.sessionId, 'running', {
    turnId: 'turn-active', runId: 'run-active', state: 'running'
  });
  const accepted = createSession(store, 'candidate-accepted');
  acceptCommand(store, accepted, 'accepted-only');
  const leased = createSession(store, 'candidate-leased');
  leaseQueue(store, leased, 'leased-only');
  const running = createSession(store, 'candidate-running-queue');
  const runningItem = leaseQueue(store, running, 'running');
  store.markQueueRunning(runningItem.queueId, 'lease-running');
  const pending = createSession(store, 'candidate-pending');
  createInteraction(store, pending, 'pending-1');
  const resolving = createSession(store, 'candidate-resolving');
  createInteraction(store, resolving, 'resolving-1', 'question');
  store.interactions.claimResolution('resolving-1', {
    sessionId: resolving.sessionId,
    revision: 1,
    resolution: { action: 'submit' }
  });
  const multi = createSession(store, 'candidate-multi');
  acceptCommand(store, multi, 'accepted-multi');
  leaseQueue(store, multi, 'multi');
  createInteraction(store, multi, 'pending-multi');
  const stateOnly = createSession(store, 'not-a-candidate-state-only');
  store.setSessionState(stateOnly.sessionId, 'running', null);
  const queuedOnly = createSession(store, 'not-a-candidate-queued');
  store.enqueue(queuedOnly.sessionId, {
    commandId: 'queue-only', policy: 'after_turn', payload: { content: 'later' }
  });
  const completed = createSession(store, 'not-a-candidate-completed-command');
  acceptCommand(store, completed, 'completed-command');
  store.completeCommand('completed-command', 'completed', {});
  const answered = createSession(store, 'not-a-candidate-answered');
  createInteraction(store, answered, 'answered-1');
  store.resolveInteraction('answered-1', { revision: 1, resolution: { decision: 'deny' } });
  for (let index = 0; index < 501; index += 1) {
    createSession(store, `idle-history-${index}`);
  }

  assert.equal(
    store.listSessions({ limit: 500 }).some(({ sessionId }) => sessionId === active.sessionId),
    false
  );
  const candidateIds = store.listRecoveryCandidates().map(({ sessionId }) => sessionId);

  assert.deepEqual(candidateIds.sort(), [
    active.sessionId,
    accepted.sessionId,
    leased.sessionId,
    multi.sessionId,
    pending.sessionId,
    resolving.sessionId,
    running.sessionId
  ].sort());
  assert.equal(candidateIds.filter((sessionId) => sessionId === multi.sessionId).length, 1);
});

test('recovery coordinator reads the focused candidate port', async () => {
  let candidateScans = 0;
  const coordinator = new ChatRuntimeRecoveryCoordinator({
    actors: { dispose() {} },
    store: {
      listRecoveryCandidates() {
        candidateScans += 1;
        return [{ sessionId: 'candidate-1' }];
      },
      listSessions() {
        throw new Error('bounded session history must not drive recovery');
      },
      beginRestartRecovery(sessionId) {
        return { recoverable: false, session: { sessionId } };
      }
    }
  });

  const results = await coordinator.start();

  assert.equal(candidateScans, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'fulfilled');
});

function createStore(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-recovery-candidates-'));
  let sequence = 0;
  const store = openChatRuntimeStore({
    fs,
    aiHomeDir,
    DatabaseSync,
    clock: () => ++sequence,
    idFactory: (prefix) => `${prefix}-${++sequence}`
  });
  t.after(() => {
    store.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return store;
}

function createSession(store, sessionId) {
  return store.createSession({
    sessionId,
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo'
  });
}

function acceptCommand(store, session, commandId) {
  return store.acceptCommand({
    commandId, sessionId: session.sessionId, type: 'runtime.prewarm', payload: {}
  });
}

function leaseQueue(store, session, suffix) {
  const queue = store.enqueue(session.sessionId, {
    commandId: `queue-${suffix}`, policy: 'after_turn', payload: { content: 'work' }
  });
  store.leaseQueueItem(session.sessionId, {
    queueId: queue.queueId, leaseId: `lease-${suffix}`
  });
  return queue;
}

function createInteraction(store, session, interactionId, kind = 'approval') {
  return store.createInteraction({
    interactionId,
    sessionId: session.sessionId,
    itemId: `item-${interactionId}`,
    kind,
    payload: kind === 'approval' ? approvalPayload() : questionPayload()
  });
}
