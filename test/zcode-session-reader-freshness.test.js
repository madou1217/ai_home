'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readSessionMessages } = require('../lib/sessions/session-reader');

function sessionStore(t) {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-reader-'));
  const dbPath = path.join(hostHomeDir, '.zcode', 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, sequence INTEGER, data TEXT);
    CREATE TABLE part (message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);`);
  let sequence = 0;
  const append = (sessionId, role, content) => {
    const id = `message-${sequence++}`;
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(id, sessionId, Date.now(), sequence, JSON.stringify({ role }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(id, sessionId, sequence, JSON.stringify({ type: 'text', text: content }));
  };
  const read = sessionId => readSessionMessages('zcode', { sessionId }, { hostHomeDir });
  t.after(() => { db.close(); fs.rmSync(hostHomeDir, { recursive: true, force: true }); });
  return { dbPath, append, read };
}

test('ZCode readers observe new native WAL messages while the main database file remains unchanged', t => {
  const h = sessionStore(t);
  h.append('sess_first', 'user', 'Original question');
  assert.equal(h.read('sess_first').length, 1);
  const before = fs.statSync(h.dbPath);
  h.append('sess_first', 'assistant', 'New native response');
  const after = fs.statSync(h.dbPath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  assert.deepEqual(h.read('sess_first').map(row => row.content), ['Original question', 'New native response']);
});

test('reading another ZCode session never returns the previous session from the same SQLite file', t => {
  const h = sessionStore(t);
  h.append('sess_first', 'user', 'First session');
  h.append('sess_second', 'user', 'Second session');
  assert.equal(h.read('sess_first')[0].content, 'First session');
  assert.equal(h.read('sess_second')[0].content, 'Second session');
  assert.equal(h.read('sess_first')[0].content, 'First session');
});
