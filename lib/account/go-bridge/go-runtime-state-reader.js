'use strict';

// 只读读取 Go 的账号运行态文档（aih.db 的 account_runtime_states）。
//
// Node 的选号热路径按候选账号逐个取运行态；每次开库不现实，所以这里保持一个
// 进程内只读连接 + 短 TTL 快照。TTL 只影响跨进程可见性（CLI 直写已经改走服务端），
// 本进程自己的写入由 go-runtime-state-store 的内存层即时覆盖。

const nodePath = require('node:path');

const DEFAULT_TTL_MS = 1000;
const TABLE_NAME = 'account_runtime_states';

function parseState(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_error) {
    return null;
  }
}

function createGoRuntimeStateReader(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const fs = options.fs || require('node:fs');
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const DatabaseSync = options.DatabaseSync || (() => {
    try {
      return require('node:sqlite').DatabaseSync;
    } catch (_error) {
      return null;
    }
  })();

  let db = null;
  let opened = false;
  let snapshotAt = 0;
  let byRef = new Map();

  function openDatabase() {
    if (opened) return db;
    opened = true;
    if (!aiHomeDir || !DatabaseSync) return null;
    const file = nodePath.join(aiHomeDir, 'aih.db');
    try {
      if (!fs.existsSync(file)) return null;
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 2000');
      db.exec('PRAGMA query_only = ON');
      const table = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(TABLE_NAME);
      if (!table) {
        db.close();
        db = null;
      }
    } catch (_error) {
      db = null;
    }
    return db;
  }

  function loadSnapshot(nowMs) {
    const connection = openDatabase();
    if (!connection) {
      byRef = new Map();
      snapshotAt = nowMs;
      return byRef;
    }
    try {
      const rows = connection.prepare(
        `SELECT account_ref, state_json, updated_at_ms FROM ${TABLE_NAME}`
      ).all();
      const next = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        const accountRef = String(row && row.account_ref || '').trim();
        const state = parseState(row && row.state_json);
        if (!accountRef || !state) continue;
        next.set(accountRef, {
          state,
          updatedAt: Number(row.updated_at_ms) || 0
        });
      }
      byRef = next;
    } catch (_error) {
      byRef = new Map();
    }
    snapshotAt = nowMs;
    return byRef;
  }

  function ensureSnapshot() {
    const now = Date.now();
    if (now - snapshotAt < ttlMs && (byRef.size > 0 || snapshotAt > 0)) return;
    loadSnapshot(now);
  }

  function get(accountRef) {
    const ref = String(accountRef || '').trim();
    if (!ref) return null;
    ensureSnapshot();
    return byRef.get(ref) || null;
  }

  function list() {
    ensureSnapshot();
    return Array.from(byRef, ([accountRef, entry]) => ({
      accountRef,
      state: entry.state,
      updatedAt: entry.updatedAt
    }));
  }

  function invalidate() {
    snapshotAt = 0;
  }

  function close() {
    try {
      if (db) db.close();
    } catch (_error) {}
    db = null;
    opened = false;
    byRef = new Map();
    snapshotAt = 0;
  }

  return { get, list, invalidate, close };
}

module.exports = {
  createGoRuntimeStateReader
};
