'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexBranchOperationPort } = require('../lib/server/chat-runtime/codex-branch-operation-port');
const { codexForkSource } = require('../lib/server/chat-runtime/codex-fork-receipt');

function fixture(reply) {
  const operation = { sessionId: 'session', commandId: 'fork', sourceThreadId: 'source',
    plan: { beforeTurnId: 'turn', items: [{ type: 'message', id: 'm' }] }, receipt: { threadId: 'child' } };
  const calls = [];
  const port = new CodexBranchOperationPort({ client: { async request(method, params) {
    calls.push({ method, params });
    return reply(method, params);
  } }, model: 'model', getRuntimeHome: async () => { throw new Error('unused'); } });
  return { operation, calls, port };
}

test('fork adapter requires an exact cut and validates the native operation marker and parent', async () => {
  const f = fixture((_method, params) => ({ thread: {
    id: 'child', forkedFromId: params.threadId, threadSource: params.threadSource
  } }));
  const receipt = await f.port.fork(f.operation);
  assert.deepEqual(receipt, { threadId: 'child', sourceThreadId: 'source', threadSource: codexForkSource(f.operation) });
  assert.equal(f.calls[0].params.beforeTurnId, 'turn');
  assert.equal(f.calls[0].params.lastTurnId, undefined);
  assert.equal(f.calls[0].params.deferGoalContinuation, true);
  assert.equal(f.calls[0].params.config['features.omit_app_server_notification_media'], false);
  await assert.rejects(f.port.fork({ ...f.operation, plan: { items: [] } }), /boundary_required/);
  assert.equal(f.calls.length, 1);
  for (const thread of [{ id: 'source' }, { id: 'child', forkedFromId: 'foreign' },
    { id: 'child', forkedFromId: 'source', threadSource: 'wrong-operation' }]) {
    const other = fixture(() => ({ thread }));
    await assert.rejects(other.port.fork(other.operation), /receipt_identity_conflict/);
  }
});

test('injection resumes only its receipt identity and refuses wrong or busy targets', async () => {
  for (const thread of [{ id: 'foreign' }, { id: 'child', status: { type: 'active' } }]) {
    const f = fixture(() => ({ thread }));
    await assert.rejects(f.port.inject(f.operation), /identity_conflict|child_busy/);
    assert.deepEqual(f.calls.map((call) => call.method), ['thread/resume']);
    assert.equal(f.calls[0].params.threadId, 'child');
  }
  const f = fixture(() => ({ thread: { id: 'child', status: { type: 'idle' } } }));
  await f.port.inject(f.operation);
  assert.deepEqual(f.calls.map((call) => call.method), ['thread/resume', 'thread/inject_items']);
  assert.deepEqual(f.calls[1].params, { threadId: 'child', items: f.operation.plan.items });
});
