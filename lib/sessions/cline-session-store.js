'use strict';

/**
 * Cline 会话存储读取（原生会话身份 + 标题）。
 *
 * cline CLI 把「会话身份」放在本地状态根里（CLINE_DATA_DIR，默认 <CLINE_DIR>/data）：
 *   <data>/db/sessions.db        `cline history` 的数据源（一行一会话）
 *   <data>/sessions/<id>/<id>.json        单会话元数据（db 缺失/锁死时的兜底）
 *
 * 读它的唯一目的是让 aih 侧的持久会话知道「这个 pane 对应 cline 的哪一段对话」：
 *   - `aih ss` 列表显示与 `cline history` 一致的会话身份；
 *   - 重启恢复用原生 `cline --id <session-id>` 精确续接（见 lib/runtime/provider-resume.js）。
 *
 * 只读、best-effort：任何失败都返回空结果，绝不抛出（列表/恢复路径不能因为读不到
 * 会话库而失败）。
 */

const nodePath = require('node:path');
const nodeFs = require('node:fs');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');

// 实测形态：<epoch-ms>_<base36 后缀>，例如 1792050248852_or8f0。
const CLINE_SESSION_ID_PATTERN = /^[0-9]{10,}_[a-z0-9]{3,}$/i;
const DEFAULT_RECORD_LIMIT = 400;
const DEFAULT_MATCH_TOLERANCE_SECONDS = 300;
const TITLE_MAX_LENGTH = 120;

function getDatabaseSyncCtor(options = {}) {
  if (options.DatabaseSync) return options.DatabaseSync;
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  return CLINE_SESSION_ID_PATTERN.test(text) ? text : '';
}

// 从启动参数里认出会话身份：恢复后的 pane 会在 argv 里带 `--id <session-id>`
// （注册表条目记录 forwardArgs），据此可以跨重启把身份一路带下去，不必重新猜。
function extractClineSessionId(args) {
  const values = (Array.isArray(args) ? args : []).map((value) => String(value));
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index].trim();
    if (token.startsWith('--id=')) {
      const inline = normalizeSessionId(token.slice('--id='.length));
      if (inline) return inline;
      continue;
    }
    if (token === '--id') {
      const next = normalizeSessionId(values[index + 1]);
      if (next) return next;
    }
  }
  return '';
}

function toEpochMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value > 100000000000 ? Math.floor(value) : Math.floor(value * 1000);
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return toEpochMs(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeCwd(value) {
  return String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

function compactTitle(value) {
  return String(value == null ? '' : value)
    .replace(/<user_input(?:\s+[^>]*)?>/gi, ' ')
    .replace(/<\/user_input>/gi, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX_LENGTH);
}

// 账号沙箱里的 cline 本地状态根。runtimeScope 就是 accountRef（gateway 目标没有
// 账号投影，返回空串 → 调用方退回原样）。
function resolveClineDataDir(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const runtimeScope = String(options.runtimeScope || '').trim();
  if (!aiHomeDir || !runtimeScope) return '';
  const pathImpl = options.path || nodePath;
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'cline', runtimeScope);
  return runtimeDir ? pathImpl.join(runtimeDir, '.cline', 'data') : '';
}

/**
 * 宿主级 cline 数据目录 `<hostHome>/.cline/data`。
 *
 * cline 的**会话面刻意与宿主共享**（`launch-profile/cline-shared-session-store.js` 把
 * `data/sessions`、`data/db/sessions.db` 等链回宿主；只有凭据留在账号投影里）。
 * 因此没有指定账号时应当读宿主这一份——否则宿主里明明有会话，读者却什么都看不到。
 */
function resolveHostClineDataDir(options = {}) {
  const pathImpl = options.path || nodePath;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!hostHomeDir) return '';
  return pathImpl.join(hostHomeDir, '.cline', 'data');
}

/** 会话历史用的数据目录：指定账号时用投影，未指定时回落到宿主共享存储。 */
function resolveClineHistoryDataDir(options = {}) {
  const projected = resolveClineDataDir({
    aiHomeDir: options.aiHomeDir,
    runtimeScope: options.accountRef,
    path: options.path
  });
  if (projected) return projected;
  if (String(options.accountRef || '').trim()) return '';
  return resolveHostClineDataDir(options);
}

function normalizeClineSessionRecord(row) {
  const sessionId = normalizeSessionId(row && (row.session_id || row.sessionId));
  if (!sessionId) return null;
  return {
    sessionId,
    startedAtMs: toEpochMs(row && (row.started_at || row.startedAt)),
    updatedAtMs: toEpochMs(row && (row.updated_at || row.updatedAt)),
    cwd: String(row && (row.cwd || row.workspace_root || row.workspaceRoot) || '').trim(),
    status: String(row && row.status || '').trim(),
    pid: Number(row && row.pid) || 0,
    title: compactTitle(row && (row.prompt || row.title)),
    model: String(row && row.model || '').trim(),
    provider: String(row && row.provider || '').trim(),
    messagesPath: String(row && (row.messages_path || row.messagesPath) || '').trim()
  };
}

