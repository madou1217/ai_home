'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { ChatRuntimeEventHub } = require('../lib/server/chat-runtime-event-hub');
const {
  createChatRuntimeService
} = require('../lib/server/chat-runtime-service');

function createFixture(t, overrides = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-service-'));
  let nextId = 0;
  const createDriver = () => ({ startTurn: async () => ({}) });
  const drivers = overrides.drivers || {
    codex: { driver: createDriver(), handlers: overrides.handlers || {} },
    claude: { driver: createDriver(), handlers: overrides.handlers || {} }
  };
  const driverRegistry = overrides.driverRegistry || {
    resolve(provider) { return drivers[provider]; }
  };
  const runtimeResolver = overrides.runtimeResolver || {
    resolve(provider, context) {
      return {
        provider,
        runtimeScope: context.runtimeScope,
        fingerprint: `${provider}-runtime`,
        generation: 1
      };
    }
  };
  const service = createChatRuntimeService({
    storeOptions: {
      fs,
      aiHomeDir,
      DatabaseSync,
      clock: () => 1000 + nextId,
      idFactory: (prefix) => `${prefix}-${++nextId}`
    },
    driverRegistry,
    runtimeResolver,
    eventHub: overrides.eventHub,
    eventRetentionLimit: overrides.eventRetentionLimit,
    catalog: overrides.catalog,
    artifactReader: overrides.artifactReader,
    traceFactory: overrides.traceFactory,
    traceSink: overrides.traceSink
  });
  t.after(() => {
    service.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return { aiHomeDir, service };
}

async function createSession(service, overrides = {}) {
  return service.createSession({
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo/one',
    ...overrides
  });
}

test('service resolves one default runtime and publishes session only after persistence', async (t) => {
  const eventHub = new ChatRuntimeEventHub();
  let service;
  let observedSession;
  const runtimeCalls = [];
  const { service: createdService } = createFixture(t, {
    eventHub,
    runtimeResolver: {
      resolve(provider, context) {
        runtimeCalls.push({ provider, context });
        return {
          provider,
          runtimeScope: context.runtimeScope,
          fingerprint: 'runtime-fingerprint',
          generation: 3
        };
      }
    }
  });
  service = createdService;
  eventHub.subscribe('stable-session', (event) => {
    observedSession = service.store.getSession(event.sessionId);
  });

  const session = await service.createSession({
    sessionId: 'stable-session',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo/one'
  });

  assert.equal(observedSession.sessionId, session.sessionId);
  assert.equal(session.runtimeBinding.runtimeId, 'codex:account-1');
  assert.equal(session.runtimeBinding.fingerprint, 'runtime-fingerprint');
  assert.equal(session.runtimeBinding.runtimeGeneration, 3);
  assert.equal(session.projectPath, '/repo/one');
  assert.deepEqual(session.runtimeBinding, {
    fingerprint: 'runtime-fingerprint',
    runtimeGeneration: 3,
    runtimeId: 'codex:account-1'
  });
  assert.deepEqual(runtimeCalls, [{
    provider: 'codex',
    context: { runtimeScope: 'account-1' }
  }]);
});

test('fresh project path remains metadata while client runtime binding is ignored', async (t) => {
  const { service } = createFixture(t);
  const session = await createSession(service, {
    projectPath: '/repo/canonical',
    runtimeBinding: {
      nativeSessionId: 'native-session-1',
      projectPath: '/repo/untrusted-binding'
    }
  });

  assert.equal(session.projectPath, '/repo/canonical');
  assert.equal(Object.hasOwn(session.runtimeBinding, 'nativeSessionId'), false);
  assert.equal(Object.hasOwn(session.runtimeBinding, 'projectPath'), false);
});

test('fresh session replaces client-owned runtime state with provider metadata', async (t) => {
  const capabilities = {
    revision: 'server-capabilities',
    capabilities: { 'turn.submit': { support: 'native' } }
  };
  const { service } = createFixture(t, {
    driverRegistry: {
      resolve() {
        return {
          driver: { startTurn: async () => ({}) },
          capabilities
        };
      }
    },
    runtimeResolver: {
      resolve(provider, context) {
        return {
          provider,
          runtimeScope: context.runtimeScope,
          fingerprint: 'server-fingerprint',
          generation: 7,
          version: '0.143.0'
        };
      }
    }
  });

  const session = await createSession(service, {
    state: 'running',
    nativeSessionId: 'client-native-id',
    runtimeBinding: {
      nativeSessionId: 'client-native-binding',
      runtimeId: 'client-runtime',
      fingerprint: 'client-fingerprint',
      runtimeGeneration: 99,
      version: 'client-version'
    },
    capabilitySnapshot: { revision: 'client-capabilities' },
    activeTurn: { turnId: 'client-turn' }
  });

  assert.equal(session.state, 'idle');
  assert.deepEqual(session.runtimeBinding, {
    fingerprint: 'server-fingerprint',
    runtimeGeneration: 7,
    runtimeId: 'codex:account-1',
    version: '0.143.0'
  });
  assert.deepEqual(session.capabilitySnapshot, capabilities);
  assert.equal(Object.hasOwn(session, 'activeTurn'), false);
});

test('create disposes its prepared driver when session persistence fails', async (t) => {
  const drivers = [];
  const { service } = createFixture(t, {
    driverRegistry: disposableDriverRegistry(drivers)
  });
  await createSession(service, { sessionId: 'session-conflict' });

  await assert.rejects(
    createSession(service, { sessionId: 'session-conflict' }),
    (error) => error.code === 'chat_session_id_conflict'
  );

  assert.equal(drivers.length, 2);
  assert.equal(drivers[0].disposed, false);
  assert.equal(drivers[1].disposed, true);
});

test('service resolves one stable session for a native provider session', async (t) => {
  const { service } = createFixture(t);
  const input = {
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo/one',
    nativeSessionId: 'thread-1',
    policy: { approvalMode: 'ask' }
  };

  const created = await service.resolveSession(input);
  const adopted = await service.resolveSession(input);

  assert.equal(created.status, 'created');
  assert.equal(adopted.status, 'adopted');
  assert.equal(adopted.session.sessionId, created.session.sessionId);
  assert.equal(adopted.session.runtimeBinding.nativeSessionId, 'thread-1');
  assert.equal(Object.hasOwn(adopted.session, 'nativeSessionId'), false);
  assert.equal(service.listSessions().length, 1);
});

test('service resumes one native session with a different execution credential', async (t) => {
  const runtimeCalls = [];
  const drivers = [];
  const { service } = createFixture(t, {
    driverRegistry: disposableDriverRegistry(drivers),
    runtimeResolver: {
      resolve(provider, context) {
        runtimeCalls.push({ provider, context });
        return {
          provider,
          runtimeScope: context.runtimeScope,
          fingerprint: `${provider}:${context.runtimeScope}`,
          generation: 1
        };
      }
    }
  });
  const identity = {
    provider: 'codex',
    projectPath: '/repo/one',
    nativeSessionId: 'thread-switch'
  };

  const created = await service.resolveSession({
    ...identity,
    executionAccountRef: 'account-1'
  });
  service.store.appendEvent(created.session.sessionId, {
    type: 'timeline.item.completed',
    source: { provider: 'codex', runtimeId: 'codex:account-1' },
    payload: { item: timelineItem('before-credential-switch', 10) }
  });
  const resumed = await service.resolveSession({
    ...identity,
    executionAccountRef: 'account-2'
  });

  assert.equal(resumed.status, 'adopted');
  assert.equal(resumed.session.sessionId, created.session.sessionId);
  assert.equal(resumed.session.executionAccountRef, 'account-2');
  assert.equal(resumed.session.runtimeBinding.nativeSessionId, 'thread-switch');
  assert.equal(Object.hasOwn(resumed.session, 'accountRef'), false);
  assert.deepEqual(runtimeCalls.map(({ context }) => context.runtimeScope), [
    'account-1',
    'account-2'
  ]);
  assert.deepEqual(
    service.getSnapshot(resumed.session.sessionId).timeline.map(({ id }) => id),
    ['before-credential-switch']
  );
  assert.equal(drivers[0].disposed, true);
  assert.equal(drivers[1].disposed, false);
});

test('service blocks execution credential changes while a turn is active', async (t) => {
  const turn = deferred();
  const { service } = createFixture(t, {
    driverRegistry: {
      resolve() {
        return { driver: { startTurn: () => turn.promise } };
      }
    }
  });
  const identity = {
    provider: 'codex',
    projectPath: '/repo/one',
    nativeSessionId: 'thread-active-switch'
  };
  const { session } = await service.resolveSession({
    ...identity,
    executionAccountRef: 'account-1'
  });
  const running = service.dispatchCommand(session.sessionId, {
    commandId: 'turn-active-switch',
    type: 'turn.submit',
    payload: { content: 'work' }
  });
  await waitForSessionState(service, session.sessionId, 'running');

  await assert.rejects(
    service.resolveSession({ ...identity, executionAccountRef: 'account-2' }),
    (error) => error.code === 'chat_execution_credential_change_conflict'
  );
  assert.equal(
    service.listSessions({ nativeSessionId: identity.nativeSessionId })[0].executionAccountRef,
    'account-1'
  );

  turn.resolve({ status: 'completed' });
  await running;
});

test('concurrent native resolution disposes the prepared driver that loses adoption', async (t) => {
  const drivers = [];
  const { service } = createFixture(t, {
    driverRegistry: disposableDriverRegistry(drivers)
  });
  const input = {
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo/one',
    nativeSessionId: 'thread-concurrent'
  };

  const results = await Promise.all([
    service.resolveSession(input),
    service.resolveSession(input)
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ['adopted', 'created']);
  assert.equal(results[0].session.sessionId, results[1].session.sessionId);
  assert.equal(drivers.length, 2);
  assert.equal(drivers.filter(({ disposed }) => disposed).length, 1);
});

test('service resolve keeps drafts without native ids distinct', async (t) => {
  const { service } = createFixture(t);
  const input = {
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo/one'
  };

  const first = await service.resolveSession(input);
  const second = await service.resolveSession(input);

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'created');
  assert.notEqual(first.session.sessionId, second.session.sessionId);
});

test('service lists canonical sessions with provider and project filters', async (t) => {
  const { service } = createFixture(t);
  const first = await createSession(service);
  await createSession(service, {
    provider: 'claude',
    executionAccountRef: 'account-2',
    projectPath: '/repo/two'
  });

  assert.deepEqual(await service.listSessions({ provider: 'codex' }), [first]);
  const claude = service.listSessions({ provider: 'claude' })[0];
  assert.deepEqual(service.listSessions({ projectPath: '/repo/two' }), [claude]);
});

test('service lists one native session after switching its execution credential', async (t) => {
  const { service } = createFixture(t);
  const sharedIdentity = {
    provider: 'codex',
    projectPath: '/repo/shared',
    nativeSessionId: 'native-thread-shared'
  };
  await service.resolveSession({ ...sharedIdentity, executionAccountRef: 'account-1' });
  await service.resolveSession({ ...sharedIdentity, executionAccountRef: 'account-2' });
  await service.resolveSession({
    ...sharedIdentity,
    executionAccountRef: 'account-other',
    nativeSessionId: 'native-thread-other'
  });

  const sessions = await service.listSessions(sharedIdentity);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].executionAccountRef, 'account-2');
});

