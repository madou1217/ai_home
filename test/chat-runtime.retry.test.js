'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SessionActor } = require('../lib/server/chat-runtime/session-actor');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');

function fixture(t, startTurn) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-turn-retry-'));
  const driver = { startTurn };
  let store = openChatRuntimeStore({ aiHomeDir });
  const session = store.createSession({ provider: 'kimi', executionAccountRef: 'account-one' });
  let actor = new SessionActor({ store, sessionId: session.sessionId, driver });
  t.after(() => { actor.dispose(); store.close(); fs.rmSync(aiHomeDir, { recursive: true, force: true }); });
  return {
    session, driver,
    get store() { return store; },
    get actor() { return actor; },
    reopen() {
      actor.dispose();
      store.close();
      store = openChatRuntimeStore({ aiHomeDir });
      actor = new SessionActor({ store, sessionId: session.sessionId, driver });
    },
    dispatch(commandId, type, payload) {
      return actor.dispatch({ sessionId: session.sessionId, commandId, type, payload });
    },
    snapshot() { return store.getSnapshot(session.sessionId); }
  };
}

async function failTurn(f, payload = { content: 'original prompt' }) {
  const response = await f.dispatch('original', 'turn.submit', payload);
  await f.actor.waitForIdle();
  return response.result.turnId;
}

test('retry survives store reload and restores exact prompt, attachments, model and effort', async (t) => {
  const calls = [];
  const f = fixture(t, async (context) => {
    calls.push(context);
    if (calls.length === 1) throw new Error('temporary failure');
  });
  const attachment = f.store.createAttachments(f.session.sessionId, [{
    filePath: '/test-owned/document.txt', name: 'document.txt', mimeType: 'text/plain'
  }])[0];
  const payload = { content: 'Read the original document', attachmentIds: [attachment.attachmentId],
    model: 'k3', reasoningEffort: 'max' };
  const sourceTurnId = await failTurn(f, payload);
  assert.equal(f.snapshot().failedTurn.retryable, true);
  assert.equal(JSON.stringify(f.snapshot().failedTurn).includes(payload.content), false);
  f.reopen();
  assert.equal(f.snapshot().policy.reasoningEffort, 'max');
  assert.equal(f.snapshot().policy.model, 'k3');
  assert.equal(f.snapshot().failedTurn.turnId, sourceTurnId);
  const retry = await f.dispatch('retry-1', 'turn.retry', { sourceTurnId });
  await f.actor.waitForIdle();
  assert.notEqual(retry.result.turnId, sourceTurnId);
  assert.deepEqual(calls[1].command.payload, payload);
  assert.deepEqual(calls[1].imagePaths, ['/test-owned/document.txt']);
  assert.equal(f.snapshot().failedTurn, undefined);
  const duplicate = await f.dispatch('retry-1', 'turn.retry', { sourceTurnId });
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls.length, 2);
  assert.equal(f.store.listEvents(f.session.sessionId).filter((event) => event.type === 'turn.failed').length, 1);
});

test('rejected and duplicate submissions cannot overwrite the saved model effort', async (t) => {
  let finish;
  const f = fixture(t, () => new Promise((resolve) => { finish = resolve; }));
  const payload = { content: 'long reasoning', model: 'k3', reasoningEffort: 'max' };
  await f.dispatch('accepted', 'turn.submit', payload);
  await assert.rejects(f.dispatch('busy', 'turn.submit', {
    content: 'overlap', model: 'other-model', reasoningEffort: 'low'
  }), /chat_turn_already_active/);
  assert.equal(f.snapshot().policy.reasoningEffort, 'max');
  finish();
  await f.actor.waitForIdle();
  await f.dispatch('change', 'session.policy.set', { key: 'reasoningEffort', value: 'high' });
  await f.dispatch('accepted', 'turn.submit', payload);
  assert.equal(f.snapshot().policy.reasoningEffort, 'high');
});

