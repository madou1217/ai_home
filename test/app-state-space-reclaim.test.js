'use strict';

// app-state.db 的磁盘回收：WAL 有上限、删除腾出的空闲页能还给磁盘。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { reclaimFreePages } = require('../lib/server/app-state-space-reclaim');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-space-reclaim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fillAndDelete(db) {
  db.exec('CREATE TABLE blob_rows (id INTEGER PRIMARY KEY, body TEXT)');
  const insert = db.prepare('INSERT INTO blob_rows (body) VALUES (?)');
  for (let index = 0; index < 400; index += 1) insert.run('x'.repeat(8000));
  db.exec('DELETE FROM blob_rows');
}

test('every app-state connection caps the WAL size', (t) => {
  const db = openAppStateDatabase(fs, tempDir(t), { DatabaseSync });
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA journal_size_limit').get().journal_size_limit, 64 * 1024 * 1024);
});

test('free pages are returned to the disk when incremental auto_vacuum is on', (t) => {
  const file = path.join(tempDir(t), 'incremental.db');
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
  fillAndDelete(db);
  const freeBefore = db.prepare('PRAGMA freelist_count').get().freelist_count;
  assert.ok(freeBefore > 100);

  const result = reclaimFreePages(db);

  assert.equal(result.enabled, true);
  assert.equal(result.reclaimedPages, freeBefore);
  assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count, 0);
  assert.deepEqual(reclaimFreePages(db), { enabled: true, reclaimedPages: 0 }, 'nothing left to reclaim');
});

test('databases without incremental auto_vacuum are left alone', (t) => {
  const db = new DatabaseSync(path.join(tempDir(t), 'none.db'));
  t.after(() => db.close());
  fillAndDelete(db);
  const freeBefore = db.prepare('PRAGMA freelist_count').get().freelist_count;

  assert.deepEqual(reclaimFreePages(db), { enabled: false, reclaimedPages: 0 });
  assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count, freeBefore);
});
