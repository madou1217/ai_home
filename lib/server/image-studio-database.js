'use strict';

const { openAppStateDatabase } = require('./app-state-store');

const IMAGE_STUDIO_SCHEMA = `
  CREATE TABLE IF NOT EXISTS image_studio_sessions (
    session_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS image_studio_assets (
    asset_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES image_studio_sessions(session_id) ON DELETE CASCADE,
    content BLOB NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_image_studio_sessions_updated
    ON image_studio_sessions(updated_at DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_image_studio_assets_session
    ON image_studio_assets(session_id, created_at);
`;

function createImageStudioDatabase(options = {}) {
  const fs = options.fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const databaseOptions = options.DatabaseSync === undefined
    ? {}
    : { DatabaseSync: options.DatabaseSync };

  function openDatabase() {
    const db = openAppStateDatabase(fs, aiHomeDir, databaseOptions);
    if (!db) throw new Error('image_studio_database_unavailable');
    try {
      db.exec(IMAGE_STUDIO_SCHEMA);
      return db;
    } catch (error) {
      try { db.close(); } catch (_closeError) {}
      throw error;
    }
  }

  function withConnection(operation) {
    const db = openDatabase();
    try {
      return operation(db);
    } finally {
      try { db.close(); } catch (_closeError) {}
    }
  }

  function withTransaction(operation) {
    return withConnection((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = operation(db);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
        throw error;
      }
    });
  }

  withConnection(() => undefined);

  return {
    withConnection,
    withTransaction
  };
}

module.exports = {
  IMAGE_STUDIO_SCHEMA,
  createImageStudioDatabase
};