test('concurrent retry commands start one turn and reject attempts from another session', async (t) => {
  let finish;
  let calls = 0;
  const f = fixture(t, () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('retry me')) : new Promise((resolve) => { finish = resolve; });
  });
  const sourceTurnId = await failTurn(f);
  const other = f.store.createSession({ provider: 'kimi', executionAccountRef: 'account-two' });
  const otherActor = new SessionActor({ store: f.store, sessionId: other.sessionId, driver: f.driver });
  t.after(() => otherActor.dispose());
  await assert.rejects(otherActor.dispatch({ sessionId: other.sessionId,
    commandId: 'cross-session', type: 'turn.retry', payload: { sourceTurnId } }), /chat_retry_not_available/);
  assert.equal(calls, 1);
  const results = await Promise.allSettled([
    f.dispatch('retry-once', 'turn.retry', { sourceTurnId }),
    f.dispatch('retry-once', 'turn.retry', { sourceTurnId }),
    f.dispatch('retry-twice', 'turn.retry', { sourceTurnId })
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].value.duplicate, true);
  assert.equal(results[2].status, 'rejected');
  assert.match(results[2].reason.message, /chat_turn_already_active/);
  assert.equal(calls, 2);
  finish();
  await f.actor.waitForIdle();
});

test('a failed retry retains its original submission and invalidates the older retry target', async (t) => {
  const calls = [];
  const f = fixture(t, async (context) => { calls.push(context); throw new Error('failure'); });
  const sourceTurnId = await failTurn(f, { content: 'keep me', model: 'k3', reasoningEffort: 'high' });
  const retry = await f.dispatch('retry-1', 'turn.retry', { sourceTurnId });
  await f.actor.waitForIdle();
  assert.equal(f.snapshot().failedTurn.turnId, retry.result.turnId);
  await assert.rejects(f.dispatch('retry-stale', 'turn.retry', { sourceTurnId }), /chat_retry_not_available/);
  await f.dispatch('retry-2', 'turn.retry', { sourceTurnId: retry.result.turnId });
  await f.actor.waitForIdle();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].command.payload, calls[0].command.payload);
});

test('the pre-fix failed turn can retry using its persisted command result', async (t) => {
  const f = fixture(t, async () => { throw new Error('old failure'); });
  const sourceTurnId = await failTurn(f);
  f.store.context.db.prepare(`UPDATE chat_runtime_events
    SET payload_json = json_remove(payload_json, '$.submissionCommandId')
    WHERE session_id = ? AND type = 'turn.queued'`).run(f.session.sessionId);
  f.reopen();
  assert.equal(f.snapshot().failedTurn.retryable, true);
  await f.dispatch('legacy-retry', 'turn.retry', { sourceTurnId });
  await f.actor.waitForIdle();
});

test('a synchronous driver failure remains retryable without a completed command result', async (t) => {
  const f = fixture(t, () => { throw new Error('start failed'); });
  await assert.rejects(f.dispatch('original', 'turn.submit', { content: 'start again' }), /start failed/);
  const sourceTurnId = f.snapshot().failedTurn.turnId;
  assert.equal(f.store.getCommand('original').status, 'failed');
  f.driver.startTurn = async () => {};
  await f.dispatch('retry-start', 'turn.retry', { sourceTurnId });
  await f.actor.waitForIdle();
  assert.equal(f.snapshot().failedTurn, undefined);
});

test('retry refuses client payload overrides and never retries a successful turn', async (t) => {
  const f = fixture(t, async () => {});
  const result = await f.dispatch('success', 'turn.submit', { content: 'done' });
  await f.actor.waitForIdle();
  await assert.rejects(f.dispatch('invalid', 'turn.retry', {
    sourceTurnId: result.result.turnId, content: 'replacement'
  }), /chat_retry_payload_invalid/);
  await assert.rejects(f.dispatch('not-failed', 'turn.retry', {
    sourceTurnId: result.result.turnId
  }), /chat_retry_not_available/);
});
