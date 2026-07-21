'use strict';

const {
  ensureExactTableSchema,
  getAppStateDbPath,
  openAppStateDatabase
} = require('../server/app-state-store');
const { isAccountRef } = require('../account/public-account-ref');
const {
  calculateCostUsd,
  matchModelPricing,
  normalizePricingRecord
} = require('./model-usage-pricing');
const { createCanonicalReadProjection } = require('./model-usage-read-projection');
const { stableHash } = require('./model-usage-stable-hash');

const MODEL_USAGE_DB_FILE = 'app-state.db';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_COST_RECALCULATION_BATCH_SIZE = 1_000;
const MAX_COST_RECALCULATION_BATCH_SIZE = 10_000;
const PRICING_ACTIVE_CATALOG_STATE_KEY = 'active:model_usage_pricing';
const PRICING_MAINTENANCE_STATE_KEY = 'maintenance:model_usage_pricing';
const PRICING_CATALOG_STALE_EPOCH = 'pricing_catalog_stale_epoch';
const MISSING_OPTIONAL_COST = -1;
const NON_CANONICAL_ACCOUNT_FIELDS = Object.freeze(['accountId', 'account_id', 'account_ref']);
const MODEL_USAGE_RECORD_COLUMNS = Object.freeze([
  'id',
  'event_key',
  'provider',
  'account_ref',
  'session_id',
  'request_id',
  'source_kind',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_output_tokens',
  'total_tokens',
  'cost_usd',
  'timestamp_ms',
  'project',
  'cwd',
  'git_branch',
  'created_at_ms'
]);
const MODEL_USAGE_SESSION_COLUMNS = Object.freeze([
  'provider',
  'session_id',
  'project',
  'cwd',
  'git_branch',
  'started_at_ms',
  'updated_at_ms',
  'prompt_count'
]);
const MODEL_USAGE_PROMPT_EVENT_COLUMNS = Object.freeze([
  'event_key',
  'provider',
  'session_id',
  'timestamp_ms'
]);
const MODEL_USAGE_FILE_STATE_COLUMNS = Object.freeze([
  'path',
  'size',
  'offset',
  'scan_context'
]);
const MODEL_USAGE_PRICING_COLUMNS = Object.freeze([
  'model',
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'reasoning_output_token_cost',
  'context_cost_tiers_json',
  'source',
  'updated_at_ms'
]);

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
  return getAppStateDbPath(aiHomeDir);
}

function canUseModelUsageDatabase(fs, aiHomeDir, deps = {}) {
  return Boolean(
    fs
    && aiHomeDir
    && typeof fs.mkdirSync === 'function'
    && typeof getDatabaseSyncCtor(deps) === 'function'
  );
}

function assertUsageAccountRefSchema(db) {
  ensureExactTableSchema(db, {
    tableName: 'model_usage_records',
    columns: MODEL_USAGE_RECORD_COLUMNS,
    primaryKey: ['id'],
    uniqueKeys: [['event_key']],
    errorCode: 'model_usage_account_ref_schema_invalid'
  });
}

