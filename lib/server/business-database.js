'use strict';

const path = require('node:path');
const fs = require('node:fs');

const BUSINESS_DB_FILE = 'aih.db';
const LEGACY_DB_FILE = 'app-state.db';
const MIGRATION_ID = 'app-state-to-aih-v1';

function rethrowMigrationRequired(error) {
  if (error && error.code === 'aih_database_migration_required') throw error;
}

function migrationRequired() {
  const error = new Error('aih_database_migration_required: run aih-db-unify offline before starting consumers');
  error.code = 'aih_database_migration_required';
  return error;
}

function readReceipt(file, table) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(`SELECT receipt FROM ${table} WHERE migration_id = ?`).get(MIGRATION_ID)?.receipt;
  } finally {
    db.close();
  }
}

// No fallback and no startup migration. Old data is retained, but after cutover
// both the authoritative receipt and the legacy write fence must agree.
function assertBusinessDatabaseReady(root) {
  const legacy = path.join(root, LEGACY_DB_FILE);
  if (!fs.existsSync(legacy)) return;
  try {
    if (!fs.lstatSync(legacy).isFile()) throw migrationRequired();
    const receipt = readReceipt(path.join(root, BUSINESS_DB_FILE), 'aih_storage_migrations');
    if (!receipt || readReceipt(legacy, 'aih_legacy_seal') !== receipt) throw migrationRequired();
  } catch (error) {
    if (error.code === 'aih_database_migration_required') throw error;
    throw migrationRequired();
  }
}

function getBusinessDatabasePath(root) {
  const value = String(root || '').trim();
  if (!value) return '';
  assertBusinessDatabaseReady(value);
  return path.join(value, BUSINESS_DB_FILE);
}

module.exports = { BUSINESS_DB_FILE, getBusinessDatabasePath, assertBusinessDatabaseReady, rethrowMigrationRequired };
