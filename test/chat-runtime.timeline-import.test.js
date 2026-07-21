'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { TimelineImportRepository } = require(
  '../lib/server/chat-runtime/timeline-import-repository'
);
const { ChatRuntimeEventHub } = require('../lib/server/chat-runtime-event-hub');
const {
  ChatRuntimePublishingStore
} = require('../lib/server/chat-runtime-publishing-store');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');

test('timeline import is transactional, idempotent, and replaces an updated native item', (t) => {
  const { store, imports, sessionId } = createFixture(t);
  const initial = event('history-v1', 'native-item-1', 'first');

  const first = imports.import(sessionId, [initial]);
  const duplicate = imports.import(sessionId, [initial]);
  const updated = imports.import(sessionId, [
    event('history-v2', 'native-item-1', 'updated')
  ]);

  assert.equal(first.events.length, 1);
  assert.equal(first.skipped, 0);
  assert.equal(duplicate.events.length, 0);
  assert.equal(duplicate.skipped, 1);
  assert.equal(updated.events.length, 1);
  assert.equal(store.getSnapshot(sessionId).timeline.length, 1);
  assert.equal(store.getSnapshot(sessionId).timeline[0].content, 'updated');
  assert.equal(store.getSession(sessionId).lastEventSeq, 3);
});

test('timeline import rolls the complete batch back when one event is invalid', (t) => {
  const { store, imports, sessionId } = createFixture(t);

  assert.throws(() => imports.import(sessionId, [
    event('history-valid', 'native-item-1', 'first'),
    { ...event('history-invalid', 'native-item-2', 'second'), type: 'unknown.event' }
  ]), (error) => error.code === 'unknown_chat_event_type');

  assert.equal(store.getSession(sessionId).lastEventSeq, 1);
  assert.deepEqual(store.getSnapshot(sessionId).timeline, []);
});

test('timeline import rejects a stable event id already owned by another session', (t) => {
  const { store, imports, sessionId } = createFixture(t);
  const other = store.createSession({
    sessionId: 'session-other', provider: 'codex', executionAccountRef: 'account-1',
    projectPath: '/repo', runtimeBinding: {}, capabilitySnapshot: {}, policy: {}
  });
  imports.import(sessionId, [event('history-shared', 'native-item-1', 'first')]);

  assert.throws(
    () => imports.import(other.sessionId, [event('history-shared', 'native-item-2', 'second')]),
    (error) => error.code === 'chat_history_event_conflict'
  );
});

test('chat runtime store exposes timeline import through its canonical persistence port', (t) => {
  const { store, sessionId } = createFixture(t);

  const result = store.importTimeline(sessionId, [
    event('history-store-port', 'native-item-store', 'through store')
  ]);

  assert.equal(result.events.length, 1);
  assert.equal(result.skipped, 0);
  assert.equal(store.getSnapshot(sessionId).timeline[0].content, 'through store');
});

test('event replay pages stop at the requested persisted sequence', (t) => {
  const { store, sessionId } = createFixture(t);
  store.importTimeline(sessionId, [
    event('history-bound-1', 'native-item-bound-1', 'first'),
    event('history-bound-2', 'native-item-bound-2', 'second')
  ]);

  assert.deepEqual(
    store.listEvents(sessionId, { after: 0, through: 2, limit: 100 }).map(({ seq }) => seq),
    [1, 2]
  );
});

test('event replay treats nullable or empty through values as no upper bound', (t) => {
  const { store, sessionId } = createFixture(t);
  store.importTimeline(sessionId, [
    event('history-nullable-1', 'native-item-nullable-1', 'first'),
    event('history-nullable-2', 'native-item-nullable-2', 'second')
  ]);

  for (const through of [null, '']) {
    assert.deepEqual(
      store.listEvents(sessionId, { after: 0, through, limit: 100 }).map(({ seq }) => seq),
      [1, 2, 3]
    );
  }
});

