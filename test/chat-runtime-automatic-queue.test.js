'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  createChatRuntimeService
} = require('../lib/server/chat-runtime-service');

test('queue lease filters FIFO by policy and deduplicates a boundary item', async (t) => {
  const { service } = createFixture(t);
  const session = await createSession(service);
  const afterTurn = enqueue(service, session.sessionId, 'after-turn', 'after_turn');
  const firstTool = enqueue(service, session.sessionId, 'first-tool', 'after_tool_boundary');
  const secondTool = enqueue(service, session.sessionId, 'second-tool', 'after_tool_boundary');

  const first = service.store.leaseNextQueueItem(session.sessionId, {
    leaseId: 'lease-tool-1', policy: 'after_tool_boundary', boundaryItemId: 'tool-1'
  });
  const duplicate = service.store.leaseNextQueueItem(session.sessionId, {
    leaseId: 'lease-tool-duplicate', policy: 'after_tool_boundary', boundaryItemId: 'tool-1'
  });
  const second = service.store.leaseNextQueueItem(session.sessionId, {
    leaseId: 'lease-tool-2', policy: 'after_tool_boundary', boundaryItemId: 'tool-2'
  });
  const manual = service.store.leaseNextQueueItem(session.sessionId, {
    leaseId: 'lease-manual'
  });

  assert.equal(first.queueId, firstTool.queueId);
  assert.equal(first.boundaryItemId, 'tool-1');
  assert.equal(duplicate, null);
  assert.equal(second.queueId, secondTool.queueId);
  assert.equal(manual.queueId, afterTurn.queueId);
});

test('live tool completion steers one queued item through an idempotent actor command', async (t) => {
  const interventions = [];
  const { service, runs } = createFixture(t, {
    intervene: async (payload) => {
      interventions.push(payload);
      return { steered: true };
    }
  });
  const session = await createSession(service);
  const started = await submitTurn(service, session.sessionId, 'current work');
  const queued = enqueue(
    service, session.sessionId, 'focus on tests', 'after_tool_boundary'
  );
  const subagentQueued = enqueue(
    service, session.sessionId, 'review the result', 'after_tool_boundary'
  );

  appendToolBoundary(service, session.sessionId, started.result, 'tool-live-1', 'tool');
  await waitFor(() => service.store.queue.get(queued.queueId).status === 'completed');

  const item = service.store.queue.get(queued.queueId);
  assert.equal(item.boundaryItemId, 'tool-live-1');
  appendToolBoundary(
    service, session.sessionId, started.result, 'subagent-live-1', 'subagent'
  );
  await waitFor(() => (
    service.store.queue.get(subagentQueued.queueId).status === 'completed'
  ));
  assert.deepEqual(interventions, [
    { mode: 'steer_current', content: 'focus on tests' },
    { mode: 'steer_current', content: 'review the result' }
  ]);
  assert.deepEqual(internalCommands(service, 'turn.intervene').map(commandShape), [{
    payload: { content: 'focus on tests', mode: 'steer_current' }, status: 'completed'
  }, {
    payload: { content: 'review the result', mode: 'steer_current' }, status: 'completed'
  }]);

  runs[0].resolve({ text: 'done' });
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
});

test('history, stale runs, and a repeated boundary never consume the next item', async (t) => {
  const interventions = [];
  const { service, runs } = createFixture(t, {
    intervene: async (payload) => interventions.push(payload)
  });
  const session = await createSession(service);
  const started = await submitTurn(service, session.sessionId, 'current work');
  const first = enqueue(service, session.sessionId, 'first', 'after_tool_boundary');
  const second = enqueue(service, session.sessionId, 'second', 'after_tool_boundary');

  importToolHistory(service, session.sessionId, 'history-tool');
  appendToolBoundary(
    service, session.sessionId, { ...started.result, runId: 'stale-run' }, 'stale-tool', 'shell'
  );
  await nextTasks();
  assert.equal(service.store.queue.get(first.queueId).status, 'queued');

  appendToolBoundary(service, session.sessionId, started.result, 'tool-live-1', 'file_change');
  await waitFor(() => service.store.queue.get(first.queueId).status === 'completed');
  appendToolBoundary(service, session.sessionId, started.result, 'tool-live-1', 'file_change');
  await nextTasks();

  assert.equal(service.store.queue.get(second.queueId).status, 'queued');
  assert.equal(interventions.length, 1);

  runs[0].resolve({ text: 'done' });
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
});

test('failed automatic steer settles only the leased boundary item as failed', async (t) => {
  const failure = Object.assign(new Error('steer unavailable'), {
    code: 'native_steer_failed', statusCode: 503
  });
  const { service, runs } = createFixture(t, {
    intervene: async () => { throw failure; }
  });
  const session = await createSession(service);
  const started = await submitTurn(service, session.sessionId, 'current work');
  const queued = enqueue(service, session.sessionId, 'later', 'after_tool_boundary');

  appendToolBoundary(service, session.sessionId, started.result, 'tool-failed', 'shell');
  await waitFor(() => service.store.queue.get(queued.queueId).status === 'failed');

  const item = service.store.queue.get(queued.queueId);
  assert.equal(item.result.error.code, 'native_steer_failed');
  assert.equal(internalCommands(service, 'turn.intervene')[0].status, 'failed');

  runs[0].resolve({ text: 'done' });
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
});

