'use strict';

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { parseIdentityObject } = require('./identity-subject');

function readKiroTokenFromDatabase(databasePath, options = {}) {
  const DatabaseSync = options.DatabaseSync || loadDatabaseSync();
  if (!DatabaseSync || !databasePath) return null;
  let database = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database.prepare('SELECT value FROM auth_kv WHERE key = ?').get('kirocli:odic:token');
    const parsed = row && parseIdentityObject(String(row.value || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const accessToken = String(parsed.access_token || parsed.accessToken || '').trim();
    const refreshToken = String(parsed.refresh_token || parsed.refreshToken || '').trim();
    if (!accessToken && !refreshToken) return null;
    return parsed;
  } catch (_error) {
    return null;
  } finally {
    try { database?.close(); } catch (_error) {}
  }
}

function loadDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

// A native Kiro login can commit its token to the WAL while the CLI remains
// alive. Copying data.sqlite3 alone would then save an older credential. VACUUM
// INTO asks SQLite for a consistent snapshot and includes committed WAL pages;
// the temporary file never becomes an AIH credential source.
function readKiroDatabaseSnapshot(databasePath, options = {}) {
  const DatabaseSync = options.DatabaseSync || loadDatabaseSync();
  const fs = options.fs || nodeFs;
  const os = options.os || nodeOs;
  const path = options.path || nodePath;
  if (!DatabaseSync || !databasePath) return null;
  let database = null;
  let tempDir = '';
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-snapshot-'));
    const target = path.join(tempDir, 'data.sqlite3');
    database.prepare('VACUUM INTO ?').run(target);
    const bytes = fs.readFileSync(target);
    return bytes && bytes.length > 0
      ? { database: Buffer.from(bytes).toString('base64'), auth: readKiroTokenFromDatabase(target, options) }
      : null;
  } catch (_error) {
    return null;
  } finally {
    try { database?.close(); } catch (_error) {}
    if (tempDir) {
      try {
        if (typeof fs.rmSync === 'function') fs.rmSync(tempDir, { recursive: true, force: true });
        else fs.rmdirSync(tempDir, { recursive: true });
      } catch (_error) {}
    }
  }
}

module.exports = { readKiroTokenFromDatabase, readKiroDatabaseSnapshot };
