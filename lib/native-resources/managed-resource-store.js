'use strict';

const fs = require('node:fs');
const { openAppStateDatabase } = require('../server/app-state-store');
const KEY = 'native-resources.managed.v1';
const { decodeManagedState, validateManagedState, MAX_BYTES } = require('./managed-state-codec');

function createManagedResourceStore({ aiHomeDir }) {
  if (!aiHomeDir) throw new Error('managed_resource_home_required');
  function get() {
    const db = openAppStateDatabase(fs, aiHomeDir, { createIfMissing: false });
    if (!db) return decodeManagedState('', false);
    try { const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(KEY); return decodeManagedState(row?.value || '', Boolean(row)); }
    finally { db.close(); }
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
      const current = decodeManagedState(row?.value || '', Boolean(row));
      const previous = JSON.stringify(current);
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('managed_resource_revision_exhausted');
      const result = mutator(current);
      validateManagedState(current);
      if (JSON.stringify(current) !== previous) {
        if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('managed_resource_revision_exhausted');
        current.revision += 1;
        if (Buffer.byteLength(JSON.stringify(current), 'utf8') > MAX_BYTES) throw new Error('managed_resource_state_too_large');
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
