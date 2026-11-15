'use strict';

const { getBusinessDatabasePath } = require('../../server/business-database');

// Once the Go host-default transaction has taken ownership, the absence of a
// Go default is authoritative. Never revive a stale legacy Node pointer.
function openDefaultDatabase(fs, aiHomeDir) {
  const filename = getBusinessDatabasePath(aiHomeDir);
  if (!filename || !fs.existsSync(filename)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000');
    return db;
  } catch (error) { db.close(); throw error; }
}

function receiptSupported(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_default_ownership'").get());
}

function ownsCodexDefault(fs, aiHomeDir) {
  const db = openDefaultDatabase(fs, aiHomeDir);
  if (!db) return false;
  try {
    return receiptSupported(db) && Boolean(db.prepare("SELECT 1 FROM account_default_ownership WHERE provider_id='codex' AND owner='go'").get());
  } finally { db.close(); }
}

function readCodexDefault(fs, aiHomeDir) {
  const db = openDefaultDatabase(fs, aiHomeDir);
  if (!db) return { owned: false, accountRef: '' };
  try {
    if (!receiptSupported(db)) return { owned: false, accountRef: '' };
    // The receipt and effective default are read by one statement. A late
    // app_kv compatibility write cannot change the authoritative gateway mode.
    const row = db.prepare(`SELECT o.expected_ref, o.operation_id,
      CASE WHEN a.enabled=1 AND a.provider_id='codex' AND c.account_ref IS NOT NULL
        THEN d.account_ref ELSE NULL END AS account_ref
      FROM account_default_ownership o
      LEFT JOIN account_defaults d ON d.provider_id=o.provider_id
      LEFT JOIN accounts a ON a.account_ref=d.account_ref
      LEFT JOIN account_credentials c ON c.account_ref=a.account_ref
      WHERE o.provider_id='codex' AND o.owner='go'`).get();
    if (!row) return { owned: false, accountRef: '' };
    const accountRef = String(row.account_ref || '');
    if (row.expected_ref !== null && accountRef !== row.expected_ref) {
      throw new Error('codex_default_unavailable');
    }
    if (row.expected_ref === null && accountRef) throw new Error('codex_default_receipt_mismatch');
    return { owned: true, accountRef, gateway: row.expected_ref === null, operation: row.operation_id };
  } finally { db.close(); }
}

// Only the selected Codex credential is read; no full-account credential scan.
function readCodexCredential(fs, aiHomeDir, accountRef) {
  if (!ownsCodexDefault(fs, aiHomeDir) || !/^acct_[a-f0-9]{20}$/.test(String(accountRef))) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(getBusinessDatabasePath(aiHomeDir), { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000');
    const row = db.prepare(`SELECT c.auth_kind, c.credential_json FROM account_credentials c
      JOIN accounts a ON a.account_ref=c.account_ref WHERE a.account_ref=? AND a.provider_id='codex' AND a.enabled=1`).get(accountRef);
    if (!row) throw new Error('codex_default_credential_unavailable');
    const doc = JSON.parse(row.credential_json);
    if (!['api_key', 'oauth'].includes(row.auth_kind) || (row.auth_kind === 'api_key' && !String(doc.api_key || '').trim())) throw new Error('invalid_codex_default_credential');
    return { provider: 'codex', env: row.auth_kind === 'api_key'
      ? { OPENAI_API_KEY: String(doc.api_key || ''), OPENAI_BASE_URL: String(doc.base_url || '') }
      : {} };
  } catch (_error) { throw new Error('codex_default_credential_unavailable'); }
  finally { db.close(); }
}

module.exports = { ownsCodexDefault, readCodexDefault, readCodexCredential };
