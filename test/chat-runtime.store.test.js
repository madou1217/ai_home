'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { getAppStateDbPath } = require('../lib/server/app-state-store');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-runtime-'));
  let nextId = 0;
  const options = {
    fs,
    aiHomeDir,
    DatabaseSync,
    clock: () => 1000 + nextId,
    idFactory: (prefix) => `${prefix}-${++nextId}`
  };
  const store = openChatRuntimeStore(options);
  const stores = [store];
  t.after(() => {
    stores.forEach((entry) => entry.close());
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return {
    aiHomeDir,
    store,
    openPeer() {
      const peer = openChatRuntimeStore(options);
      stores.push(peer);
      return peer;
    }
  };
}

function createSession(store, overrides = {}) {
  return store.createSession({
    provider: 'codex',
    executionAccountRef: 'account-1',
    capabilitySnapshot: { steer: 'native' },
    ...overrides
  });
}

test('chat runtime creates its canonical tables in the shared app-state database', (t) => {
  const { aiHomeDir } = createFixture(t);
  const inspection = new DatabaseSync(getAppStateDbPath(aiHomeDir));
  t.after(() => inspection.close());

  const names = inspection.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'chat_runtime_%'
    ORDER BY name
  `).all().map((row) => row.name);

  assert.deepEqual(names, [
    'chat_runtime_attachments',
    'chat_runtime_commands',
    'chat_runtime_events',
    'chat_runtime_interactions',
    'chat_runtime_queue',
    'chat_runtime_sessions'
  ]);
});

test('chat attachments resolve in upload order and stay isolated to their session', (t) => {
  const { store } = createFixture(t);
  const first = createSession(store);
  const second = createSession(store, { executionAccountRef: 'account-2' });
  const attachments = store.createAttachments(first.sessionId, [
    { filePath: '/tmp/one.png', name: 'one.png', mimeType: 'image/png' },
    { filePath: '/tmp/two.jpg', name: 'two.jpg', mimeType: 'image/jpeg' }
  ]);

  assert.deepEqual(
    store.resolveAttachmentPaths(first.sessionId, attachments.map(({ attachmentId }) => attachmentId)),
    ['/tmp/one.png', '/tmp/two.jpg']
  );
  assert.throws(
    () => store.resolveAttachmentPaths(second.sessionId, [attachments[0].attachmentId]),
    (error) => error.code === 'chat_attachment_not_found' && error.statusCode === 404
  );
});

test('legacy account-bound rows migrate to execution credentials without deleting sessions', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-runtime-migration-'));
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const db = new DatabaseSync(getAppStateDbPath(aiHomeDir));
  db.exec(`
    CREATE TABLE chat_runtime_sessions (
      session_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      project_path TEXT NOT NULL,
      state TEXT NOT NULL,
      runtime_binding_json TEXT NOT NULL,
      capability_snapshot_json TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      active_turn_json TEXT,
      last_event_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_chat_runtime_native_session
      ON chat_runtime_sessions(
        provider,
        account_ref,
        NULLIF(TRIM(CAST(json_extract(
          runtime_binding_json, '$.nativeSessionId'
        ) AS TEXT)), '')
      );
  `);
  const insert = db.prepare(`
    INSERT INTO chat_runtime_sessions (
      session_id, provider, account_ref, project_path, state, runtime_binding_json,
      capability_snapshot_json, policy_json, last_event_seq, created_at, updated_at
    ) VALUES (?, 'codex', ?, '/repo', 'idle', ?, '{}', '{}', 0, ?, ?)
  `);
  insert.run('older', 'account-1', '{"nativeSessionId":"thread-legacy"}', 1, 10);
  insert.run('newer', 'account-2', '{"nativeSessionId":"thread-legacy"}', 2, 20);
  db.close();

  const store = openChatRuntimeStore({ fs, aiHomeDir, DatabaseSync });
  t.after(() => {
    store.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  const sessions = store.listSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions.every((session) => !Object.hasOwn(session, 'accountRef')), true);
  assert.deepEqual(
    sessions.map(({ sessionId, executionAccountRef }) => [sessionId, executionAccountRef]),
    [['newer', 'account-2'], ['older', 'account-1']]
  );
  assert.deepEqual(store.listSessions({
    provider: 'codex', nativeSessionId: 'thread-legacy'
  }).map(({ sessionId }) => sessionId), ['newer']);
  assert.equal(sessions.find(({ sessionId }) => sessionId === 'older').state, 'closed');
});

test('native binding updates never replace the stable AIH session id', (t) => {
  const { store } = createFixture(t);
  const created = createSession(store);
  const bound = store.updateRuntimeBinding(created.sessionId, {
    runtimeId: 'runtime-1',
    nativeSessionId: 'native-thread-1'
  });

  assert.equal(created.sessionId, 'session-1');
  assert.equal(bound.sessionId, created.sessionId);
  assert.deepEqual(bound.runtimeBinding, {
    runtimeId: 'runtime-1',
    nativeSessionId: 'native-thread-1'
  });
  assert.equal(store.getSession(created.sessionId).sessionId, 'session-1');
});

test('native turn anchors persist through the store port without changing AIH run identity', (t) => {
  const { store } = createFixture(t);
  const created = createSession(store);
  store.setSessionState(created.sessionId, 'running', {
    turnId: 'turn-1',
    runId: 'run-1',
    clientUserMessageId: 'run-1',
    state: 'running'
  });

  const anchored = store.updateActiveTurnAnchor(created.sessionId, {
    clientUserMessageId: 'run-1',
    nativeTurnId: 'native-turn-1',
    runId: 'run-1'
  });

  assert.deepEqual(anchored.activeTurn, {
    turnId: 'turn-1',
    runId: 'run-1',
    clientUserMessageId: 'run-1',
    nativeTurnId: 'native-turn-1',
    state: 'running'
  });
});

test('native session resolution creates once and adopts the stable AIH session thereafter', (t) => {
  const { store } = createFixture(t);
  const input = {
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo/one',
    runtimeBinding: { runtimeId: 'codex:account-1', nativeSessionId: 'thread-1' },
    policy: { approvalMode: 'ask' }
  };

  const created = store.resolveSession(input);
  const adopted = store.resolveSession({
    ...input,
    projectPath: '/repo/renamed',
    policy: { approvalMode: 'bypass' }
  });

  assert.equal(created.status, 'created');
  assert.equal(adopted.status, 'adopted');
  assert.equal(adopted.session.sessionId, created.session.sessionId);
  assert.equal(adopted.session.projectPath, '/repo/one');
  assert.deepEqual(adopted.session.policy, { approvalMode: 'ask' });
  assert.equal(store.listSessions().length, 1);
});

test('native session identity is independent from the selected execution credential', (t) => {
  const { store } = createFixture(t);
  const identity = {
    provider: 'codex',
    projectPath: '/repo/one',
    runtimeBinding: { nativeSessionId: 'thread-switch' }
  };

  const created = store.resolveSession({
    ...identity,
    executionAccountRef: 'account-1'
  });
  const resumed = store.resolveSession({
    ...identity,
    executionAccountRef: 'account-2'
  });
  const rebound = store.updateExecutionContext(resumed.session.sessionId, {
    executionAccountRef: 'account-2'
  });

  assert.equal(created.status, 'created');
  assert.equal(resumed.status, 'adopted');
  assert.equal(resumed.session.sessionId, created.session.sessionId);
  assert.equal(rebound.executionAccountRef, 'account-2');
  assert.equal(rebound.runtimeBinding.nativeSessionId, 'thread-switch');
  assert.equal(Object.hasOwn(rebound, 'accountRef'), false);
  assert.equal(store.listSessions({
    provider: 'codex', nativeSessionId: 'thread-switch'
  }).length, 1);
});

test('session resolution never deduplicates drafts without a native session id', (t) => {
  const { store } = createFixture(t);
  const input = {
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo/one'
  };

  const first = store.resolveSession(input);
  const second = store.resolveSession(input);

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'created');
  assert.notEqual(first.session.sessionId, second.session.sessionId);
  assert.equal(store.listSessions().length, 2);
});

test('command acceptance is idempotent and allocates one monotonic event seq', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store, { sessionId: 'session-fixed' });
  const command = {
    commandId: 'command-fixed',
    sessionId: session.sessionId,
    type: 'turn.submit',
    payload: { content: 'hello' }
  };

  const first = store.acceptCommand(command);
  const duplicate = store.acceptCommand(command);
  const next = store.appendEvent(session.sessionId, {
    type: 'timeline.item.started',
    source: { provider: 'codex', runtimeId: 'runtime-1' },
    payload: { item: timelineItem('message', 'hi') }
  });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.command.acceptedSeq, 1);
  assert.equal(duplicate.command.acceptedSeq, 1);
  assert.equal(next.seq, 2);
  assert.deepEqual(store.listEvents(session.sessionId).map((event) => event.seq), [1, 2]);
  assert.deepEqual(store.listEvents(session.sessionId).map((event) => event.type), [
    'session.created',
    'timeline.item.started'
  ]);
});

test('reusing a command id with different content fails with 409', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  store.acceptCommand({
    commandId: 'command-fixed',
    sessionId: session.sessionId,
    type: 'runtime.prewarm',
    payload: {}
  });

  assert.throws(() => store.acceptCommand({
    commandId: 'command-fixed',
    sessionId: session.sessionId,
    type: 'turn.submit',
    payload: { content: 'conflicting command' }
  }), (error) => {
    assert.equal(error.code, 'chat_command_id_conflict');
    assert.equal(error.statusCode, 409);
    return true;
  });
});

test('queue enforces FIFO lifecycle and preserves the delivery boundary', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  const first = store.enqueue(session.sessionId, {
    commandId: 'queued-command-1',
    policy: 'after_tool_boundary',
    payload: { content: 'first' }
  });
  store.enqueue(session.sessionId, {
    commandId: 'queued-command-2',
    policy: 'after_turn',
    payload: { content: 'second' }
  });

  const leased = store.leaseNextQueueItem(session.sessionId, {
    leaseId: 'lease-1',
    boundaryItemId: 'tool-item-9'
  });
  const running = store.markQueueRunning(first.queueId, 'lease-1');
  const completed = store.settleQueueItem(first.queueId, 'lease-1', 'completed');

  assert.equal(leased.queueId, first.queueId);
  assert.equal(leased.status, 'leased');
  assert.equal(leased.boundaryItemId, 'tool-item-9');
  assert.equal(running.status, 'running');
  assert.equal(completed.status, 'completed');
  assert.equal(store.listQueue(session.sessionId)[1].status, 'queued');
  assert.throws(
    () => store.settleQueueItem(first.queueId, 'lease-1', 'failed'),
    (error) => error.code === 'invalid_queue_transition' && error.statusCode === 409
  );
});

test('queued items can be edited, removed, and moved without position collisions', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  const first = store.enqueue(session.sessionId, {
    commandId: 'queue-add-1', policy: 'after_turn', payload: { content: 'first' }
  });
  const second = store.enqueue(session.sessionId, {
    commandId: 'queue-add-2', policy: 'after_turn', payload: { content: 'second' }
  });
  const third = store.enqueue(session.sessionId, {
    commandId: 'queue-add-3', policy: 'after_turn', payload: { content: 'third' }
  });

  const edited = store.editQueueItem(second.queueId, { content: 'edited' });
  const moved = store.moveQueueItem(third.queueId, first.queueId);
  const removed = store.removeQueueItem(first.queueId);

  assert.deepEqual(edited.payload, { content: 'edited' });
  assert.equal(moved.queueId, third.queueId);
  assert.equal(removed.queueId, first.queueId);
  assert.equal(store.queue.get(first.queueId), null);
  assert.deepEqual(store.listQueue(session.sessionId).map((item) => item.queueId), [
    third.queueId,
    second.queueId
  ]);
  assert.deepEqual(
    store.listEvents(session.sessionId).slice(-3).map((event) => event.type),
    ['queue.item.updated', 'queue.item.moved', 'queue.item.removed']
  );
});

test('queue CRUD rejects leased and running items', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  const leasedItem = store.enqueue(session.sessionId, {
    commandId: 'queue-add-1', policy: 'after_turn', payload: { content: 'leased' }
  });
  const runningItem = store.enqueue(session.sessionId, {
    commandId: 'queue-add-2', policy: 'after_turn', payload: { content: 'running' }
  });
  store.leaseQueueItem(session.sessionId, {
    queueId: leasedItem.queueId,
    leaseId: 'lease-1'
  });
  store.leaseQueueItem(session.sessionId, {
    queueId: runningItem.queueId,
    leaseId: 'lease-2'
  });
  store.markQueueRunning(runningItem.queueId, 'lease-2');

  for (const operation of [
    () => store.editQueueItem(leasedItem.queueId, { content: 'no' }),
    () => store.removeQueueItem(runningItem.queueId),
    () => store.moveQueueItem(leasedItem.queueId)
  ]) {
    assert.throws(operation, (error) => (
      error.code === 'chat_queue_item_not_queued' && error.statusCode === 409
    ));
  }
});

test('queue lease selects an explicit queued entry exactly once or falls back to FIFO', (t) => {
  const { store, openPeer } = createFixture(t);
  const session = createSession(store);
  const first = store.enqueue(session.sessionId, {
    commandId: 'queued-first', policy: 'after_turn', payload: { content: 'first' }
  });
  const second = store.enqueue(session.sessionId, {
    commandId: 'queued-second', policy: 'after_turn', payload: { content: 'second' }
  });
  const peer = openPeer();

  const selected = store.leaseQueueItem(session.sessionId, {
    queueId: second.queueId,
    leaseId: 'lease-selected'
  });
  const duplicate = peer.leaseQueueItem(session.sessionId, {
    queueId: second.queueId,
    leaseId: 'lease-duplicate'
  });
  const fifo = peer.leaseQueueItem(session.sessionId, { leaseId: 'lease-fifo' });

  assert.equal(selected.queueId, second.queueId);
  assert.equal(duplicate, null);
  assert.equal(fifo.queueId, first.queueId);
});

test('interaction decisions are revisioned and first-writer-wins', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  const interaction = store.createInteraction({
    interactionId: 'approval-1',
    sessionId: session.sessionId,
    itemId: 'approval-item-1',
    kind: 'approval',
    revision: 2,
    payload: canonicalApprovalPayload()
  });

  const resolved = store.resolveInteraction(interaction.interactionId, {
    revision: 2,
    resolution: { decision: 'allow' }
  });

  assert.equal(resolved.state, 'answered');
  assert.deepEqual(resolved.resolution, { decision: 'allow' });
  assert.throws(
    () => store.resolveInteraction(interaction.interactionId, {
      revision: 2,
      resolution: { decision: 'deny' }
    }),
    (error) => error.code === 'stale_interaction' && error.statusCode === 409
  );
});

test('submitted interaction answers persist as user timeline messages across snapshots', (t) => {
  const { store, openPeer } = createFixture(t);
  const session = createSession(store);
  const interaction = store.createInteraction({
    interactionId: 'plan-answer-visible',
    sessionId: session.sessionId,
    itemId: 'plan-answer-item',
    kind: 'plan_confirmation',
    revision: 3,
    payload: canonicalQuestionPayload({
      fields: [{
        id: 'choice', label: 'Plan choice', type: 'single_select',
        required: true, allowOther: true, secret: false,
        options: [{ value: '3', label: 'No, stay in Plan mode' }]
      }]
    })
  });

  store.resolveInteraction(interaction.interactionId, {
    revision: 3,
    resolution: { action: 'submit', answer: { choice: ['3'] } }
  });

  const events = store.listEvents(session.sessionId);
  assert.deepEqual(events.slice(-2).map(({ type }) => type), [
    'interaction.resolved',
    'timeline.item.completed'
  ]);
  const snapshot = openPeer().getSnapshot(session.sessionId);
  const answer = snapshot.timeline.find(({ id }) => (
    id === 'interaction-answer:plan-answer-visible:3'
  ));
  assert.equal(answer.kind, 'message');
  assert.equal(answer.content, 'No, stay in Plan mode');
  assert.deepEqual(answer.detail, { role: 'user', phase: 'interaction_answer' });
  assert.equal(snapshot.interactions.length, 0);
});

test('interaction creation strictly normalizes the frozen canonical payload', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  const input = canonicalQuestionPayload({
    title: '  Confirm plan  ',
    fields: [{
      id: 'confirm', label: 'Implement this plan?', type: 'boolean',
      required: true, allowOther: false, secret: false
    }]
  });

  const interaction = store.createInteraction({
    interactionId: 'plan-confirmation-normalized',
    sessionId: session.sessionId,
    itemId: 'plan-confirmation-item',
    kind: 'plan_confirmation',
    payload: input
  });

  assert.equal(interaction.payload.presentation.title, 'Confirm plan');
  assert.notStrictEqual(interaction.payload, input);
  assert.throws(() => store.createInteraction({
    interactionId: 'approval-private-wire-key',
    sessionId: session.sessionId,
    itemId: 'approval-private-wire-key-item',
    kind: 'approval',
    payload: {
      ...canonicalApprovalPayload(),
      requestId: 17
    }
  }), (error) => (
    error.code === 'invalid_canonical_interaction_payload'
    && error.statusCode === 422
  ));
  assert.throws(() => store.createInteraction({
    interactionId: 'question-unsafe-link',
    sessionId: session.sessionId,
    itemId: 'question-unsafe-link-item',
    kind: 'question',
    payload: {
      ...canonicalQuestionPayload(),
      fields: [],
      presentation: {
        title: 'Open authorization',
        link: { label: 'Open', url: 'javascript:alert(1)' }
      },
      answerShape: 'none'
    }
  }), (error) => error.code === 'invalid_canonical_interaction_payload');
  assert.throws(() => store.createInteraction({
    interactionId: 'question-empty-object-form',
    sessionId: session.sessionId,
    itemId: 'question-empty-object-form-item',
    kind: 'question',
    payload: canonicalQuestionPayload({ fields: [] })
  }), (error) => error.code === 'invalid_canonical_interaction_payload');
});

test('interaction validation is read-only and rejects stale revisions and wrong kinds', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  const interaction = store.createInteraction({
    interactionId: 'question-validate',
    sessionId: session.sessionId,
    itemId: 'question-item-validate',
    kind: 'question',
    revision: 3,
    payload: canonicalQuestionPayload()
  });
  const before = store.listEvents(session.sessionId).length;

  const validated = store.validateInteraction(interaction.interactionId, {
    kind: 'question', revision: 3
  });

  assert.equal(validated.state, 'pending');
  assert.equal(store.listEvents(session.sessionId).length, before);
  assert.throws(
    () => store.validateInteraction(interaction.interactionId, {
      kind: 'approval', revision: 3
    }),
    (error) => error.code === 'chat_interaction_kind_mismatch' && error.statusCode === 409
  );
  assert.throws(
    () => store.validateInteraction(interaction.interactionId, {
      kind: 'question', revision: 4
    }),
    (error) => error.code === 'stale_interaction' && error.statusCode === 409
  );
  assert.equal(store.interactions.get(interaction.interactionId).state, 'pending');
  assert.equal(store.listEvents(session.sessionId).length, before);
});

test('snapshot preserves a resolving interaction for reconnect projection', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  store.createInteraction({
    interactionId: 'approval-resolving', sessionId: session.sessionId,
    itemId: 'approval-item-resolving', kind: 'approval', revision: 1,
    payload: canonicalApprovalPayload()
  });

  store.claimInteractionResolution('approval-resolving', {
    sessionId: session.sessionId,
    revision: 1,
    resolution: { decision: 'allow' }
  });

  assert.equal(store.getSnapshot(session.sessionId).interactions[0].state, 'resolving');
});

test('snapshot returns the canonical reconnect projection at throughSeq', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  store.enqueue(session.sessionId, {
    commandId: 'queued-command-1',
    policy: 'after_turn',
    payload: { content: 'next' }
  });
  store.createInteraction({
    interactionId: 'question-1',
    sessionId: session.sessionId,
    itemId: 'question-item-1',
    kind: 'question',
    payload: canonicalQuestionPayload()
  });
  store.appendEvent(session.sessionId, {
    type: 'timeline.item.started',
    source: { provider: 'codex', runtimeId: 'runtime-1' },
    payload: { item: timelineItem('question', 'Continue?') }
  });

  const snapshot = store.getSnapshot(session.sessionId);

  assert.equal(snapshot.sessionId, session.sessionId);
  assert.equal(snapshot.state, 'idle');
  assert.deepEqual(snapshot.policy, {});
  assert.equal(snapshot.throughSeq, 4);
  assert.equal(snapshot.queue.length, 1);
  assert.equal(snapshot.interactions.length, 1);
  assert.equal(snapshot.timeline.length, 1);
  assert.equal(snapshot.timelineHasMore, false);
  assert.equal(snapshot.timelineNextBefore, null);
});

test('snapshot bounds the initial timeline and exposes an older-page cursor', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  for (let index = 0; index < 50; index += 1) {
    store.appendEvent(session.sessionId, {
      type: 'timeline.item.started',
      source: { provider: 'codex', runtimeId: 'runtime-1' },
      payload: { item: timelineItem('message', `item-${index}`, `item-${index}`) }
    });
  }

  const snapshot = store.getSnapshot(session.sessionId);

  assert.equal(snapshot.timeline.length, 30);
  assert.equal(snapshot.timeline[0].id, 'item-20');
  assert.equal(snapshot.timeline.at(-1).id, 'item-49');
  assert.equal(snapshot.timelineHasMore, true);
  assert.equal(snapshot.timelineNextBefore, 'item-20');
});

test('session policy is persisted and projected through snapshot', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);

  store.updatePolicy(session.sessionId, { approvalMode: 'ask' });

  assert.deepEqual(store.getSession(session.sessionId).policy, { approvalMode: 'ask' });
  assert.deepEqual(store.getSnapshot(session.sessionId).policy, { approvalMode: 'ask' });
  assert.equal(store.listEvents(session.sessionId).at(-1).type, 'session.policy.changed');
});

test('session listing filters the canonical provider and project path columns', (t) => {
  const { store } = createFixture(t);
  createSession(store, { sessionId: 'codex-a', projectPath: '/repo/a' });
  createSession(store, { sessionId: 'codex-b', projectPath: '/repo/b' });
  createSession(store, {
    sessionId: 'claude-a',
    provider: 'claude',
    projectPath: '/repo/a'
  });

  const sessions = store.listSessions({ provider: 'codex', projectPath: '/repo/a' });

  assert.deepEqual(sessions.map((session) => session.sessionId), ['codex-a']);
  assert.equal(sessions[0].projectPath, '/repo/a');
});

test('exact native session listing returns one canonical session identity', (t) => {
  const { store } = createFixture(t);
  createSession(store, {
    sessionId: 'target',
    executionAccountRef: 'account-current',
    projectPath: '/repo/target',
    runtimeBinding: { nativeSessionId: 'native-thread-target' }
  });
  createSession(store, {
    sessionId: 'other-native',
    executionAccountRef: 'account-other-native',
    projectPath: '/repo/target',
    runtimeBinding: { nativeSessionId: 'native-thread-other' }
  });
  createSession(store, {
    sessionId: 'other-provider',
    provider: 'claude',
    executionAccountRef: 'account-other-provider',
    projectPath: '/repo/target',
    runtimeBinding: { nativeSessionId: 'native-thread-target' }
  });

  const sessions = store.listSessions({
    provider: 'codex',
    projectPath: '/repo/target',
    nativeSessionId: 'native-thread-target'
  });

  assert.deepEqual(sessions.map(({ sessionId, executionAccountRef }) => ({
    sessionId,
    executionAccountRef
  })), [{ sessionId: 'target', executionAccountRef: 'account-current' }]);
});

test('timeline cursor pagination and event bounds support reconnect replay', (t) => {
  const { store } = createFixture(t);
  const session = createSession(store);
  ['one', 'two', 'three'].forEach((content, index) => {
    store.appendEvent(session.sessionId, {
      type: 'timeline.item.started',
      source: { provider: 'codex', runtimeId: 'runtime-1' },
      payload: {
        item: {
          ...timelineItem('message', content),
          id: `message-${index + 1}`
        }
      }
    });
  });

  const newest = store.readTimeline(session.sessionId, { limit: 2 });
  const older = store.readTimeline(session.sessionId, {
    before: newest.items[0].id,
    limit: 2
  });
  const bounds = store.getEventBounds(session.sessionId);

  assert.deepEqual(newest.items.map((item) => item.id), ['message-2', 'message-3']);
  assert.equal(newest.hasMore, true);
  assert.equal(newest.nextBefore, 'message-2');
  assert.deepEqual(older.items.map((item) => item.id), ['message-1']);
  assert.deepEqual(bounds, { firstSeq: 1, lastSeq: 4, count: 4 });
});

function timelineItem(kind, content, id = `${kind}-item-1`) {
  const detail = kind === 'message'
    ? { role: 'assistant' }
    : { interactionId: 'question-1' };
  return {
    id,
    kind,
    createdAt: 1000,
    status: 'completed',
    content,
    detail
  };
}

function canonicalApprovalPayload() {
  return {
    presentation: { title: 'Approve operation' },
    choices: [{ id: 'choice-0', label: 'Allow', intent: 'accept' }]
  };
}

function canonicalQuestionPayload({
  title = 'Input required',
  fields = [{
    id: 'answer', label: 'Answer', type: 'text',
    required: false, allowOther: false, secret: false
  }]
} = {}) {
  return {
    presentation: { title },
    fields,
    actions: ['submit'],
    answerShape: 'object',
    confirmUnanswered: false
  };
}
