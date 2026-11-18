'use strict';

const path = require('node:path');

const BUSINESS_DB_FILE = 'aih.db';

// AIH has exactly one business database. There is no legacy file to migrate,
// gate or fall back to; callers only need the canonical path.
function assertBusinessDatabaseReady(root) {
  if (!String(root || '').trim()) throw new Error('aih_database_root_required');
}

function getBusinessDatabasePath(root) {
  const value = String(root || '').trim();
  if (!value) return '';
  assertBusinessDatabaseReady(value);
  return path.join(value, BUSINESS_DB_FILE);
}

// Kept as a no-op for callers that historically translated the migration gate.
function rethrowMigrationRequired() {}

module.exports = { BUSINESS_DB_FILE, getBusinessDatabasePath, assertBusinessDatabaseReady, rethrowMigrationRequired };
