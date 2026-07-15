'use strict';

const DEFAULT_SCAN_LIMIT = 210;
const DEFAULT_ROW_LIMIT = 200;

function getDatabaseSyncCtor() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function listCodexStateDbPaths(fs, path, codexHome) {
  try {
    if (!codexHome || !fs.existsSync(codexHome)) return [];
    return fs.readdirSync(codexHome)
      .filter((entryName) => /^state_\d+\.sqlite$/i.test(entryName))
      .map((entryName) => path.join(codexHome, entryName))
      .sort((left, right) => {
        const leftVersion = Number((path.basename(left).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
        const rightVersion = Number((path.basename(right).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
        if (leftVersion !== rightVersion) return rightVersion - leftVersion;
        return 0;
      });
  } catch (_error) {
    return [];
  }
}

function getSqliteTableColumns(db, tableName) {
  try {
    return new Set(
      db.prepare(`PRAGMA table_info(${tableName})`).all()
        .map((row) => String(row && row.name || '').trim())
        .filter(Boolean)
    );
  } catch (_error) {
    return new Set();
  }
}

function buildThreadQuery(columns, options = {}) {
  if (!columns.has('id') || !columns.has('rollout_path')) return '';
  const whereParts = ['rollout_path IS NOT NULL', "rollout_path <> ''"];
  if (columns.has('archived')) whereParts.push('COALESCE(archived, 0) = 0');
  if (columns.has('cwd') && String(options.cwd || '').trim()) whereParts.push('cwd = ?');
  if (columns.has('source') && !options.includeNonInteractive) whereParts.push("source IN ('cli', 'vscode')");
  const titleExpr = columns.has('title') ? 'title' : "''";
  const firstUserExpr = columns.has('first_user_message') ? 'first_user_message' : "''";
  whereParts.push(`(COALESCE(${firstUserExpr}, '') <> '' OR COALESCE(${titleExpr}, '') <> '')`);

  const updatedExpr = columns.has('updated_at_ms') && columns.has('updated_at')
    ? 'COALESCE(updated_at_ms, updated_at * 1000)'
    : columns.has('updated_at_ms')
      ? 'updated_at_ms'
      : columns.has('updated_at')
        ? 'updated_at * 1000'
        : '0';
  const createdExpr = columns.has('created_at_ms') && columns.has('created_at')
    ? 'COALESCE(created_at_ms, created_at * 1000)'
    : columns.has('created_at_ms')
      ? 'created_at_ms'
      : columns.has('created_at')
        ? 'created_at * 1000'
        : '0';
  const cwdExpr = columns.has('cwd') ? 'cwd' : "''";
  const modelProviderExpr = columns.has('model_provider') ? 'model_provider' : "''";
  const sourceExpr = columns.has('source') ? 'source' : "''";

  return `
    SELECT id, rollout_path, ${titleExpr} AS title, ${firstUserExpr} AS first_user_message,
      ${updatedExpr} AS updated_at_ms, ${createdExpr} AS created_at_ms,
      ${cwdExpr} AS cwd, ${modelProviderExpr} AS model_provider, ${sourceExpr} AS source
    FROM threads
    WHERE ${whereParts.join(' AND ')}
    ORDER BY ${updatedExpr} DESC, id DESC
    LIMIT ?
  `;
}

function readCandidateThreads(fs, path, codexHome, options = {}) {
  const DatabaseSync = options.DatabaseSync || getDatabaseSyncCtor();
  if (!DatabaseSync) return [];
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_ROW_LIMIT, DEFAULT_ROW_LIMIT));
  const rows = [];
  const seen = new Set();
  for (const stateDbPath of listCodexStateDbPaths(fs, path, codexHome)) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath, { readOnly: true });
      if (typeof db.exec === 'function') db.exec('PRAGMA query_only = ON;');
      const query = buildThreadQuery(getSqliteTableColumns(db, 'threads'), options);
      if (!query) continue;
      const params = [];
      if (String(options.cwd || '').trim()) params.push(String(options.cwd).trim());
      params.push(limit);
      for (const row of db.prepare(query).all(...params)) {
        const id = String(row && row.id || '').trim();
        const rolloutPath = String(row && row.rollout_path || '').trim();
        if (!id || !rolloutPath || seen.has(id)) continue;
        seen.add(id);
        rows.push({
          id,
          rolloutPath,
          title: String(row && row.title || '').trim(),
          firstUserMessage: String(row && row.first_user_message || '').trim(),
          updatedAtMs: Number(row && row.updated_at_ms) || 0,
          createdAtMs: Number(row && row.created_at_ms) || 0,
          cwd: String(row && row.cwd || '').trim(),
          modelProvider: String(row && row.model_provider || '').trim(),
          source: String(row && row.source || '').trim(),
          stateDbPath
        });
        if (rows.length >= limit) return rows;
      }
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }
  return rows;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_error) {
    return null;
  }
}

function isUserMessageEventLine(line) {
  const parsed = parseJsonLine(line);
  return Boolean(
    parsed
    && parsed.type === 'event_msg'
    && parsed.payload
    && parsed.payload.type === 'user_message'
    && typeof parsed.payload.message === 'string'
    && parsed.payload.message.trim()
  );
}

function hasEarlyUserMessageEvent(text, scanLimit = DEFAULT_SCAN_LIMIT) {
  const lines = String(text || '').split(/\r?\n/);
  let scanned = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    scanned += 1;
    if (isUserMessageEventLine(trimmed)) return true;
    if (scanned >= scanLimit) return false;
  }
  return false;
}

function repairCodexSessionVisibility(codexHome, options = {}) {
  const fs = options.fs || require('node:fs');
  const path = options.path || require('node:path');
  const normalizedHome = String(codexHome || '').trim();
  const result = {
    ok: true,
    scanned: 0,
    indexAdded: 0,
    rolloutPatched: 0,
    providerAligned: 0,
    reason: 'read_only_diagnostic'
  };
  if (!normalizedHome || !fs.existsSync(normalizedHome)) return result;

  const threads = readCandidateThreads(fs, path, normalizedHome, options);
  result.scanned = threads.length;
  if (threads.length === 0) return result;

  return result;
}

module.exports = {
  DEFAULT_SCAN_LIMIT,
  hasEarlyUserMessageEvent,
  readCandidateThreads,
  repairCodexSessionVisibility
};