// sessions.db 是权威来源；读不到（缺失/锁死/无表）返回 null，让调用方决定兜底。
// 只读我们真正需要的列，并按**实际存在的列**裁剪：cline 的 sessions 表会随版本增列，
// 缺列不能让整段历史读不出来（缺 model/provider/messages_path 时它们为空）。
const SESSION_RECORD_COLUMNS = Object.freeze([
  'session_id',
  'started_at',
  'updated_at',
  'cwd',
  'workspace_root',
  'status',
  'pid',
  'prompt',
  'model',
  'provider',
  'messages_path'
]);

function readClineSessionRecordsFromDb(options = {}) {
  const fs = options.fs || nodeFs;
  const { dataDir, DatabaseSync } = options;
  const pathImpl = options.path || nodePath;
  const limit = Math.max(1, Number(options.limit) || DEFAULT_RECORD_LIMIT);
  if (!DatabaseSync || !dataDir) return null;
  const dbPath = pathImpl.join(dataDir, 'db', 'sessions.db');
  try {
    if (!fs.existsSync(dbPath)) return null;
  } catch (_error) {
    return null;
  }
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const available = new Set(
      db.prepare('PRAGMA table_info(sessions)').all().map((row) => String(row && row.name || ''))
    );
    if (!available.has('session_id')) return null;
    const columns = SESSION_RECORD_COLUMNS.filter((column) => available.has(column));
    const rows = db.prepare(
      `SELECT ${columns.join(', ')} FROM sessions ORDER BY started_at DESC LIMIT ?`
    ).all(limit);
    return rows.map(normalizeClineSessionRecord).filter(Boolean);
  } catch (_error) {
    return null;
  } finally {
    try {
      if (db && typeof db.close === 'function') db.close();
    } catch (_error) {}
  }
}

// 兜底：直接读会话目录里的 <id>.json（db 被锁或换版本时仍能认出身份）。
function readClineSessionRecordsFromJson(options = {}) {
  const fs = options.fs || nodeFs;
  const { dataDir } = options;
  const pathImpl = options.path || nodePath;
  const limit = Math.max(1, Number(options.limit) || DEFAULT_RECORD_LIMIT);
  if (!dataDir) return [];
  const sessionsDir = pathImpl.join(dataDir, 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch (_error) {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (records.length >= limit) break;
    const sessionId = normalizeSessionId(name);
    if (!sessionId) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(pathImpl.join(sessionsDir, name, `${name}.json`), 'utf8'));
      const record = normalizeClineSessionRecord(raw);
      if (record) records.push(record);
    } catch (_error) {}
  }
  return records.sort((left, right) => right.startedAtMs - left.startedAtMs);
}

function readClineSessionRecords(options = {}) {
  const fromDb = readClineSessionRecordsFromDb(options);
  if (Array.isArray(fromDb) && fromDb.length > 0) return fromDb;
  return readClineSessionRecordsFromJson(options);
}

/**
 * 按「cwd 精确匹配 + 启动时间距离」列出候选 cline 会话，距离近的在前。
 * 只返回容差内的候选；没有可用输入时返回空数组。
 *
 * @returns {Array<{sessionId: string, title: string, startedAtMs: number, distanceMs: number}>}
 */
function findClineSessionCandidates(options = {}) {
  const records = Array.isArray(options.records) ? options.records : [];
  const cwd = normalizeCwd(options.cwd);
  const startedAtMs = toEpochMs(options.startedAt);
  const toleranceMs = Math.max(1, Number(options.toleranceSeconds) || DEFAULT_MATCH_TOLERANCE_SECONDS) * 1000;
  const exclude = options.excludeSessionIds instanceof Set
    ? options.excludeSessionIds
    : new Set(Array.isArray(options.excludeSessionIds) ? options.excludeSessionIds : []);
  if (!cwd || !startedAtMs) return [];

  const candidates = [];
  for (const record of records) {
    if (!record || !record.sessionId || exclude.has(record.sessionId)) continue;
    if (normalizeCwd(record.cwd) !== cwd) continue;
    if (!record.startedAtMs) continue;
    const distanceMs = Math.abs(record.startedAtMs - startedAtMs);
    if (distanceMs > toleranceMs) continue;
    candidates.push({
      sessionId: record.sessionId,
      title: record.title || '',
      startedAtMs: record.startedAtMs,
      distanceMs
    });
  }
  return candidates.sort((left, right) => (
    left.distanceMs - right.distanceMs || left.sessionId.localeCompare(right.sessionId)
  ));
}

