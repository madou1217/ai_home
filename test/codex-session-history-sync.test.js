'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CodexSessionHistorySync
} = require('../lib/server/chat-runtime/codex-session-history-sync');
const { CodexTurnRecovery } = require('../lib/server/chat-runtime/codex-turn-recovery');

test('recovery imports the returned thread directly and rejects a foreign thread before persistence', async () => {
  const histories = [];
  const sync = new CodexSessionHistorySync({
    getThreadId: () => 'thread-1', historySink: async (history) => histories.push(history),
    client: { request() { throw new Error('recovery must not reread a moving snapshot'); } }
  });
  const response = { thread: { id: 'thread-1', turns: [{ id: 'native-turn', status: 'completed',
    startedAt: 1, completedAt: 2, items: [{ id: 'answer', type: 'agentMessage', text: 'offline answer' }] }] } };
  await sync.importRecovered(response, { nativeTurnId: 'native-turn', turnId: 'aih-turn' });
  assert.equal(histories[0].events[0].payload.item.turnId, 'aih-turn');
  await assert.rejects(sync.importRecovered({ thread: { ...response.thread, id: 'foreign' } }),
    /codex_history_thread_mismatch/);
  assert.equal(histories.length, 1);
});

test('recovery hydrates a paginated resume response before resolving its native anchor', async () => {
  const histories = [];
  let reads = 0;
  const client = { async request(method) {
    assert.equal(++reads, 1, 'recovery and import must share one hydrated snapshot');
    assert.equal(method, 'thread/turns/list');
    return { data: [{ id: 'native-turn', status: 'completed', startedAt: 1, completedAt: 2,
      items: [{ id: 'answer', type: 'agentMessage', text: 'paged answer' }] }], nextCursor: null };
  } };
  const sync = new CodexSessionHistorySync({
    getThreadId: () => 'thread-1',
    historySink: async (history) => histories.push(history),
    client
  });
  const recovery = new CodexTurnRecovery({ client,
    importRecoveredHistory: (response, anchor) => sync.importRecovered(response, anchor) });
  const active = { nativeThreadId: 'thread-1', nativeTurnId: 'native-turn',
    context: { turnId: 'aih-turn', runId: 'aih-run' } };
  const snapshot = await recovery.restoreSnapshot(active, {
    thread: { id: 'thread-1', turns: [] }, turnsBackwardsCursor: 'turn-cursor'
  });
  assert.equal(snapshot.status, 'completed');
  assert.equal(histories[0].events[0].payload.item.content, 'paged answer');
  assert.equal(histories[0].events[0].turnId, 'aih-turn');
  assert.equal(reads, 1);
});

test('recovery and direct import reject foreign cursor ownership before requesting pages', async () => {
  const client = { request() { assert.fail('must not read the foreign thread'); } };
  const response = { thread: { id: 'foreign', turns: [] }, turnsBackwardsCursor: 'foreign-cursor' };
  const sync = new CodexSessionHistorySync({ getThreadId: () => 'thread-1', client,
    historySink() { assert.fail('must not persist a foreign history'); } });
  await assert.rejects(sync.importRecovered(response), /codex_history_thread_mismatch/);
  const recovery = new CodexTurnRecovery({ client });
  await assert.rejects(recovery.restoreSnapshot({ nativeThreadId: 'thread-1', nativeTurnId: 'native-turn',
    context: { turnId: 'aih-turn' } }, response), /codex_history_thread_mismatch/);
});

test('a failed recovery page still invalidates raw coverage of the known native turn first', async () => {
  const order = [];
  const recovery = new CodexTurnRecovery({
    bridge: { async markHistoryCoverage(threadId, turnId, boundary) {
      order.push([threadId, turnId, boundary]);
    } },
    client: { async request() { order.push('page'); throw new Error('page unavailable'); } }
  });
  await assert.rejects(recovery.restoreSnapshot({ nativeThreadId: 'thread-1', nativeTurnId: 'native-turn',
    context: { turnId: 'aih-turn' } }, { thread: { id: 'thread-1', turns: [] }, turnsBackwardsCursor: 'cursor' }),
  /page unavailable/);
  assert.deepEqual(order, [['thread-1', 'native-turn', 'gap'], 'page']);
});

test('history sync reads and imports the currently bound native thread', async () => {
  const calls = [];
  const history = {
    threadId: 'thread-1',
    revision: 7,
    events: [{ eventId: 'history-1' }]
  };
  const sync = new CodexSessionHistorySync({
    client: { request() {} },
    getThreadId: () => 'thread-1',
    runtimeId: 'codex:account-1',
    historyReader: async (client, threadId, options) => {
      calls.push({ client, threadId, options });
      return history;
    },
    historySink: async (input) => {
      calls.push({ history: input });
      return { events: input.events, skipped: 0 };
    }
  });

  const result = await sync.run();

  assert.equal(calls[0].threadId, 'thread-1');
  assert.deepEqual(calls[0].options, { runtimeId: 'codex:account-1' });
  assert.strictEqual(calls[1].history, history);
  assert.deepEqual(result, { events: history.events, skipped: 0 });
});

test('history sync is inert until a native thread and sink both exist', async () => {
  let reads = 0;
  const create = (overrides = {}) => new CodexSessionHistorySync({
    client: {},
    getThreadId: () => 'thread-1',
    historyReader: async () => { reads += 1; },
    ...overrides
  });

  assert.deepEqual(await create({ getThreadId: () => '' }).run(), {
    imported: 0,
    skipped: true
  });
  assert.deepEqual(await create().run(), { imported: 0, skipped: true });
  assert.equal(reads, 0);
});

test('history sync refreshes an existing native thread and shares concurrent work', async () => {
  let reads = 0;
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const sync = new CodexSessionHistorySync({
    client: {},
    getThreadId: () => 'thread-1',
    historyReader: async () => {
      reads += 1;
      await readGate;
      return { threadId: 'thread-1', events: [] };
    },
    historySink: async () => ({ imported: 0, skipped: false })
  });

  const first = sync.run();
  const concurrent = sync.run();
  releaseRead();

  assert.deepEqual(await Promise.all([first, concurrent]), [
    { imported: 0, skipped: false },
    { imported: 0, skipped: false }
  ]);
  assert.deepEqual(await sync.run(), { imported: 0, skipped: false });
  assert.equal(reads, 2);
});

test('history sync retries after a failed import', async () => {
  let reads = 0;
  const sync = new CodexSessionHistorySync({
    client: {},
    getThreadId: () => 'thread-1',
    historyReader: async () => {
      reads += 1;
      if (reads === 1) throw new Error('read failed');
      return { threadId: 'thread-1', events: [] };
    },
    historySink: async () => ({ imported: 0, skipped: false })
  });

  await assert.rejects(sync.run(), /read failed/);
  assert.deepEqual(await sync.run(), { imported: 0, skipped: false });
  assert.equal(reads, 2);
});
