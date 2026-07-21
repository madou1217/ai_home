'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  normalizeEvent,
  normalizeSnapshot
} = require('../lib/server/chat-runtime/contracts');
const {
  openChatRuntimeStore
} = require('../lib/server/chat-runtime/store');

test('completed queue persistence replaces arbitrary handler results with an empty outcome', (t) => {
  const { item, store } = runningQueue(t, 'completed');

  const completed = store.settleQueueItem(item.queueId, item.leaseId, 'completed', {
    nativeSessionId: 'native-thread-1',
    result: { providerPrivate: true }
  });

  assert.deepEqual(completed.result, {});
  assert.deepEqual(store.queue.get(item.queueId).result, {});
});

test('failed queue persistence retains only canonical error code and message', (t) => {
  const { item, store } = runningQueue(t, 'failed');

  const failed = store.settleQueueItem(item.queueId, item.leaseId, 'failed', {
    commandId: 'provider-command-1',
    error: {
      code: 'native_steer_failed',
      message: 'Steer failed',
      nativeTurnId: 'native-turn-1',
      statusCode: 503
    }
  });

  assert.deepEqual(failed.result, {
    error: { code: 'native_steer_failed', message: 'Steer failed' }
  });
});

test('snapshot normalization closes queue results from legacy storage', () => {
  const completed = queueEntry('queue-completed', 'completed', {
    nativeSessionId: 'native-thread-1'
  });
  const failed = queueEntry('queue-failed', 'failed', {
    code: 'provider_failed',
    message: 'Provider failed',
    nativeTurnId: 'native-turn-1',
    stack: 'private stack'
  });

  const snapshot = normalizeSnapshot({
    sessionId: 'session-1',
    state: 'idle',
    throughSeq: 3,
    queue: [completed, failed]
  });

  assert.deepEqual(snapshot.queue[0].result, {});
  assert.deepEqual(snapshot.queue[1].result, {
    error: { code: 'provider_failed', message: 'Provider failed' }
  });
});

test('queue event normalization closes entry results before publication', () => {
  const entry = queueEntry('queue-failed', 'failed', {
    commandId: 'provider-command-1',
    error: {
      code: 'provider_failed',
      message: 'Provider failed',
      nativeSessionId: 'native-thread-1'
    }
  });
  entry.nativeThreadId = 'native-thread-top-level';
  const {
    nativeThreadId: _nativeThreadId,
    result: _providerResult,
    ...canonicalEntry
  } = entry;

  const event = normalizeEvent({
    eventId: 'event-queue-failed',
    sessionId: 'session-1',
    seq: 1,
    type: 'queue.item.updated',
    at: 1,
    source: { provider: 'aih', runtimeId: 'chat-runtime' },
    payload: { entry, providerTurnId: 'native-turn-1' }
  });

  assert.deepEqual(event.payload, {
    entry: {
      ...canonicalEntry,
      result: { error: { code: 'provider_failed', message: 'Provider failed' } }
    }
  });
});

function runningQueue(t, suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-queue-result-'));
  const store = openChatRuntimeStore({ fs, aiHomeDir: root, DatabaseSync });
  t.after(() => {
    store.close();
    fs.rmSync(root, { force: true, recursive: true });
  });
  const session = store.createSession({
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo'
  });
  const queued = store.enqueue(session.sessionId, {
    commandId: `command-${suffix}`,
    policy: 'after_turn',
    payload: { content: suffix }
  });
  const item = store.leaseQueueItem(session.sessionId, {
    queueId: queued.queueId,
    leaseId: `lease-${suffix}`
  });
  store.markQueueRunning(item.queueId, item.leaseId);
  return { item, store };
}

function queueEntry(queueId, status, result) {
  return {
    queueId,
    sessionId: 'session-1',
    commandId: `command-${queueId}`,
    position: 1,
    policy: 'after_turn',
    payload: { content: 'work' },
    status,
    result,
    createdAt: 1,
    updatedAt: 2
  };
}
