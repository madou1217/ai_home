'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const { CodexSessionEventBridge } = require('../lib/server/chat-runtime/codex-session-event-bridge');
const { createChatRuntimeExtensionPipeline } = require('../lib/server/chat-runtime/chat-runtime-extension-pipeline');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-evidence-'));
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
  return { store: open(), open };
}

test('private native history retains wire shapes and model order across restart and account boundaries', (t) => {
  const f = fixture(t);
  const source = f.store.createSession({ provider: 'codex', executionAccountRef: 'a',
    runtimeBinding: { nativeSessionId: 'thread-a' } });
  const other = f.store.createSession({ provider: 'codex', executionAccountRef: 'b',
    runtimeBinding: { nativeSessionId: 'thread-b' } });
  const items = [
    { type: 'message', id: 'image-input', role: 'user', content: [
      { type: 'input_image', image_url: 'data:image/png;base64,PRIVATE_IMAGE', detail: 'original' }] },
    { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'PRIVATE_REASONING' },
    { type: 'function_call', id: 'call-a', call_id: 'a', name: 'execute', namespace: 'tools', arguments: '{"a":1}' },
    { type: 'custom_tool_call', id: 'call-b', call_id: 'b', name: 'exec', input: 'PRIVATE_INPUT' },
    { type: 'function_call_output', id: 'output-a', call_id: 'a', output: [
      { type: 'input_image', image_url: 'data:image/png;base64,PRIVATE_OUTPUT', detail: 'high' }] },
    { type: 'custom_tool_call_output', id: 'output-b', call_id: 'b', output: 'PRIVATE_RESULT' },
    { type: 'future_item', id: 'unknown', opaque: { nested: ['PRIVATE_UNKNOWN'] } },
    { type: 'message', id: 'answer', role: 'assistant', phase: 'commentary', content: [
      { type: 'output_text', text: 'PRIVATE_ANSWER' }] }
  ];
  for (const item of items) {
    const evidence = { threadId: 'thread-a', turnId: 'turn-a', item };
    f.store.recordNativeResponseItem(source.sessionId, evidence);
    f.store.recordNativeResponseItem(source.sessionId, structuredClone(evidence));
    assert.throws(() => f.store.recordNativeResponseItem(other.sessionId, evidence), /thread_mismatch/);
  }
  const anotherTurn = { threadId: 'thread-a', turnId: 'turn-b', item: { ...items[0], id: 'next-image' } };
  f.store.recordNativeResponseItem(source.sessionId, anotherTurn);
  assert.throws(() => f.store.recordNativeResponseItem(source.sessionId,
    { ...anotherTurn, item: items[0] }), /item_conflict/);
  f.store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.nativeResponseItems.readTurn(source.sessionId, 'thread-a', 'turn-a'), items);
  assert.deepEqual(reopened.nativeResponseItems.readTurn(other.sessionId, 'thread-a', 'turn-a'), []);
  assert.deepEqual(reopened.nativeResponseItems.readTurn(source.sessionId, 'thread-b', 'turn-a'), []);
  assert.doesNotMatch(JSON.stringify(reopened.getSnapshot(source.sessionId)), /PRIVATE_/);
  assert.doesNotMatch(JSON.stringify(reopened.listEvents(source.sessionId)), /PRIVATE_/);
});

test('reasoning-only schema upgrade keeps unknown historical order explicit', (t) => {
  const f = fixture(t);
  const session = f.store.createSession({ provider: 'codex', executionAccountRef: 'a',
    runtimeBinding: { nativeSessionId: 'thread-a' } });
  const raw = { id: 'old', type: 'reasoning', summary: [], encrypted_content: 'old-evidence' };
  f.store.context.db.exec(`DROP TABLE chat_runtime_native_response_items;
    CREATE TABLE chat_runtime_native_response_items (
      session_id TEXT NOT NULL, item_id TEXT NOT NULL, native_thread_id TEXT NOT NULL,
      response_item_json TEXT NOT NULL, PRIMARY KEY(session_id, item_id));`);
  f.store.context.db.prepare('INSERT INTO chat_runtime_native_response_items VALUES (?, ?, ?, ?)')
    .run(session.sessionId, raw.id, 'thread-a', JSON.stringify(raw));
  f.store.close();
  const upgraded = f.open();
  assert.deepEqual(upgraded.readNativeResponseItem(session.sessionId, 'old'), raw);
  assert.equal(upgraded.nativeResponseItems.readRow(session.sessionId, 'old').ordinal, null);
  assert.deepEqual(upgraded.nativeResponseItems.readTurn(session.sessionId, 'thread-a', 'turn-a'), []);
  const next = { ...raw, id: 'new' };
  upgraded.recordNativeResponseItem(session.sessionId, { threadId: 'thread-a', turnId: 'turn-a', item: next });
  assert.deepEqual(upgraded.nativeResponseItems.readTurn(session.sessionId, 'thread-a', 'turn-a'), [next]);
});

