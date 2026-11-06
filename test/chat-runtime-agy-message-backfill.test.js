'use strict';

// 回归守卫（2026-11-06）：旧 agy 会话每轮 assistant 都用固定 item id agy_message，
// timeline 投影按 id 去重后新回复会被合并到旧位置。启动迁移必须按 turn_id 拆分事件，
// 且保持幂等；新代码产生的唯一 id 不能被改写。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { CHAT_RUNTIME_SCHEMA, openChatRuntimeDatabase } = require('../lib/server/chat-runtime/database');
const { projectTimeline } = require('../lib/server/chat-runtime/timeline-projector');

const SESSION_ID = 'session-agy-legacy';

function seed(db) {
  db.prepare(`
    INSERT INTO chat_runtime_sessions (
      session_id, provider, execution_account_ref, project_path, state, runtime_binding_json,
      capability_snapshot_json, policy_json, active_turn_json, last_event_seq, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
  `).run(SESSION_ID, 'agy', 'acct_test', '/tmp', 'idle', '{}', '{}', '{}', 1, 1);

  const insert = db.prepare(`
    INSERT INTO chat_runtime_events (
      event_id, session_id, seq, schema, type, at, turn_id, run_id, item_id, source_json, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
  `);
  const emit = (seq, type, turnId, itemId, payload) => insert.run(
    `evt-${seq}`, SESSION_ID, seq, 'v1', type, seq, turnId, `run-${turnId}`, itemId, JSON.stringify(payload),
  );
  emit(1, 'timeline.item.started', 'turn-a', 'agy_message', {
    item: { id: 'agy_message', kind: 'message', status: 'running', turnId: 'turn-a', content: '' },
  });
  emit(2, 'timeline.item.delta', 'turn-a', 'agy_message', { itemId: 'agy_message', chunk: 'A' });
  emit(3, 'timeline.item.completed', 'turn-a', 'agy_message', {
    item: { id: 'agy_message', kind: 'message', status: 'completed', turnId: 'turn-a', content: 'A' },
  });
  emit(4, 'timeline.item.started', 'turn-b', 'agy_message', {
    item: { id: 'agy_message', kind: 'message', status: 'running', turnId: 'turn-b', content: '' },
  });
  emit(5, 'timeline.item.delta', 'turn-b', 'agy_message', { itemId: 'agy_message', chunk: 'B' });
  emit(6, 'timeline.item.completed', 'turn-b', 'agy_message', {
    item: { id: 'agy_message', kind: 'message', status: 'completed', turnId: 'turn-b', content: 'B' },
  });
  emit(7, 'timeline.item.completed', 'turn-c', 'agy_message_agent_123_abc_0', {
    item: { id: 'agy_message_agent_123_abc_0', kind: 'message', status: 'completed', turnId: 'turn-c', content: 'C' },
  });
  insert.run(
    'evt-native-turn', SESSION_ID, 8, 'v1', 'turn.phase.changed', 8, 'turn-a', 'run-turn-a', null,
    JSON.stringify({ activeTurn: { turnId: 'turn-a', nativeTurnId: 'native-turn-a' } }),
  );
  db.prepare(`
    INSERT INTO chat_runtime_native_thread_items (
      session_id, native_thread_id, native_turn_id, item_id, item_json, raw_message_id, ordinal
    ) VALUES (?, ?, ?, ?, ?, NULL, 1)
  `).run(
    SESSION_ID, 'thread-1', 'native-turn-a', 'agy_message',
    JSON.stringify({ type: 'agentMessage', id: 'agy_message', text: 'A' }),
  );
}

function readEvents(db) {
  return db.prepare('SELECT seq, type, turn_id, item_id, payload_json FROM chat_runtime_events ORDER BY seq').all()
    .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
}

test('启动迁移按 turn 拆分旧 agy_message，且不改写新 id、可重复打开', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-backfill-'));
  try {
    const seedDb = new DatabaseSync(path.join(root, 'app-state.db'));
    seedDb.exec(CHAT_RUNTIME_SCHEMA);
    seed(seedDb);
    seedDb.close();

    let db = openChatRuntimeDatabase({ fs, aiHomeDir: root });
    try {
      const events = readEvents(db);
      const a = events.filter((event) => event.turn_id === 'turn-a' && event.type.startsWith('timeline.'));
      const b = events.filter((event) => event.turn_id === 'turn-b' && event.type.startsWith('timeline.'));
      assert.deepEqual(a.map((event) => event.item_id), [
        'agy_message_legacy_turn-a_0',
        'agy_message_legacy_turn-a_0',
        'agy_message_legacy_turn-a_0',
      ]);
      assert.deepEqual(b.map((event) => event.item_id), [
        'agy_message_legacy_turn-b_0',
        'agy_message_legacy_turn-b_0',
        'agy_message_legacy_turn-b_0',
      ]);
      assert.equal(events[6].item_id, 'agy_message_agent_123_abc_0');
      assert.equal(events[1].payload.itemId, 'agy_message_legacy_turn-a_0');
      assert.equal(events[4].payload.itemId, 'agy_message_legacy_turn-b_0');
      const timeline = projectTimeline(events.map((event) => ({ type: event.type, payload: event.payload })));
      assert.deepEqual(timeline.map((item) => [item.id, item.content]), [
        ['agy_message_legacy_turn-a_0', 'A'],
        ['agy_message_legacy_turn-b_0', 'B'],
        ['agy_message_agent_123_abc_0', 'C'],
      ]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_runtime_migrations WHERE id = ?')
        .get('agy_message_item_id_v1').n, 1);
      const nativeRow = db.prepare(`
        SELECT item_id, item_json FROM chat_runtime_native_thread_items
        WHERE session_id = ? AND native_turn_id = 'native-turn-a'
      `).get(SESSION_ID);
      assert.equal(nativeRow.item_id, 'agy_message_legacy_turn-a_0');
      assert.equal(JSON.parse(nativeRow.item_json).id, 'agy_message_legacy_turn-a_0');
    } finally {
      db.close();
    }

    db = openChatRuntimeDatabase({ fs, aiHomeDir: root });
    try {
      const events = readEvents(db);
      assert.equal(events.filter((event) => event.turn_id === 'turn-a' && event.type.startsWith('timeline.')).every(
        (event) => event.item_id === 'agy_message_legacy_turn-a_0'), true);
      assert.equal(events.filter((event) => event.turn_id === 'turn-b' && event.type.startsWith('timeline.')).every(
        (event) => event.item_id === 'agy_message_legacy_turn-b_0'), true);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