test('unknown provider driver fails closed before a session is persisted', async (t) => {
  const { service } = createFixture(t, {
    driverRegistry: { resolve() { return null; } }
  });

  await assert.rejects(createSession(service), (error) => {
    assert.equal(error.code, 'chat_provider_driver_unavailable');
    assert.equal(error.statusCode, 422);
    return true;
  });
  assert.deepEqual(await service.listSessions(), []);
});

test('dispatch binds the path session id and publishes handler events once', async (t) => {
  const published = [];
  const { service } = createFixture(t, {
    handlers: {
      'session.policy.set': ({ sessionId, command, store }) => {
        store.updatePolicy(sessionId, command.payload);
        return { applied: true };
      }
    }
  });
  const session = await createSession(service, { sessionId: 'session-policy' });
  service.subscribe(session.sessionId, (event) => published.push(event.type));

  const result = await service.dispatchCommand(session.sessionId, {
    commandId: 'command-policy',
    sessionId: 'untrusted-body-id',
    type: 'session.policy.set',
    payload: { approvalMode: 'ask' }
  });

  assert.equal(result.sessionId, session.sessionId);
  assert.equal(result.duplicate, false);
  assert.deepEqual(service.getSnapshot(session.sessionId).policy, { approvalMode: 'ask' });
  assert.deepEqual(published, ['session.policy.changed']);
});

