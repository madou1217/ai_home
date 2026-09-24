'use strict';

// 只读读取 Go 账号库（<AIH_HOME>/aih.db），用于迁移校验与 Go -> Node 凭据回写判断。
// 表结构见 internal/adapters/accounts/sqliteaccount/schema_v*.sql；只做 SELECT。

const nodePath = require('node:path');

const GO_ACCOUNT_DB_FILE = 'aih.db';

function parseJsonObject(text) {
  if (typeof text !== 'string' || !text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_error) {
    return {};
  }
}

function readGoAccounts(aiHomeDir, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const file = nodePath.join(aiHomeDir, GO_ACCOUNT_DB_FILE);
  if (!fs.existsSync(file)) return { exists: false, accounts: [], defaults: {} };
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA query_only = ON');
    const rows = db.prepare(`
      SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled,
             c.auth_kind, c.auth_mode, c.credential_json, c.updated_at_ms AS credential_updated_at_ms,
             p.profile_json
        FROM accounts a
        LEFT JOIN account_credentials c ON c.account_ref = a.account_ref
        LEFT JOIN account_profiles p ON p.account_ref = a.account_ref
       ORDER BY a.account_ref
    `).all();
    const accounts = rows.map((row) => ({
      accountRef: String(row.account_ref),
      provider: String(row.provider_id),
      cliAccountId: Number(row.cli_account_id) || 0,
      enabled: Number(row.enabled) === 1,
      authKind: String(row.auth_kind || ''),
      authMode: String(row.auth_mode || ''),
      credential: parseJsonObject(row.credential_json),
      credentialUpdatedAtMs: Number(row.credential_updated_at_ms) || 0,
      profile: parseJsonObject(row.profile_json)
    }));
    const defaults = {};
    for (const row of db.prepare('SELECT provider_id, account_ref FROM account_defaults').all()) {
      defaults[String(row.provider_id)] = String(row.account_ref);
    }
    return { exists: true, accounts, defaults };
  } finally {
    db.close();
  }
}

module.exports = {
  GO_ACCOUNT_DB_FILE,
  readGoAccounts
};
