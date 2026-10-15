'use strict';

/**
 * Cline 共享会话存储（把会话历史链回宿主 `~/.cline`）。
 *
 * 现状（2026-10-15 本机取证）：cline CLI 的配置根由 `CLINE_DIR` 选择、本地状态根由
 * `CLINE_DATA_DIR` 选择，aih 把两者都钉进账号沙箱，于是**宿主 `cline /history` 与
 * `aih cline` 里的 `/history` 看到的是两批互不相干的会话**——同一台机器上的同一份
 * 产品，历史却按账号分裂。会话不属于账号，凭据才属于账号，因此这里把「会话面」链回
 * 宿主同一份：
 *
 *   共享（链到 `<hostHome>/.cline/<同路径>`）
 *     data/sessions                    会话目录（<id>.json + <id>.messages.json）
 *     data/checkpoint-scratch          会话级 checkpoint 草稿
 *     data/db/sessions.db(+wal/shm)    `cline history` 的数据源
 *     data/db/session-search.db(+侧车) 消息全文索引（FTS5）
 *
 *   账号私有（绝不链接，只在此处记录口径）
 *     data/settings（providers.json 凭据库）、data/secrets.json、data/cache、
 *     data/logs、data/locks、data/globalState.json、data/workspaces、
 *     data/remote-config-workspace、data/db/{tasks,teams,cron,connectors,hub-*}.db、
 *     <CLINE_DIR>/{tasks,cron,cli-node-extra-ca-certs.pem}
 *
 * 为什么不用通用的 session-store 共享引擎：那套的共享粒度是**数据根下的一级条目名**，
 * 而 cline 的 `data/` 同时装着凭据库与会话，一级名 `data` 因 `privateArtifacts` 被判
 * 私有而整块跳过——结构上表达不了「共享 data 下的某几个子路径」。这里因此走
 * `shared-store-linker` 的显式声明表（与 zcode 同一条原语）。
 *
 * 首次接管（adopt）：投影里已经存在真实会话数据时，先**搬到宿主共享存储**再建链，
 * 绝不静默丢弃（与 zcode 的「派生残留直接删」不同：这里是真的用户对话）。
 *   - 会话目录：宿主缺失的同名子项逐个 move（跨设备回落 copy+unlink），宿主已有的不动；
 *   - sessions.db：宿主没有就整体搬过去；宿主已有则把投影 `sessions` 表按主键
 *     `INSERT OR IGNORE` 合并（只插不改不删），随后清掉投影侧文件与 wal/shm；
 *   - session-search.db：FTS5 影子表不可按行合并，因此宿主没有就整体搬过去，
 *     宿主已有就删除投影侧这份**派生索引**（`indexed_sessions` 会让 CLI 重新索引）；
 *   - 合并前一律 `wal_checkpoint(TRUNCATE)`，避免残留 wal 之后被应用到共享库上。
 *
 * Fail-closed：投影里仍有**存活**的 cline 会话（sessions 表 status='running' 且 pid
 * 存活）时整体推迟到下次启动——正在跑的进程还持有旧 inode，此刻换链会让它的写入落进
 * 已摘除的文件。任何一步失败都只记进 summary，绝不抛出、绝不丢数据。
 */

const { ensureSharedStoreEntries, createSummary } = require('../../../../runtime/shared-store-linker');

const SHARED_DIR_ENTRIES = Object.freeze([
  Object.freeze(['data', 'sessions']),
  Object.freeze(['data', 'checkpoint-scratch'])
]);

// `cline history` 的数据源 + 消息全文索引。两者都要跟随共享的 sessions 目录，
// 否则宿主看到的会话与它自己的索引不一致。
const SHARED_DB_FILES = Object.freeze([
  Object.freeze(['data', 'db', 'sessions.db']),
  Object.freeze(['data', 'db', 'session-search.db'])
]);

const SHARED_DB_SIDECARS = Object.freeze([
  Object.freeze(['data', 'db', 'sessions.db-wal']),
  Object.freeze(['data', 'db', 'sessions.db-shm']),
  Object.freeze(['data', 'db', 'session-search.db-wal']),
  Object.freeze(['data', 'db', 'session-search.db-shm'])
]);

// 会话历史的数据源（唯一需要按行合并的表）；tasks/teams/cron/connectors/hub 属于
// 账号级应用状态，绝不搬进共享库。
const SESSIONS_TABLE = 'sessions';
const SESSIONS_ID_COLUMN = 'session_id';

