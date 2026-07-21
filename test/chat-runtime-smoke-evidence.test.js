'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  auditPublicProtocolBoundary,
  findFilesContainingText,
  summarizePrewarmEvidence
} = require('../scripts/chat-runtime-smoke-evidence');

test('real smoke prewarm evidence requires lifecycle events and native model discovery', () => {
  const verified = summarizePrewarmEvidence([
    { type: 'runtime.prewarm.started' },
    { type: 'runtime.prewarm.ready' }
  ], [
    { method: 'thread/list' },
    { method: 'model/list' }
  ]);
  assert.equal(verified.verified, true);
  assert.equal(summarizePrewarmEvidence([
    { type: 'runtime.prewarm.started' },
    { type: 'runtime.prewarm.failed' }
  ], [{ method: 'model/list' }]).verified, false);
});

test('real smoke public boundary rejects provider-private interaction and stream fields', () => {
  const clean = auditPublicProtocolBoundary({
    activeTurn: {
      turnId: 'turn-canonical',
      nativeTurnId: 'turn-native',
      state: 'running'
    },
    interactions: [{
      payload: {
        presentation: { title: 'Approve' },
        choices: [{ id: 'choice-0', label: 'Deny', intent: 'deny' }]
      }
    }],
    timeline: [{
      id: 'message-1',
      turnId: 'turn-canonical',
      kind: 'message',
      detail: { role: 'assistant' }
    }]
  }, [
    {
      type: 'run.reattached',
      payload: { state: 'running', nativeTurnId: 'turn-native' }
    },
    {
      type: 'timeline.item.updated',
      turnId: 'turn-canonical',
      payload: { item: { id: 'message-1', turnId: 'turn-canonical' } }
    },
    {
      type: 'stream.error',
      payload: { error: 'failed', message: 'Failed', retryable: false }
    }
  ]);
  assert.deepEqual(clean, { verified: true, leakPaths: [] });

  const leaked = auditPublicProtocolBoundary({
    interactions: [{
      payload: {
        presentation: { title: 'Approve' },
        requestId: 7,
        availableDecisions: ['accept']
      }
    }]
  }, [{
    type: 'stream.error',
    payload: { error: 'failed', message: 'Failed', detail: { method: 'turn/start' } }
  }]);
  assert.equal(leaked.verified, false);
  assert.deepEqual(leaked.leakPaths, [
    'events[0].payload.detail',
    'events[0].payload.detail.method',
    'snapshot.interactions[0].payload.availableDecisions',
    'snapshot.interactions[0].payload.requestId'
  ]);
});

test('real smoke public boundary scans ordinary events and snapshot timeline identities', () => {
  const result = auditPublicProtocolBoundary({
    interactions: [],
    timeline: [{
      id: 'message-1',
      providerTurnId: 'provider-turn-snapshot',
      detail: { nativeThreadId: 'provider-thread-snapshot' }
    }]
  }, [
    {
      type: 'turn.completed',
      payload: {
        nativeTurnId: 'provider-turn-top-level',
        providerTurnId: 'provider-turn-event',
        result: {
          nativeRequestId: 'provider-request-event',
          nativeSessionId: 'provider-session-event',
          nativeTurnId: 'provider-turn-result'
        }
      }
    },
    {
      type: 'timeline.item.delta',
      payload: {
        itemId: 'message-1',
        chunk: 'hello',
        providerTurnId: 'provider-turn-delta'
      }
    }
  ]);

  assert.deepEqual(result, {
    verified: false,
    leakPaths: [
      'events[0].payload.nativeTurnId',
      'events[0].payload.providerTurnId',
      'events[0].payload.result.nativeRequestId',
      'events[0].payload.result.nativeSessionId',
      'events[0].payload.result.nativeTurnId',
      'events[1].payload.providerTurnId',
      'snapshot.timeline[0].detail.nativeThreadId',
      'snapshot.timeline[0].providerTurnId'
    ]
  });
});

test('real smoke public boundary scans queue results without rejecting recovery anchors', () => {
  const result = auditPublicProtocolBoundary({
    runtimeBinding: { nativeSessionId: 'allowed-native-session' },
    activeTurn: {
      turnId: 'turn-canonical',
      nativeTurnId: 'allowed-native-turn',
      state: 'recovering'
    },
    queue: [{
      queueId: 'queue-1',
      result: { nativeTurnId: 'leaked-queue-turn' }
    }],
    interactions: [],
    timeline: []
  }, [
    {
      type: 'run.reattached',
      payload: { state: 'running', nativeTurnId: 'allowed-native-turn' }
    },
    {
      type: 'queue.item.updated',
      payload: {
        entry: {
          queueId: 'queue-1',
          result: { nativeSessionId: 'leaked-queue-session' }
        }
      }
    }
  ]);

  assert.deepEqual(result, {
    verified: false,
    leakPaths: [
      'events[1].payload.entry.result.nativeSessionId',
      'snapshot.queue[0].result.nativeTurnId'
    ]
  });
});

test('real smoke public boundary requires lifecycle item turn identity consistency', () => {
  const result = auditPublicProtocolBoundary({}, [
    {
      type: 'timeline.item.started',
      turnId: 'turn-canonical',
      payload: { item: { id: 'message-1', turnId: 'turn-native' } }
    },
    {
      type: 'timeline.item.completed',
      turnId: 'turn-canonical',
      payload: { item: { id: 'message-2', turnId: 'turn-canonical' } }
    }
  ]);

  assert.deepEqual(result, {
    verified: false,
    leakPaths: ['events[0].payload.item.turnId']
  });
});

test('real smoke secret scan reports only durable files containing the sentinel', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-smoke-evidence-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'safe.db'), 'redacted');
  fs.writeFileSync(path.join(root, 'nested', 'leaked.log'), 'secret-sentinel');

  assert.deepEqual(findFilesContainingText(root, 'secret-sentinel'), [
    path.join('nested', 'leaked.log')
  ]);
});

test('real smoke secret scan fails closed when a durable file cannot be read', () => {
  const fileSystem = {
    readdirSync() {
      return [{
        name: 'state.db',
        isDirectory: () => false,
        isFile: () => true
      }];
    },
    readFileSync() { throw new Error('permission denied'); }
  };

  assert.throws(
    () => findFilesContainingText('/virtual-smoke', 'secret-sentinel', fileSystem),
    (error) => error && error.code === 'smoke_secret_scan_failed'
  );
});

test('real smoke secret scan fails closed when a directory cannot be traversed', () => {
  const fileSystem = {
    readdirSync(currentPath) {
      if (currentPath.endsWith('nested')) throw new Error('directory disappeared');
      return [{
        name: 'nested',
        isDirectory: () => true,
        isFile: () => false
      }];
    },
    readFileSync() { return Buffer.from('safe'); }
  };

  assert.throws(
    () => findFilesContainingText('/virtual-smoke', 'secret-sentinel', fileSystem),
    (error) => error && error.code === 'smoke_secret_scan_failed'
  );
});