test('only uninterrupted native capture certifies a turn and recovery gaps remain sticky', (t) => {
  const f = fixture(t);
  const session = f.store.createSession({ provider: 'codex', executionAccountRef: 'a',
    runtimeBinding: { nativeSessionId: 'thread-a' } });
  const mark = (turnId, boundary) => f.store.markNativeHistoryCoverage(session.sessionId,
    { threadId: 'thread-a', turnId, boundary });
  assert.equal(mark('observed', 'started'), 'recording');
  f.store.recordNativeResponseItem(session.sessionId, { threadId: 'thread-a', turnId: 'observed',
    item: { id: 'observed-answer', type: 'message', role: 'assistant', content: [] } });
  assert.equal(mark('observed', 'completed'), 'complete');
  assert.equal(mark('observed', 'started'), 'complete');
  assert.equal(mark('missed-start', 'completed'), 'incomplete');
  assert.equal(mark('missed-start', 'started'), 'incomplete');
  assert.equal(mark('reconnected', 'started'), 'recording');
  assert.equal(mark('reconnected', 'gap'), 'incomplete');
  assert.equal(mark('reconnected', 'completed'), 'incomplete');
  assert.equal(mark('raw-disabled', 'started'), 'recording');
  assert.equal(mark('raw-disabled', 'completed'), 'incomplete');
  f.store.close();
  const reopened = f.open();
  assert.equal(reopened.nativeResponseItems.coverage(session.sessionId, 'thread-a', 'observed'), 'complete');
  assert.equal(reopened.nativeResponseItems.coverage(session.sessionId, 'thread-a', 'reconnected'), 'incomplete');
  assert.throws(() => reopened.markNativeHistoryCoverage(session.sessionId,
    { threadId: 'foreign', turnId: 'observed', boundary: 'started' }), /thread_mismatch/);
});

test('missing raw identity and persistence failure invalidate native capture before completion', async (t) => {
  const f = fixture(t);
  const session = f.store.createSession({ provider: 'codex', executionAccountRef: 'a',
    runtimeBinding: { nativeSessionId: 'thread-a' } });
  const bridge = new CodexSessionEventBridge({ eventSink() {},
    nativeResponseItemSink: (evidence) => f.store.recordNativeResponseItem(session.sessionId, evidence),
    nativeHistoryCoverageSink: (evidence) => f.store.markNativeHistoryCoverage(session.sessionId, evidence)
  });
  for (const [turnId, item] of [
    ['missing-id', { type: 'message', role: 'assistant', content: [] }],
    ['invalid-item', { type: 'reasoning', id: 'bad', summary: 'invalid' }]
  ]) {
    const context = { sessionId: session.sessionId, turnId: 'turn', runId: 'run', toolOrder: bridge.createToolOrder() };
    const forward = (method, extra) => bridge.forwardNotification({ method,
      params: { threadId: 'thread-a', turnId, ...extra } }, context).persisted;
    await forward('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } });
    const result = forward('rawResponseItem/completed', { item });
    if (turnId === 'invalid-item') await assert.rejects(result, /item_invalid/);
    else await result;
    await forward('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
    assert.equal(f.store.nativeResponseItems.coverage(session.sessionId, 'thread-a', turnId), 'incomplete');
  }
});

test('private output persistence precedes hooks for typed events released by the order coordinator', async () => {
  const events = [];
  const writes = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const extensions = createChatRuntimeExtensionPipeline({ extensions: [{
    afterToolCall() { writes.push('after-tool'); }
  }] });
  const bridge = new CodexSessionEventBridge({ sessionId: 's', extensions,
    eventSink: (event) => { events.push(event); },
    async nativeResponseItemSink(evidence) {
      if (evidence.item.type === 'function_call_output') await gate;
      writes.push(evidence.item.type);
    }
  });
  const context = { sessionId: 's', runId: 'run', turnId: 'turn', toolOrder: bridge.createToolOrder() };
  const raw = (item) => bridge.forwardNotification({ method: 'rawResponseItem/completed',
    params: { threadId: 'native', turnId: 'native-turn', item } }, context).persisted;
  await raw({ type: 'function_call', id: 'call', call_id: 'a', name: 'exec_command', arguments: '{}' });
  await raw({ type: 'function_call', id: 'call-b', call_id: 'b', name: 'exec_command', arguments: '{}' });
  const completed = bridge.forwardNotification({ method: 'item/completed', params: {
    threadId: 'native', turnId: 'native-turn', item: { id: 'b', type: 'commandExecution',
      command: 'echo done', cwd: '/tmp', status: 'completed', aggregatedOutput: 'done', exitCode: 0 }
  } }, context).persisted;
  const output = raw({ type: 'function_call_output', id: 'output', call_id: 'a', output: 'PRIVATE_RESULT' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 0);
  release();
  await Promise.all([completed, output]);
  assert.deepEqual(writes, ['function_call', 'function_call', 'function_call_output', 'after-tool']);
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_RESULT/);
});
