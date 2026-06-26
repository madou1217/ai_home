'use strict';

const {
  isDegradedUniqueKey,
  resolveAccountUniqueKeyFromObject
} = require('../account/account-identity');
const {
  ACCOUNT_REF_PREFIX,
  getPublicAccountRef,
  isAccountRef
} = require('../account/public-account-ref');
const { openAppStateDatabase } = require('./app-state-store');

function getAccountId(account) {
  return String(account && (account.accountId || account.id) || '').trim();
}

function resolveStableUniqueKey(provider, account) {
  const explicit = String(account && account.uniqueKey || '').trim();
  if (explicit && !isDegradedUniqueKey(explicit)) return explicit;
  if (!account) return '';
  const resolved = resolveAccountUniqueKeyFromObject({ ...account, provider });
  return resolved && resolved.uniqueKey && !resolved.degraded
    ? String(resolved.uniqueKey || '').trim()
    : '';
}

function normalizeAccountRefRecord(input) {
  const provider = String(input && input.provider || '').trim();
  const accountId = getAccountId(input);
  const accountKey = String(input && input.accountKey || '').trim();
  const uniqueKey = resolveStableUniqueKey(provider, input);
  const identityKey = uniqueKey ? `unique:${uniqueKey}` : '';
  if (!identityKey) return null;
  return {
    accountRef: getPublicAccountRef(identityKey),
    identityKey,
    uniqueKey,
    provider,
    accountId,
    accountKey
  };
}

function ensureAccountRefsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_refs (
      account_ref TEXT PRIMARY KEY,
      identity_key TEXT NOT NULL UNIQUE,
      unique_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_account_refs_unique_key ON account_refs(unique_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_account_refs_account_key ON account_refs(account_key)');
}

function upsertAccountRef(fs, aiHomeDir, account, deps = {}) {
  const record = normalizeAccountRefRecord(account);
  if (!record) return '';
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, deps);
    if (!db) return '';
    ensureAccountRefsTable(db);
    const now = Date.now();
    const previous = db.prepare('SELECT created_at FROM account_refs WHERE account_ref = ?').get(record.accountRef);
    db.prepare(`
      INSERT INTO account_refs (
        account_ref,
        identity_key,
        unique_key,
        provider,
        account_id,
        account_key,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_ref) DO UPDATE SET
        identity_key = excluded.identity_key,
        unique_key = excluded.unique_key,
        provider = excluded.provider,
        account_id = excluded.account_id,
        account_key = excluded.account_key,
        updated_at = excluded.updated_at
    `).run(
      record.accountRef,
      record.identityKey,
      record.uniqueKey,
      record.provider,
      record.accountId,
      record.accountKey,
      Number(previous && previous.created_at) || now,
      now
    );
    return record.accountRef;
  } catch (error) {
    if (!deps.bestEffort) throw error;
    return '';
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

function resolveAccountRef(fs, aiHomeDir, accountRef, deps = {}) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) return null;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, deps);
    if (!db) return null;
    ensureAccountRefsTable(db);
    const row = db.prepare(`
      SELECT account_ref, unique_key, provider, account_id, account_key
      FROM account_refs
      WHERE account_ref = ?
    `).get(normalizedRef);
    if (!row) return null;
    return {
      accountRef: String(row.account_ref || ''),
      uniqueKey: String(row.unique_key || ''),
      provider: String(row.provider || ''),
      accountId: String(row.account_id || ''),
      accountKey: String(row.account_key || '')
    };
  } catch (error) {
    if (!deps.bestEffort) throw error;
    return null;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

module.exports = {
  ACCOUNT_REF_PREFIX,
  getPublicAccountRef,
  isAccountRef,
  normalizeAccountRefRecord,
  resolveAccountRef,
  upsertAccountRef
};
