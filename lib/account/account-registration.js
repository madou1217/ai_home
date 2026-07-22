'use strict';

const {
  advanceCliAccountIdSequenceInDatabase,
  allocateCliAccountIdInDatabase,
  ensureSequenceTable
} = require('./account-id-allocator');
const {
  CLI_ACCOUNT_ALIASES_TABLE,
  ensureCliAccountAliasesTable,
  getPublicAccountRef
} = require('../server/account-ref-store');
const { openAppStateDatabase } = require('../server/app-state-store');
const { providerCatalog } = require('../provider-catalog');

function normalizeProvider(provider) {
  return providerCatalog.normalize(provider);
}

function registerAccountIdentity(fs, aiHomeDir, input = {}, deps = {}) {
  const provider = normalizeProvider(input.provider);
  const identitySeed = String(input.identitySeed || '').trim();
  if (!provider || !identitySeed || identitySeed.startsWith('legacy:')) {
    throw new Error('invalid_account_identity');
  }

  const accountRef = getPublicAccountRef(`unique:${identitySeed}`);
  const requestedCliAccountId = String(input.cliAccountId || '').trim();
  if (requestedCliAccountId && !/^\d+$/.test(requestedCliAccountId)) {
    throw new Error('invalid_cli_account_id');
  }

  let db = null;
  let inTransaction = false;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, deps);
    if (!db) throw new Error('account_ref_database_unavailable');
    ensureCliAccountAliasesTable(db);
    ensureSequenceTable(db);
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;

    const existing = db.prepare(`
      SELECT r.account_ref, r.provider, a.cli_account_id, r.created_at, r.updated_at
      FROM account_refs r
      LEFT JOIN ${CLI_ACCOUNT_ALIASES_TABLE} a ON a.account_ref = r.account_ref
      WHERE r.account_ref = ?
      LIMIT 1
    `).get(accountRef);
    if (existing) {
      if (String(existing.provider || '') !== provider) throw new Error('account_ref_provider_mismatch');
      let cliAccountId = String(existing.cli_account_id || '').trim();
      if (!/^\d+$/.test(cliAccountId)) {
        cliAccountId = requestedCliAccountId || allocateCliAccountIdInDatabase(db, provider);
        if (requestedCliAccountId) {
          advanceCliAccountIdSequenceInDatabase(db, provider, cliAccountId);
        }
        const occupied = db.prepare(`
          SELECT account_ref
          FROM ${CLI_ACCOUNT_ALIASES_TABLE}
          WHERE provider = ? AND cli_account_id = ?
          LIMIT 1
        `).get(provider, cliAccountId);
        if (occupied && String(occupied.account_ref || '') !== accountRef) {
          throw new Error('cli_account_id_conflict');
        }
        const now = Date.now();
        db.prepare(`
          INSERT INTO ${CLI_ACCOUNT_ALIASES_TABLE} (
            account_ref, provider, cli_account_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(accountRef, provider, cliAccountId, now, now);
      }
      db.exec('COMMIT');
      inTransaction = false;
      return {
        accountRef,
        provider,
        cliAccountId,
        createdAt: Number(existing.created_at) || 0,
        updatedAt: Number(existing.updated_at) || 0,
        created: false
      };
    }

    const cliAccountId = requestedCliAccountId
      || allocateCliAccountIdInDatabase(db, provider);
    if (requestedCliAccountId) {
      advanceCliAccountIdSequenceInDatabase(db, provider, cliAccountId);
    }
    const occupied = db.prepare(`
      SELECT account_ref
      FROM ${CLI_ACCOUNT_ALIASES_TABLE}
      WHERE provider = ? AND cli_account_id = ?
      LIMIT 1
    `).get(provider, cliAccountId);
    if (occupied && String(occupied.account_ref || '') !== accountRef) {
      throw new Error('cli_account_id_conflict');
    }

    const now = Date.now();
    db.prepare(`
      INSERT INTO account_refs (
        account_ref, provider, created_at, updated_at
      ) VALUES (?, ?, ?, ?)
    `).run(accountRef, provider, now, now);
    db.prepare(`
      INSERT INTO ${CLI_ACCOUNT_ALIASES_TABLE} (
        account_ref, provider, cli_account_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(accountRef, provider, cliAccountId, now, now);
    db.exec('COMMIT');
    inTransaction = false;
    return {
      accountRef,
      provider,
      cliAccountId,
      createdAt: now,
      updatedAt: now,
      created: true
    };
  } catch (error) {
    if (inTransaction && db) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
    }
    throw error;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

module.exports = {
  registerAccountIdentity
};
