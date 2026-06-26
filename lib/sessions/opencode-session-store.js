'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let DatabaseSyncCtor = null;
let didResolveDatabaseSync = false;

function getDatabaseSyncCtor() {
  if (didResolveDatabaseSync) return DatabaseSyncCtor;
  didResolveDatabaseSync = true;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = require('node:sqlite'));
  } catch (_error) {
    DatabaseSyncCtor = null;
  }
  return DatabaseSyncCtor;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeProjectPath(value) {
  return normalizeString(value) || '/';
}

function getOpenCodeDbPath(hostHome) {
  const home = normalizeString(hostHome);
  return home ? path.join(home, '.local', 'share', 'opencode', 'opencode.db') : '';
}

function openOpenCodeDb(hostHome, options = {}) {
  const DatabaseSync = getDatabaseSyncCtor();
  if (!DatabaseSync) {
    const error = new Error('node_sqlite_unavailable');
    error.code = 'node_sqlite_unavailable';
    throw error;
  }
  const dbPath = getOpenCodeDbPath(hostHome);
  if (!dbPath) {
    const error = new Error('opencode_db_path_unavailable');
    error.code = 'opencode_db_path_unavailable';
    throw error;
  }
  if (!options.create && !fs.existsSync(dbPath)) {
    const error = new Error('opencode_db_missing');
    error.code = 'opencode_db_missing';
    throw error;
  }
  return new DatabaseSync(dbPath, { readOnly: Boolean(options.readOnly) });
}

function getTableColumns(db, tableName) {
  try {
    return new Set(
      db.prepare(`PRAGMA table_info(${tableName})`)
        .all()
        .map((row) => String(row && row.name || '').trim())
        .filter(Boolean)
    );
  } catch (_error) {
    return new Set();
  }
}

function hasTable(db, tableName) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName);
    return Boolean(row && row.name);
  } catch (_error) {
    return false;
  }
}

function assertRequiredTables(db) {
  for (const tableName of ['project', 'session', 'message', 'part']) {
    if (hasTable(db, tableName)) continue;
    const error = new Error(`opencode_db_missing_table:${tableName}`);
    error.code = 'opencode_db_missing_table';
    error.tableName = tableName;
    throw error;
  }
}