test('service queue CRUD persists and publishes each generic mutation once', async (t) => {
  const { service } = createFixture(t);
  const session = await createSession(service);
  const published = [];
  service.subscribe(session.sessionId, (event) => published.push(event.type));

  const first = await service.dispatchCommand(session.sessionId, {
    commandId: 'queue-add-1',
    type: 'queue.add',
    payload: { content: 'first', policy: 'after_turn' }
  });
  const second = await service.dispatchCommand(session.sessionId, {
    commandId: 'queue-add-2',
    type: 'queue.add',
    payload: { content: 'second', policy: 'after_turn' }
  });
  await service.dispatchCommand(session.sessionId, {
    commandId: 'queue-edit',
    type: 'queue.edit',
    payload: { queueId: second.result.queueId, content: 'edited' }
  });
  await service.dispatchCommand(session.sessionId, {
    commandId: 'queue-move',
    type: 'queue.move',
    payload: { queueId: second.result.queueId, beforeQueueId: first.result.queueId }
  });
  await service.dispatchCommand(session.sessionId, {
    commandId: 'queue-remove',
    type: 'queue.remove',
    payload: { queueId: first.result.queueId }
  });

  assert.deepEqual(service.getSnapshot(session.sessionId).queue.map((item) => ({
    content: item.payload.content,
    queueId: item.queueId
  })), [{ content: 'edited', queueId: second.result.queueId }]);
  assert.deepEqual(published, [
    'queue.item.added',
    'queue.item.added',
    'queue.item.updated',
    'queue.item.moved',
    'queue.item.removed'
  ]);
});

