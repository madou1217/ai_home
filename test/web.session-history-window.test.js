'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadWindowHelpers() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'services',
    'session-history-window.js'
  )).href;
  return import(modulePath);
}

function createMessages(start, end) {
  return Array.from({ length: end - start }, (_item, offset) => ({
    role: offset % 2 === 0 ? 'user' : 'assistant',
    content: `message-${start + offset}`
  }));
}

function createPage(start, end, total, cursor = total) {
  return {
    messages: createMessages(start, end),
    start,
    total,
    hasMore: start > 0,
    cursor
  };
}

test('older-page rebase prepends an adjacent page without replacing the tail snapshot', async () => {
  const { rebaseOlderSessionHistoryPage } = await loadWindowHelpers();
  const current = createPage(5, 10, 10, 100);
  const older = createPage(2, 5, 8, 80);

  const merged = rebaseOlderSessionHistoryPage(current, older);

  assert.equal(merged.start, 2);
  assert.equal(merged.total, 10);
  assert.equal(merged.cursor, 100);
  assert.equal(merged.hasMore, true);
  assert.deepEqual(
    merged.messages.map((message) => message.content),
    createMessages(2, 10).map((message) => message.content)
  );
});

test('session history tail refresh preserves loaded older messages', async () => {
  const { rebaseLatestSessionHistoryTail } = await loadWindowHelpers();
  const current = createPage(2, 10, 10, 100);
  const refreshedTail = createPage(7, 12, 12, 120);

  const merged = rebaseLatestSessionHistoryTail(current, refreshedTail);

  assert.equal(merged.start, 2);
  assert.equal(merged.total, 12);
  assert.equal(merged.cursor, 120);
  assert.deepEqual(
    merged.messages.map((message) => message.content),
    createMessages(2, 12).map((message) => message.content)
  );
});

test('session history overlap uses the refreshed page as the source of truth', async () => {
  const { rebaseLatestSessionHistoryTail } = await loadWindowHelpers();
  const current = createPage(5, 10, 10, 100);
  const refreshedTail = {
    ...createPage(8, 11, 11, 110),
    messages: [
      { role: 'user', content: 'message-8-updated' },
      { role: 'assistant', content: 'message-9-updated' },
      { role: 'user', content: 'message-10' }
    ]
  };

  const merged = rebaseLatestSessionHistoryTail(current, refreshedTail);

  assert.deepEqual(
    merged.messages.map((message) => message.content),
    [
      'message-5',
      'message-6',
      'message-7',
      'message-8-updated',
      'message-9-updated',
      'message-10'
    ]
  );
});

test('older-page and tail requests converge regardless of completion order', async () => {
  const {
    rebaseLatestSessionHistoryTail,
    rebaseOlderSessionHistoryPage
  } = await loadWindowHelpers();
  const initial = createPage(5, 10, 10, 100);
  const older = createPage(2, 5, 9, 90);
  const refreshedTail = createPage(7, 12, 12, 120);

  const tailThenOlder = rebaseOlderSessionHistoryPage(
    rebaseLatestSessionHistoryTail(initial, refreshedTail),
    older
  );
  const olderThenTail = rebaseLatestSessionHistoryTail(
    rebaseOlderSessionHistoryPage(initial, older),
    refreshedTail
  );

  for (const merged of [tailThenOlder, olderThenTail]) {
    assert.equal(merged.start, 2);
    assert.equal(merged.total, 12);
    assert.equal(merged.cursor, 120);
    assert.deepEqual(
      merged.messages.map((message) => message.content),
      createMessages(2, 12).map((message) => message.content)
    );
  }
});

test('a stale tail response cannot replace a newer completed tail', async () => {
  const { rebaseLatestSessionHistoryTail } = await loadWindowHelpers();
  const newerTail = createPage(5, 12, 12, 120);
  const staleTail = createPage(5, 10, 10, 100);

  const merged = rebaseLatestSessionHistoryTail(newerTail, staleTail);

  assert.equal(merged.total, 12);
  assert.equal(merged.cursor, 120);
  assert.deepEqual(
    merged.messages.map((message) => message.content),
    createMessages(5, 12).map((message) => message.content)
  );
});

test('incremental events advance the cached window before a stale tail completes', async () => {
  const {
    advanceSessionHistoryWindow,
    rebaseLatestSessionHistoryTail
  } = await loadWindowHelpers();
  const initial = createPage(5, 10, 10, 100);
  const eventMessages = createMessages(5, 11);
  const advanced = advanceSessionHistoryWindow(initial, eventMessages, 120);
  const staleTail = createPage(5, 10, 10, 100);

  const rebased = rebaseLatestSessionHistoryTail(advanced, staleTail);

  assert.equal(rebased.start, 5);
  assert.equal(rebased.total, 11);
  assert.equal(rebased.cursor, 120);
  assert.deepEqual(
    rebased.messages.map((message) => message.content),
    createMessages(5, 11).map((message) => message.content)
  );
});

