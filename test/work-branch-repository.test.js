'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-work-child-'));
  const stores = [];
  const open = () => { const store = openChatRuntimeStore({ fs, aiHomeDir: root }); stores.push(store); return store; };
  t.after(() => { stores.forEach((s) => s.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const store = open();
  const source = store.createSession({ provider: 'codex', executionAccountRef: 'a', projectPath: root,
    runtimeBinding: { nativeSessionId: 'native-source' }, policy: { model: 'm', approvalMode: 'confirm',
      contextState: { goal: { threadId: 'native-source', objective: 'finish branch', status: 'active',
        tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 } } } });
  const foreign = store.createSession({ provider: 'codex', executionAccountRef: 'b' });
  const attach = (sessionId) => store.createAttachments(sessionId,
    [{ filePath: path.join(root, 'image.png'), name: 'image.png', mimeType: 'image/png' }])[0].attachmentId;
  const attachment = attach(source.sessionId);
  const foreignAttachment = attach(foreign.sessionId);
  const input = { type: 'message', id: 'raw-user', role: 'user', content: [{ type: 'input_text', text: 'prompt' }] };
  const answer = { type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] };
  const items = [
    { id: 'user', kind: 'message', status: 'completed', content: 'prompt', createdAt: 1, updatedAt: 2, detail: { role: 'user', inputs: [{ kind: 'image' }] } },
    { id: 'tool', kind: 'shell', status: 'completed', content: 'result', createdAt: 2, updatedAt: 3,
      detail: { callId: 'call', command: 'echo result', exitCode: 0 } },
    { id: 'answer', kind: 'message', status: 'completed', content: 'answer', createdAt: 3, updatedAt: 4,
      detail: { role: 'assistant', metrics: { durationMs: 20, ttftMs: 5 } } }
  ];
  for (const item of [input, answer]) store.recordNativeResponseItem(source.sessionId,
    { threadId: 'native-source', turnId: 'native-turn', item });
  const threadItems = [{ item: { id: 'user', type: 'userMessage', content: [] }, rawMessageId: 'raw-user' },
    { item: { id: 'answer', type: 'agentMessage', text: 'answer' }, rawMessageId: null }];
  const command = { sessionId: source.sessionId, commandId: 'branch', type: 'session.fork', payload: { sourceItemId: 'answer' } };
  const plan = { threadId: 'native-source', lastTurnId: 'native-turn', sourceItemId: 'answer', items: [],
    projection: { items, submissions: { user: { content: 'prompt', attachmentIds: [attachment] } },
      policy: source.policy, projectPath: root, capabilitySnapshot: {}, runtimeBinding: source.runtimeBinding },
    nativeTurns: [{ id: 'native-turn', items: [input, answer], coverage: 'complete', threadItems }] };
  const prepare = () => {
    store.acceptCommand(command);
    store.branchOperations.prepare(command, plan);
    for (const [from, to, receipt] of [['prepared', 'fork_pending'], ['fork_pending', 'forked',
      { threadId: 'native-child', sourceThreadId: 'native-source' }], ['forked', 'ready']]) {
      store.branchOperations.advance(source.sessionId, command.commandId, from, to, receipt);
    }
  };
  return { store, open, source, foreign, command, plan, attachment, foreignAttachment, prepare };
}

test('ready native operation commits child, exact timeline, attachment ownership and private evidence atomically', (t) => {
  const f = fixture(t);
  f.prepare();
  const child = f.store.workBranches.commit(f.command);
  assert.equal(child.projectPath, f.source.projectPath);
  assert.equal(child.executionAccountRef, 'a');
  assert.equal(child.runtimeBinding.nativeSessionId, 'native-child');
  assert.equal(child.policy.contextState.goal.objective, 'finish branch');
  const snapshot = f.store.getSnapshot(child.sessionId);
  assert.deepEqual(snapshot.timeline.map((item) => item.id), ['user', 'tool', 'answer']);
  assert.equal(snapshot.timeline[1].detail.callId, 'call');
  assert.equal(snapshot.timeline[2].detail.metrics.durationMs, 20);
  const attached = f.store.readHistorySeed(child.sessionId).messageSubmissions.user.attachmentIds;
  assert.notEqual(attached[0], f.attachment);
  assert.throws(() => f.store.resolveAttachmentPaths(f.source.sessionId, attached), /attachment_not_found/);
  assert.equal(f.store.nativeResponseItems.coverage(child.sessionId, 'native-child', 'native-turn'), 'complete');
  assert.equal(f.store.nativeThreadItems.readTurn(child.sessionId, 'native-child', 'native-turn')[0].rawMessageId, 'raw-user');
  assert.doesNotMatch(JSON.stringify(snapshot), /raw-user|response_item_json/);
  f.store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.workBranches.commit(f.command), child);
  assert.equal(reopened.listSessions().length, 3);
  assert.equal(reopened.getSnapshot(child.sessionId).timeline.length, 3);
});

