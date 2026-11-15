'use strict';

// The compatibility view is a projection of committed Go facts, not another
// identity import. A version check prevents a stale readback overwriting newer
// canonical credentials. No native host files or default selections are touched.
const { openAppStateDatabase } = require('../../server/app-state-store');
const { ensureCliAccountAliasesTable } = require('../../server/account-ref-store');
const { ensureCredentialTable } = require('../../server/account-credential-store');
const { createAccountStateIndex } = require('../state-index');

function mirrorCanonicalAccounts(fs, home, core) {
  const records = core.document?.accounts || [];
  if (!records.length) return;
  // Reuse the schema owner, then perform projection writes in one SQLite txn.
  const state = createAccountStateIndex({ fs, aiHomeDir: home }); state.close();
  const db = openAppStateDatabase(fs, home);
  try {
    ensureCliAccountAliasesTable(db); ensureCredentialTable(db);
    db.exec('BEGIN IMMEDIATE');
    const now = Date.now();
    for (const record of records) {
      const outcome = core.accounts.find((item) => item.accountRef === record.accountRef && !['failed', 'invalid'].includes(item.status));
      const actual = db.prepare('SELECT a.provider_id,a.cli_account_id,a.enabled,c.updated_at_ms FROM accounts a JOIN account_credentials c ON c.account_ref=a.account_ref WHERE a.account_ref=?').get(record.accountRef);
      const profile = outcome?.profileUpdatedAt ? db.prepare('SELECT updated_at_ms FROM account_profiles WHERE account_ref=?').get(record.accountRef) : null;
      if (outcome?.profileUpdatedAt && Number(profile?.updated_at_ms) !== outcome.profileUpdatedAt) throw new Error('backup_core_projection_stale');
      if (!outcome || !actual || actual.provider_id !== record.provider || String(actual.cli_account_id) !== record.cliAccountId || Number(actual.updated_at_ms) !== outcome.credentialUpdatedAt) throw new Error('backup_core_projection_stale');
      const existing = db.prepare('SELECT provider FROM account_refs WHERE account_ref=?').get(record.accountRef);
      if (existing && existing.provider !== record.provider) throw new Error('backup_core_projection_identity_conflict');
      const occupied = db.prepare('SELECT account_ref FROM account_cli_aliases WHERE provider=? AND cli_account_id=?').get(record.provider, record.cliAccountId);
      if (occupied && occupied.account_ref !== record.accountRef) throw new Error('backup_core_projection_alias_conflict');
      db.prepare('INSERT INTO account_refs(account_ref,provider,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(account_ref) DO UPDATE SET updated_at=excluded.updated_at').run(record.accountRef, record.provider, now, now);
      db.prepare('INSERT INTO account_cli_aliases(account_ref,provider,cli_account_id,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account_ref) DO UPDATE SET cli_account_id=excluded.cli_account_id,updated_at=excluded.updated_at').run(record.accountRef, record.provider, record.cliAccountId, now, now);
      db.prepare('INSERT INTO compat_account_credentials(account_ref,env_json,native_auth_json,env_updated_at,native_auth_updated_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_ref) DO UPDATE SET env_json=excluded.env_json,native_auth_json=excluded.native_auth_json,env_updated_at=excluded.env_updated_at,native_auth_updated_at=excluded.native_auth_updated_at,updated_at=excluded.updated_at').run(record.accountRef, JSON.stringify(record.env || {}), JSON.stringify(record.nativeAuth || {}), now, now, now);
      db.prepare("INSERT INTO account_state(account_ref,provider,status,configured,api_key_mode,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT(account_ref) DO UPDATE SET status=excluded.status,configured=1,api_key_mode=excluded.api_key_mode,updated_at=excluded.updated_at").run(record.accountRef, record.provider, actual.enabled ? 'up' : 'down', Object.keys(record.nativeAuth || {}).length ? 0 : 1, now);
    }
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
  finally { db.close(); }
}
module.exports = { mirrorCanonicalAccounts };