test('turn terminals wait for actor idle and drain after-turn items one by one', async (t) => {
  const { service, runs, starts } = createFixture(t);
  const session = await createSession(service);
  await submitTurn(service, session.sessionId, 'current work');
  const tool = enqueue(service, session.sessionId, 'tool-boundary', 'after_tool_boundary');
  const afterTurn = enqueue(service, session.sessionId, 'next turn', 'after_turn');
  const finalTurn = enqueue(service, session.sessionId, 'final turn', 'after_turn');

  runs[0].resolve({ text: 'done' });
  await waitFor(() => starts.length === 2);

  assert.deepEqual(starts.map(({ command }) => command.payload.content), [
    'current work', 'next turn'
  ]);
  assert.equal(service.store.queue.get(tool.queueId).status, 'queued');
  assert.equal(service.store.queue.get(afterTurn.queueId).status, 'running');
  assert.deepEqual(internalCommands(service, 'queue.dispatch').map(commandShape), [{
    payload: { policy: 'after_turn' }, status: 'completed'
  }]);

  runs[1].resolve({ text: 'next done' });
  await waitFor(() => starts.length === 3);
  assert.equal(service.store.queue.get(afterTurn.queueId).status, 'completed');
  assert.deepEqual(service.store.queue.get(afterTurn.queueId).result, {});
  assert.equal(service.store.queue.get(finalTurn.queueId).status, 'running');
  assert.deepEqual(starts.map(({ command }) => command.payload.content), [
    'current work', 'next turn', 'final turn'
  ]);

  runs[2].resolve({ text: 'final done' });
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  assert.equal(service.store.queue.get(finalTurn.queueId).status, 'completed');
});

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-auto-queue-'));
  let nextId = 0;
  const starts = [];
  const runs = [];
  const driver = {
    startTurn(context) {
      const run = deferred();
      starts.push(context);
      runs.push(run);
      return run.promise;
    }
  };
  const service = createChatRuntimeService({
    storeOptions: {
      fs, aiHomeDir: root, DatabaseSync,
      clock: () => 1000 + nextId,
      idFactory: (prefix) => `${prefix}-${++nextId}`
    },
    driverRegistry: {
      resolve: () => ({
        driver,
        handlers: {
          'turn.intervene': ({ command }) => (
            options.intervene ? options.intervene(command.payload) : { steered: true }
          )
        }
      })
    },
    runtimeResolver: {
      resolve: (provider, context) => ({
        provider, runtimeScope: context.runtimeScope,
        fingerprint: `${provider}-runtime`, generation: 1
      })
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { runs, service, starts };
}

function createSession(service) {
  return service.createSession({
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo'
  });
}

function submitTurn(service, sessionId, content) {
  return service.dispatchCommand(sessionId, {
    commandId: `submit-${content}`, type: 'turn.submit', payload: { content }
  });
}

function enqueue(service, sessionId, content, policy) {
  return service.store.enqueue(sessionId, {
    commandId: `add-${content}`, payload: { content }, policy
  });
}

function appendToolBoundary(service, sessionId, run, itemId, kind) {
  return service.store.appendEvent(sessionId, {
    type: 'timeline.item.completed', turnId: run.turnId, runId: run.runId, itemId,
    source: { provider: 'codex', runtimeId: 'codex:account-1' },
    payload: { item: timelineItem(itemId, kind) }
  });
}

function importToolHistory(service, sessionId, itemId) {
  return service.store.importTimeline(sessionId, [{
    eventId: `history-${itemId}`, type: 'timeline.item.completed', at: 1, itemId,
    source: { provider: 'codex', runtimeId: 'codex:account-1' },
    payload: { item: timelineItem(itemId, 'tool') }
  }]);
}

function timelineItem(itemId, kind) {
  const details = {
    tool: { name: 'read' },
    shell: { command: 'npm test' },
    file_change: { changes: [{ path: 'file.js' }] },
    subagent: { agentId: 'reviewer-1' }
  };
  return {
    id: itemId, kind, status: 'completed', createdAt: 1, updatedAt: 2,
    detail: details[kind]
  };
}

function internalCommands(service, type) {
  return service.store.context.db.prepare(`
    SELECT type, payload_json, status FROM chat_runtime_commands
    WHERE type = ? AND command_id LIKE 'aih-auto:%' ORDER BY created_at
  `).all(type).map((row) => ({
    type: row.type, payload: JSON.parse(row.payload_json), status: row.status
  }));
}

function commandShape(command) {
  return { payload: command.payload, status: command.status };
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

async function nextTasks(count = 5) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}
