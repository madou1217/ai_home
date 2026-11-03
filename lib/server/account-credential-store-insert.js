'use strict';

const { openAppStateDatabase } = require('./app-state-store');
const { ensureCredentialTable, ACCOUNT_CREDENTIAL_TABLE } = require('./account-credential-store');
const { isAccountRef } = require('./account-ref-store');

// Registration and credential publication may race with another login. Initial
// publication must never use an unconditional upsert after a prior null read.
function insertAccountNativeAuthIfMissing(fs, aiHomeDir, accountRef, nativeAuth) {
  if (!isAccountRef(accountRef) || !nativeAuth || typeof nativeAuth !== 'object' || Array.isArray(nativeAuth)) return false;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { createIfMissing: false });
    if (!db) return false;
    ensureCredentialTable(db);
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO ${ACCOUNT_CREDENTIAL_TABLE}
        (account_ref, native_auth_json, native_auth_updated_at, updated_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM account_refs WHERE account_ref = ?)
      ON CONFLICT(account_ref) DO NOTHING
    `).run(accountRef, JSON.stringify(nativeAuth), now, now, accountRef);
    return Number(result && result.changes) === 1;
  } finally {
    if (db && typeof db.close === 'function') db.close();
  }
}
module.exports = { insertAccountNativeAuthIfMissing };
