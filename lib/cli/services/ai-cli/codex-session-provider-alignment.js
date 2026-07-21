'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AIH_CODEX_PROVIDER_KEY } = require('./codex-provider-args');

const SESSION_META_READ_LIMIT = 16 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;

function getDatabaseSyncCtor(deps = {}) {
  if (Object.prototype.hasOwnProperty.call(deps, 'DatabaseSync')) return deps.DatabaseSync;
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function isLegacyAihProvider(value, canonicalProvider = AIH_CODEX_PROVIDER_KEY) {
  const provider = String(value || '').trim();
  const canonical = String(canonicalProvider || '').trim();
  return Boolean(provider && provider !== canonical && (provider === 'aih' || provider.startsWith('aih_')));
}

function listCodexStateDbPaths(fsImpl, pathImpl, codexHome) {
  const roots = [codexHome, pathImpl.join(codexHome, 'sqlite')];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    try {
      if (!fsImpl.existsSync(root) || !fsImpl.statSync(root).isDirectory()) continue;
      for (const name of fsImpl.readdirSync(root)) {
        if (!/^state_\d+\.sqlite$/i.test(name)) continue;
        const dbPath = pathImpl.join(root, name);
        const identity = typeof fsImpl.realpathSync === 'function' ? fsImpl.realpathSync(dbPath) : dbPath;
        if (seen.has(identity)) continue;
        seen.add(identity);
        out.push(dbPath);
      }
    } catch (_error) {}
  }
  return out.sort();
}

function listSessionFiles(fsImpl, pathImpl, sessionsRoot) {
  const out = [];
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fsImpl.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const entryPath = pathImpl.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(entryPath);
    }
  }
  return out.sort();
}

function readFirstLine(fsImpl, filePath, maxBytes = SESSION_META_READ_LIMIT) {
  const fd = fsImpl.openSync(filePath, 'r');
  const chunks = [];
  let position = 0;
  try {
    while (position < maxBytes) {
      const size = Math.min(64 * 1024, maxBytes - position);
      const buffer = Buffer.allocUnsafe(size);
      const bytesRead = fsImpl.readSync(fd, buffer, 0, size, position);
      if (bytesRead <= 0) break;
      const view = buffer.subarray(0, bytesRead);
      const newlineIndex = view.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(view.subarray(0, newlineIndex));
        return {
          text: Buffer.concat(chunks).toString('utf8').replace(/\r$/, ''),
          nextOffset: position + newlineIndex + 1,
          hasNewline: true
        };
      }
      chunks.push(view);
      position += bytesRead;
    }
    const stat = fsImpl.fstatSync(fd);
    if (Number(stat.size) > position) throw new Error('session_meta_line_too_large');
    return {
      text: Buffer.concat(chunks).toString('utf8').replace(/\r$/, ''),
      nextOffset: position,
      hasNewline: false
    };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function readSessionMetaProvider(fsImpl, filePath) {
  try {
    const firstLine = readFirstLine(fsImpl, filePath);
    const parsed = JSON.parse(firstLine.text.replace(/^\uFEFF/, ''));
    const payload = parsed && parsed.type === 'session_meta' && parsed.payload;
    return {
      ok: true,
      firstLine,
      parsed,
      provider: String(payload && payload.model_provider || '').trim()
    };
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.message) || error || 'invalid_session_meta')
    };
  }
}