// 与 session-title-resolver / codex-session-provider-alignment 同一口径：
// 允许注入 DatabaseSync（测试替身），缺省懒加载 node:sqlite。
function getDatabaseSyncCtor(options = {}) {
  if (options.DatabaseSync) return options.DatabaseSync;
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

// pid 存活探测：EPERM 说明进程存在但无权限发信号，同样算存活。
function isProcessAlive(pid) {
  const normalized = normalizePid(pid);
  if (!normalized) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function lstatIfExists(fs, targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }
}

// 只有**真实**（非链接）条目才算「投影里待接管的存量数据」：链接已经指向共享存储，
// 再走一遍接管会把共享目标当成投影数据（合并到自己身上、或删掉自己）。
function isRealEntry(fs, targetPath) {
  const stat = lstatIfExists(fs, targetPath);
  return Boolean(stat && !stat.isSymbolicLink());
}

function listDirNames(fs, dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    return [];
  }
}

// move（同设备 rename；跨设备回落 copy + unlink）。目标已存在时返回 'exists'，
// 绝不覆盖宿主已有内容。
function moveEntry(fs, path, srcPath, dstPath) {
  if (lstatIfExists(fs, dstPath)) return 'exists';
  try {
    fs.renameSync(srcPath, dstPath);
    return 'moved';
  } catch (error) {
    const recoverable = error && (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EACCES');
    if (!recoverable) throw error;
    const stat = lstatIfExists(fs, srcPath);
    if (!stat) return 'missing';
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    if (stat.isDirectory()) {
      fs.cpSync(srcPath, dstPath, { recursive: true, force: false, errorOnExist: true });
      fs.rmSync(srcPath, { recursive: true, force: true });
    } else {
      fs.copyFileSync(srcPath, dstPath);
      fs.unlinkSync(srcPath);
    }
    return 'moved';
  }
}

function checkpointDatabase(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (_error) {}
}

function closeDatabaseQuietly(db) {
  try {
    if (db && typeof db.close === 'function') db.close();
  } catch (_error) {}
}

function readTableColumns(db, tableName) {
  try {
    return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row && row.name || '')).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function dropDatabaseSidecars(fs, dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch (_error) {}
  }
}

function dropDatabaseFiles(fs, dbPath) {
  try {
    fs.unlinkSync(dbPath);
  } catch (_error) {}
  dropDatabaseSidecars(fs, dbPath);
}

// 投影里是否有**存活**的 cline 会话。有则整体推迟：正在跑的进程还持有旧 inode，
// 此刻换链会让它的写入落进已摘除的文件。
function readRunningSessionPids(options = {}) {
  const { fs, DatabaseSync, dbPath } = options;
  if (!DatabaseSync || !dbPath || !lstatIfExists(fs, dbPath)) return { checked: false, pids: [] };
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`SELECT pid FROM ${SESSIONS_TABLE} WHERE status = 'running'`).all();
    return { checked: true, pids: rows.map((row) => normalizePid(row && row.pid)).filter(Boolean) };
  } catch (_error) {
    return { checked: false, pids: [] };
  } finally {
    closeDatabaseQuietly(db);
  }
}

