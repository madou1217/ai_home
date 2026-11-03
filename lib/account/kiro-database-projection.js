'use strict';

const os = require('node:os');
const { readKiroTokenFromDatabase } = require('./kiro-auth-metadata');
const { kiroTokenBinding } = require('./kiro-identity');

// The database also holds conversations/settings, so credential projection must
// merge auth_kv in place. The last applied grant binding lets another CLI/GUI
// launch preserve a token refreshed by an already running native process.
function materializeKiroDatabase(fs, path, databasePath, nativeAuth, writeInitialDatabase) {
  const { DatabaseSync } = require('node:sqlite');
  const binding = kiroTokenBinding(nativeAuth.auth);
  const bindingPath = path.join(path.dirname(databasePath), '.aih-kiro-auth-binding');
  let existing;
  try { existing = fs.lstatSync(databasePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('kiro_database_path_not_private');
  }
  if (existing && binding) {
    let applied = '';
    try { applied = fs.readFileSync(bindingPath, 'utf8').trim(); } catch (_) {}
    const token = readKiroTokenFromDatabase(databasePath);
    if (applied === binding && (token?.access_token || token?.accessToken)) return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-materialize-'));
  let source = null;
  let target = null;
  try {
    const sourcePath = path.join(tempDir, 'data.sqlite3');
    fs.writeFileSync(sourcePath, Buffer.from(nativeAuth.database, 'base64'), { mode: 0o600 });
    source = new DatabaseSync(sourcePath, { readOnly: true });
    const rows = source.prepare('SELECT key, value FROM auth_kv').all();
    const sourceToken = readKiroTokenFromDatabase(sourcePath);
    if (!sourceToken?.access_token && !sourceToken?.accessToken) throw new Error('kiro_snapshot_missing_access_token');
    if (!existing) {
      writeInitialDatabase();
    } else {
      target = new DatabaseSync(databasePath);
      target.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      target.exec('DELETE FROM auth_kv');
      const insert = target.prepare('INSERT INTO auth_kv(key, value) VALUES(?, ?)');
      for (const row of rows) insert.run(row.key, row.value);
      target.exec('COMMIT');
    }
    if (binding) fs.writeFileSync(bindingPath, binding + '\n', { mode: 0o600 });
  } catch (error) {
    try { target?.exec('ROLLBACK'); } catch (_) {}
    // Never replace a busy, corrupt or unknown live database: the caller must
    // fail closed instead of erasing native sessions to make launch succeed.
    throw new Error('kiro_database_credential_projection_failed', { cause: error });
  } finally {
    try { source?.close(); } catch (_) {}
    try { target?.close(); } catch (_) {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { materializeKiroDatabase };
