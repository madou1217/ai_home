'use strict';

const path = require('node:path');
const {
  calculateCostUsd,
  matchModelPricing,
  normalizePricingRecord
} = require('./model-usage-pricing');

const MODEL_USAGE_DB_FILE = 'model-usage.db';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function getDatabaseSyncCtor(deps = {}) {
  if (
    Object.prototype.hasOwnProperty.call(deps, 'DatabaseSync')
    && deps.DatabaseSync !== undefined
  ) {
    return deps.DatabaseSync;
  }
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function getModelUsageDbPath(aiHomeDir) {
  return path.join(aiHomeDir, MODEL_USAGE_DB_FILE);
}

function canUseModelUsageDatabase(fs, aiHomeDir, deps = {}) {
  return Boolean(
    fs
    && aiHomeDir
    && typeof fs.mkdirSync === 'function'
    && typeof getDatabaseSyncCtor(deps) === 'function'
  );
}

function getTableColumns(db, tableName) {
  return new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() || [])
    .map((row) => String(row.name || '').trim())
    .filter(Boolean));
}

function ensureColumn(db, tableName, columnName, columnDefinition) {
  const columns = getTableColumns(db, tableName);
  if (columns.has(columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

function ensureSchema(db) {
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      timestamp_ms INTEGER NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      git_branch TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_usage_timestamp ON model_usage_records(timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_model_usage_provider_model ON model_usage_records(provider, model);
    CREATE INDEX IF NOT EXISTS idx_model_usage_session ON model_usage_records(provider, session_id);

    CREATE TABLE IF NOT EXISTS model_usage_sessions (
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      git_branch TEXT NOT NULL DEFAULT '',
      started_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      prompt_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(provider, session_id)
    );

    CREATE TABLE IF NOT EXISTS model_usage_prompt_events (
      event_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_usage_prompt_timestamp ON model_usage_prompt_events(timestamp_ms);

    CREATE TABLE IF NOT EXISTS model_usage_file_state (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL DEFAULT 0,
      offset INTEGER NOT NULL DEFAULT 0,
      scan_context TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS model_usage_pricing (
      model TEXT PRIMARY KEY,
      input_cost_per_token REAL NOT NULL DEFAULT 0,
      output_cost_per_token REAL NOT NULL DEFAULT 0,
      cache_read_input_token_cost REAL NOT NULL DEFAULT 0,
      cache_creation_input_token_cost REAL NOT NULL DEFAULT 0,
      reasoning_output_token_cost REAL NOT NULL DEFAULT 0,
      context_cost_tiers_json TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureColumn(db, 'model_usage_pricing', 'reasoning_output_token_cost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'model_usage_pricing', 'context_cost_tiers_json', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'model_usage_pricing', 'source', "TEXT NOT NULL DEFAULT ''");
}

function openModelUsageStore(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!canUseModelUsageDatabase(fs, aiHomeDir, options)) return null;
  const dbPath = options.dbPath || getModelUsageDbPath(aiHomeDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const DatabaseSync = getDatabaseSyncCtor(options);
  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  return createModelUsageStore(db);
}

function toSafeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number));
}

function toTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeUsageRecord(input = {}, pricingByModel = {}) {
  const provider = String(input.provider || input.source || '').trim().toLowerCase();
  const timestampMs = toTimestampMs(input.timestampMs || input.timestamp || input.createdAt);
  const model = String(input.model || '').trim();
  if (!provider || !timestampMs) return null;

  const cacheReadInputTokens = toSafeInteger(input.cacheReadInputTokens ?? input.cache_read_input_tokens);
  const cacheCreationInputTokens = toSafeInteger(input.cacheCreationInputTokens ?? input.cache_creation_input_tokens);
  const inputTokens = toSafeInteger(input.inputTokens ?? input.input_tokens);
  const outputTokens = toSafeInteger(input.outputTokens ?? input.output_tokens);
  const reasoningOutputTokens = toSafeInteger(input.reasoningOutputTokens ?? input.reasoning_output_tokens);
  const explicitTotal = toSafeInteger(input.totalTokens ?? input.total_tokens);
  const totalTokens = explicitTotal || inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens + reasoningOutputTokens;
  const eventKey = String(input.eventKey || input.event_key || '').trim();

  if (!eventKey) return null;
  const pricing = matchModelPricing(model, pricingByModel, provider);
  const costUsd = Number.isFinite(Number(input.costUsd ?? input.cost_usd))
    ? Math.max(0, Number(input.costUsd ?? input.cost_usd))
    : calculateCostUsd({
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      reasoningOutputTokens
    }, pricing);

  return {
    eventKey,
    provider,
    accountId: String(input.accountId || input.account_id || '').trim(),
    sessionId: String(input.sessionId || input.session_id || '').trim(),
    requestId: String(input.requestId || input.request_id || '').trim(),
    sourceKind: String(input.sourceKind || input.source_kind || '').trim(),
    model,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    totalTokens,
    costUsd,
    timestampMs,
    project: String(input.project || '').trim(),
    cwd: String(input.cwd || '').trim(),
    gitBranch: String(input.gitBranch || input.git_branch || '').trim()
  };
}

function normalizeSessionRecord(input = {}) {
  const provider = String(input.provider || input.source || '').trim().toLowerCase();
  const sessionId = String(input.sessionId || input.session_id || '').trim();
  if (!provider || !sessionId) return null;
  return {
    provider,
    sessionId,
    project: String(input.project || '').trim(),
    cwd: String(input.cwd || '').trim(),
    gitBranch: String(input.gitBranch || input.git_branch || '').trim(),
    startedAtMs: toTimestampMs(input.startedAtMs || input.startedAt || input.startTime),
    updatedAtMs: toTimestampMs(input.updatedAtMs || input.updatedAt),
    promptCount: toSafeInteger(input.promptCount || input.prompts)
  };
}

function normalizePromptEvent(input = {}) {
  const provider = String(input.provider || input.source || '').trim().toLowerCase();
  const sessionId = String(input.sessionId || input.session_id || '').trim();
  const eventKey = String(input.eventKey || input.event_key || '').trim();
  const timestampMs = toTimestampMs(input.timestampMs || input.timestamp);
  if (!provider || !sessionId || !eventKey || !timestampMs) return null;
  return { provider, sessionId, eventKey, timestampMs };
}

function normalizeQuery(input = {}) {
  const fromMs = toTimestampMs(input.fromMs || input.from);
  const toMs = toTimestampMs(input.toMs || input.to) || Date.now();
  return {
    fromMs: fromMs || 0,
    toMs,
    provider: String(input.provider || input.source || '').trim().toLowerCase(),
    model: String(input.model || '').trim(),
    sessionId: String(input.sessionId || input.session_id || '').trim(),
    limit: Math.max(1, Math.min(500, toSafeInteger(input.limit) || 50))
  };
}

// Each model-usage event is observed by two independent ingestors: the local
// session-file scanner (`session_*`) and the proxy recorder (`server_*`). For
// claude/codex/gemini both fire on the same request, so summing across source
// kinds double-counts. The session files are the ground truth for those three
// (the CLI logs every turn locally, with full cache breakdown), so the proxy copy
// is redundant and we drop it at aggregation time. agy has no scannable local log
// (protobuf) and is only ever seen by the proxy, so its `server_*` rows are kept.
// Dropping only the redundant copy (rather than whitelisting one source) leaves
// every other row — including agy and any synthetic source — counted once.
function authoritativeSourceClause(prefix) {
  return `NOT (${prefix}provider IN ('claude','codex','gemini') AND ${prefix}source_kind LIKE 'server\\_%' ESCAPE '\\')`;
}

function buildWhereClause(query = {}, options = {}) {
  const normalized = normalizeQuery(query);
  const prefix = options.tableAlias ? `${String(options.tableAlias).trim()}.` : '';
  const clauses = [`${prefix}timestamp_ms BETWEEN ? AND ?`];
  const args = [normalized.fromMs, normalized.toMs];
  if (normalized.provider) {
    clauses.push(`${prefix}provider = ?`);
    args.push(normalized.provider);
  }
  if (normalized.model) {
    clauses.push(`${prefix}model = ?`);
    args.push(normalized.model);
  }
  if (options.includeSession && normalized.sessionId) {
    clauses.push(`${prefix}session_id = ?`);
    args.push(normalized.sessionId);
  }
  clauses.push(authoritativeSourceClause(prefix));
  return {
    where: clauses.join(' AND '),
    args,
    normalized
  };
}

function createModelUsageStore(db) {
  function close() {
    if (db && typeof db.close === 'function') db.close();
  }

  function parseContextCostTiers(value) {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  function stringifyContextCostTiers(value) {
    const tiers = Array.isArray(value) ? value : [];
    return tiers.length > 0 ? JSON.stringify(tiers) : '';
  }

  function getAllPricing() {
    const rows = db.prepare(`
      SELECT model, input_cost_per_token, output_cost_per_token,
        cache_read_input_token_cost, cache_creation_input_token_cost,
        reasoning_output_token_cost, context_cost_tiers_json, source
      FROM model_usage_pricing
    `).all() || [];
    const out = {};
    rows.forEach((row) => {
      out[row.model] = {
        model: row.model,
        inputCostPerToken: Number(row.input_cost_per_token) || 0,
        outputCostPerToken: Number(row.output_cost_per_token) || 0,
        cacheReadInputTokenCost: Number(row.cache_read_input_token_cost) || 0,
        cacheCreationInputTokenCost: Number(row.cache_creation_input_token_cost) || 0,
        reasoningOutputTokenCost: Number(row.reasoning_output_token_cost) || 0,
        contextCostTiers: parseContextCostTiers(row.context_cost_tiers_json),
        source: row.source || ''
      };
    });
    return out;
  }

  function getPricingLastUpdatedAt(source = '') {
    const normalizedSource = String(source || '').trim();
    const row = normalizedSource
      ? db.prepare('SELECT COALESCE(MAX(updated_at_ms), 0) AS updated_at_ms FROM model_usage_pricing WHERE source = ?').get(normalizedSource)
      : db.prepare('SELECT COALESCE(MAX(updated_at_ms), 0) AS updated_at_ms FROM model_usage_pricing').get();
    return Number(row.updated_at_ms) || 0;
  }

  function upsertPricing(records = [], options = {}) {
    const source = String(options.source || '').trim();
    const normalized = (Array.isArray(records) ? records : [])
      .map((record) => normalizePricingRecord(record && record.model, record))
      .filter(Boolean);
    if (normalized.length === 0) return 0;
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO model_usage_pricing (
        model, input_cost_per_token, output_cost_per_token,
        cache_read_input_token_cost, cache_creation_input_token_cost,
        reasoning_output_token_cost, context_cost_tiers_json, source, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        input_cost_per_token = excluded.input_cost_per_token,
        output_cost_per_token = excluded.output_cost_per_token,
        cache_read_input_token_cost = excluded.cache_read_input_token_cost,
        cache_creation_input_token_cost = excluded.cache_creation_input_token_cost,
        reasoning_output_token_cost = excluded.reasoning_output_token_cost,
        context_cost_tiers_json = excluded.context_cost_tiers_json,
        source = excluded.source,
        updated_at_ms = excluded.updated_at_ms
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      normalized.forEach((record) => {
        stmt.run(
          record.model,
          record.inputCostPerToken,
          record.outputCostPerToken,
          record.cacheReadInputTokenCost,
          record.cacheCreationInputTokenCost,
          record.reasoningOutputTokenCost,
          stringifyContextCostTiers(record.contextCostTiers),
          source,
          now
        );
      });
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
    return normalized.length;
  }

  function insertUsageBatch(records = []) {
    const pricingByModel = getAllPricing();
    const normalized = (Array.isArray(records) ? records : [])
      .map((record) => normalizeUsageRecord(record, pricingByModel))
      .filter(Boolean);
    if (normalized.length === 0) return 0;
    const createdAtMs = Date.now();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO model_usage_records (
        event_key, provider, account_id, session_id, request_id, source_kind, model,
        input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
        reasoning_output_tokens, total_tokens, cost_usd, timestamp_ms,
        project, cwd, git_branch, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    let inserted = 0;
    try {
      normalized.forEach((record) => {
        const result = stmt.run(
          record.eventKey,
          record.provider,
          record.accountId,
          record.sessionId,
          record.requestId,
          record.sourceKind,
          record.model,
          record.inputTokens,
          record.outputTokens,
          record.cacheReadInputTokens,
          record.cacheCreationInputTokens,
          record.reasoningOutputTokens,
          record.totalTokens,
          record.costUsd,
          record.timestampMs,
          record.project,
          record.cwd,
          record.gitBranch,
          createdAtMs
        );
        if (Number(result && result.changes) > 0) inserted += 1;
      });
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
    return inserted;
  }

  function recalculateCosts(options = {}) {
    const all = options.all === true;
    const pricingByModel = getAllPricing();
    const rows = db.prepare(`
      SELECT id, provider, model, input_tokens, output_tokens, cache_read_input_tokens,
        cache_creation_input_tokens, reasoning_output_tokens, cost_usd
      FROM model_usage_records
      ${all ? '' : 'WHERE cost_usd = 0'}
    `).all() || [];
    if (rows.length === 0) return 0;
    const stmt = db.prepare('UPDATE model_usage_records SET cost_usd = ? WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    let updated = 0;
    try {
      rows.forEach((row) => {
        const pricing = matchModelPricing(row.model, pricingByModel, row.provider);
        if (!pricing) return;
        const cost = calculateCostUsd({
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cacheReadInputTokens: row.cache_read_input_tokens,
          cacheCreationInputTokens: row.cache_creation_input_tokens,
          reasoningOutputTokens: row.reasoning_output_tokens
        }, pricing);
        if (!cost && !all) return;
        if (Math.abs((Number(row.cost_usd) || 0) - cost) <= 1e-12) return;
        const result = stmt.run(cost, row.id);
        if (Number(result && result.changes) > 0) updated += 1;
      });
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
    return updated;
  }

  function insertUsage(record) {
    return insertUsageBatch([record]);
  }

  function upsertSessions(records = []) {
    const normalized = (Array.isArray(records) ? records : [])
      .map(normalizeSessionRecord)
      .filter(Boolean);
    if (normalized.length === 0) return 0;
    const stmt = db.prepare(`
      INSERT INTO model_usage_sessions (
        provider, session_id, project, cwd, git_branch, started_at_ms, updated_at_ms, prompt_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, session_id) DO UPDATE SET
        project = CASE WHEN excluded.project != '' THEN excluded.project ELSE model_usage_sessions.project END,
        cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE model_usage_sessions.cwd END,
        git_branch = CASE WHEN excluded.git_branch != '' THEN excluded.git_branch ELSE model_usage_sessions.git_branch END,
        started_at_ms = CASE
          WHEN model_usage_sessions.started_at_ms = 0 THEN excluded.started_at_ms
          WHEN excluded.started_at_ms = 0 THEN model_usage_sessions.started_at_ms
          WHEN excluded.started_at_ms < model_usage_sessions.started_at_ms THEN excluded.started_at_ms
          ELSE model_usage_sessions.started_at_ms
        END,
        updated_at_ms = CASE
          WHEN excluded.updated_at_ms > model_usage_sessions.updated_at_ms THEN excluded.updated_at_ms
          ELSE model_usage_sessions.updated_at_ms
        END,
        prompt_count = model_usage_sessions.prompt_count + excluded.prompt_count
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      normalized.forEach((record) => {
        stmt.run(
          record.provider,
          record.sessionId,
          record.project,
          record.cwd,
          record.gitBranch,
          record.startedAtMs,
          record.updatedAtMs,
          record.promptCount
        );
      });
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
    return normalized.length;
  }

  function insertPromptEvents(records = []) {
    const normalized = (Array.isArray(records) ? records : [])
      .map(normalizePromptEvent)
      .filter(Boolean);
    if (normalized.length === 0) return 0;
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO model_usage_prompt_events (
        event_key, provider, session_id, timestamp_ms
      ) VALUES (?, ?, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    let inserted = 0;
    try {
      normalized.forEach((record) => {
        const result = stmt.run(record.eventKey, record.provider, record.sessionId, record.timestampMs);
        if (Number(result && result.changes) > 0) inserted += 1;
      });
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
    return inserted;
  }

  function getFileState(filePath) {
    const row = db.prepare(`
      SELECT size, offset, scan_context
      FROM model_usage_file_state
      WHERE path = ?
    `).get(String(filePath || '').trim());
    if (!row) return { size: 0, offset: 0, scanContext: null };
    let scanContext = null;
    try {
      scanContext = row.scan_context ? JSON.parse(row.scan_context) : null;
    } catch (_error) {
      scanContext = null;
    }
    return {
      size: Number(row.size) || 0,
      offset: Number(row.offset) || 0,
      scanContext
    };
  }

  function setFileState(filePath, state = {}) {
    const scanContext = state.scanContext && typeof state.scanContext === 'object'
      ? JSON.stringify(state.scanContext)
      : '';
    db.prepare(`
      INSERT INTO model_usage_file_state(path, size, offset, scan_context)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        size = excluded.size,
        offset = excluded.offset,
        scan_context = excluded.scan_context
    `).run(
      String(filePath || '').trim(),
      toSafeInteger(state.size),
      toSafeInteger(state.offset),
      scanContext
    );
  }

  function queryStats(query = {}) {
    const { where, args, normalized } = buildWhereClause(query);
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total_calls,
        COUNT(DISTINCT CASE WHEN session_id != '' THEN provider || ':' || session_id END) AS total_sessions,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM model_usage_records
      WHERE ${where}
    `).get(...args) || {};
    const promptArgs = normalized.provider
      ? [normalized.fromMs, normalized.toMs, normalized.provider]
      : [normalized.fromMs, normalized.toMs];
    const promptRow = db.prepare(`
      SELECT COUNT(*) AS total_prompts
      FROM model_usage_prompt_events
      WHERE timestamp_ms BETWEEN ? AND ?
        ${normalized.provider ? 'AND provider = ?' : ''}
    `).get(...promptArgs) || {};
    return {
      totalCalls: Number(row.total_calls) || 0,
      totalSessions: Number(row.total_sessions) || 0,
      totalPrompts: Number(promptRow.total_prompts) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
      cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
      reasoningOutputTokens: Number(row.reasoning_output_tokens) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      totalCostUsd: Number(row.total_cost_usd) || 0
    };
  }

  function queryCostByModel(query = {}) {
    const { where, args } = buildWhereClause(query);
    return (db.prepare(`
      SELECT
        provider,
        model,
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM model_usage_records
      WHERE ${where}
      GROUP BY provider, model
      ORDER BY cost_usd DESC, total_tokens DESC, calls DESC
    `).all(...args) || []).map((row) => ({
      provider: row.provider,
      model: row.model,
      calls: Number(row.calls) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
      cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
      reasoningOutputTokens: Number(row.reasoning_output_tokens) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      costUsd: Number(row.cost_usd) || 0
    }));
  }

  function querySessions(query = {}) {
    const { where, args, normalized } = buildWhereClause(query, { tableAlias: 'r' });
    return (db.prepare(`
      SELECT
        r.provider,
        r.session_id,
        COALESCE(s.project, MAX(r.project), '') AS project,
        COALESCE(s.cwd, MAX(r.cwd), '') AS cwd,
        COALESCE(s.git_branch, MAX(r.git_branch), '') AS git_branch,
        COALESCE(NULLIF(s.started_at_ms, 0), MIN(r.timestamp_ms)) AS started_at_ms,
        COALESCE(NULLIF(s.updated_at_ms, 0), MAX(r.timestamp_ms)) AS updated_at_ms,
        COALESCE(s.prompt_count, 0) AS prompt_count,
        COUNT(*) AS calls,
        COALESCE(SUM(r.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(r.cost_usd), 0) AS cost_usd
      FROM model_usage_records r
      LEFT JOIN model_usage_sessions s
        ON s.provider = r.provider AND s.session_id = r.session_id
      WHERE ${where} AND r.session_id != ''
      GROUP BY r.provider, r.session_id
      ORDER BY updated_at_ms DESC
      LIMIT ?
    `).all(...args, normalized.limit) || []).map((row) => ({
      provider: row.provider,
      sessionId: row.session_id,
      project: row.project || '',
      cwd: row.cwd || '',
      gitBranch: row.git_branch || '',
      startedAtMs: Number(row.started_at_ms) || 0,
      updatedAtMs: Number(row.updated_at_ms) || 0,
      promptCount: Number(row.prompt_count) || 0,
      calls: Number(row.calls) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      costUsd: Number(row.cost_usd) || 0
    }));
  }

  function querySessionDetail(query = {}) {
    const { where, args } = buildWhereClause(query, { includeSession: true });
    return (db.prepare(`
      SELECT
        provider,
        session_id,
        model,
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM model_usage_records
      WHERE ${where}
      GROUP BY provider, session_id, model
      ORDER BY cost_usd DESC, total_tokens DESC
    `).all(...args) || []).map((row) => ({
      provider: row.provider,
      sessionId: row.session_id,
      model: row.model,
      calls: Number(row.calls) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
      cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
      reasoningOutputTokens: Number(row.reasoning_output_tokens) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      costUsd: Number(row.cost_usd) || 0
    }));
  }

  return {
    close,
    db,
    getAllPricing,
    getPricingLastUpdatedAt,
    upsertPricing,
    recalculateCosts,
    insertUsage,
    insertUsageBatch,
    upsertSessions,
    insertPromptEvents,
    getFileState,
    setFileState,
    queryStats,
    queryCostByModel,
    querySessions,
    querySessionDetail
  };
}

module.exports = {
  MODEL_USAGE_DB_FILE,
  canUseModelUsageDatabase,
  getModelUsageDbPath,
  openModelUsageStore,
  normalizeUsageRecord,
  normalizeSessionRecord,
  normalizePromptEvent,
  normalizeQuery,
  __private: {
    buildWhereClause,
    ensureSchema,
    toSafeInteger,
    toTimestampMs
  }
};
