'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  openAppStateDatabase,
  readJsonValue,
} = require('../../server/app-state-store');
const { PluginError, requireCondition } = require('../sdk/errors');

const PLUGIN_STATE_KEY = 'plugins.control.v1';
const EMPTY_STATE = Object.freeze({ schemaVersion: 1, revision: 0, installed: [], instances: [], generations: [], activeGeneration: 0 });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    schemaVersion: 1,
    revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    installed: Array.isArray(source.installed) ? source.installed : [],
    instances: Array.isArray(source.instances) ? source.instances : [],
    generations: Array.isArray(source.generations) ? source.generations : [],
    activeGeneration: Number.isSafeInteger(source.activeGeneration) && source.activeGeneration >= 0 ? source.activeGeneration : 0,
  };
}

function createPluginStateStore(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const pathImpl = options.path || path;
  const databaseOptions = options.databaseOptions || {};
  const open = options.openDatabase || ((...args) => openAppStateDatabase(...args));
  const read = options.readValue || ((...args) => readJsonValue(...args));

  function get() {
    return normalizeState(read(fsImpl, aiHomeDir, PLUGIN_STATE_KEY, { ...databaseOptions, bestEffort: false }));
  }

  function update(mutator, expectedRevision) {
    requireCondition(typeof mutator === 'function', 'plugin_state_mutator_invalid');
    let db = null;
    try {
      db = open(fsImpl, aiHomeDir, databaseOptions);
      if (!db) throw new PluginError('plugin_state_unavailable');
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(PLUGIN_STATE_KEY);
      const current = normalizeState(row ? JSON.parse(String(row.value)) : EMPTY_STATE);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        db.exec('ROLLBACK');
        throw new PluginError('plugin_revision_conflict');
      }
      const next = normalizeState(mutator(clone(current)) || current);
      next.revision = current.revision + 1;
      db.prepare(`
        INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(PLUGIN_STATE_KEY, JSON.stringify(next), Date.now());
      db.exec('COMMIT');
      return clone(next);
    } catch (error) {
      try { if (db) db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    } finally {
      try { if (db) db.close(); } catch (_error) {}
    }
  }

  return {
    aiHomeDir,
    path: pathImpl,
    get,
    update,
    key: PLUGIN_STATE_KEY,
  };
}

module.exports = { EMPTY_STATE, PLUGIN_STATE_KEY, createPluginStateStore, normalizeState };
