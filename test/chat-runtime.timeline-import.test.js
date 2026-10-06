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

test('a history re-import that only moved updatedAt is not stored again', (t) => {
  // 回合进行中先导入一次（updatedAt=开始时间），回合结束后再导入只有 updatedAt 变化：
  // 不再追加整行副本。
  const { store, imports, sessionId } = createFixture(t);
  const during = event('history-during-turn', 'native-item-1', 'same content');
  const after = event('history-after-turn', 'native-item-1', 'same content');
  after.payload.item.updatedAt = 99;

  imports.import(sessionId, [during]);
  const repeat = imports.import(sessionId, [after]);

  assert.equal(repeat.events.length, 0);
  assert.equal(repeat.skipped, 1);
  assert.equal(store.getSession(sessionId).lastEventSeq, 2);
  assert.equal(store.getSnapshot(sessionId).timeline[0].content, 'same content');
});

test('a history re-import behind a newer live row is still appended', (t) => {
  const { store, imports, sessionId } = createFixture(t);
  imports.import(sessionId, [event('history-first', 'native-item-1', 'same content')]);
  store.appendEvent(sessionId, { ...event('live-update', 'native-item-1', 'live content'), eventId: undefined });
  const after = event('history-after-turn', 'native-item-1', 'same content');
  after.payload.item.updatedAt = 99;

  const repeat = imports.import(sessionId, [after]);

  assert.equal(repeat.events.length, 1, 'the latest row is live, so the import is not a stale repeat');
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

test('failed import validation does not poison the transaction-scoped tool guard', (t) => {
  const { store, imports, sessionId } = createFixture(t);
  const invalid = toolEvent('tool-invalid', 'tool-item-invalid', 'call-reusable', 'completed');
  invalid.type = 'unknown.event';

  assert.throws(
    () => imports.import(sessionId, [invalid]),
    (error) => error.code === 'unknown_chat_event_type'
  );
  imports.import(sessionId, [
    toolEvent('tool-valid', 'tool-item-valid', 'call-reusable', 'completed')
  ]);

  assert.equal(store.getSnapshot(sessionId).timeline.at(-1).id, 'tool-item-valid');
});

test('tool history keeps one canonical item owner per call id and rolls conflicts back', (t) => {
  const { store, imports, sessionId } = createFixture(t);
  const first = toolEvent('tool-start', 'tool-item-1', 'call-1', 'running');
  const completed = toolEvent('tool-done', 'tool-item-1', 'call-1', 'completed');

  imports.import(sessionId, [first]);
  imports.import(sessionId, [completed]);
  const before = store.getSnapshot(sessionId);
  assert.equal(before.timeline.length, 1);
  assert.equal(before.timeline[0].status, 'completed');

  assert.throws(() => imports.import(sessionId, [
    toolEvent('tool-call-2', 'tool-item-2', 'call-2', 'completed'),
    toolEvent('tool-call-conflict', 'tool-item-3', 'call-1', 'completed')
  ]), (error) => error.code === 'chat_tool_history_call_id_conflict');

  assert.deepEqual(store.getSnapshot(sessionId), before);
});

test('tool history keeps one call id per canonical item and rolls mutations back', (t) => {
  const { store, imports, sessionId } = createFixture(t);
  imports.import(sessionId, [toolEvent('tool-start', 'tool-item-1', 'call-1', 'running')]);
  const before = store.getSnapshot(sessionId);

  assert.throws(
    () => imports.import(sessionId, [
      toolEvent('tool-mutated-call', 'tool-item-1', 'call-2', 'completed')
    ]),
    (error) => error.code === 'chat_tool_history_item_call_id_conflict'
  );

  assert.deepEqual(store.getSnapshot(sessionId), before);
});

test('live event appends enforce the same tool history ownership contract', (t) => {
  const { store, sessionId } = createFixture(t);
  store.appendEvent(sessionId, toolEvent('ignored', 'tool-item-1', 'call-1', 'running'));

  assert.throws(
    () => store.appendEvent(sessionId, toolEvent('ignored', 'tool-item-2', 'call-1', 'completed')),
    (error) => error.code === 'chat_tool_history_call_id_conflict'
  );
  assert.equal(store.getSnapshot(sessionId).timeline.length, 1);
});

test('tool history preserves model item order when completion updates arrive out of order', (t) => {
  const { store, imports, sessionId } = createFixture(t);
  imports.import(sessionId, [
    toolEvent('first-start', 'first-tool', 'first-call', 'running'),
    toolEvent('second-start', 'second-tool', 'second-call', 'running')
  ]);
  imports.import(sessionId, [
    toolEvent('second-done', 'second-tool', 'second-call', 'completed'),
    toolEvent('first-done', 'first-tool', 'first-call', 'completed')
  ]);

  assert.deepEqual(store.getSnapshot(sessionId).timeline.map((item) => [
    item.id, item.detail.callId, item.status
  ]), [
    ['first-tool', 'first-call', 'completed'],
    ['second-tool', 'second-call', 'completed']
  ]);
});

test('imported model tool history requires an explicit call id', (t) => {
  const { imports, sessionId } = createFixture(t);
  const missing = toolEvent('tool-missing-call', 'tool-item', '', 'completed');
  delete missing.payload.item.detail.callId;

  assert.throws(
    () => imports.import(sessionId, [missing]),
    (error) => error.code === 'chat_tool_history_call_id_required'
  );
});

test('live model tool history also requires an explicit call id', (t) => {
  const { store, sessionId } = createFixture(t);
  const missing = toolEvent('ignored', 'tool-item', '', 'completed');
  delete missing.payload.item.detail.callId;

  assert.throws(
    () => store.appendEvent(sessionId, missing),
    (error) => error.code === 'chat_tool_history_call_id_required'
  );
});

test('legacy persisted tool items may settle without inventing a call id', (t) => {
  const { store, imports, sessionId } = createFixture(t);
  const legacy = toolEvent('legacy-start', 'legacy-tool', '', 'running');
  delete legacy.payload.item.detail.callId;
  store.context.db.prepare(`
    INSERT INTO chat_runtime_events (
      event_id, session_id, seq, schema, type, at, turn_id, run_id,
      item_id, source_json, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    legacy.eventId, sessionId, 2, 'aih.chat.event.v1', legacy.type, legacy.at,
    null, null, legacy.itemId, JSON.stringify(legacy.source), JSON.stringify(legacy.payload)
  );
  store.context.db.prepare(`
    UPDATE chat_runtime_sessions SET last_event_seq = 2 WHERE session_id = ?
  `).run(sessionId);
  const completed = toolEvent('legacy-done', 'legacy-tool', '', 'completed');
  delete completed.payload.item.detail.callId;

  imports.import(sessionId, [completed]);

  assert.equal(store.getSnapshot(sessionId).timeline.find((item) => item.id === 'legacy-tool').status, 'completed');
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

function toolEvent(eventId, itemId, callId, status) {
  return {
    eventId,
    type: status === 'running' ? 'timeline.item.started' : 'timeline.item.completed',
    at: 1,
    itemId,
    source: { provider: 'codex', runtimeId: 'codex:account-1' },
    payload: {
      item: {
        id: itemId,
        kind: 'tool',
        createdAt: 1,
        ...(status === 'running' ? {} : { updatedAt: 2 }),
        status,
        detail: { callId, name: 'probe', ...(status === 'completed' ? { result: 'ok' } : {}) }
      }
    }
  };
}

test('prewarm events outside the replay window are pruned when a new one is written', (t) => {
  const { store, sessionId } = createFixture(t);
  const { PREWARM_RETAINED_EVENT_WINDOW } = require('../lib/server/chat-runtime/event-repository');
  const prewarm = () => store.appendEvent(sessionId, {
    type: 'runtime.prewarm.started',
    source: { provider: 'codex', runtimeId: 'codex:account-1' },
    payload: { runtimeBinding: {}, capabilitySnapshot: {} }
  });
  const first = prewarm();
  for (let index = 0; index < PREWARM_RETAINED_EVENT_WINDOW; index += 1) {
    store.appendEvent(sessionId, { ...event(`history-${index}`, `item-${index}`, 'x') });
  }
  const latest = prewarm();

  const kept = store.context.db.prepare(`
    SELECT seq FROM chat_runtime_events WHERE session_id = ? AND type LIKE 'runtime.prewarm.%' ORDER BY seq
  `).all(sessionId).map((row) => row.seq);
  assert.deepEqual(kept, [latest.seq], 'the prewarm event now outside the window is gone');
  assert.ok(first.seq <= latest.seq - PREWARM_RETAINED_EVENT_WINDOW);
  const timelineRows = store.context.db.prepare(`
    SELECT COUNT(*) AS count FROM chat_runtime_events WHERE session_id = ? AND type LIKE 'timeline.item.%'
  `).get(sessionId).count;
  assert.equal(timelineRows, PREWARM_RETAINED_EVENT_WINDOW, 'timeline rows untouched');
});
