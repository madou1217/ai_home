'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const { createChatRuntimeService } = require('../lib/server/chat-runtime-service');
const { projectCodexSessionHistory } = require('../lib/server/chat-runtime/codex-session-history');

const source = { provider: 'codex', runtimeId: 'probe' };
const tool = (id, status = 'running') => ({ id, kind: 'shell', status, createdAt: 1000,
  detail: { callId: id, command: 'write probe marker', ...(status === 'completed' ? { exitCode: 0 } : {}) } });

function seed(store) {
  store.createSession({ sessionId: 'probe', provider: 'codex', executionAccountRef: 'probe-account',
    runtimeBinding: { nativeSessionId: 'probe-thread' } });
  store.acceptCommand({ commandId: 'submit', sessionId: 'probe', type: 'turn.submit', payload: { content: 'probe' } });
  store.beginTurn('probe', { activeTurn: { turnId: 'turn', runId: 'run', state: 'running', startedAt: 1000 },
    event: { type: 'turn.queued', turnId: 'turn', runId: 'run', source,
      payload: { state: 'running', submissionCommandId: 'submit' } } });
}

function append(store, item) {
  store.appendEvent('probe', { type: 'timeline.item.started', turnId: 'turn', runId: 'run', source,
    payload: { item: { ...item, turnId: 'turn' } } });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tool-recovery-'));
  const store = openChatRuntimeStore({ aiHomeDir: root, clock: () => 5000 });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  seed(store);
  return { root, store };
}

for (const terminal of ['turn.failed', 'turn.interrupted', 'turn.completed', 'run.lost']) {
  test(`${terminal} closes missing tool results without claiming success or changing known results`, (t) => {
    const { store } = fixture(t);
    append(store, tool('unknown'));
    append(store, tool('known', 'completed'));
    append(store, { id: 'answer', kind: 'message', status: 'running', createdAt: 2000,
      content: 'partial answer', detail: { role: 'assistant' } });
    if (terminal === 'run.lost') store.failRestartRecovery('probe', { code: 'native_gone' });
    else store.settleTurn('probe', { event: { type: terminal, turnId: 'turn', runId: 'run', source,
      payload: { state: 'idle', retryable: true, error: { code: 'connection_lost' } } } });
    const snapshot = store.getSnapshot('probe');
    assert.equal(snapshot.policy.queueControl.paused, true);
    assert.equal(snapshot.timeline.find((i) => i.id === 'unknown').status, 'unknown');
    assert.equal(snapshot.timeline.find((i) => i.id === 'unknown').detail.exitCode, undefined);
    assert.equal(snapshot.timeline.find((i) => i.id === 'known').status, 'completed');
    assert.equal(snapshot.timeline.find((i) => i.id === 'answer').status,
      terminal === 'turn.completed' ? 'completed' : terminal === 'turn.interrupted' ? 'cancelled' : 'failed');
    assert.equal(snapshot.timeline.find((i) => i.id === 'answer').detail.metrics.durationMs, 4000);
    if (terminal === 'turn.failed' || terminal === 'run.lost') {
      assert.equal(snapshot.failedTurn.retryable, false);
      assert.throws(() => store.getRetrySubmission('probe', 'turn'), /chat_retry_not_available/);
    }
  });
}

test('history closes abandoned tools and only a definitive later result resolves uncertainty', (t) => {
  const { store } = fixture(t);
  append(store, tool('unknown'));
  store.failRestartRecovery('probe', { code: 'native_gone' });
  const history = (status, toolStatus) => projectCodexSessionHistory({ thread: { id: 'probe-thread', turns: [{
    id: 'native-turn', status, startedAt: 1, completedAt: status === 'inProgress' ? null : 5,
    items: [{ id: 'unknown', type: 'commandExecution', command: 'write probe marker', status: toolStatus,
      ...(toolStatus === 'completed' ? { exitCode: 0, aggregatedOutput: 'recorded result' } : {}) }]
  }] } }, { threadId: 'probe-thread' }).events;
  assert.equal(history('interrupted', 'inProgress')[0].payload.item.status, 'unknown');
  store.importTimeline('probe', history('inProgress', 'inProgress'));
  assert.equal(store.getSnapshot('probe').timeline[0].status, 'unknown');
  store.importTimeline('probe', history('completed', 'completed'));
  assert.equal(store.getSnapshot('probe').timeline[0].status, 'completed');
  assert.equal(store.getSnapshot('probe').timeline[0].detail.exitCode, 0);
  store.importTimeline('probe', history('failed', 'inProgress'));
  assert.equal(store.getSnapshot('probe').timeline[0].status, 'completed');
  assert.equal(store.getSnapshot('probe').timeline[0].detail.exitCode, 0);
});