function writeAll(fsImpl, fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += fsImpl.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function rewriteSessionMetaProvider(fsImpl, filePath, canonicalProvider) {
  const current = readSessionMetaProvider(fsImpl, filePath);
  if (!current.ok || !isLegacyAihProvider(current.provider, canonicalProvider)) return false;
  const next = {
    ...current.parsed,
    payload: {
      ...current.parsed.payload,
      model_provider: canonicalProvider
    }
  };
  const stat = fsImpl.statSync(filePath);
  const tempPath = `${filePath}.aih-provider-align-${process.pid}-${Date.now()}.tmp`;
  let sourceFd = null;
  let targetFd = null;
  try {
    sourceFd = fsImpl.openSync(filePath, 'r');
    targetFd = fsImpl.openSync(tempPath, 'wx', stat.mode & 0o777);
    writeAll(fsImpl, targetFd, Buffer.from(`${JSON.stringify(next)}\n`, 'utf8'));
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = current.firstLine.nextOffset;
    while (position < stat.size) {
      const bytesRead = fsImpl.readSync(
        sourceFd,
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position
      );
      if (bytesRead <= 0) break;
      writeAll(fsImpl, targetFd, buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    fsImpl.fsyncSync(targetFd);
    fsImpl.closeSync(sourceFd);
    sourceFd = null;
    fsImpl.closeSync(targetFd);
    targetFd = null;
    fsImpl.renameSync(tempPath, filePath);
    fsImpl.chmodSync(filePath, stat.mode & 0o777);
    fsImpl.utimesSync(filePath, stat.atime, stat.mtime);
    return true;
  } catch (error) {
    if (sourceFd !== null) {
      try { fsImpl.closeSync(sourceFd); } catch (_closeError) {}
    }
    if (targetFd !== null) {
      try { fsImpl.closeSync(targetFd); } catch (_closeError) {}
    }
    try { fsImpl.unlinkSync(tempPath); } catch (_unlinkError) {}
    throw error;
  }
}

function inspectDatabase(DatabaseSync, dbPath, canonicalProvider) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = new Set(
      db.prepare('PRAGMA table_info(threads)').all()
        .map((column) => String(column && column.name || '').trim())
    );
    if (!columns.has('model_provider')) return { dbPath, legacy: [], legacyRows: 0 };
    const rows = db.prepare(
      'SELECT model_provider, COUNT(*) AS count FROM threads GROUP BY model_provider ORDER BY model_provider'
    ).all();
    const legacy = rows
      .filter((row) => isLegacyAihProvider(row.model_provider, canonicalProvider))
      .map((row) => ({ provider: String(row.model_provider), count: Number(row.count) || 0 }));
    return {
      dbPath,
      legacy,
      legacyRows: legacy.reduce((sum, item) => sum + item.count, 0)
    };
  } finally {
    db.close();
  }
}

function applyDatabaseAlignment(DatabaseSync, plan, canonicalProvider) {
  if (!plan || plan.legacyRows < 1) return 0;
  const db = new DatabaseSync(plan.dbPath);
  let changed = 0;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    const update = db.prepare('UPDATE threads SET model_provider = ? WHERE model_provider = ?');
    for (const item of plan.legacy) {
      const result = update.run(canonicalProvider, item.provider);
      changed += Number(result && result.changes) || 0;
    }
    db.exec('COMMIT');
    return changed;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  } finally {
    db.close();
  }
}

function alignCodexSessionProviders(codexHome, options = {}) {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const DatabaseSync = getDatabaseSyncCtor(options);
  if (!DatabaseSync) throw new Error('node_sqlite_unavailable');
  const requestedHome = String(codexHome || '').trim();
  if (!requestedHome) throw new Error('codex_home_required');
  const normalizedHome = pathImpl.resolve(requestedHome);
  const canonicalProvider = String(options.canonicalProvider || AIH_CODEX_PROVIDER_KEY).trim();
  const apply = options.apply === true;
  const includeRollouts = options.includeRollouts !== false;

  const databases = listCodexStateDbPaths(fsImpl, pathImpl, normalizedHome)
    .map((dbPath) => inspectDatabase(DatabaseSync, dbPath, canonicalProvider));
  const rolloutPlans = [];
  const rolloutErrors = [];
  if (includeRollouts) {
    const sessionsRoot = pathImpl.join(normalizedHome, 'sessions');
    for (const filePath of listSessionFiles(fsImpl, pathImpl, sessionsRoot)) {
      const metadata = readSessionMetaProvider(fsImpl, filePath);
      if (!metadata.ok) {
        rolloutErrors.push({ filePath, error: metadata.error });
        continue;
      }
      if (!isLegacyAihProvider(metadata.provider, canonicalProvider)) continue;
      const stat = fsImpl.statSync(filePath);
      rolloutPlans.push({ filePath, provider: metadata.provider, bytes: Number(stat.size) || 0 });
    }
  }

  let rolloutFilesChanged = 0;
  let databaseRowsChanged = 0;
  if (apply) {
    for (const item of rolloutPlans) {
      if (rewriteSessionMetaProvider(fsImpl, item.filePath, canonicalProvider)) rolloutFilesChanged += 1;
    }
    for (const plan of databases) {
      databaseRowsChanged += applyDatabaseAlignment(DatabaseSync, plan, canonicalProvider);
    }
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    codexHome: normalizedHome,
    canonicalProvider,
    databases,
    databaseRowsMatched: databases.reduce((sum, item) => sum + item.legacyRows, 0),
    databaseRowsChanged,
    rolloutFilesMatched: rolloutPlans.length,
    rolloutFilesChanged,
    rolloutBytesMatched: rolloutPlans.reduce((sum, item) => sum + item.bytes, 0),
    rolloutProviders: rolloutPlans.reduce((counts, item) => {
      counts[item.provider] = (counts[item.provider] || 0) + 1;
      return counts;
    }, {}),
    rolloutErrors
  };
}

module.exports = {
  AIH_CODEX_PROVIDER_KEY,
  alignCodexSessionProviders,
  isLegacyAihProvider,
  listCodexStateDbPaths,
  readSessionMetaProvider,
  rewriteSessionMetaProvider
};