test('foreign attachment failure rolls back child, events, history and native ownership together', (t) => {
  const f = fixture(t);
  f.plan.projection.submissions.user.attachmentIds = [f.foreignAttachment];
  f.prepare();
  assert.throws(() => f.store.workBranches.commit(f.command), /attachment_not_found/);
  assert.equal(f.store.listSessions().length, 2);
  assert.equal(f.store.context.db.prepare('SELECT count(*) AS n FROM chat_runtime_history_seeds').get().n, 0);
  assert.equal(f.store.context.db.prepare('SELECT count(*) AS n FROM chat_runtime_native_thread_items').get().n, 0);
  assert.equal(f.store.branchOperations.read(f.source.sessionId, f.command.commandId).state, 'ready');
});

test('native receipt cannot be committed before ready or rebound to another source account', (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.workBranches.commit(f.command), /operation_not_ready/);
  f.prepare();
  f.store.context.db.prepare('UPDATE chat_runtime_sessions SET execution_account_ref = ? WHERE session_id = ?')
    .run('b', f.source.sessionId);
  assert.throws(() => f.store.workBranches.commit(f.command), /identity_conflict/);
  assert.equal(f.store.listSessions().length, 2);
});

test('explicit native message links cannot be reused or cross thread boundaries', (t) => {
  const f = fixture(t);
  const evidence = { threadId: 'native-source', turnId: 'native-turn',
    item: { id: 'user', type: 'userMessage', content: [] }, rawMessageId: 'raw-user' };
  f.store.nativeThreadItems.record(f.source.sessionId, evidence);
  f.store.nativeThreadItems.record(f.source.sessionId, { ...evidence, rawMessageId: null });
  assert.equal(f.store.nativeThreadItems.readTurn(f.source.sessionId, 'native-source', 'native-turn')[0].rawMessageId, 'raw-user');
  assert.throws(() => f.store.nativeThreadItems.record(f.foreign.sessionId, evidence), /thread_mismatch/);
  assert.throws(() => f.store.nativeThreadItems.record(f.source.sessionId,
    { ...evidence, item: { ...evidence.item, id: 'another' } }), /link_conflict/);
  assert.throws(() => f.store.nativeThreadItems.record(f.source.sessionId,
    { ...evidence, turnId: 'other-turn' }), /item_conflict/);
});

test('resolved approval history is copied with new ownership and cannot become a pending action', (t) => {
  const f = fixture(t);
  f.plan.projection.interactions = [{ interactionId: 'approval', sessionId: f.source.sessionId, itemId: 'tool',
    kind: 'approval', revision: 1, payload: { action: 'command', title: 'Run command', choices: [] },
    state: 'answered', resolution: { action: 'allow' }, createdAt: 1, updatedAt: 2 }];
  f.prepare();
  const child = f.store.workBranches.commit(f.command);
  assert.deepEqual(f.store.getSnapshot(child.sessionId).interactions, []);
  const event = f.store.listEvents(child.sessionId).find((entry) => entry.type === 'interaction.resolved');
  assert.equal(event.payload.interaction.sessionId, child.sessionId);
  assert.notEqual(event.payload.interaction.interactionId, 'approval');
  assert.equal(event.payload.interaction.state, 'answered');
  assert.deepEqual(event.payload.interaction.resolution, { action: 'allow' });
  assert.throws(() => f.store.interactions.validate(event.payload.interaction.interactionId,
    { sessionId: child.sessionId, revision: 1 }), /stale_interaction/);
});