test('service queue dispatch publishes one running and terminal lifecycle', async (t) => {
  const run = deferred();
  const starts = [];
  const driver = {
    startTurn(context) {
      starts.push(context.command.payload.content);
      return run.promise;
    }
  };
  const { service } = createFixture(t, {
    drivers: { codex: { driver, handlers: {} } }
  });
  const session = await createSession(service);
  const first = await addQueued(service, session.sessionId, 'queue-add-1', 'first');
  const second = await addQueued(service, session.sessionId, 'queue-add-2', 'second');
  const published = [];
  service.subscribe(session.sessionId, (event) => published.push(event.type));
  const dispatch = {
    commandId: 'queue-dispatch',
    type: 'queue.dispatch',
    payload: { queueId: second.result.queueId }
  };

  const started = await service.dispatchCommand(session.sessionId, dispatch);
  const duplicate = await service.dispatchCommand(session.sessionId, dispatch);

  assert.equal(started.result.queueId, second.result.queueId);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(starts, ['second']);
  assert.equal(service.store.queue.get(second.result.queueId).status, 'running');

  run.resolve({ text: 'done' });
  await waitForSessionState(service, session.sessionId, 'idle');

  assert.equal(service.store.queue.get(second.result.queueId).status, 'completed');
  assert.equal(service.store.queue.get(first.result.queueId).status, 'queued');
  assert.deepEqual(published, [
    'queue.item.dispatched',
    'turn.queued',
    'queue.item.updated',
    'turn.started',
    'queue.item.updated',
    'turn.completed'
  ]);
});