test('recovery settlement is atomic, idempotent and keeps compaction from running forever', (t) => {
  const { store } = fixture(t);
  store.updatePolicy('probe', { workspaceMode: 'chat', contextState: {
    usedTokens: 123, stale: false, compaction: { turnId: 'turn', status: 'running' }
  } });
  append(store, tool('unknown'));
  const before = store.getSnapshot('probe');
  const original = store.events.appendInTransaction.bind(store.events);
  store.events.appendInTransaction = (id, event, options) => {
    if (event.type === 'run.lost') throw new Error('injected disk failure');
    return original(id, event, options);
  };
  assert.throws(() => store.failRestartRecovery('probe', { code: 'native_gone' }), /injected disk failure/);
  assert.deepEqual(store.getSnapshot('probe'), before);
  store.events.appendInTransaction = original;
  store.failRestartRecovery('probe', { code: 'native_gone' });
  const snapshot = store.getSnapshot('probe');
  assert.equal(snapshot.policy.contextState.compaction.status, 'failed');
  assert.equal(snapshot.policy.contextState.usedTokens, 123);
  const count = store.listEvents('probe', { limit: 1000 }).filter((e) => e.type === 'timeline.item.completed').length;
  store.failRestartRecovery('probe', { code: 'native_gone' });
  assert.equal(store.listEvents('probe', { limit: 1000 }).filter((e) => e.type === 'timeline.item.completed').length, count);
});

// A real process exits without closing SQLite at each execution boundary. The
// external marker is the side effect; no provider credentials or upstream calls.
for (const boundary of ['intent', 'effect', 'result']) test(`process exit at ${boundary} never replays the side effect`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tool-crash-'));
  t.after(() => {
    if (process.env.AIH_TEST_KEEP_ARTIFACTS) console.log(`Tool recovery artifacts: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  });
  const script = `const fs = require('node:fs');
    const { openChatRuntimeStore } = require(${JSON.stringify(require.resolve('../lib/server/chat-runtime/store'))});
    const source = ${JSON.stringify(source)};
    const store = openChatRuntimeStore({ aiHomeDir: process.argv[1] });
    (${seed.toString()})(store);
    (${append.toString()})(store, ${JSON.stringify(tool('unknown'))});
    if (process.argv[2] !== 'intent') fs.appendFileSync(process.argv[1] + '/marker', 'executed\\n');
    if (process.argv[2] === 'result') (${append.toString()})(store, ${JSON.stringify(tool('unknown', 'completed'))});
    process.exit(73);`;
  assert.equal(spawnSync(process.execPath, ['-e', script, root, boundary], { encoding: 'utf8' }).status, 73);
  let starts = 0;
  const service = createChatRuntimeService({ storeOptions: { aiHomeDir: root },
    runtimeResolver: { resolve: () => ({ provider: 'codex', runtimeScope: 'probe-account', fingerprint: 'probe', generation: 1 }) },
    driverRegistry: { resolve: () => ({ handlers: {}, driver: {
      startTurn() { starts += 1; }, recoverTurn() { throw new Error('native process gone'); }
    } }) } });
  try {
    await service.waitForRecovery();
    assert.equal(starts, 0);
    assert.equal(fs.existsSync(path.join(root, 'marker')), boundary !== 'intent');
    if (boundary !== 'intent') assert.equal(fs.readFileSync(path.join(root, 'marker'), 'utf8'), 'executed\n');
    assert.equal(service.getSnapshot('probe').timeline[0].status, boundary === 'result' ? 'completed' : 'unknown');
    assert.equal(service.getSnapshot('probe').policy.queueControl.paused, true);
    if (process.env.AIH_TEST_KEEP_ARTIFACTS) {
      fs.writeFileSync(path.join(root, 'snapshot.json'), JSON.stringify(service.getSnapshot('probe')));
    }
    const reopened = openChatRuntimeStore({ aiHomeDir: root });
    try { assert.equal(reopened.readTimeline('probe', { limit: 1 }).items[0].status, boundary === 'result' ? 'completed' : 'unknown'); }
    finally { reopened.close(); }
  } finally { service.close(); }
});
