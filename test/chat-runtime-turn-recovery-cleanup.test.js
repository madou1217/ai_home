'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { CodexTurnRecovery } = require('../lib/server/chat-runtime/codex-turn-recovery');
const {
  recoveredTurnSnapshot
} = require('../lib/server/chat-runtime/codex-turn-recovery');
const { TurnRehydrator } = require('../lib/server/chat-runtime/turn-rehydrator');

test('local recovery commit failure abandons the attached provider run', async () => {
  const failure = Object.assign(new Error('recovery event rejected'), {
    code: 'SQLITE_CONSTRAINT'
  });
  let abandonReason;
  const rehydrator = new TurnRehydrator({
    sessionId: 'session-1',
    driver: {
      async recoverTurn() {
        return {
          nativeTurnId: 'native-turn-1',
          done: new Promise(() => {}),
          async abandon(reason) {
            abandonReason = reason;
            return 'interrupted';
          }
        };
      }
    },
    store: {
      completeRestartRecovery() { throw failure; }
    }
  });

  await assert.rejects(
    rehydrator.rehydrate(recoveryContext()),
    (error) => error === failure
  );

  assert.strictEqual(abandonReason, failure);
  assert.equal(failure.nativeCleanup, 'interrupted');
});

test('Codex recovery cleanup times out and releases its local binding', async () => {
  let active;
  let cleanupCalls = 0;
  const recovery = new CodexTurnRecovery({
    bridge: replayBridge(),
    cleanupTimeoutMs: 5,
    client: {
      ensureConnected: async () => {},
      request(method) {
        if (method === 'thread/resume') return Promise.resolve(resumedThread());
        return new Promise(() => {});
      }
    },
    sessionId: 'session-1',
    getActive: () => active,
    setActive: (next) => { active = next; },
    getThreadId: () => 'native-thread-1',
    getApprovalMode: () => 'confirm',
    bind: () => {},
    cleanup: () => { cleanupCalls += 1; active = null; }
  });
  const providerRun = await recovery.recover(recoveryContext());
  const reason = new Error('local commit failed');

  assert.equal(await providerRun.abandon(reason), 'timed_out');
  await assert.rejects(providerRun.done, (error) => error === reason);
  assert.equal(active, null);
  assert.ok(cleanupCalls >= 1);
});

function recoveryContext() {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    activeTurn: {
      turnId: 'turn-1',
      runId: 'run-1',
      nativeTurnId: 'native-turn-1',
      clientUserMessageId: 'run-1'
    },
    pendingInteractions: []
  };
}

test('Codex recovery matches only an exact native turn anchor', () => {
  const response = {
    thread: {
      turns: [
        nativeTurn('native-turn-old', 'run-old', 'inProgress'),
        nativeTurn('native-turn-1', 'run-1', 'completed')
      ]
    }
  };

  assert.deepEqual(recoveredTurnSnapshot(response, {
    nativeTurnId: 'native-turn-1',
    clientUserMessageId: 'run-1'
  }), {
    id: 'native-turn-1',
    status: 'completed',
    error: undefined
  });
  assert.throws(
    () => recoveredTurnSnapshot(response, { nativeTurnId: 'missing' }),
    (error) => error.code === 'codex_native_turn_recovery_anchor_missing'
  );
});

test('Codex recovery falls back to one exact client user message id and never latest turn', () => {
  const response = {
    thread: {
      turns: [
        nativeTurn('native-turn-target', 'run-1', 'inProgress'),
        nativeTurn('native-turn-latest', 'run-other', 'inProgress')
      ]
    }
  };

  assert.equal(recoveredTurnSnapshot(response, {
    clientUserMessageId: 'run-1'
  }).id, 'native-turn-target');
  assert.throws(
    () => recoveredTurnSnapshot(response, {}),
    (error) => error.code === 'codex_native_turn_recovery_anchor_missing'
  );
  assert.throws(
    () => recoveredTurnSnapshot({
      thread: {
        turns: [
          nativeTurn('native-turn-a', 'run-1', 'inProgress'),
          nativeTurn('native-turn-b', 'run-1', 'inProgress')
        ]
      }
    }, { clientUserMessageId: 'run-1' }),
    (error) => error.code === 'codex_native_turn_recovery_anchor_ambiguous'
  );
});

function nativeTurn(id, clientId, status) {
  return {
    id,
    status,
    items: [{ type: 'userMessage', id: `message-${id}`, clientId, content: [] }]
  };
}

function replayBridge() {
  return {
    cancelExpectedReplays() {},
    expectReplays() {},
    waitForExpectedReplays: async () => {}
  };
}

function resumedThread() {
  return {
    thread: {
      turns: [{ id: 'native-turn-1', status: 'inProgress' }]
    }
  };
}
