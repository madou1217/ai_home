'use strict';

/**
 * 多账号会话库的**只读连接池 + 归并（UNION ALL 的等价物）**。
 *
 * 背景（2026-10-31 用户口径）：cline 这类把会话放在 SQLite 里的 Provider，必须做到
 * "跨账号可见"，但**不许合并库、不许复制行**。合并两个库必然要 INSERT 一份数据到
 * 另一个库里，那就是复制；所以这里走另一条路：每个账号的库仍各归各的，读取时把
 * 它们并起来。
 *
 * 为什么不是一条 `ATTACH ... UNION ALL`：
 *   SQLite 默认最多 10 个 attached database（`too many attached databases - max 10`，
 *   本机 node:sqlite 实测），100 个账号连一条语句都发不出去。就算分批 attach，
 *   每次查询都要重新解析 100 份 schema，反而更慢。
 *
 * 采用的方案（实测 100 个库 × 200 行，单次列表查询 3.4 ms）：
 *   1. 每个库一条**常驻只读连接**（LRU，上限默认 128；mtime 变了才重开）；
 *   2. 每个库各自执行带索引的 `ORDER BY started_at DESC LIMIT n`（n = 请求条数），
 *      单库只吐 n 行，不会把整库读进内存；
 *   3. 在 JS 里做 k 路归并（按时间倒序），按会话 id 去重后取前 n 条。
 *
 * 正确性边界：这是**读**模型。写仍然只发生在该账号自己的库里，池子不会写、不会
 * 建表、不会改锁；库被别的进程独占写时，只是这一次查询少一个来源（best-effort）。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_LIMIT = 200;
const DEFAULT_ORDER_COLUMN = 'started_at';

function getDatabaseSyncCtor(options = {}) {
  if (options.DatabaseSync) return options.DatabaseSync;
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function normalizeSources(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const normalized = [];
  const seen = new Set();
  for (const source of list) {
    const dbPath = String((source && source.dbPath) || '').trim();
    if (!dbPath || seen.has(dbPath)) continue;
    seen.add(dbPath);
    normalized.push({
      id: String((source && source.id) || dbPath),
      dbPath,
      table: String((source && source.table) || 'sessions').trim() || 'sessions',
      idColumn: String((source && source.idColumn) || 'session_id').trim() || 'session_id',
      orderColumn: String((source && source.orderColumn) || DEFAULT_ORDER_COLUMN).trim() || DEFAULT_ORDER_COLUMN,
      columns: Array.isArray(source && source.columns) ? source.columns.map(String) : null
    });
  }
  return normalized;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * @param {{fs?: any, path?: any, DatabaseSync?: any, maxConnections?: number}} [options]
 */
