'use strict';

function readKiroTokenFromDatabase(databasePath, options = {}) {
  const DatabaseSync = options.DatabaseSync || loadDatabaseSync();
  if (!DatabaseSync || !databasePath) return null;
  let database = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database.prepare('SELECT value FROM auth_kv WHERE key = ?').get('kirocli:odic:token');
    const parsed = row && JSON.parse(String(row.value || ''));
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

module.exports = { readKiroTokenFromDatabase };
