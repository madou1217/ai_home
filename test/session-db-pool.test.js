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

// ---------------------------------------------------------------------------
// 回归基准：只用**结构性断言 + 同进程相对比较**，不写绝对耗时阈值。
// 绝对毫秒数在不同机器/负载下会抖，写死就会变成 flaky test；能稳定守住的是：
//   - 缓存命中时不再逐库查询（queries 不涨、cacheHits 涨）；
//   - 连接池上限默认高于常见账号数（否则 LRU 抖动，实测会慢 3~9 倍）；
//   - 同一份数据下，池的热路径不慢于"分批 ATTACH + UNION ALL"。
// 绝对数字由 scripts/bench-session-db-pool.js 输出，进 docs/verification 记录趋势。
// ---------------------------------------------------------------------------

function attachBatchMs(sources, limit, iterations) {
  const { DatabaseSync } = require('node:sqlite');
  const run = () => {
    const master = new DatabaseSync(':memory:');
    const rows = [];
    for (let start = 0; start < sources.length; start += 10) {
      const batch = sources.slice(start, start + 10);
      const aliases = batch.map((source, index) => {
        const alias = 'a' + index;
        master.exec("ATTACH DATABASE '" + source.dbPath.replace(/'/g, "''") + "' AS " + alias);
        return alias;
      });
      const sql = aliases
        .map((alias) => 'SELECT * FROM (SELECT session_id, started_at FROM ' + alias + '.sessions ORDER BY started_at DESC LIMIT ' + limit + ')')
        .join(' UNION ALL ');
      rows.push(...master.prepare(sql).all());
      for (const alias of aliases) master.exec('DETACH DATABASE ' + alias);
    }
    master.close();
    rows.sort((left, right) => Number(right.started_at) - Number(left.started_at));
    return rows.length;
  };
  run();
  const startedAt = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) run();
  return Number(process.hrtime.bigint() - startedAt) / 1e6 / iterations;
}

test('回归基准：缓存命中不重复查询，热路径不慢于分批 ATTACH', { skip }, (t) => withRoot(t, (root) => {
  const sources = [];
  for (let account = 0; account < 100; account += 1) {
    const dbPath = buildDb(root, 'bench' + account, Array.from({ length: 100 }, (_, index) => ({
      id: '17920502488' + String(account).padStart(2, '0') + '_' + String(index).padStart(3, '0'),
      startedAt: 1_700_000_000_000 + account * 1000 + index
    })));
    sources.push({ id: 'bench' + account, dbPath });
  }

  const pool = createSessionDbPool({ fs, path, DatabaseSync });
  pool.querySessionList({ sources, limit: 50 });            // 冷启动：建连接 + 填缓存
  const before = pool.stats();
  const warmStartedAt = process.hrtime.bigint();
  for (let index = 0; index < 5; index += 1) pool.querySessionList({ sources, limit: 50 });
  const poolMs = Number(process.hrtime.bigint() - warmStartedAt) / 1e6 / 5;
  const after = pool.stats();

  // 结构性断言：库没变就不该再逐库查询。
  assert.equal(after.queries, before.queries);
  assert.equal(after.cacheHits - before.cacheHits, 500);

  const attachMs = attachBatchMs(sources, 50, 3);
  console.log(`[dbpool-bench] pool ${poolMs.toFixed(2)} ms vs attach ${attachMs.toFixed(2)} ms (100 账号)`);
  // 留 1.5x 余量吸收机器抖动；真正的性能结论看 docs/verification。
  assert.ok(poolMs < attachMs * 1.5, `pool ${poolMs.toFixed(2)}ms 明显慢于 attach ${attachMs.toFixed(2)}ms`);
  pool.closeAll();
}));