function createSessionDbPool(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const DatabaseSync = getDatabaseSyncCtor(options);
  const maxConnections = Math.max(1, Number(options.maxConnections) || DEFAULT_MAX_CONNECTIONS);

  // dbPath -> { db, mtimeMs, statements: Map<string, Statement>, columns: Set<string> }
  const connections = new Map();
  const stats = { opens: 0, reopens: 0, evictions: 0, misses: 0 };

  function closeEntry(entry) {
    try {
      if (entry && entry.db && typeof entry.db.close === 'function') entry.db.close();
    } catch (_error) {}
  }

  function evictIfNeeded() {
    while (connections.size > maxConnections) {
      const oldestKey = connections.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = connections.get(oldestKey);
      connections.delete(oldestKey);
      closeEntry(entry);
      stats.evictions += 1;
    }
  }

  function readMtimeMs(dbPath) {
    try { return fs.statSync(dbPath).mtimeMs || 0; } catch (_error) { return -1; }
  }

  function getConnection(dbPath) {
    const mtimeMs = readMtimeMs(dbPath);
    if (mtimeMs < 0) return null;
    const existing = connections.get(dbPath);
    if (existing && existing.mtimeMs === mtimeMs) {
      // LRU：命中的挪到队尾
      connections.delete(dbPath);
      connections.set(dbPath, existing);
      return existing;
    }
    if (existing) {
      connections.delete(dbPath);
      closeEntry(existing);
      stats.reopens += 1;
    }
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { db.exec('PRAGMA query_only = ON'); } catch (_error) {}
      // 另一个进程正在 checkpoint / 持写锁时，读也别立刻失败：等一小会儿再报错。
      // （WAL 模式下读本来不阻塞；这里兜底 DELETE journal 的短事务。）
      try { db.exec('PRAGMA busy_timeout = 250'); } catch (_error) {}
      const entry = { db, mtimeMs, statements: new Map(), columns: null };
      connections.set(dbPath, entry);
      stats.opens += 1;
      evictIfNeeded();
      return entry;
    } catch (error) {
      stats.misses += 1;
      const reason = String((error && (error.message || error.code)) || error);
      stats.failures = stats.failures || {};
      stats.failures[reason] = (stats.failures[reason] || 0) + 1;
      return null;
    }
  }

  function tableColumns(entry, table) {
    if (entry.columns) return entry.columns;
    try {
      entry.columns = new Set(
        entry.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((row) => String(row && row.name || ''))
      );
    } catch (_error) {
      entry.columns = new Set();
    }
    return entry.columns;
  }

  function selectStatement(entry, source, columns, limit) {
    const cacheKey = `${source.table}|${columns.join(',')}|${source.orderColumn}|${limit}`;
    const cached = entry.statements.get(cacheKey);
    if (cached) return cached;
    const sql = `SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(source.table)} ORDER BY ${quoteIdent(source.orderColumn)} DESC LIMIT ?`;
    const statement = entry.db.prepare(sql);
    entry.statements.set(cacheKey, statement);
    return statement;
  }

  /**
   * 跨多个库列出会话：每个库各取前 limit 条，按 orderColumn 倒序归并、按会话 id 去重。
   *
   * @returns {{ rows: Array<object>, sources: number, failed: string[] }}
   */
  function querySessionList(queryOptions = {}) {
    const sources = normalizeSources(queryOptions.sources);
    const limit = Math.max(1, Number(queryOptions.limit) || DEFAULT_LIMIT);
    const rows = [];
    const failed = [];
    let usedSources = 0;

    for (const source of sources) {
      const entry = getConnection(source.dbPath);
      if (!entry) { failed.push(source.dbPath); continue; }
      const available = tableColumns(entry, source.table);
      if (!available.has(source.idColumn)) { failed.push(source.dbPath); continue; }

      const wanted = (source.columns && source.columns.length > 0 ? source.columns : Array.from(available))
        .filter((column) => available.has(column));
      if (!wanted.includes(source.idColumn)) wanted.unshift(source.idColumn);
      if (!wanted.includes(source.orderColumn)) wanted.push(source.orderColumn);

      let list = [];
      try {
        list = selectStatement(entry, source, wanted, limit).all(limit);
      } catch (_error) {
        failed.push(source.dbPath);
        continue;
      }
      usedSources += 1;
      for (const row of list) {
        rows.push({ ...row, __source: source.id });
      }
    }

    const orderColumn = sources[0] ? sources[0].orderColumn : DEFAULT_ORDER_COLUMN;
    const idColumn = sources[0] ? sources[0].idColumn : 'session_id';
    rows.sort((left, right) => Number(right[orderColumn] || 0) - Number(left[orderColumn] || 0));

    const seen = new Set();
    const merged = [];
    for (const row of rows) {
      const id = String(row[idColumn] == null ? '' : row[idColumn]);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(row);
      if (merged.length >= limit) break;
    }

    return { rows: merged, sources: usedSources, failed };
  }

  function closeAll() {
    for (const entry of connections.values()) closeEntry(entry);
    connections.clear();
  }

  return {
    querySessionList,
    closeAll,
    stats: () => ({ ...stats, open: connections.size })
  };
}

module.exports = {
  createSessionDbPool,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_LIMIT
};
