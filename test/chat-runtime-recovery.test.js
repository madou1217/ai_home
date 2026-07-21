'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createChatRuntimeService } = require('../lib/server/chat-runtime-service');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const {
  approvalPayload,
  questionPayload
} = require('./chat-runtime-interaction-fixtures');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-recovery-'));
  let nextId = 0;
  const storeOptions = {
    fs,
    aiHomeDir,
    DatabaseSync,
    clock: () => 5000 + nextId,
    idFactory: (prefix) => `${prefix}-${++nextId}`
  };
  const resources = [];
  t.after(() => {
    resources.reverse().forEach((resource) => resource.close());
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return {
    openService(driver) {
      const service = createChatRuntimeService({
        storeOptions,
        runtimeResolver: {
          resolve: () => ({
            provider: 'codex', runtimeScope: 'account-1',
            fingerprint: 'runtime-1', generation: 1
          })
        },
        driverRegistry: { resolve: () => ({ driver, handlers: {} }) }
      });
      resources.push(service);
      return service;
    },
    openStore() {
      const store = openChatRuntimeStore(storeOptions);
      resources.push(store);
      return store;
    }
  };
}

function createSession(store, overrides = {}) {
  return store.createSession({
    sessionId: 'session-1',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    runtimeBinding: {
      runtimeId: 'codex:account-1',
      nativeSessionId: 'native-thread-1',
      fingerprint: 'runtime-1',
      runtimeGeneration: 1
    },
    ...overrides
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

function seedActiveRun(store, options = {}) {
  const session = createSession(store);
  const queue = store.enqueue(session.sessionId, {
    commandId: 'queue-add', policy: 'after_turn', payload: { content: 'queued work' }
  });
  store.leaseQueueItem(session.sessionId, { queueId: queue.queueId, leaseId: 'lease-1' });
  if (options.queueState !== 'leased') store.markQueueRunning(queue.queueId, 'lease-1');
  store.createInteraction({
    interactionId: 'approval-1', sessionId: session.sessionId,
    itemId: 'approval-item-1', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });
  store.acceptCommand({
    commandId: 'accepted-before-restart', sessionId: session.sessionId,
    type: 'runtime.prewarm', payload: {}
  });
  store.setSessionState(session.sessionId, 'waiting_input', {
    turnId: 'turn-1', runId: 'run-1', state: 'waiting_input'
  });
  return { queue, session };
}

test('service restart reattaches one active run and preserves pending interaction ownership', async (t) => {
  const fixture = createFixture(t);
  const seed = fixture.openStore();
  const { queue, session } = seedActiveRun(seed, { queueState: 'leased' });
  seed.close();
  const run = deferred();
  let recoveryContext;
  const service = fixture.openService({
    startTurn: async () => ({}),
    async recoverTurn(context) {
      recoveryContext = context;
      return { done: run.promise };
    }
  });

  await service.waitForRecovery();

  assert.equal(recoveryContext.activeTurn.runId, 'run-1');
  assert.equal(recoveryContext.pendingInteractions[0].interactionId, 'approval-1');
  assert.equal(recoveryContext.queue.queueId, queue.queueId);
  assert.equal(service.store.getCommand('accepted-before-restart').status, 'failed');
  assert.equal(service.store.queue.get(queue.queueId).status, 'running');
  assert.equal(service.store.interactions.get('approval-1').state, 'pending');
  assert.equal(service.getSnapshot(session.sessionId).state, 'waiting_input');
  assert.equal(eventTypes(service, session.sessionId).includes('run.reattached'), true);

  run.resolve({ recovered: true });
  await waitForState(service, session.sessionId, 'idle');
  assert.equal(service.store.queue.get(queue.queueId).status, 'completed');
  assert.equal(service.store.interactions.get('approval-1').state, 'expired');
});

test('restart converges orphaned leases, running work, interactions and accepted commands', async (t) => {
  const fixture = createFixture(t);
  const seed = fixture.openStore();
  const session = createSession(seed, { runtimeBinding: { runtimeId: 'codex:account-1' } });
  const leased = seed.enqueue(session.sessionId, {
    commandId: 'lease-command', policy: 'after_turn', payload: { content: 'safe retry' }
  });
  seed.leaseQueueItem(session.sessionId, { queueId: leased.queueId, leaseId: 'lease-orphan' });
  const running = seed.enqueue(session.sessionId, {
    commandId: 'run-command', policy: 'after_turn', payload: { content: 'uncertain work' }
  });
  seed.leaseQueueItem(session.sessionId, { queueId: running.queueId, leaseId: 'run-orphan' });
  seed.markQueueRunning(running.queueId, 'run-orphan');
  seed.createInteraction({
    interactionId: 'orphan-question', sessionId: session.sessionId,
    itemId: 'question-item', kind: 'question', payload: questionPayload()
  });
  seed.acceptCommand({
    commandId: 'orphan-command', sessionId: session.sessionId,
    type: 'runtime.prewarm', payload: {}
  });
  seed.setSessionState(session.sessionId, 'running', null);
  seed.close();
  let driverCalls = 0;
  const service = fixture.openService({
    startTurn: async () => ({}),
    recoverTurn() { driverCalls += 1; }
  });

  await service.waitForRecovery();

  assert.equal(driverCalls, 0);
  assert.equal(service.getSnapshot(session.sessionId).state, 'idle');
  assert.equal(service.store.queue.get(leased.queueId).status, 'queued');
  assert.equal(service.store.queue.get(leased.queueId).leaseId, undefined);
  assert.equal(service.store.queue.get(running.queueId).status, 'failed');
  assert.equal(service.store.interactions.get('orphan-question').state, 'expired');
  assert.equal(service.store.getCommand('orphan-command').status, 'failed');
});

test('failed provider reattach fails closed and makes the session usable for a new turn', async (t) => {
  const fixture = createFixture(t);
  const seed = fixture.openStore();
  const { queue, session } = seedActiveRun(seed);
  seed.close();
  const failure = Object.assign(new Error('native thread gone'), {
    code: 'codex_native_turn_recovery_missing',
    nativeCleanup: 'failed'
  });
  const service = fixture.openService({
    startTurn: async () => ({}),
    async recoverTurn() { throw failure; }
  });

  await service.waitForRecovery();

  assert.equal(service.getSnapshot(session.sessionId).state, 'idle');
  assert.equal(service.store.queue.get(queue.queueId).status, 'failed');
  assert.equal(service.store.interactions.get('approval-1').state, 'expired');
  const lost = service.store.listEvents(session.sessionId).find(({ type }) => type === 'run.lost');
  assert.equal(lost.runId, 'run-1');
  assert.equal(lost.payload.error.code, failure.code);
  assert.equal(lost.payload.error.nativeCleanup, 'failed');
});

test('restart resets a resolving claim before fail-closed replay recovery', async (t) => {
  const fixture = createFixture(t);
  const seed = fixture.openStore();
  const { session } = seedActiveRun(seed);
  seed.interactions.claimResolution('approval-1', {
    sessionId: session.sessionId,
    revision: 1,
    resolution: { decision: 'allow' }
  });
  assert.equal(seed.interactions.get('approval-1').state, 'resolving');
  seed.close();
  let recoveryInteraction;
  const service = fixture.openService({
    startTurn: async () => ({}),
    async recoverTurn(context) {
      recoveryInteraction = context.pendingInteractions[0];
      const error = new Error('pending request was not replayed');
      error.code = 'codex_pending_interaction_replay_missing';
      throw error;
    }
  });

  await service.waitForRecovery();

  assert.equal(recoveryInteraction.state, 'pending');
  assert.equal(recoveryInteraction.resolution, undefined);
  assert.equal(service.store.interactions.get('approval-1').state, 'expired');
  assert.equal(service.getSnapshot(session.sessionId).state, 'idle');
});

function eventTypes(service, sessionId) {
  return service.store.listEvents(sessionId).map(({ type }) => type);
}

async function waitForState(service, sessionId, expected) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (service.getSnapshot(sessionId).state === expected) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(service.getSnapshot(sessionId).state, expected);
}
