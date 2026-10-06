'use strict';

// 一次性回填：历史导入行去重复字段、合并只差 updatedAt 的副本、清窗口外预热事件；
// 实时运行写入的行一行都不碰。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const {
  COMPACTION_MARKER,
  compactStoredTimelineHistory
} = require('../lib/server/chat-runtime/timeline-history-compaction');

const SOURCE = { provider: 'codex', runtimeId: 'codex:account-1' };

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-timeline-compaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openChatRuntimeStore({ fs, aiHomeDir: root, DatabaseSync, historyCompaction: false });
  t.after(() => store.close());
  const session = store.createSession({
    sessionId: 'session-1', provider: 'codex', executionAccountRef: 'account-1',
    projectPath: '/repo', runtimeBinding: {}, capabilitySnapshot: {}, policy: {}
  });
  const append = (eventId, item) => store.appendEvent(session.sessionId, {
    eventId, type: 'timeline.item.completed', at: 1, itemId: item.id, source: SOURCE, payload: { item }
  });
  const rows = () => store.context.db.prepare(`
    SELECT event_id, payload_json FROM chat_runtime_events
    WHERE session_id = ? AND type LIKE 'timeline.item.%' ORDER BY seq
  `).all(session.sessionId);
  return { store, sessionId: session.sessionId, append, rows, db: store.context.db };
}

const shell = (id, updatedAt) => ({
  id, kind: 'shell', createdAt: 1, updatedAt, status: 'completed',
  detail: { callId: id, command: 'ls', output: 'a\nb' }, content: 'a\nb'
});
const fileChange = (id) => ({
  id, kind: 'file_change', createdAt: 1, updatedAt: 1, status: 'completed',
  detail: { callId: id, changes: [{ path: '/x', diff: 'D1' }, { path: '/y', diff: 'D2' }], diff: 'D1\nD2' },
  content: 'D1\nD2'
});

test('history payloads keep one copy of shell output and file diffs', (t) => {
  const f = createFixture(t);
  f.append('history-shell', shell('s1', 1));
  f.append('history-file', fileChange('f1'));

  const stats = compactStoredTimelineHistory(f.db);

  assert.equal(stats.rowsCompacted, 2);
  const [shellRow, fileRow] = f.rows().map((row) => JSON.parse(row.payload_json).item);
  assert.equal(shellRow.content, 'a\nb');
  assert.equal(shellRow.detail.output, undefined);
  assert.deepEqual(fileRow.detail.changes.map((change) => change.diff), ['D1', 'D2'], 'per-file diffs are the single source');
  assert.equal(fileRow.detail.diff, undefined);
  assert.equal(fileRow.content, undefined);
});

test('adjacent history repeats that only moved updatedAt merge into the earliest row', (t) => {
  const f = createFixture(t);
  f.append('history-during', shell('s1', 1));
  f.append('history-other', shell('s2', 1));
  f.append('history-after', shell('s1', 99));

  const stats = compactStoredTimelineHistory(f.db);

  assert.equal(stats.rowsMerged, 1);
  const rows = f.rows();
  assert.deepEqual(rows.map((row) => row.event_id), ['history-during', 'history-other'], 'earliest position kept');
  assert.equal(JSON.parse(rows[0].payload_json).item.updatedAt, 99, 'carries the newer timestamp');
  assert.deepEqual(f.store.getSnapshot(f.sessionId).timeline.map((item) => item.id), ['s1', 's2']);
});

test('live rows are never compacted and break the merge chain', (t) => {
  const f = createFixture(t);
  f.append('history-first', shell('s1', 1));
  f.append('live-row', { ...shell('s1', 5), content: 'a\nb' });
  f.append('history-again', shell('s1', 99));

  const stats = compactStoredTimelineHistory(f.db);

  assert.equal(stats.rowsMerged, 0);
  const live = f.rows().find((row) => row.event_id === 'live-row');
  assert.equal(JSON.parse(live.payload_json).item.detail.output, 'a\nb', 'live rows are the only copy and stay as written');
});

test('the completion marker makes later runs a no-op', (t) => {
  const f = createFixture(t);
  f.append('history-shell', shell('s1', 1));

  compactStoredTimelineHistory(f.db);
  const second = compactStoredTimelineHistory(f.db);

  assert.equal(second.skipped, true);
  assert.ok(f.db.prepare('SELECT 1 FROM app_kv WHERE key = ?').get(COMPACTION_MARKER));
});