function ensureSchema(db) {
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
  ensureExactTableSchema(db, {
    tableName: 'model_usage_records',
    columns: MODEL_USAGE_RECORD_COLUMNS,
    primaryKey: ['id'],
    uniqueKeys: [['event_key']],
    create: () => db.exec(`
      CREATE TABLE model_usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      account_ref TEXT NOT NULL DEFAULT '' CHECK (
        account_ref = '' OR (
          length(account_ref) = 25
          AND substr(account_ref, 1, 5) = 'acct_'
          AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
        )
      ),
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
      )
    `),
    errorCode: 'model_usage_account_ref_schema_invalid'
  });
  ensureExactTableSchema(db, {
    tableName: 'model_usage_sessions',
    columns: MODEL_USAGE_SESSION_COLUMNS,
    primaryKey: ['provider', 'session_id'],
    create: () => db.exec(`
      CREATE TABLE model_usage_sessions (
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      git_branch TEXT NOT NULL DEFAULT '',
      started_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      prompt_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(provider, session_id)
      )
    `),
    errorCode: 'model_usage_session_schema_invalid'
  });
  ensureExactTableSchema(db, {
    tableName: 'model_usage_prompt_events',
    columns: MODEL_USAGE_PROMPT_EVENT_COLUMNS,
    primaryKey: [],
    uniqueKeys: [['event_key']],
    create: () => db.exec(`
      CREATE TABLE model_usage_prompt_events (
      event_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL
      )
    `),
    errorCode: 'model_usage_prompt_event_schema_invalid'
  });
  ensureExactTableSchema(db, {
    tableName: 'model_usage_file_state',
    columns: MODEL_USAGE_FILE_STATE_COLUMNS,
    primaryKey: ['path'],
    create: () => db.exec(`
      CREATE TABLE model_usage_file_state (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL DEFAULT 0,
      offset INTEGER NOT NULL DEFAULT 0,
      scan_context TEXT NOT NULL DEFAULT ''
      )
    `),
    errorCode: 'model_usage_file_state_schema_invalid'
  });
  ensureExactTableSchema(db, {
    tableName: 'model_usage_pricing',
    columns: MODEL_USAGE_PRICING_COLUMNS,
    primaryKey: ['model'],
    create: () => db.exec(`
      CREATE TABLE model_usage_pricing (
      model TEXT PRIMARY KEY,
      input_cost_per_token REAL NOT NULL DEFAULT 0,
      output_cost_per_token REAL NOT NULL DEFAULT 0,
      cache_read_input_token_cost REAL NOT NULL DEFAULT 0,
      cache_creation_input_token_cost REAL NOT NULL DEFAULT 0,
      reasoning_output_token_cost REAL NOT NULL DEFAULT 0,
      context_cost_tiers_json TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL DEFAULT 0
      )
    `),
    errorCode: 'model_usage_pricing_schema_invalid'
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_model_usage_timestamp ON model_usage_records(timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_model_usage_provider_model ON model_usage_records(provider, model);
    CREATE INDEX IF NOT EXISTS idx_model_usage_session ON model_usage_records(provider, session_id);
    CREATE INDEX IF NOT EXISTS idx_model_usage_prompt_timestamp ON model_usage_prompt_events(timestamp_ms);
  `);
}

function openModelUsageStore(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!canUseModelUsageDatabase(fs, aiHomeDir, options)) return null;
  const db = openAppStateDatabase(fs, aiHomeDir, options);
  if (!db) return null;
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
  if (!provider || !model || !timestampMs) return null;

  const cacheReadInputTokens = toSafeInteger(input.cacheReadInputTokens ?? input.cache_read_input_tokens);
  const cacheCreationInputTokens = toSafeInteger(input.cacheCreationInputTokens ?? input.cache_creation_input_tokens);
  const inputTokens = toSafeInteger(input.inputTokens ?? input.input_tokens);
  const outputTokens = toSafeInteger(input.outputTokens ?? input.output_tokens);
  const reasoningOutputTokens = toSafeInteger(input.reasoningOutputTokens ?? input.reasoning_output_tokens);
  const explicitTotal = toSafeInteger(input.totalTokens ?? input.total_tokens);
  const totalTokens = explicitTotal || inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens + reasoningOutputTokens;
  const eventKey = String(input.eventKey || input.event_key || '').trim();

  if (!eventKey) return null;
  if (NON_CANONICAL_ACCOUNT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(input, field))) {
    throw new Error('model_usage_account_key_invalid');
  }
  const accountRef = String(input.accountRef || '').trim();
  if (accountRef && !isAccountRef(accountRef)) {
    throw new Error('model_usage_account_ref_invalid');
  }
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
    accountRef,
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

function buildProjectedWhereClause(query = {}, options = {}) {
  const normalized = normalizeQuery(query);
  const prefix = options.tableAlias ? `${String(options.tableAlias).trim()}.` : '';
  const clauses = [];
  const args = [];
  if (normalized.provider) {
    clauses.push(`${prefix}provider = ?`);
    args.push(normalized.provider);
  }
  if (options.includeModel !== false && normalized.model) {
    clauses.push(`${prefix}model = ?`);
    args.push(normalized.model);
  }
  if (options.includeSession && normalized.sessionId) {
    clauses.push(`${prefix}session_id = ?`);
    args.push(normalized.sessionId);
  }
  return {
    where: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1',
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

  function deserializeOptionalCost(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function serializeOptionalCost(value) {
    if (value === null || value === undefined || value === '') return MISSING_OPTIONAL_COST;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : MISSING_OPTIONAL_COST;
  }

  function readJsonState(key) {
    const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(key);
    if (!row || !row.value) return null;
    try {
      const state = JSON.parse(String(row.value));
      return state && typeof state === 'object' ? state : null;
    } catch (_error) {
      return null;
    }
  }

  function writeJsonState(key, value, updatedAt = Date.now()) {
    db.prepare(`
      INSERT INTO app_kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), updatedAt);
  }

  function getActivePricingCatalog() {
    return readJsonState(PRICING_ACTIVE_CATALOG_STATE_KEY);
  }

  function getAllPricing(options = {}) {
    const requestedSource = String(options.source || '').trim();
    const activeCatalog = requestedSource ? null : getActivePricingCatalog();
    const activeSource = requestedSource || String(activeCatalog && activeCatalog.source || '').trim();
    const select = `
      SELECT model, input_cost_per_token, output_cost_per_token,
        cache_read_input_token_cost, cache_creation_input_token_cost,
        reasoning_output_token_cost, context_cost_tiers_json, source
      FROM model_usage_pricing
      ${activeSource ? 'WHERE source = ?' : ''}
    `;
    const rows = activeSource
      ? db.prepare(select).all(activeSource) || []
      : db.prepare(select).all() || [];
    const out = {};
    rows.forEach((row) => {
      out[row.model] = {
        model: row.model,
        inputCostPerToken: Number(row.input_cost_per_token) || 0,
        outputCostPerToken: Number(row.output_cost_per_token) || 0,
        cacheReadInputTokenCost: Number(row.cache_read_input_token_cost) || 0,
        cacheCreationInputTokenCost: Number(row.cache_creation_input_token_cost) || 0,
        reasoningOutputTokenCost: deserializeOptionalCost(row.reasoning_output_token_cost),
        contextCostTiers: parseContextCostTiers(row.context_cost_tiers_json),
        source: row.source || ''
      };
    });
    return out;
  }

  function getPricingMaintenanceState() {
    return readJsonState(PRICING_MAINTENANCE_STATE_KEY);
  }

  function getUsageRecordHighWaterMark() {
    const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM model_usage_records').get() || {};
    return toSafeInteger(row.id);
  }

  function normalizePricingRecords(records = []) {
    return (Array.isArray(records) ? records : [])
      .map((record) => normalizePricingRecord(record && record.model, record))
      .filter(Boolean);
  }

  function upsertNormalizedPricing(records, source, updatedAt) {
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
    records.forEach((record) => {
      stmt.run(
        record.model,
        record.inputCostPerToken,
        record.outputCostPerToken,
        record.cacheReadInputTokenCost,
        record.cacheCreationInputTokenCost,
        serializeOptionalCost(record.reasoningOutputTokenCost),
        stringifyContextCostTiers(record.contextCostTiers),
        source,
        updatedAt
      );
    });
    return records.length;
  }

  function activatePricingCatalog(records = [], options = {}) {
    const normalized = normalizePricingRecords(records);
    const source = String(options.source || '').trim();
    const sourceFamily = String(options.sourceFamily || '').trim();
    const formatVersion = String(options.formatVersion || '').trim();
    const fingerprint = String(options.fingerprint || '').trim();
    if (!source || !sourceFamily || !formatVersion || !fingerprint || normalized.length === 0) {
      throw new Error('model_usage_pricing_catalog_invalid');
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const currentActive = getActivePricingCatalog();
      const currentSource = String(currentActive && currentActive.source || '').trim();
      const currentEpoch = toSafeInteger(currentActive && currentActive.epoch);
      const sameCatalog = currentSource === source
        && String(currentActive && currentActive.sourceFamily || '').trim() === sourceFamily
        && String(currentActive && currentActive.formatVersion || '').trim() === formatVersion
        && String(currentActive && currentActive.fingerprint || '').trim() === fingerprint;
      if (sameCatalog) {
        const maintenance = getPricingMaintenanceState();
        db.exec('COMMIT');
        return {
          activated: false,
          stale: false,
          upserted: 0,
          deleted: 0,
          activeCatalog: currentActive,
          maintenance
        };
      }

      const expectsSource = Object.prototype.hasOwnProperty.call(options, 'expectedActiveSource');
      const expectsEpoch = Object.prototype.hasOwnProperty.call(options, 'expectedActiveEpoch');
      const expectedSource = String(options.expectedActiveSource || '').trim();
      const expectedEpoch = toSafeInteger(options.expectedActiveEpoch);
      if (
        (expectsSource && currentSource !== expectedSource)
        || (expectsEpoch && currentEpoch !== expectedEpoch)
      ) {
        db.exec('ROLLBACK');
        return {
          activated: false,
          stale: true,
          reason: PRICING_CATALOG_STALE_EPOCH,
          activeCatalog: getActivePricingCatalog(),
          maintenance: getPricingMaintenanceState()
        };
      }

      const now = Date.now();
      const epoch = currentEpoch + 1;
      const activeCatalog = {
        version: 1,
        source,
        sourceFamily,
        formatVersion,
        fingerprint,
        epoch,
        updatedAt: now
      };
      const targetMaxId = getUsageRecordHighWaterMark();
      const maintenance = {
        version: 1,
        status: 'pending',
        source,
        pricingSource: sourceFamily,
        catalogFingerprint: fingerprint,
        catalogEpoch: epoch,
        cursorId: 0,
        targetMaxId,
        scanned: 0,
        recalculated: 0,
        batches: 0,
        startedAtMs: now,
        updatedAtMs: now,
        completedAtMs: 0
      };
      const upserted = upsertNormalizedPricing(normalized, source, now);
      const deletedResult = db.prepare(`
        DELETE FROM model_usage_pricing
        WHERE source != ?
          AND (
            source = ?
            OR substr(source, 1, length(?) + 1) = ? || ':'
          )
      `).run(source, sourceFamily, sourceFamily, sourceFamily);
      writeJsonState(PRICING_ACTIVE_CATALOG_STATE_KEY, activeCatalog, now);
      writeJsonState(PRICING_MAINTENANCE_STATE_KEY, maintenance, now);
      db.exec('COMMIT');
      return {
        activated: true,
        stale: false,
        upserted,
        deleted: Number(deletedResult && deletedResult.changes) || 0,
        activeCatalog,
        maintenance
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
  }

  function upsertPricing(records = [], options = {}) {
    const source = String(options.source || '').trim();
    const normalized = normalizePricingRecords(records);
    if (normalized.length === 0) return 0;
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (getActivePricingCatalog()) {
        throw new Error('model_usage_pricing_catalog_active');
      }
      upsertNormalizedPricing(normalized, source, now);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
    return normalized.length;
  }

  function runInImmediateTransaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
  }

  function normalizeUsageRecords(records = []) {
    const pricingByModel = getAllPricing();
    return (Array.isArray(records) ? records : [])
      .map((record) => normalizeUsageRecord(record, pricingByModel))
      .filter(Boolean);
  }

  function insertNormalizedUsageRecords(normalized = []) {
    if (normalized.length === 0) return 0;
    const createdAtMs = Date.now();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO model_usage_records (
        event_key, provider, account_ref, session_id, request_id, source_kind, model,
        input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
        reasoning_output_tokens, total_tokens, cost_usd, timestamp_ms,
        project, cwd, git_branch, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    normalized.forEach((record) => {
      const result = stmt.run(
        record.eventKey,
        record.provider,
        record.accountRef,
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
    return inserted;
  }

  function insertUsageBatch(records = []) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    return runInImmediateTransaction(() => {
      const normalized = normalizeUsageRecords(records);
      return insertNormalizedUsageRecords(normalized);
    });
  }

  function readCostRecalculationRows(options = {}) {
    return db.prepare(`
      SELECT id, provider, model, input_tokens, output_tokens, cache_read_input_tokens,
        cache_creation_input_tokens, reasoning_output_tokens, cost_usd
      FROM model_usage_records
      WHERE id > ? AND id <= ?
        ${options.onlyZeroCost ? 'AND cost_usd = 0' : ''}
      ORDER BY id
      LIMIT ?
    `).all(options.afterId, options.throughId, options.batchSize) || [];
  }

  function buildCostChanges(rows, pricingByModel) {
    const changes = [];
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
      if (Math.abs((Number(row.cost_usd) || 0) - cost) <= 1e-12) return;
      changes.push({ id: row.id, cost });
    });
    return changes;
  }

  function applyCostChanges(changes) {
    const stmt = db.prepare('UPDATE model_usage_records SET cost_usd = ? WHERE id = ?');
    changes.forEach((change) => stmt.run(change.cost, change.id));
  }

  function recalculatePricingMaintenanceBatch(options = {}) {
    const expectedSource = String(options.expectedSource || '').trim();
    const expectedEpoch = toSafeInteger(options.expectedEpoch);
    const batchSize = Math.max(1, Math.min(
      MAX_COST_RECALCULATION_BATCH_SIZE,
      toSafeInteger(options.batchSize) || DEFAULT_COST_RECALCULATION_BATCH_SIZE
    ));
    db.exec('BEGIN IMMEDIATE');
    try {
      const activeCatalog = getActivePricingCatalog();
      if (
        String(activeCatalog && activeCatalog.source || '').trim() !== expectedSource
        || toSafeInteger(activeCatalog && activeCatalog.epoch) !== expectedEpoch
      ) {
        db.exec('ROLLBACK');
        return {
          stale: true,
          reason: PRICING_CATALOG_STALE_EPOCH,
          activeCatalog: getActivePricingCatalog(),
          maintenance: getPricingMaintenanceState()
        };
      }

      const state = getPricingMaintenanceState();
      if (
        !state
        || String(state.source || '').trim() !== expectedSource
        || toSafeInteger(state.catalogEpoch) !== expectedEpoch
      ) {
        db.exec('ROLLBACK');
        return {
          stale: true,
          reason: PRICING_CATALOG_STALE_EPOCH,
          activeCatalog: getActivePricingCatalog(),
          maintenance: getPricingMaintenanceState()
        };
      }
      if (state.status === 'completed') {
        db.exec('COMMIT');
        return {
          stale: false,
          state,
          scanned: 0,
          updated: 0,
          cursorId: toSafeInteger(state.cursorId),
          done: true
        };
      }

      const afterId = toSafeInteger(state.cursorId);
      const throughId = toSafeInteger(state.targetMaxId);
      const pricingByModel = getAllPricing({ source: expectedSource });
      const rows = readCostRecalculationRows({
        afterId,
        throughId,
        batchSize,
        onlyZeroCost: false
      });
      const changes = buildCostChanges(rows, pricingByModel);
      const cursorId = rows.length > 0
        ? toSafeInteger(rows[rows.length - 1].id)
        : Math.max(afterId, throughId);
      const done = cursorId >= throughId;
      const now = Date.now();
      const nextState = {
        ...state,
        status: done ? 'completed' : 'pending',
        cursorId,
        scanned: toSafeInteger(state.scanned) + rows.length,
        recalculated: toSafeInteger(state.recalculated) + changes.length,
        batches: toSafeInteger(state.batches) + (rows.length > 0 ? 1 : 0),
        updatedAtMs: now,
        completedAtMs: done ? now : 0
      };
      applyCostChanges(changes);
      writeJsonState(PRICING_MAINTENANCE_STATE_KEY, nextState, now);
      db.exec('COMMIT');
      return {
        stale: false,
        state: nextState,
        scanned: rows.length,
        updated: changes.length,
        cursorId,
        done
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
  }

  function insertUsage(record) {
    return insertUsageBatch([record]);
  }

  function normalizeSessionRecords(records = []) {
    return (Array.isArray(records) ? records : [])
      .map(normalizeSessionRecord)
      .filter(Boolean);
  }

  function upsertNormalizedSessions(normalized = []) {
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
    return normalized.length;
  }

  function replaceNormalizedSessions(normalized = []) {
    if (normalized.length === 0) return 0;
    const stmt = db.prepare(`
      INSERT INTO model_usage_sessions (
        provider, session_id, project, cwd, git_branch, started_at_ms, updated_at_ms, prompt_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, session_id) DO UPDATE SET
        project = excluded.project,
        cwd = excluded.cwd,
        git_branch = excluded.git_branch,
        started_at_ms = excluded.started_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        prompt_count = excluded.prompt_count
    `);
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
    return normalized.length;
  }

  function upsertSessions(records = []) {
    const normalized = normalizeSessionRecords(records);
    if (normalized.length === 0) return 0;
    return runInImmediateTransaction(() => upsertNormalizedSessions(normalized));
  }

  function normalizePromptEvents(records = []) {
    return (Array.isArray(records) ? records : [])
      .map(normalizePromptEvent)
      .filter(Boolean);
  }

  function insertNormalizedPromptEvents(normalized = []) {
    if (normalized.length === 0) return 0;
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO model_usage_prompt_events (
        event_key, provider, session_id, timestamp_ms
      ) VALUES (?, ?, ?, ?)
    `);
    let inserted = 0;
    normalized.forEach((record) => {
      const result = stmt.run(record.eventKey, record.provider, record.sessionId, record.timestampMs);
      if (Number(result && result.changes) > 0) inserted += 1;
    });
    return inserted;
  }

  function insertPromptEvents(records = []) {
    const normalized = normalizePromptEvents(records);
    if (normalized.length === 0) return 0;
    return runInImmediateTransaction(() => insertNormalizedPromptEvents(normalized));
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

  function normalizeFileState(filePath, state = {}) {
    const scanContext = state.scanContext && typeof state.scanContext === 'object'
      ? JSON.stringify(state.scanContext)
      : '';
    return {
      filePath: String(filePath || '').trim(),
      size: toSafeInteger(state.size),
      offset: toSafeInteger(state.offset),
      scanContext
    };
  }

  function writeFileState(state) {
    db.prepare(`
      INSERT INTO model_usage_file_state(path, size, offset, scan_context)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        size = excluded.size,
        offset = excluded.offset,
        scan_context = excluded.scan_context
    `).run(
      state.filePath,
      state.size,
      state.offset,
      state.scanContext
    );
  }

  function setFileState(filePath, state = {}) {
    writeFileState(normalizeFileState(filePath, state));
  }

  function replaceFileProjection(input = {}) {
    const provider = String(input.provider || '').trim().toLowerCase();
    const sourceHash = String(input.sourceHash || '').trim();
    const filePath = String(input.filePath || '').trim();
    if (
      provider !== 'codex'
      || !/^[0-9a-f]{16}$/.test(sourceHash)
      || !filePath
      || sourceHash !== stableHash(filePath)
    ) {
      throw new Error('model_usage_file_projection_scope_invalid');
    }

    const eventPrefix = `${provider}:file:${sourceHash}:`;
    const deleteUsage = db.prepare(`
      DELETE FROM model_usage_records
      WHERE provider = ? AND event_key GLOB ?
    `);
    const deletePrompts = db.prepare(`
      DELETE FROM model_usage_prompt_events
      WHERE provider = ? AND event_key GLOB ?
    `);
    return runInImmediateTransaction(() => {
      const usageRecords = normalizeUsageRecords(input.usageRecords);
      const promptEvents = normalizePromptEvents(input.promptEvents);
      const sessionRecords = normalizeSessionRecords(input.sessionRecords);
      const fileState = normalizeFileState(filePath, input.fileState);
      const usageInScope = usageRecords.every((record) => (
        record.provider === provider
        && record.eventKey.startsWith(eventPrefix)
        && record.eventKey.endsWith(':usage')
      ));
      const promptsInScope = promptEvents.every((record) => (
        record.provider === provider
        && record.eventKey.startsWith(eventPrefix)
        && record.eventKey.endsWith(':prompt')
      ));
      const sessionsInScope = sessionRecords.every((record) => record.provider === provider);
      if (!usageInScope || !promptsInScope || !sessionsInScope) {
        throw new Error('model_usage_file_projection_scope_invalid');
      }
      const usageDeleted = Number(deleteUsage.run(
        provider,
        `${eventPrefix}*:usage`
      ).changes) || 0;
      const promptsDeleted = Number(deletePrompts.run(
        provider,
        `${eventPrefix}*:prompt`
      ).changes) || 0;
      const records = insertNormalizedUsageRecords(usageRecords);
      const prompts = insertNormalizedPromptEvents(promptEvents);
      const sessions = replaceNormalizedSessions(sessionRecords);
      writeFileState(fileState);
      return { usageDeleted, promptsDeleted, records, prompts, sessions };
    });
  }

  function buildReadProjection(query = {}) {
    const normalized = normalizeQuery(query);
    return {
      normalized,
      ...createCanonicalReadProjection(db, normalized, {
        getPricingByModel: getAllPricing
      })
    };
  }

  function queryStatsFromProjection(projection, query = projection.normalized) {
    const usageFilter = buildProjectedWhereClause(query, { tableAlias: 'u' });
    const row = db.prepare(`
      WITH ${projection.ctes}
      SELECT
        COUNT(*) AS total_calls,
        COUNT(DISTINCT CASE WHEN u.session_id != '' THEN u.provider || ':' || u.session_id END) AS total_sessions,
        COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(u.cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(u.cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(u.reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(u.cost_usd), 0) AS total_cost_usd
      FROM canonical_usage u
      WHERE ${usageFilter.where}
    `).get(...projection.args, ...usageFilter.args) || {};
    const promptFilter = buildProjectedWhereClause(query, {
      tableAlias: 'p',
      includeModel: false
    });
    const promptRow = db.prepare(`
      WITH ${projection.ctes}
      SELECT COUNT(*) AS total_prompts
      FROM canonical_prompt_events p
      WHERE ${promptFilter.where}
    `).get(...projection.args, ...promptFilter.args) || {};
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

  function queryStats(query = {}) {
    return queryStatsFromProjection(buildReadProjection(query));
  }

  function queryCostByModelFromProjection(projection, query = projection.normalized) {
    const filter = buildProjectedWhereClause(query, { tableAlias: 'u' });
    return (db.prepare(`
      WITH ${projection.ctes}
      SELECT
        u.provider,
        u.model,
        COUNT(*) AS calls,
        COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(u.cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(u.cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(u.reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(u.cost_usd), 0) AS cost_usd
      FROM canonical_usage u
      WHERE ${filter.where}
      GROUP BY u.provider, u.model
      ORDER BY cost_usd DESC, total_tokens DESC, calls DESC, u.model
    `).all(...projection.args, ...filter.args) || []).map((row) => ({
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

  function queryCostByModel(query = {}) {
    return queryCostByModelFromProjection(buildReadProjection(query));
  }

  function querySessionsFromProjection(projection, query = projection.normalized) {
    const filter = buildProjectedWhereClause(query, { tableAlias: 'r' });
    const normalized = normalizeQuery(query);
    const rows = db.prepare(`
      WITH ${projection.ctes}
      SELECT
        r.provider,
        r.session_id,
        COALESCE(NULLIF(MAX(r.project), ''), NULLIF(MAX(s.project), ''), '') AS project,
        COALESCE(NULLIF(MAX(r.cwd), ''), NULLIF(MAX(s.cwd), ''), '') AS cwd,
        COALESCE(NULLIF(MAX(r.git_branch), ''), NULLIF(MAX(s.git_branch), ''), '') AS git_branch,
        COALESCE(NULLIF(MIN(s.started_at_ms), 0), MIN(r.timestamp_ms)) AS started_at_ms,
        MAX(COALESCE(NULLIF(s.updated_at_ms, 0), r.timestamp_ms)) AS updated_at_ms,
        COUNT(*) AS calls,
        COALESCE(SUM(r.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(r.cost_usd), 0) AS cost_usd
      FROM canonical_usage r
      LEFT JOIN model_usage_sessions s
        ON s.provider = r.provider AND s.session_id = r.session_id
      WHERE ${filter.where} AND r.session_id != ''
      GROUP BY r.provider, r.session_id
      ORDER BY updated_at_ms DESC, r.provider, r.session_id
      LIMIT ?
    `).all(...projection.args, ...filter.args, normalized.limit) || [];
    const promptFilter = buildProjectedWhereClause(query, {
      tableAlias: 'p',
      includeModel: false
    });
    const promptCounts = new Map((db.prepare(`
      WITH ${projection.ctes}
      SELECT p.provider, p.session_id, COUNT(*) AS prompt_count
      FROM canonical_prompt_events p
      WHERE ${promptFilter.where} AND p.session_id != ''
      GROUP BY p.provider, p.session_id
    `).all(...projection.args, ...promptFilter.args) || []).map((row) => [
      `${row.provider}\0${row.session_id}`,
      Number(row.prompt_count) || 0
    ]));
    return rows.map((row) => ({
      provider: row.provider,
      sessionId: row.session_id,
      project: row.project || '',
      cwd: row.cwd || '',
      gitBranch: row.git_branch || '',
      startedAtMs: Number(row.started_at_ms) || 0,
      updatedAtMs: Number(row.updated_at_ms) || 0,
      promptCount: promptCounts.get(`${row.provider}\0${row.session_id}`) || 0,
      calls: Number(row.calls) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      costUsd: Number(row.cost_usd) || 0
    }));
  }

  function querySessions(query = {}) {
    return querySessionsFromProjection(buildReadProjection(query));
  }

  function queryDashboard(query = {}) {
    const projection = buildReadProjection(query);
    const stats = queryStatsFromProjection(projection);
    const models = queryCostByModelFromProjection(projection);
    const sessions = querySessionsFromProjection(projection);
    const modelOptions = projection.normalized.model
      ? queryCostByModelFromProjection(projection, {
        ...projection.normalized,
        model: ''
      })
      : models;
    return { stats, models, sessions, modelOptions };
  }

  function querySessionDetail(query = {}) {
    const projection = buildReadProjection(query);
    const filter = buildProjectedWhereClause(projection.normalized, {
      tableAlias: 'u',
      includeSession: true
    });
    return (db.prepare(`
      WITH ${projection.ctes}
      SELECT
        u.provider,
        u.session_id,
        u.model,
        COUNT(*) AS calls,
        COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(u.cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(u.cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(u.reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(u.cost_usd), 0) AS cost_usd
      FROM canonical_usage u
      WHERE ${filter.where}
      GROUP BY u.provider, u.session_id, u.model
      ORDER BY cost_usd DESC, total_tokens DESC, u.model
    `).all(...projection.args, ...filter.args) || []).map((row) => ({
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

  // 某会话最近一次实际使用的模型（用于 /chat 打开已存在会话时的默认值，跟随 server）。
  function getLastSessionModel(provider, sessionId) {
    const p = String(provider || '').trim().toLowerCase();
    const sid = String(sessionId || '').trim();
    if (!p || !sid) return '';
    try {
      const row = db.prepare(`
        SELECT model FROM model_usage_records
        WHERE provider = ? AND session_id = ? AND model != ''
        ORDER BY timestamp_ms DESC
        LIMIT 1
      `).get(p, sid);
      return row && row.model ? String(row.model) : '';
    } catch (_error) {
      return '';
    }
  }

  function getNativeSessionModelTimeline(provider, sessionId) {
    const p = String(provider || '').trim().toLowerCase();
    const sid = String(sessionId || '').trim();
    if (!p || !sid) return [];
    try {
      return db.prepare(`
        SELECT model, timestamp_ms
        FROM model_usage_records
        WHERE provider = ? AND session_id = ?
          AND source_kind = 'native_session_done'
          AND model != ''
        ORDER BY timestamp_ms ASC, id ASC
      `).all(p, sid).map((row) => ({
        model: String(row.model || ''),
        timestampMs: Number(row.timestamp_ms) || 0
      }));
    } catch (_error) {
      return [];
    }
  }

  return {
    close,
    db,
    getActivePricingCatalog,
    getAllPricing,
    getPricingMaintenanceState,
    activatePricingCatalog,
    upsertPricing,
    recalculatePricingMaintenanceBatch,
    insertUsage,
    insertUsageBatch,
    upsertSessions,
    insertPromptEvents,
    getFileState,
    setFileState,
    replaceFileProjection,
    queryStats,
    queryDashboard,
    queryCostByModel,
    querySessions,
    querySessionDetail,
    getLastSessionModel,
    getNativeSessionModelTimeline
  };
}

module.exports = {
  DEFAULT_COST_RECALCULATION_BATCH_SIZE,
  MODEL_USAGE_DB_FILE,
  PRICING_ACTIVE_CATALOG_STATE_KEY,
  PRICING_CATALOG_STALE_EPOCH,
  PRICING_MAINTENANCE_STATE_KEY,
  canUseModelUsageDatabase,
  getModelUsageDbPath,
  openModelUsageStore,
  normalizeUsageRecord,
  normalizeSessionRecord,
  normalizePromptEvent,
  normalizeQuery,
  __private: {
    assertUsageAccountRefSchema,
    buildProjectedWhereClause,
    ensureSchema,
    toSafeInteger,
    toTimestampMs
  }
};
