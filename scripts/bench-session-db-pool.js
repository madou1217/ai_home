'use strict';

/**
 * 会话库读取方案基准：连接池归并 vs 分批 ATTACH + UNION ALL。
 *
 * 背景：cline 这类 Provider 每个账号一个 `sessions.db`，要跨账号列出会话且**不合并库、
 * 不复制行**。SQLite 的 `SQLITE_MAX_ATTACHED` 是编译期常量（Node 内置的那份是 10），
 * 运行时改不了；所以只剩两条路可比：
 *   A. 常驻只读连接池：每库一条连接，各取前 N 行，JS 里归并；
 *   B. 分批 ATTACH（每批 10 个库）+ 子查询 UNION ALL，批间再归并。
 *
 * 用法：
 *   node scripts/bench-session-db-pool.js                 # 默认 100 库 × 200 行
 *   node scripts/bench-session-db-pool.js --accounts 200 --rows 500 --limit 50
 *   node scripts/bench-session-db-pool.js --json
 *
 * 指标：
 *   - cold：池子首次查询（含 N 次只读连接打开）
 *   - warm：之后每一次列表查询的平均值
 *   - attach：每次查询都 ATTACH/DETACH 一遍（分批）的耗时
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionDbPool } = require('../lib/sessions/session-db-pool');

function parseArgs(argv) {
  const args = { accounts: 100, rows: 200, limit: 50, warm: 5, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') { args.json = true; continue; }
    const key = token.replace(/^--/, '');
    const value = argv[index + 1];
    if (['accounts', 'rows', 'limit', 'warm'].includes(key)) {
      args[key] = Math.max(1, Number(value) || args[key]);
      index += 1;
    }
  }
  return args;
}

function createDatabases(root, accounts, rows) {
  const { DatabaseSync } = require('node:sqlite');
  const sources = [];
  for (let account = 0; account < accounts; account += 1) {
    const dbPath = path.join(root, `acct${account}`, 'db', 'sessions.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at INTEGER, title TEXT, cwd TEXT)');
    const insert = db.prepare('INSERT INTO sessions VALUES (?,?,?,?)');
    for (let row = 0; row < rows; row += 1) {
      insert.run(`s${account}_${row}`, Date.now() - row * 1000, 'title ' + row, '/repo');
    }
    db.close();
    sources.push({ id: `acct${account}`, dbPath });
  }
  return sources;
}

function measure(label, fn, iterations) {
  fn();
  const startedAt = process.hrtime.bigint();
  let rows = 0;
  for (let index = 0; index < iterations; index += 1) rows = fn();
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6 / iterations;
  return { label, elapsedMs, rows };
}

function runAttachBatch(sources, limit) {
  const { DatabaseSync } = require('node:sqlite');
  const master = new DatabaseSync(':memory:');
  const rows = [];
  for (let start = 0; start < sources.length; start += 10) {
    const batch = sources.slice(start, start + 10);
    const aliases = batch.map((source, index) => {
      const alias = `a${index}`;
      master.exec(`ATTACH DATABASE '${source.dbPath.replace(/'/g, "''")}' AS ${alias}`);
      return alias;
    });
    const sql = aliases
      .map((alias) => `SELECT * FROM (SELECT session_id, started_at FROM ${alias}.sessions ORDER BY started_at DESC LIMIT ${limit})`)
      .join(' UNION ALL ');
    rows.push(...master.prepare(sql).all());
    for (const alias of aliases) master.exec(`DETACH DATABASE ${alias}`);
  }
  master.close();
  rows.sort((left, right) => Number(right.started_at) - Number(left.started_at));
  return Math.min(rows.length, limit);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-dbpool-bench-'));
  try {
    const sources = createDatabases(root, args.accounts, args.rows);
    const pool = createSessionDbPool({ fs, path });
    const coldStartedAt = process.hrtime.bigint();
    const coldResult = pool.querySessionList({ sources, limit: args.limit });
    const coldMs = Number(process.hrtime.bigint() - coldStartedAt) / 1e6;

    const warm = measure('warm', () => pool.querySessionList({ sources, limit: args.limit }).rows.length, args.warm);
    const attach = measure('attach', () => runAttachBatch(sources, args.limit), Math.max(1, Math.min(3, args.warm)));

    const report = {
      accounts: args.accounts,
      rowsPerAccount: args.rows,
      limit: args.limit,
      coldMs: Number(coldMs.toFixed(2)),
      warmMs: Number(warm.elapsedMs.toFixed(2)),
      attachMs: Number(attach.elapsedMs.toFixed(2)),
      rowsReturned: coldResult.rows.length,
      speedup: Number((attach.elapsedMs / warm.elapsedMs).toFixed(2))
    };
    pool.closeAll();

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`accounts=${report.accounts} rows/account=${report.rowsPerAccount} limit=${report.limit}`);
    console.log(`  pool cold（含 ${args.accounts} 次只读连接打开）: ${report.coldMs} ms`);
    console.log(`  pool warm（平均）                     : ${report.warmMs} ms`);
    console.log(`  分批 ATTACH + UNION ALL（平均）        : ${report.attachMs} ms`);
    console.log(`  归并比 ATTACH 快                      : ${report.speedup}x`);
    console.log(`  返回行数                              : ${report.rowsReturned}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = { createDatabases, runAttachBatch, parseArgs };
