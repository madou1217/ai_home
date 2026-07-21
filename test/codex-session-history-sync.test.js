'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CodexSessionHistorySync
} = require('../lib/server/chat-runtime/codex-session-history-sync');

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
