'use strict';

// DB pool：多账号会话库只读归并（不合并、不复制）。
//
// 守三件事：
//   1) 100 个库的列表查询在毫秒级（实测 ~3ms，这里给 250ms 的宽松上限防回归）；
//   2) 跨库按时间倒序归并、按会话 id 去重（同一个 id 只出现一次）；
//   3) 某个库损坏/被独占时只丢这个来源，不影响整体。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionDbPool } = require('../lib/sessions/session-db-pool');

let DatabaseSync = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch (_error) { DatabaseSync = null; }

function withRoot(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-dbpool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fn(root);
}

function buildDb(root, name, rows) {
  const dbPath = path.join(root, name, 'db', 'sessions.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at INTEGER, cwd TEXT, title TEXT, prompt TEXT)');
  const insert = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)');
  for (const row of rows) {
    insert.run(row.id, row.startedAt, '/p', row.title || row.id, 'prompt');
  }
  db.close();
  return dbPath;
}

const skip = DatabaseSync ? false : 'node:sqlite unavailable';

test('100 个账号库：归并列表毫秒级、按时间倒序、按 id 去重', { skip }, (t) => withRoot(t, (root) => {
  const sources = [];
  let clock = 1_700_000_000_000;
  for (let account = 0; account < 100; account += 1) {
    const rows = [];
    for (let index = 0; index < 200; index += 1) {
      clock += 1000;
      rows.push({ id: `a${account}-s${index}`, startedAt: clock });
    }
    // 让两个账号各带一条相同的会话 id（同一段对话被两个库同时看到的情形）
    if (account === 1) rows.push({ id: 'a0-s0', startedAt: clock - 1, title: 'dup' });
    sources.push({ id: `acct${account}`, dbPath: buildDb(root, `acct${account}`, rows) });
  }

  const pool = createSessionDbPool({ fs, path, DatabaseSync });
  const startedAt = process.hrtime.bigint();
  const result = pool.querySessionList({ sources, limit: 50 });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  assert.equal(result.failed.length, 0);
  assert.equal(result.sources, 100);
  assert.equal(result.rows.length, 50);
  const ids = result.rows.map((row) => row.session_id);
  assert.equal(new Set(ids).size, 50);
  const times = result.rows.map((row) => Number(row.started_at));
  assert.deepEqual(times, [...times].sort((left, right) => right - left));
  console.log(`[dbpool] 100 库 / 20000 行, limit=50 -> ${elapsedMs.toFixed(2)} ms`);
  assert.ok(elapsedMs < 250, `too slow: ${elapsedMs.toFixed(2)} ms`);

  // 第二次查询走连接池，应该更快且结果一致
  const again = pool.querySessionList({ sources, limit: 50 });
  assert.deepEqual(again.rows.map((row) => row.session_id), ids);
  assert.equal(pool.stats().opens, 100);
  pool.closeAll();
}));

test('同一会话出现在两个库：只保留一条', { skip }, (t) => withRoot(t, (root) => {
  const first = buildDb(root, 'a', [{ id: 'shared', startedAt: 100 }]);
  const second = buildDb(root, 'b', [
    { id: 'shared', startedAt: 100, title: 'dup' },
    { id: 'only-b', startedAt: 200 }
  ]);
  const pool = createSessionDbPool({ fs, path, DatabaseSync });
  const result = pool.querySessionList({
    sources: [{ id: 'a', dbPath: first }, { id: 'b', dbPath: second }],
    limit: 10
  });
  assert.deepEqual(result.rows.map((row) => row.session_id), ['only-b', 'shared']);
  pool.closeAll();
}));

test('库损坏 / 不存在：只丢该来源，不影响其它账号', { skip }, (t) => withRoot(t, (root) => {
  const good = buildDb(root, 'good', [{ id: 's1', startedAt: 10 }]);
  const broken = path.join(root, 'broken', 'db', 'sessions.db');
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, 'not a sqlite file');
  const pool = createSessionDbPool({ fs, path, DatabaseSync });
  const result = pool.querySessionList({
    sources: [
      { id: 'good', dbPath: good },
      { id: 'broken', dbPath: broken },
      { id: 'missing', dbPath: path.join(root, 'nope', 'sessions.db') }
    ],
    limit: 10
  });
  assert.deepEqual(result.rows.map((row) => row.session_id), ['s1']);
  assert.equal(result.sources, 1);
  assert.equal(result.failed.length, 2);
  pool.closeAll();
}));
