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

// 连接数上限要高于账号数：LRU 一旦小于来源数，每轮都会把刚建好的连接挤掉，
// 缓存和 prepare 全废（实测 200 个库、上限 128 时会退化到 27ms）。
const DEFAULT_MAX_CONNECTIONS = 512;
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
  const stats = { opens: 0, reopens: 0, evictions: 0, misses: 0, queries: 0, cacheHits: 0 };

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

  // WAL 模式下写入只动 -wal 与 -shm，主库 mtime 可能不变；缓存键必须带上它们。
  function readFreshnessKey(dbPath) {
    let key = '';
    try { key = String(fs.statSync(dbPath).mtimeMs || 0); } catch (_error) { return ''; }
    // 只看 -wal：读连接自己会更新 -shm 的 mtime，把它算进新鲜度会导致缓存永远失效。
    for (const suffix of ['-wal']) {
      try {
        const stat = fs.statSync(dbPath + suffix);
        key += ':' + String(stat.mtimeMs || 0) + ':' + String(stat.size || 0);
      } catch (_error) { key += ':0:0'; }
    }
    return key;
  }

  function readIdentity(dbPath) {
    try {
      const stat = fs.statSync(dbPath);
      return `${stat.dev}:${stat.ino}`;
    } catch (_error) {
      return '';
    }
  }

  function getConnection(dbPath) {
    const freshness = readFreshnessKey(dbPath);
    if (!freshness) return null;
    const identity = readIdentity(dbPath);
    const existing = connections.get(dbPath);
    if (existing && existing.identity === identity) {
      // 同一个文件：写过了就只丢缓存，连接继续用（重开连接比重查更贵）。
      if (existing.freshness !== freshness) {
        existing.freshness = freshness;
        existing.cache = null;
      }
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
      const entry = { db, freshness, identity, statements: new Map(), columns: null, cache: null };
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
    const lists = [];
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

      // 每个库的"前 limit 条"按新鲜度缓存：库没变就不查，直接复用。
      // 会话库是追加写的，绝大多数查询只命中少数几个变动的库 —— 100 个账号的
      // 列表逐次查询从 ~7ms 降到 ~1ms（见 scripts/bench-session-db-pool.js）。
      const cache = entry.cache;
      const cacheHit = cache && cache.limit >= limit && cache.columns === wanted.join(',');
      let list = cacheHit ? cache.rows : null;
      if (cacheHit) {
        stats.cacheHits += 1;
      } else {
        stats.queries += 1;
      }
      if (!list) {
        try {
          list = selectStatement(entry, source, wanted, limit).all(limit);
        } catch (_error) {
          failed.push(source.dbPath);
          continue;
        }
        entry.cache = { limit, columns: wanted.join(','), rows: list };
      }
      usedSources += 1;
      lists.push({ list, sourceId: source.id });
    }

    const orderColumn = sources[0] ? sources[0].orderColumn : DEFAULT_ORDER_COLUMN;
    const idColumn = sources[0] ? sources[0].idColumn : 'session_id';

    // k 路归并：每个来源的 list 已经按 orderColumn 倒序，这里只在线性比较里取最大的
    // 那一行，取满 limit 就停 —— 不再把所有来源的行摊平再整体排序（200 个库时那一步
    // 比查询本身还贵）。
    const cursors = lists.map((entry) => ({ list: entry.list, index: 0, sourceId: entry.sourceId }));
    const merged = [];
    const seen = new Set();
    while (merged.length < limit) {
      let bestCursor = -1;
      let bestValue = -Infinity;
      for (let index = 0; index < cursors.length; index += 1) {
        const cursor = cursors[index];
        if (cursor.index >= cursor.list.length) continue;
        const value = Number(cursor.list[cursor.index][orderColumn] || 0);
        if (value > bestValue) {
          bestValue = value;
          bestCursor = index;
        }
      }
      if (bestCursor < 0) break;
      const cursor = cursors[bestCursor];
      const row = cursor.list[cursor.index];
      cursor.index += 1;
      const id = String(row[idColumn] == null ? '' : row[idColumn]);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push({ ...row, __source: cursor.sourceId });
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