test('service publishes failed queue settlement and leaves the next item queued', async (t) => {
  const driver = {
    startTurn: () => Promise.reject(Object.assign(
      new Error('provider failed'),
      { code: 'UPSTREAM_FAILED' }
    ))
  };
  const { service } = createFixture(t, {
    drivers: { codex: { driver, handlers: {} } }
  });
  const session = await createSession(service);
  const first = await addQueued(service, session.sessionId, 'queue-add-1', 'first');
  const second = await addQueued(service, session.sessionId, 'queue-add-2', 'second');
  const published = [];
  service.subscribe(session.sessionId, (event) => published.push(event));

  await service.dispatchCommand(session.sessionId, {
    commandId: 'queue-dispatch', type: 'queue.dispatch', payload: {}
  });
  await waitForSessionState(service, session.sessionId, 'idle');

  assert.equal(service.store.queue.get(first.result.queueId).status, 'failed');
  assert.equal(service.store.queue.get(second.result.queueId).status, 'queued');
  assert.equal(published.filter(({ type }) => type === 'queue.item.dispatched').length, 1);
  assert.deepEqual(published.slice(-2).map(({ type }) => type), [
    'queue.item.updated',
    'turn.failed'
  ]);
  assert.equal(published.at(-1).payload.error.code, 'UPSTREAM_FAILED');
});

test('readEvents replays after a cursor and resets from snapshot across retention gap', async (t) => {
  const { service } = createFixture(t, { eventRetentionLimit: 2 });
  const session = await createSession(service);
  for (const phase of ['thinking', 'working', 'finishing']) {
    service.store.appendEvent(session.sessionId, {
      type: 'turn.phase.changed',
      source: { provider: 'codex', runtimeId: 'codex-runtime' },
      payload: { phase }
    });
  }

  const replay = await service.readEvents(session.sessionId, { after: 2 });
  assert.equal(replay.gap, false);
  assert.deepEqual(replay.events.map((event) => event.seq), [3, 4]);
  assert.equal(replay.throughSeq, 4);

  const reset = await service.readEvents(session.sessionId, { after: 1 });
  assert.equal(reset.gap, true);
  assert.equal(reset.snapshot.throughSeq, 4);
  assert.deepEqual(reset.events, []);

  const ahead = await service.readEvents(session.sessionId, { after: 99 });
  assert.equal(ahead.gap, true);
  assert.equal(ahead.snapshot.throughSeq, 4);
  assert.equal(ahead.throughSeq, 4);
});

test('dispatch scans the default runtime and rebuilds the actor after generation changes', async (t) => {
  let generation = 1;
  let runtimeResolutions = 0;
  let driverResolutions = 0;
  const handler = () => ({ ready: true });
  const { service } = createFixture(t, {
    runtimeResolver: {
      resolve(provider, context) {
        runtimeResolutions += 1;
        return {
          provider,
          runtimeScope: context.runtimeScope,
          fingerprint: `fingerprint-${generation}`,
          generation
        };
      }
    },
    driverRegistry: {
      resolve() {
        driverResolutions += 1;
        return {
          driver: { startTurn: async () => ({}) },
          handlers: { 'runtime.prewarm': handler }
        };
      }
    }
  });
  const session = await createSession(service);

  await service.dispatchCommand(session.sessionId, {
    commandId: 'prewarm-1', type: 'runtime.prewarm', payload: {}
  });
  generation = 2;
  await service.dispatchCommand(session.sessionId, {
    commandId: 'prewarm-2', type: 'runtime.prewarm', payload: {}
  });

  assert.equal(runtimeResolutions, 3);
  assert.equal(driverResolutions, 2);
  assert.deepEqual(service.listSessions({ provider: 'codex' })[0].runtimeBinding, {
    fingerprint: 'fingerprint-2',
    runtimeGeneration: 2,
    runtimeId: 'codex:account-1'
  });
});

