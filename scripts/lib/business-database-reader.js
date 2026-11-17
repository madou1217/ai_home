'use strict';

const { resolveAiHomeDir } = require('../../lib/runtime/aih-home');
const { getBusinessDatabasePath } = require('../../lib/server/business-database');

function resolveBusinessDatabasePath(options = {}) {
  return getBusinessDatabasePath(resolveAiHomeDir(options));
}

function openBusinessDatabase(options = {}) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(resolveBusinessDatabasePath(options), { readOnly: true });
}

function readManagementKey(options = {}) {
  const db = openBusinessDatabase(options);
  try {
    const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get('config:server');
    if (!row) throw new Error('business_database_server_config_missing');
    let config;
    try {
      config = JSON.parse(row.value);
    } catch (_error) {
      throw new Error('business_database_server_config_invalid');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('business_database_server_config_invalid');
    }
    const key = config.managementKey || config.management_key;
    if (typeof key !== 'string' || !key.trim()) throw new Error('business_database_management_key_missing');
    return key.trim();
  } finally {
    db.close();
  }
}

module.exports = { resolveBusinessDatabasePath, openBusinessDatabase, readManagementKey };
