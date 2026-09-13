'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const { prepareNativeBranch } = require('../lib/server/chat-runtime/native-branch-operation');

function fixture(t, items = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-branch-operation-'));
  const stores = [];
  const open = () => {
    const store = openChatRuntimeStore({ fs, aiHomeDir: root });
    stores.push(store);
    return store;
  };
  t.after(() => {
    stores.forEach((store) => store.close());
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = open();
  const source = store.createSession({ provider: 'codex', executionAccountRef: 'a',
    runtimeBinding: { nativeSessionId: 'source' } });
  const command = { sessionId: source.sessionId, commandId: 'fork', type: 'session.fork', payload: { sourceItemId: 'message' } };
  store.acceptCommand(command);
  const plan = { threadId: 'source', sourceItemId: 'message',
    ...(items.length ? { beforeTurnId: 'turn' } : { lastTurnId: 'turn' }), items };
  const receipt = { sourceThreadId: 'source', threadId: 'child' };
  const calls = [];
  const native = {
    async fork() { calls.push('fork'); return receipt; },
    async inject() { calls.push('inject'); },
    async recoverFork() { calls.push('recoverFork'); return receipt; },
    async recoverInjection() { calls.push('recoverInjection'); return 'complete'; }
  };
  return { store, open, command, plan, receipt, native, calls,
    run: (repository = store.branchOperations) => prepareNativeBranch({ repository, command, plan, native }) };
}

test('native branch checkpoints preserve a single create across repeated calls and store restart', async (t) => {
  const f = fixture(t);
  const ready = await f.run();
  assert.equal(ready.state, 'ready');
  f.store.close();
  assert.deepEqual(await f.run(f.open().branchOperations), ready);
  assert.deepEqual(f.calls, ['fork']);
});

test('fork and injection lost receipts recover without replaying either mutation', async (t) => {
  const f = fixture(t, [{ id: 'private', type: 'reasoning', encrypted_content: 'PRIVATE_RAW' }]);
  f.native.fork = async () => { f.calls.push('fork'); throw new Error('lost receipt'); };
  f.native.inject = async () => { f.calls.push('inject'); throw new Error('lost receipt'); };
  assert.equal((await f.run()).state, 'ready');
  assert.deepEqual(f.calls, ['fork', 'recoverFork', 'inject', 'recoverInjection']);
  assert.doesNotMatch(JSON.stringify(f.store.getSnapshot(f.command.sessionId)), /PRIVATE_RAW|fork_pending|native_receipt/);
  assert.doesNotMatch(JSON.stringify(f.store.listEvents(f.command.sessionId)), /PRIVATE_RAW/);
});

for (const stage of ['fork_pending', 'inject_pending']) test(`restart resolves ${stage} only from native evidence`, async (t) => {
  const f = fixture(t, [{ id: 'message', type: 'message', role: 'assistant', content: [] }]);
  const repo = f.store.branchOperations;
  repo.prepare(f.command, f.plan);
  repo.advance(f.command.sessionId, f.command.commandId, 'prepared', 'fork_pending');
  if (stage === 'inject_pending') {
    repo.advance(f.command.sessionId, f.command.commandId, 'fork_pending', 'forked', f.receipt);
    repo.advance(f.command.sessionId, f.command.commandId, 'forked', 'inject_pending');
  }
  f.store.close();
  const reopened = f.open().branchOperations;
  assert.equal((await f.run(reopened)).state, 'ready');
  assert.deepEqual(f.calls, stage === 'fork_pending' ? ['recoverFork', 'inject'] : ['recoverInjection']);
});

for (const stage of ['fork', 'injection']) test(`missing ${stage} receipt remains pending without repeated mutations`, async (t) => {
  const f = fixture(t, [{ id: 'message', type: 'message', role: 'assistant', content: [] }]);
  if (stage === 'fork') {
    f.native.fork = async () => { f.calls.push('fork'); throw new Error('lost'); };
    f.native.recoverFork = async () => { f.calls.push('recoverFork'); return null; };
  } else {
    f.native.inject = async () => { f.calls.push('inject'); throw new Error('lost'); };
    f.native.recoverInjection = async () => { f.calls.push('recoverInjection'); return 'incomplete'; };
  }
  await assert.rejects(f.run(), new RegExp(`${stage}_outcome_unknown`));
  f.store.close();
  const reopened = f.open().branchOperations;
  await assert.rejects(f.run(reopened), new RegExp(`${stage}_outcome_unknown`));
  assert.equal(f.calls.filter((call) => call === stage.replace('injection', 'inject')).length, 1);
  assert.equal(reopened.read(f.command.sessionId, f.command.commandId).state,
    stage === 'fork' ? 'fork_pending' : 'inject_pending');
});

test('operation identity, transition order and account boundaries cannot change during recovery', (t) => {
  const f = fixture(t, [{ id: 'private' }]);
  const repo = f.store.branchOperations;
  repo.prepare(f.command, f.plan);
  assert.equal(repo.read('other-session', f.command.commandId), null);
  assert.throws(() => repo.prepare(f.command, { ...f.plan, items: [] }), /identity_conflict/);
  assert.throws(() => repo.prepare({ ...f.command, payload: { sourceItemId: 'other' } }, f.plan), /identity_conflict/);
  assert.throws(() => repo.advance(f.command.sessionId, 'fork', 'prepared', 'ready', f.receipt), /operation_stale/);
  repo.advance(f.command.sessionId, 'fork', 'prepared', 'fork_pending');
  assert.throws(() => repo.advance(f.command.sessionId, 'fork', 'fork_pending', 'forked',
    { ...f.receipt, sourceThreadId: 'foreign' }), /identity_conflict/);
  repo.advance(f.command.sessionId, 'fork', 'fork_pending', 'forked', f.receipt);
  assert.throws(() => repo.advance(f.command.sessionId, 'fork', 'forked', 'ready'), /injection_required/);
  assert.throws(() => repo.advance(f.command.sessionId, 'fork', 'forked', 'inject_pending',
    { ...f.receipt, threadId: 'different' }), /identity_conflict/);
  f.store.context.db.prepare('UPDATE chat_runtime_sessions SET execution_account_ref = ? WHERE session_id = ?')
    .run('other-account', f.command.sessionId);
  assert.throws(() => repo.advance(f.command.sessionId, 'fork', 'forked', 'inject_pending'), /identity_conflict/);
});
