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

module.exports = {
  CLINE_SESSION_ID_PATTERN,
  DEFAULT_MATCH_TOLERANCE_SECONDS,
  getDatabaseSyncCtor,
  normalizeSessionId,
  extractClineSessionId,
  toEpochMs,
  resolveClineDataDir,
  readClineSessionRecords,
  readClineSessionRecordsFromDb,
  readClineSessionRecordsFromJson,
  findClineSessionCandidates,
  matchClineSessionForLaunch
};