test('active turn pins its actor until terminal before runtime refresh', async (t) => {
  let generation = 1;
  let runtimeResolutions = 0;
  let driverResolutions = 0;
  let finishTurn;
  const handledGenerations = [];
  const activeTurn = new Promise((resolve) => { finishTurn = resolve; });
  const { service } = createFixture(t, {
    runtimeResolver: {
      resolve(provider, context) {
        runtimeResolutions += 1;
        return {
          provider,
          runtimeScope: context.runtimeScope,
          fingerprint: `fingerprint-${generation}`,
          generation
        };
      }
    },
    driverRegistry: {
      resolve(_provider, { runtime }) {
        driverResolutions += 1;
        return {
          driver: { startTurn: () => activeTurn },
          handlers: {
            'runtime.prewarm': () => {
              handledGenerations.push(runtime.generation);
              return { ready: true };
            }
          }
        };
      }
    }
  });
  const session = await createSession(service);
  await service.dispatchCommand(session.sessionId, {
    commandId: 'turn-active', type: 'turn.submit', payload: { content: 'work' }
  });
  generation = 2;

  await service.dispatchCommand(session.sessionId, {
    commandId: 'control-on-active-runtime', type: 'runtime.prewarm', payload: {}
  });
  assert.deepEqual(handledGenerations, [1]);
  assert.equal(runtimeResolutions, 2);
  assert.equal(driverResolutions, 1);
  assert.equal(service.store.getSession(session.sessionId).runtimeBinding.runtimeGeneration, 1);

  finishTurn({ text: 'done' });
  await waitForSessionState(service, session.sessionId, 'idle');
  await service.dispatchCommand(session.sessionId, {
    commandId: 'control-after-terminal', type: 'runtime.prewarm', payload: {}
  });

  assert.deepEqual(handledGenerations, [1, 2]);
  assert.equal(driverResolutions, 2);
  assert.equal(service.store.getSession(session.sessionId).runtimeBinding.runtimeGeneration, 2);
});

test('readTimeline returns chronological pages with an exclusive item cursor', async (t) => {
  const { service } = createFixture(t);
  const session = await createSession(service);
  for (const [index, id] of ['item-a', 'item-b', 'item-c'].entries()) {
    service.store.appendEvent(session.sessionId, {
      type: 'timeline.item.started',
      source: { provider: 'codex', runtimeId: 'codex-runtime' },
      payload: { item: timelineItem(id, 2000 + index) }
    });
  }

  const newest = await service.readTimeline(session.sessionId, { limit: 2 });
  assert.deepEqual(newest.items.map((item) => item.id), ['item-b', 'item-c']);
  assert.equal(newest.nextBefore, 'item-b');

  const older = await service.readTimeline(session.sessionId, {
    before: newest.nextBefore,
    limit: 2
  });
  assert.deepEqual(older.items.map((item) => item.id), ['item-a']);
  assert.equal(older.nextBefore, null);
});

test('catalog, artifacts, and command traces stay behind injected ports', async (t) => {
  const marks = [];
  const traces = [];
  const { service } = createFixture(t, {
    handlers: { 'runtime.prewarm': () => ({ ready: true }) },
    catalog: { list: (session) => [{ type: 'runtime.prewarm', provider: session.provider }] },
    artifactReader: { read: (artifactId) => ({ artifactId, body: Buffer.from('ok') }) },
    traceFactory: () => ({
      mark(stage) { marks.push(stage); },
      snapshot() { return { marks: [...marks] }; }
    }),
    traceSink: (trace) => traces.push(trace)
  });
  const session = await createSession(service);

  assert.deepEqual(await service.getCommandCatalog(session.sessionId), [
    { type: 'runtime.prewarm', provider: 'codex' }
  ]);
  assert.equal((await service.readArtifact('artifact-1')).body.toString(), 'ok');
  await service.dispatchCommand(session.sessionId, {
    commandId: 'command-traced',
    type: 'runtime.prewarm',
    payload: {}
  });

  assert.deepEqual(marks, [
    'actorDequeued',
    'runtimeAcquired',
    'commandPersisted',
    'completed'
  ]);
  assert.equal(traces.length, 1);
});

function timelineItem(id, createdAt) {
  return {
    id,
    kind: 'message',
    createdAt,
    status: 'completed',
    detail: { role: 'assistant' },
    content: id
  };
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

function addQueued(service, sessionId, commandId, content) {
  return service.dispatchCommand(sessionId, {
    commandId,
    type: 'queue.add',
    payload: { content, policy: 'after_turn' }
  });
}

async function waitForSessionState(service, sessionId, expected) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (service.getSnapshot(sessionId).state === expected) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`session ${sessionId} did not reach ${expected}`);
}

function disposableDriverRegistry(drivers) {
  return {
    resolve() {
      const driver = {
        disposed: false,
        startTurn: async () => ({}),
        dispose() {
          if (this.disposed) return false;
          this.disposed = true;
          return true;
        }
      };
      drivers.push(driver);
      return { driver };
    }
  };
}