test('an event observed before the initial window rejects an older tail snapshot', async () => {
  const { isSessionHistorySnapshotCurrent } = await loadWindowHelpers();
  const pendingMessages = [{ role: 'assistant', content: 'live event' }];
  const observedCursor = 120;
  const staleInitialTail = createPage(5, 10, 10, 100);

  assert.equal(isSessionHistorySnapshotCurrent(observedCursor, staleInitialTail), false);
  assert.deepEqual(pendingMessages, [{ role: 'assistant', content: 'live event' }]);
  assert.equal(
    isSessionHistorySnapshotCurrent(observedCursor, createPage(6, 11, 11, 120)),
    true
  );
});

test('a smaller event cursor marks a truncated transcript as a new snapshot generation', async () => {
  const { didSessionHistoryCursorReset } = await loadWindowHelpers();

  assert.equal(didSessionHistoryCursorReset(283, 141), true);
  assert.equal(didSessionHistoryCursorReset(141, 141), false);
  assert.equal(didSessionHistoryCursorReset(141, 283), false);
});

test('a smaller snapshot replaces an idle truncated transcript but not a concurrent stale tail', async () => {
  const { didSessionHistorySnapshotReset } = await loadWindowHelpers();
  const latest = createPage(5, 10, 10, 283);
  const truncated = createPage(0, 4, 4, 141);

  assert.equal(didSessionHistorySnapshotReset(latest, truncated, 283), true);
  assert.equal(
    didSessionHistorySnapshotReset(latest, truncated, 320),
    false,
    'a newer observed event cursor means the smaller response is merely stale'
  );
});

test('complete session history walks every older page without missing content', async () => {
  const { collectAllSessionHistoryMessages } = await loadWindowHelpers();
  const calls = [];
  const loadPage = async ({ before } = {}) => {
    calls.push(before ?? null);
    const end = before ?? 9;
    const start = Math.max(0, end - 3);
    return createPage(start, end, 9, 90);
  };

  const messages = await collectAllSessionHistoryMessages(loadPage);

  assert.deepEqual(calls, [null, 6, 3]);
  assert.deepEqual(
    messages.map((message) => message.content),
    createMessages(0, 9).map((message) => message.content)
  );
});

test('tail loading bridges a pagination gap before merging with older content', async () => {
  const { loadContiguousSessionHistoryTail } = await loadWindowHelpers();
  const current = createPage(0, 5, 5, 50);
  const calls = [];
  const loadPage = async ({ before } = {}) => {
    calls.push(before ?? null);
    const end = before ?? 15;
    const start = Math.max(0, end - 5);
    return createPage(start, end, 15, 150);
  };

  const merged = await loadContiguousSessionHistoryTail(current, loadPage);

  assert.deepEqual(calls, [null, 10]);
  assert.equal(merged.start, 0);
  assert.equal(merged.total, 15);
  assert.deepEqual(
    merged.messages.map((message) => message.content),
    createMessages(0, 15).map((message) => message.content)
  );
});

test('tail loading bounds bridge requests when history grows far beyond the cached window', async () => {
  const { loadContiguousSessionHistoryTail } = await loadWindowHelpers();
  const current = createPage(0, 50, 50, 50);
  const calls = [];
  const loadPage = async ({ before } = {}) => {
    calls.push(before ?? null);
    const end = before ?? 10_000;
    const start = Math.max(0, end - 50);
    return createPage(start, end, 10_000, 10_000);
  };

  const loaded = await loadContiguousSessionHistoryTail(current, loadPage);

  assert.deepEqual(calls, [null, 9950, 9900]);
  assert.equal(loaded.start, 9850);
  assert.equal(loaded.messages.length, 150);
  assert.equal(loaded.total, 10_000);
  assert.equal(loaded.cursor, 10_000);
});

test('complete history keeps paging when the transcript grows between requests', async () => {
  const { collectAllSessionHistoryMessages } = await loadWindowHelpers();
  let call = 0;
  const loadPage = async ({ before } = {}) => {
    call += 1;
    if (call === 1) return createPage(6, 9, 9, 90);
    const end = before ?? 10;
    const start = Math.max(0, end - 3);
    return createPage(start, end, 10, 100);
  };

  const messages = await collectAllSessionHistoryMessages(loadPage);

  assert.deepEqual(
    messages.map((message) => message.content),
    createMessages(0, 9).map((message) => message.content)
  );
});