test('publishing store emits only newly imported timeline events', (t) => {
  const { store, sessionId } = createFixture(t);
  const eventHub = new ChatRuntimeEventHub();
  const published = [];
  eventHub.subscribe(sessionId, (entry) => published.push(entry));
  const publishing = new ChatRuntimePublishingStore({ store, eventHub });
  const history = event('history-published', 'native-item-published', 'published');

  publishing.importTimeline(sessionId, [history]);
  publishing.importTimeline(sessionId, [history]);

  assert.deepEqual(published.map(({ eventId }) => eventId), ['history-published']);
});

test('publishing store emits imported history beyond one repository page in sequence', (t) => {
  const { store, sessionId } = createFixture(t);
  const eventHub = new ChatRuntimeEventHub();
  const published = [];
  eventHub.subscribe(sessionId, (entry) => published.push(entry));
  const publishing = new ChatRuntimePublishingStore({ store, eventHub });
  const history = Array.from({ length: 1_001 }, (_value, index) => (
    event(`history-page-${index}`, `native-item-page-${index}`, `item ${index}`)
  ));

  publishing.importTimeline(sessionId, history);

  assert.deepEqual(
    published.map(({ seq }) => seq),
    Array.from({ length: 1_001 }, (_value, index) => index + 2)
  );
});

test('publishing store propagates a repository failure from a later page', () => {
  const failure = new Error('page read failed');
  let reads = 0;
  const publishing = new ChatRuntimePublishingStore({
    store: {
      getSession: () => ({ lastEventSeq: 2 }),
      listEvents() {
        reads += 1;
        if (reads === 1) return [{ seq: 1 }];
        throw failure;
      }
    },
    eventHub: { publish() {} }
  });

  assert.throws(() => publishing.publishSince('session-1', 0), (error) => error === failure);
  assert.equal(reads, 2);
});

test('publishing store keeps one high-water mark when new events arrive during replay', () => {
  const observedThrough = [];
  const published = [];
  let lastEventSeq = 2;
  const publishing = new ChatRuntimePublishingStore({
    store: {
      getSession: () => ({ lastEventSeq }),
      listEvents(_sessionId, options) {
        observedThrough.push(options.through);
        return options.after === 0 ? [{ seq: 1 }] : [{ seq: 2 }];
      }
    },
    eventHub: {
      publish(event) {
        published.push(event.seq);
        if (event.seq === 1) lastEventSeq = 3;
      }
    }
  });

  assert.equal(publishing.publishSince('session-1', 0), 2);
  assert.deepEqual(published, [1, 2]);
  assert.deepEqual(observedThrough, [2, 2]);
});

test('publishing store fails closed when a persisted sequence page cannot advance', () => {
  const publishing = new ChatRuntimePublishingStore({
    store: {
      getSession: () => ({ lastEventSeq: 2 }),
      listEvents: () => []
    },
    eventHub: { publish() {} }
  });

  assert.throws(
    () => publishing.publishSince('session-1', 0),
    (error) => (
      error.code === 'chat_runtime_publish_sequence_gap'
      && error.details.expectedSeq === 1
      && error.details.throughSeq === 2
    )
  );
});

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-history-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openChatRuntimeStore({ fs, aiHomeDir: root, DatabaseSync });
  t.after(() => store.close());
  const session = store.createSession({
    sessionId: 'session-1', provider: 'codex', executionAccountRef: 'account-1',
    projectPath: '/repo', runtimeBinding: {}, capabilitySnapshot: {}, policy: {}
  });
  return {
    store,
    sessionId: session.sessionId,
    imports: new TimelineImportRepository(store.context, store.events)
  };
}

function event(eventId, itemId, content) {
  return {
    eventId,
    type: 'timeline.item.completed',
    at: 1,
    itemId,
    source: { provider: 'codex', runtimeId: 'codex:account-1' },
    payload: {
      item: {
        id: itemId,
        kind: 'message',
        createdAt: 1,
        updatedAt: 1,
        status: 'completed',
        detail: { role: 'assistant' },
        content
      }
    }
  };
}