function insertRow(db, tableName, values) {
  const columns = Array.from(getTableColumns(db, tableName))
    .filter((column) => Object.prototype.hasOwnProperty.call(values, column));
  if (columns.length < 1) return false;
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`)
    .run(...columns.map((column) => values[column]));
  return true;
}

function updateRows(db, tableName, values, whereSql, whereValues) {
  const columns = Array.from(getTableColumns(db, tableName))
    .filter((column) => Object.prototype.hasOwnProperty.call(values, column));
  if (columns.length < 1) return false;
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  db.prepare(`UPDATE ${tableName} SET ${assignments} WHERE ${whereSql}`)
    .run(...columns.map((column) => values[column]), ...whereValues);
  return true;
}

function createOpenCodeId(prefix) {
  const safePrefix = normalizeString(prefix) || 'id';
  return `${safePrefix}_${Date.now().toString(36)}${crypto.randomBytes(9).toString('base64url')}`;
}

function parseOpenCodeModel(model) {
  const raw = normalizeString(model);
  if (raw.includes('/')) {
    const [providerID, ...rest] = raw.split('/');
    return {
      providerID: normalizeString(providerID) || 'opencode-go',
      modelID: normalizeString(rest.join('/')) || raw
    };
  }
  return {
    providerID: 'opencode-go',
    modelID: raw || 'glm-5.2'
  };
}

function deriveTitle(prompt, fallbackModel) {
  const title = String(prompt || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (title || normalizeString(fallbackModel) || 'OpenCode WebUI Chat').slice(0, 80);
}

function deriveSlug(title) {
  const slug = normalizeString(title)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || `webui-${Date.now().toString(36)}`;
}

function resolveProjectId(db, projectPath, nowMs) {
  const worktree = normalizeProjectPath(projectPath);
  const existing = db.prepare('SELECT id FROM project WHERE worktree = ? ORDER BY time_updated DESC, id DESC LIMIT 1').get(worktree);
  if (existing && existing.id) {
    updateRows(db, 'project', { time_updated: nowMs }, 'id = ?', [existing.id]);
    return String(existing.id);
  }
  const projectId = worktree === '/' ? 'global' : crypto.randomBytes(20).toString('hex');
  insertRow(db, 'project', {
    id: projectId,
    worktree,
    vcs: '',
    name: '',
    icon_url: '',
    icon_color: '',
    time_created: nowMs,
    time_updated: nowMs,
    time_initialized: null,
    sandboxes: '[]',
    commands: null,
    icon_url_override: null
  });
  return projectId;
}

function readSessionRow(db, sessionId) {
  const id = normalizeString(sessionId);
  if (!id) return null;
  try {
    return db.prepare('SELECT id, project_id, directory FROM session WHERE id = ? LIMIT 1').get(id) || null;
  } catch (_error) {
    return null;
  }
}

function nextSessionMessageSeq(db, sessionId) {
  if (!hasTable(db, 'session_message')) return 1;
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_message WHERE session_id = ?').get(sessionId);
  return Math.max(1, Number(row && row.seq) || 1);
}

function insertSessionMessage(db, values) {
  if (!hasTable(db, 'session_message')) return false;
  return insertRow(db, 'session_message', values);
}

function insertSessionSwitchMessages(db, sessionId, nowMs, model, agent) {
  const { providerID, modelID } = parseOpenCodeModel(model);
  let seq = nextSessionMessageSeq(db, sessionId);
  insertSessionMessage(db, {
    id: createOpenCodeId('msg'),
    session_id: sessionId,
    type: 'agent-switched',
    time_created: nowMs,
    time_updated: nowMs,
    data: JSON.stringify({ time: { created: nowMs }, agent }),
    seq
  });
  seq += 1;
  insertSessionMessage(db, {
    id: createOpenCodeId('msg'),
    session_id: sessionId,
    type: 'model-switched',
    time_created: nowMs,
    time_updated: nowMs,
    data: JSON.stringify({ time: { created: nowMs }, model: { id: modelID, providerID, variant: 'default' } }),
    seq
  });
}

function insertMessageWithTextPart(db, values) {
  insertRow(db, 'message', {
    id: values.messageId,
    session_id: values.sessionId,
    time_created: values.createdAt,
    time_updated: values.updatedAt,
    data: JSON.stringify(values.messageData)
  });
  insertRow(db, 'part', {
    id: values.partId || createOpenCodeId('prt'),
    message_id: values.messageId,
    session_id: values.sessionId,
    time_created: values.createdAt,
    time_updated: values.updatedAt,
    data: JSON.stringify(values.partData)
  });
}

function createSessionRow(db, input) {
  const nowMs = Number(input.nowMs) || Date.now();
  const directory = normalizeProjectPath(input.projectPath);
  const title = deriveTitle(input.prompt, input.model);
  const sessionId = createOpenCodeId('ses');
  const projectId = resolveProjectId(db, directory, nowMs);
  const { providerID, modelID } = parseOpenCodeModel(input.model);
  const agent = normalizeString(input.agent) || 'build';
  insertRow(db, 'session', {
    id: sessionId,
    project_id: projectId,
    parent_id: null,
    slug: deriveSlug(title),
    directory,
    title,
    version: 'aih-webui',
    share_url: null,
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    revert: null,
    permission: null,
    time_created: nowMs,
    time_updated: nowMs,
    time_compacting: null,
    time_archived: null,
    workspace_id: null,
    path: directory,
    agent,
    model: JSON.stringify({ id: modelID, providerID, variant: 'default' }),
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    metadata: JSON.stringify({ source: 'aih-webui-api-proxy' })
  });
  insertSessionSwitchMessages(db, sessionId, nowMs, input.model, agent);
  return { sessionId, projectId, directory, title };
}

function appendUserMessage(db, input) {
  const nowMs = Number(input.nowMs) || Date.now();
  const sessionId = normalizeString(input.sessionId);
  const prompt = String(input.prompt || '').trim();
  const { providerID, modelID } = parseOpenCodeModel(input.model);
  const agent = normalizeString(input.agent) || 'build';
  const messageId = createOpenCodeId('msg');
  insertMessageWithTextPart(db, {
    sessionId,
    messageId,
    createdAt: nowMs,
    updatedAt: nowMs,
    messageData: {
      role: 'user',
      time: { created: nowMs },
      agent,
      model: { providerID, modelID },
      summary: { diffs: [] }
    },
    partData: {
      type: 'text',
      text: `User: ${prompt}`
    }
  });
  updateRows(db, 'session', { time_updated: nowMs }, 'id = ?', [sessionId]);
  return { messageId };
}

function beginOpenCodeChatTurn(options = {}) {
  const hostHome = normalizeString(options.hostHome);
  const db = openOpenCodeDb(hostHome, { readOnly: false });
  try {
    assertRequiredTables(db);
    db.exec('BEGIN IMMEDIATE');
    let sessionId = normalizeString(options.sessionId);
    let created = false;
    let sessionRow = sessionId ? readSessionRow(db, sessionId) : null;
    if (!sessionRow) {
      const createdSession = createSessionRow(db, options);
      sessionId = createdSession.sessionId;
      sessionRow = readSessionRow(db, sessionId);
      created = true;
    }
    const userMessage = appendUserMessage(db, {
      ...options,
      sessionId,
      nowMs: Number(options.nowMs) || Date.now()
    });
    db.exec('COMMIT');
    return {
      sessionId,
      userMessageId: userMessage.messageId,
      created,
      directory: normalizeProjectPath(sessionRow && sessionRow.directory || options.projectPath)
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  } finally {
    try { db.close(); } catch (_closeError) {}
  }
}

function completeOpenCodeChatTurn(options = {}) {
  const content = String(options.content || '').trim();
  const sessionId = normalizeString(options.sessionId);
  if (!sessionId || !content) return false;
  const hostHome = normalizeString(options.hostHome);
  const db = openOpenCodeDb(hostHome, { readOnly: false });
  try {
    assertRequiredTables(db);
    db.exec('BEGIN IMMEDIATE');
    const nowMs = Number(options.nowMs) || Date.now();
    const startedMs = Number(options.startedMs) || nowMs;
    const { providerID, modelID } = parseOpenCodeModel(options.model);
    const agent = normalizeString(options.agent) || 'build';
    const usage = options.usage && typeof options.usage === 'object' ? options.usage : {};
    const inputTokens = Math.max(0, Number(usage.prompt_tokens || usage.input_tokens || 0) || 0);
    const outputTokens = Math.max(0, Number(usage.completion_tokens || usage.output_tokens || 0) || 0);
    const reasoningTokens = Math.max(0, Number(usage.reasoning_tokens || 0) || 0);
    const cacheRead = Math.max(0, Number(usage.cache_read_tokens || usage.cached_tokens || 0) || 0);
    const cacheWrite = Math.max(0, Number(usage.cache_write_tokens || 0) || 0);
    const messageId = createOpenCodeId('msg');
    insertMessageWithTextPart(db, {
      sessionId,
      messageId,
      createdAt: startedMs,
      updatedAt: nowMs,
      messageData: {
        parentID: normalizeString(options.userMessageId) || undefined,
        role: 'assistant',
        mode: agent,
        agent,
        path: {
          cwd: normalizeProjectPath(options.projectPath),
          root: normalizeProjectPath(options.projectPath)
        },
        cost: Number(usage.cost || 0) || 0,
        tokens: {
          total: inputTokens + outputTokens + reasoningTokens,
          input: inputTokens,
          output: outputTokens,
          reasoning: reasoningTokens,
          cache: {
            write: cacheWrite,
            read: cacheRead
          }
        },
        modelID,
        providerID,
        time: {
          created: startedMs,
          completed: nowMs
        },
        finish: normalizeString(options.finishReason) || 'stop'
      },
      partData: {
        type: 'text',
        text: content,
        time: {
          start: startedMs,
          end: nowMs
        }
      }
    });
    updateRows(db, 'session', {
      time_updated: nowMs,
      model: JSON.stringify({ id: modelID, providerID, variant: 'default' }),
      agent,
      tokens_input: inputTokens,
      tokens_output: outputTokens,
      tokens_reasoning: reasoningTokens,
      tokens_cache_read: cacheRead,
      tokens_cache_write: cacheWrite,
      cost: Number(usage.cost || 0) || 0
    }, 'id = ?', [sessionId]);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  } finally {
    try { db.close(); } catch (_closeError) {}
  }
}

function ensureOpenCodeSessionTestSchema(hostHome) {
  const db = openOpenCodeDb(hostHome, { readOnly: false, create: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id text PRIMARY KEY,
        worktree text NOT NULL,
        vcs text,
        name text,
        icon_url text,
        icon_color text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_initialized integer,
        sandboxes text NOT NULL,
        commands text,
        icon_url_override text
      );
      CREATE TABLE IF NOT EXISTS session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        title text NOT NULL,
        version text NOT NULL,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_compacting integer,
        time_archived integer,
        workspace_id text,
        path text,
        agent text,
        model text,
        cost real DEFAULT 0 NOT NULL,
        tokens_input integer DEFAULT 0 NOT NULL,
        tokens_output integer DEFAULT 0 NOT NULL,
        tokens_reasoning integer DEFAULT 0 NOT NULL,
        tokens_cache_read integer DEFAULT 0 NOT NULL,
        tokens_cache_write integer DEFAULT 0 NOT NULL,
        metadata text
      );
      CREATE TABLE IF NOT EXISTS message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        type text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL,
        seq integer NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS session_message_session_seq_idx ON session_message (session_id, seq);
    `);
  } finally {
    try { db.close(); } catch (_closeError) {}
  }
}

module.exports = {
  beginOpenCodeChatTurn,
  completeOpenCodeChatTurn,
  ensureOpenCodeSessionTestSchema,
  getOpenCodeDbPath,
  openOpenCodeDb,
  __private: {
    createOpenCodeId,
    deriveTitle,
    parseOpenCodeModel
  }
};