// 单个 pane 的最佳候选（距离最近的一个）；没有就返回 null。
function matchClineSessionForLaunch(options = {}) {
  const [best] = findClineSessionCandidates(options);
  if (!best) return null;
  return { sessionId: best.sessionId, title: best.title, startedAtMs: best.startedAtMs };
}

// ---------------------------------------------------------------------------
// 跨账号：DB pool（不合并库、不复制行）
// ---------------------------------------------------------------------------
//
// 每个账号的投影里各有一份 <data>/db/sessions.db。合并它们必然要 INSERT 一份行到
// 另一个库 —— 那就是复制。所以读取侧改成「池化 + 归并」：每个库一条常驻只读连接，
// 各取前 N 行再按时间归并（见 session-db-pool.js，100 个库实测 3~23ms）。
//
// 写侧不变：每个账号只写自己的库；宿主库只是"默认账号"的那一份。

function listClineSessionDatabasePaths(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const paths = [];
  const push = (dbPath) => {
    if (!dbPath || paths.includes(dbPath)) return;
    try { if (!fsImpl.existsSync(dbPath)) return; } catch (_error) { return; }
    paths.push(dbPath);
  };

  if (hostHomeDir) push(pathImpl.join(hostHomeDir, '.cline', 'data', 'db', 'sessions.db'));
  if (aiHomeDir) {
    const providerRoot = pathImpl.join(aiHomeDir, 'run', 'auth-projections', 'cline');
    let refs = [];
    try { refs = fsImpl.readdirSync(providerRoot); } catch (_error) { refs = []; }
    for (const ref of refs) {
      push(pathImpl.join(providerRoot, ref, '.cline', 'data', 'db', 'sessions.db'));
    }
  }
  return paths;
}

/**
 * 跨账号列出 cline 会话（只读归并）。
 *
 * @returns {{ records: Array<object>, sources: number, failed: string[] }}
 */
function readClineSessionRecordsAcrossAccounts(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const DatabaseSync = getDatabaseSyncCtor(options);
  const limit = Math.max(1, Number(options.limit) || DEFAULT_RECORD_LIMIT);
  if (!DatabaseSync) return { records: [], sources: 0, failed: [] };
  const dbPaths = listClineSessionDatabasePaths({ fs: fsImpl, path: pathImpl, hostHomeDir: options.hostHomeDir, aiHomeDir: options.aiHomeDir });
  if (dbPaths.length === 0) return { records: [], sources: 0, failed: [] };
  const { createSessionDbPool } = require('./session-db-pool');
  const pool = createSessionDbPool({ fs: fsImpl, path: pathImpl, DatabaseSync });
  try {
    const result = pool.querySessionList({
      sources: dbPaths.map((dbPath) => ({ id: dbPath, dbPath, table: 'sessions', idColumn: 'session_id', orderColumn: 'started_at', columns: SESSION_RECORD_COLUMNS })),
      limit
    });
    return {
      records: result.rows.map(normalizeClineSessionRecord).filter(Boolean),
      sources: result.sources,
      failed: result.failed
    };
  } finally {
    pool.closeAll();
  }
}

// 会话消息文件在哪个账号的数据根下：先问指定的账号，再依次问宿主与其余账号。
function resolveClineMessagesDataDirs(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const dirs = [];
  const add = (dir) => { if (dir && !dirs.includes(dir)) dirs.push(dir); };
  if (options.accountRef) {
    add(resolveClineHistoryDataDir({ aiHomeDir: options.aiHomeDir, accountRef: options.accountRef, hostHomeDir: options.hostHomeDir, path: pathImpl }));
  }
  for (const dbPath of listClineSessionDatabasePaths({ fs: fsImpl, path: pathImpl, hostHomeDir: options.hostHomeDir, aiHomeDir: options.aiHomeDir })) {
    // <data>/db/sessions.db → <data>
    add(pathImpl.dirname(pathImpl.dirname(dbPath)));
  }
  return dirs;
}

module.exports = {
  CLINE_SESSION_ID_PATTERN,
  DEFAULT_MATCH_TOLERANCE_SECONDS,
  getDatabaseSyncCtor,
  normalizeSessionId,
  extractClineSessionId,
  toEpochMs,
  resolveClineDataDir,
  resolveClineHistoryDataDir,
  resolveHostClineDataDir,
  readClineSessionRecords,
  readClineSessionRecordsFromDb,
  readClineSessionRecordsFromJson,
  listClineSessionDatabasePaths,
  readClineSessionRecordsAcrossAccounts,
  resolveClineMessagesDataDirs,
  findClineSessionCandidates,
  matchClineSessionForLaunch
};
