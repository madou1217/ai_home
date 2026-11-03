'use strict';

const fs = require('node:fs');
const { openAppStateDatabase, readJsonValue } = require('../server/app-state-store');
const KEY = 'native-resources.managed.v1';
const empty = () => ({ schemaVersion: 1, revision: 0, resources: [] });

function createManagedResourceStore({ aiHomeDir }) {
  if (!aiHomeDir) throw new Error('managed_resource_home_required');
  function get() {
    return readJsonValue(fs, aiHomeDir, KEY, { strict: true }) || empty();
  }
  // Serialize projection changes with the corresponding desired state. A failed
  // filesystem write leaves the old desired state. SQLite and the filesystem
  // are not one crash-atomic transaction; existing records enable drift detection.
  function update(mutator) {
    const db = openAppStateDatabase(fs, aiHomeDir);
    if (!db) throw new Error('managed_resource_store_unavailable');
    try {
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(KEY);
      const current = row ? JSON.parse(row.value) : empty();
      const previous = JSON.stringify(current);
      const result = mutator(current);
      if (JSON.stringify(current) !== previous) {
        current.revision += 1;
        db.prepare('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .run(KEY, JSON.stringify(current), Date.now());
      }
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { db.close(); }
  }
  return { get, update };
}
module.exports = { createManagedResourceStore };