function mergeSessionsRowsIntoSharedStore(options = {}) {
  const { fs, DatabaseSync, projectionDbPath, sharedDbPath } = options;
  let projectionDb = null;
  let sharedDb = null;
  try {
    projectionDb = new DatabaseSync(projectionDbPath);
    checkpointDatabase(projectionDb);
    sharedDb = new DatabaseSync(sharedDbPath);
    const projectionColumns = readTableColumns(projectionDb, SESSIONS_TABLE);
    if (!projectionColumns.length) return { ok: true, merged: 0 };
    const sharedColumns = readTableColumns(sharedDb, SESSIONS_TABLE);
    if (!sharedColumns.length) return { ok: false, reason: 'shared-db-schema-mismatch' };
    const columns = projectionColumns.filter((column) => sharedColumns.includes(column));
    if (!columns.includes(SESSIONS_ID_COLUMN)) return { ok: false, reason: 'shared-db-schema-mismatch' };
    const rows = projectionDb.prepare(`SELECT ${columns.join(', ')} FROM ${SESSIONS_TABLE}`).all();
    const placeholders = columns.map(() => '?').join(', ');
    const insert = sharedDb.prepare(
      `INSERT OR IGNORE INTO ${SESSIONS_TABLE} (${columns.join(', ')}) VALUES (${placeholders})`
    );
    let merged = 0;
    sharedDb.exec('BEGIN');
    try {
      for (const row of rows) {
        insert.run(...columns.map((column) => row[column]));
        merged += 1;
      }
      sharedDb.exec('COMMIT');
    } catch (error) {
      try { sharedDb.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
    return { ok: true, merged };
  } finally {
    closeDatabaseQuietly(projectionDb);
    closeDatabaseQuietly(sharedDb);
  }
}

// 投影 sessions.db → 宿主共享 sessions.db：
//   宿主没有 → checkpoint 后整体搬过去（数据原样，不重写）；
//   宿主已有 → 按主键 INSERT OR IGNORE 合并（只插不改不删），再清掉投影侧文件与侧车。
function adoptSessionsDatabase(options = {}) {
  const { fs, path, DatabaseSync, projectionDbPath, sharedDbPath } = options;
  if (!isRealEntry(fs, projectionDbPath)) return { ok: true, adopted: 0 };
  fs.mkdirSync(path.dirname(sharedDbPath), { recursive: true });
  if (!lstatIfExists(fs, sharedDbPath)) {
    let db = null;
    try {
      db = new DatabaseSync(projectionDbPath);
      checkpointDatabase(db);
    } catch (_error) {
      return { ok: false, reason: 'projection-db-unreadable' };
    } finally {
      closeDatabaseQuietly(db);
    }
    const moved = moveEntry(fs, path, projectionDbPath, sharedDbPath);
    dropDatabaseSidecars(fs, projectionDbPath);
    return { ok: moved === 'moved', adopted: moved === 'moved' ? 1 : 0, reason: moved === 'moved' ? '' : 'shared-db-occupied' };
  }
  if (!DatabaseSync) return { ok: false, reason: 'node_sqlite_unavailable' };
  const merge = mergeSessionsRowsIntoSharedStore({ fs, DatabaseSync, projectionDbPath, sharedDbPath });
  if (!merge.ok) return { ok: false, reason: merge.reason };
  dropDatabaseFiles(fs, projectionDbPath);
  return { ok: true, adopted: merge.merged };
}

// 投影 session-search.db（FTS5 索引）→ 宿主共享索引。FTS5 的影子表不能按行合并，
// 所以：宿主没有就整体搬过去；宿主已有就丢弃投影侧这份**派生索引**（`indexed_sessions`
// 会让 CLI 重新索引）。会话数据本身已经由 sessions.db/sessions 共享，这里只是索引。
function adoptSessionSearchDatabase(options = {}) {
  const { fs, path, projectionDbPath, sharedDbPath } = options;
  if (!isRealEntry(fs, projectionDbPath)) return { ok: true, adopted: 0 };
  fs.mkdirSync(path.dirname(sharedDbPath), { recursive: true });
  if (!lstatIfExists(fs, sharedDbPath)) {
    const moved = moveEntry(fs, path, projectionDbPath, sharedDbPath);
    dropDatabaseSidecars(fs, projectionDbPath);
    return { ok: moved === 'moved', adopted: moved === 'moved' ? 1 : 0, reason: moved === 'moved' ? '' : 'shared-search-db-occupied' };
  }
  dropDatabaseFiles(fs, projectionDbPath);
  return { ok: true, adopted: 0 };
}

// 同名会话目录在两边都存在（同一个 session id）：宿主那份是权威，但投影侧可能多出
// 宿主还没有的文件（例如只在沙箱写过 .messages.json）。先按「不覆盖」补齐宿主缺失的
// 文件，再删掉投影侧重复项——两份指向同一段对话，不补齐就丢内容，不删除就永远建不了链。
function mergeDuplicateDirectory(fs, path, srcDir, dstDir) {
  for (const name of listDirNames(fs, srcDir)) {
    const srcPath = path.join(srcDir, name);
    const dstPath = path.join(dstDir, name);
    if (lstatIfExists(fs, dstPath)) continue;
    try {
      moveEntry(fs, path, srcPath, dstPath);
    } catch (_error) {}
  }
  try {
    fs.rmSync(srcDir, { recursive: true, force: true });
  } catch (_error) {}
}

// 目录条目：宿主缺失的同名子项逐个 move；宿主已有的按上一条规则并档（不覆盖宿主文件）。
function adoptDirectoryEntry(options = {}) {
  const { fs, path, projectionDir, sharedDir } = options;
  if (!isRealEntry(fs, projectionDir)) return { ok: true, adopted: 0 };
  fs.mkdirSync(sharedDir, { recursive: true });
  let adopted = 0;
  for (const name of listDirNames(fs, projectionDir)) {
    const srcPath = path.join(projectionDir, name);
    const dstPath = path.join(sharedDir, name);
    try {
      if (lstatIfExists(fs, dstPath)) {
        mergeDuplicateDirectory(fs, path, srcPath, dstPath);
        adopted += 1;
        continue;
      }
      if (moveEntry(fs, path, srcPath, dstPath) === 'moved') adopted += 1;
    } catch (_error) {}
  }
  return { ok: true, adopted };
}

function createClineAdoptHook(options = {}) {
  const { fs, path, DatabaseSync } = options;
  const isPidAlive = typeof options.isPidAlive === 'function' ? options.isPidAlive : isProcessAlive;
  return ({ projectionRoot, sharedRoot }) => {
    const projectionDb = path.join(projectionRoot, 'data', 'db', 'sessions.db');
    const live = readRunningSessionPids({ fs, DatabaseSync, dbPath: projectionDb });
    if (live.pids.some((pid) => isPidAlive(pid))) {
      return { ok: false, reason: 'live-session' };
    }

    const unresolved = [];
    let adopted = 0;
    // 1) 会话历史的数据源先行：接不了就整体不建链（半共享状态比不共享更难排查）。
    const sessionsDb = adoptSessionsDatabase({
      fs,
      path,
      DatabaseSync,
      projectionDbPath: projectionDb,
      sharedDbPath: path.join(sharedRoot, 'data', 'db', 'sessions.db')
    });
    if (!sessionsDb.ok) return { ok: false, reason: sessionsDb.reason || 'sessions-db-not-adoptable' };
    adopted += sessionsDb.adopted;

    // 2) 会话目录与 checkpoint 草稿：逐个 move，失败只是该条目保持私有（unresolved）。
    for (const entry of SHARED_DIR_ENTRIES) {
      const result = adoptDirectoryEntry({
        fs,
        path,
        projectionDir: path.join(projectionRoot, ...entry),
        sharedDir: path.join(sharedRoot, ...entry)
      });
      adopted += result.adopted;
    }

    // 3) 全文索引（派生数据）：接不了就保留投影侧私有索引，历史本身已经共享。
    const searchDb = adoptSessionSearchDatabase({
      fs,
      path,
      projectionDbPath: path.join(projectionRoot, 'data', 'db', 'session-search.db'),
      sharedDbPath: path.join(sharedRoot, 'data', 'db', 'session-search.db')
    });
    if (!searchDb.ok) unresolved.push('data/db/session-search.db');
    else adopted += searchDb.adopted;

    return { ok: true, adopted, unresolved };
  };
}

/**
 * 让 `aih cline` 与宿主 `cline` 看到同一批会话（凭据/配置仍按账号隔离）。
 *
 * @param {{fs?: any, path?: any, sandboxDir: string, hostHomeDir: string, DatabaseSync?: any, isPidAlive?: Function}} input
 * @returns {{linked: number, discarded: number, adopted: number, unresolved: string[], deferred: string, skipped: string, errors: string[]}}
 */
function ensureClineSharedSessionState(input = {}) {
  const fs = input.fs || require('node:fs');
  const path = input.path || require('node:path');
  const sandboxDir = String(input.sandboxDir || '').trim();
  const hostHomeDir = String(input.hostHomeDir || '').trim();
  if (!sandboxDir || !hostHomeDir) return createSummary();
  const DatabaseSync = getDatabaseSyncCtor(input);
  return ensureSharedStoreEntries({
    fs: input.fs,
    path,
    projectionRoot: path.join(sandboxDir, '.cline'),
    sharedRoot: path.join(hostHomeDir, '.cline'),
    dirEntries: SHARED_DIR_ENTRIES,
    fileEntries: SHARED_DB_FILES,
    sidecarEntries: SHARED_DB_SIDECARS,
    adopt: createClineAdoptHook({ fs, path, DatabaseSync, isPidAlive: input.isPidAlive }),
    // 投影里是真实用户对话：绝不丢弃，只能先接管（adopt）再建链。
    discardRealEntries: false
  });
}

module.exports = {
  ensureClineSharedSessionState,
  readRunningSessionPids,
  CLINE_SHARED_DIR_ENTRIES: SHARED_DIR_ENTRIES,
  CLINE_SHARED_DB_FILES: SHARED_DB_FILES,
  CLINE_SHARED_DB_SIDECARS: SHARED_DB_SIDECARS
};
