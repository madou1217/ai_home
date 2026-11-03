'use strict';

// 只读读取 Node 账号真相（app-state.db），供迁移账本与持续同步使用。
// 以 query_only 打开，绝不写入；不存在的表按空处理（新装机或旧版本库）。

const crypto = require('node:crypto');
const nodePath = require('node:path');

const { APP_STATE_DB_FILE } = require('../../server/app-state-store');

function parseJsonObject(text) {
  if (typeof text !== 'string' || !text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_error) {
    return {};
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function openReadOnly(aiHomeDir, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const file = nodePath.join(aiHomeDir, APP_STATE_DB_FILE);
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA query_only = ON');
  return db;
}

/**
 * @returns {{accounts: Array<object>, defaults: Record<string,string>, fingerprint: string}}
 *   accounts 按 accountRef 排序；status 为 'up' | 'down'（无状态行视为 up，与 Node 默认一致）。
 */
function readNodeAccounts(aiHomeDir, deps = {}) {
  const db = openReadOnly(aiHomeDir, deps);
  if (!db) return { accounts: [], defaults: {}, fingerprint: fingerprintOf([], {}) };
  try {
    if (!tableExists(db, 'account_refs')) return { accounts: [], defaults: {}, fingerprint: fingerprintOf([], {}) };
    const hasAliases = tableExists(db, 'account_cli_aliases');
    const hasCredentials = tableExists(db, 'account_credentials');
    const hasState = tableExists(db, 'account_state');
    const rows = db.prepare(`
      SELECT r.account_ref, r.provider, r.created_at, r.updated_at
        ${hasAliases ? ', a.cli_account_id' : ", '' AS cli_account_id"}
        ${hasCredentials ? ', c.env_json, c.native_auth_json, c.env_updated_at, c.native_auth_updated_at' : ", '{}' AS env_json, '{}' AS native_auth_json, 0 AS env_updated_at, 0 AS native_auth_updated_at"}
        ${hasState ? ', s.status' : ", 'up' AS status"}
      FROM account_refs r
        ${hasAliases ? 'LEFT JOIN account_cli_aliases a ON a.account_ref = r.account_ref' : ''}
        ${hasCredentials ? 'LEFT JOIN account_credentials c ON c.account_ref = r.account_ref' : ''}
        ${hasState ? 'LEFT JOIN account_state s ON s.account_ref = r.account_ref' : ''}
      ORDER BY r.account_ref
    `).all();
    const accounts = rows.map((row) => ({
      accountRef: String(row.account_ref),
      provider: String(row.provider),
      cliAccountId: row.cli_account_id === null || row.cli_account_id === undefined ? '' : String(row.cli_account_id),
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      env: parseJsonObject(row.env_json),
      nativeAuth: parseJsonObject(row.native_auth_json),
      envUpdatedAt: Number(row.env_updated_at) || 0,
      nativeAuthUpdatedAt: Number(row.native_auth_updated_at) || 0,
      status: String(row.status || 'up') === 'down' ? 'down' : 'up'
    }));
    const defaults = {};
    if (tableExists(db, 'app_kv')) {
      for (const row of db.prepare("SELECT key, value FROM app_kv WHERE key LIKE 'account:default:%'").all()) {
        try {
          const ref = JSON.parse(row.value);
          if (typeof ref === 'string' && ref) defaults[String(row.key).slice('account:default:'.length)] = ref;
        } catch (_error) {}
      }
    }
    return { accounts, defaults, fingerprint: fingerprintOf(accounts, defaults) };
  } finally {
    db.close();
  }
}

// 源快照指纹：账本生成后 Node 账号有任何变化，apply 都必须拒绝并要求重新 plan。
function fingerprintOf(accounts, defaults) {
  const canonical = JSON.stringify({
    accounts: accounts.map((account) => [
      account.accountRef, account.provider, account.status, account.env, account.nativeAuth
    ]),
    defaults: Object.keys(defaults).sort().map((key) => [key, defaults[key]])
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  readNodeAccounts
};
