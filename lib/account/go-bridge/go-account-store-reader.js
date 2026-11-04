'use strict';

// 只读读取 Go 账号库（<AIH_HOME_DIR>/aih.db），用于迁移校验与 Go -> Node 凭据回写判断。
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
  if (!fs.existsSync(file)) return { exists: false, accounts: [], defaults: {}, modelPolicies: [] };
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA query_only = ON');
    const rows = db.prepare(`
      SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled,
             c.auth_kind, c.auth_mode, c.credential_json, c.updated_at_ms AS credential_updated_at_ms,
             p.profile_json, p.email, p.subscription_raw
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
      profile: {
        ...parseJsonObject(row.profile_json),
        email: String(row.email || ''),
        subscriptionRaw: String(row.subscription_raw || '')
      }
    }));
    const defaults = {};
    for (const row of db.prepare('SELECT provider_id, account_ref FROM account_defaults').all()) {
      defaults[String(row.provider_id)] = String(row.account_ref);
    }
    // 只读人工覆盖行：inherit 是缺省语义，模型策略同步只需要知道哪些行被强制过。
    const modelPolicies = db.prepare(`
      SELECT account_ref, model_id, manual_policy FROM account_models WHERE manual_policy <> 'inherit'
    `).all().map((row) => ({
      accountRef: String(row.account_ref),
      modelId: String(row.model_id),
      manualPolicy: String(row.manual_policy)
    }));
    return { exists: true, accounts, defaults, modelPolicies };
  } finally {
    db.close();
  }
}

/**
 * 读取 Go 物化的账号级额度状态（Node 服务端与 CLI 共用同一份计算结果）。
 *
 * 返回 Map<accountRef, {status, reason, remainingPct, hasNumericRemaining, capturedAtMs}>。
 * 旧库（v12 之前）没有这些列时返回空 Map，调用方回退到本地推导。
 */
function readGoQuotaStates(aiHomeDir, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const file = nodePath.join(aiHomeDir, GO_ACCOUNT_DB_FILE);
  if (!fs.existsSync(file)) return { exists: false, states: new Map() };
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA query_only = ON');
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT account_ref, quota_status, quota_reason, remaining_bps, has_numeric_remaining, captured_at_ms
          FROM account_usage_snapshots
         WHERE quota_status <> ''
      `).all();
    } catch (_error) {
      return { exists: true, states: new Map() };
    }
    const states = new Map();
    for (const row of rows) {
      const bps = row.remaining_bps === null || row.remaining_bps === undefined
        ? null
        : Number(row.remaining_bps);
      states.set(String(row.account_ref), {
        status: String(row.quota_status || ''),
        reason: String(row.quota_reason || ''),
        remainingPct: Number.isFinite(bps) ? bps / 100 : null,
        hasNumericRemaining: Number(row.has_numeric_remaining) === 1,
        capturedAtMs: Number(row.captured_at_ms) || 0
      });
    }
    return { exists: true, states };
  } finally {
    db.close();
  }
}

/**
 * 读取 Go 保存的完整额度快照文档；Node 的 app_kv 只是采集暂存与本地缓存。
 *
 * 返回 Map<accountRef, payload>；旧库或文件不存在时返回空 Map。
 */
function readGoUsageDocuments(aiHomeDir, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const file = nodePath.join(aiHomeDir, GO_ACCOUNT_DB_FILE);
  if (!fs.existsSync(file)) return new Map();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA query_only = ON');
    let rows = [];
    try {
      rows = db.prepare('SELECT account_ref, payload_json FROM account_usage_snapshots').all();
    } catch (_error) {
      return new Map();
    }
    const documents = new Map();
    for (const row of rows) {
      const payload = parseJsonObject(row.payload_json);
      if (Object.keys(payload).length > 0) documents.set(String(row.account_ref), payload);
    }
    return documents;
  } finally {
    db.close();
  }
}

/**
 * 读取 Go 物化的账号页展示状态；与 readGoQuotaStates 同一形状，按 aiHomeDir 做 1 秒缓存
 * （账号编辑/状态接口会在同一请求里多次读取）。
 */
function readGoUIStates(aiHomeDir, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const file = nodePath.join(aiHomeDir, GO_ACCOUNT_DB_FILE);
  if (!fs.existsSync(file)) return new Map();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA query_only = ON');
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT account_ref, status, display_name, auth_mode, api_key_mode, configured, oauth_pending, updated_at_ms
          FROM account_ui_state
      `).all();
    } catch (_error) {
      return new Map();
    }
    const states = new Map();
    for (const row of rows) {
      states.set(String(row.account_ref), {
        status: String(row.status || ''),
        displayName: String(row.display_name || ''),
        authMode: String(row.auth_mode || ''),
        apiKeyMode: Number(row.api_key_mode) === 1,
        configured: Number(row.configured) === 1,
        oauthPending: Number(row.oauth_pending) === 1,
        updatedAtMs: Number(row.updated_at_ms) || 0
      });
    }
    return states;
  } finally {
    db.close();
  }
}

module.exports = {
  GO_ACCOUNT_DB_FILE,
  readGoAccounts,
  readGoQuotaStates,
  readGoUIStates,
  readGoUsageDocuments
};
