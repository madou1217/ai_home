'use strict';

// Retired account refs: a record that an accountRef existed and was deleted.
//
// Deleting an account removes every persisted row, so a session still pinned to
// it (x-account-ref) looks exactly like a ref that never existed. The pin
// fallback must tell those apart: a deleted account is a stale affinity that
// falls back to the pool, while a never-seen ref stays a 404 so a client cannot
// borrow another identity with a made-up ref.
//
// Separate from `account:deleted:<ref>`, which only codex/codebuddy write and
// which also blocks background re-adoption — a different concern.

const { readJsonValue } = require('../server/app-state-store');

const RETIRED_KEY_PREFIX = 'account:retired:';

function retiredAccountRefKey(accountRef) {
  return `${RETIRED_KEY_PREFIX}${String(accountRef || '').trim()}`;
}

function writeRetiredAccountRefInDatabase(db, accountRef, provider, now = Date.now()) {
  db.prepare(`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(retiredAccountRefKey(accountRef), JSON.stringify({ provider, retiredAt: now }), now);
}

/** @returns {{provider: string, retiredAt: number} | null} */
function readRetiredAccountRef(fs, aiHomeDir, accountRef) {
  if (!fs || !aiHomeDir || !accountRef) return null;
  const value = readJsonValue(fs, aiHomeDir, retiredAccountRefKey(accountRef));
  const provider = String(value && value.provider || '').trim();
  return provider ? { provider, retiredAt: Number(value.retiredAt) || 0 } : null;
}

module.exports = {
  readRetiredAccountRef,
  writeRetiredAccountRefInDatabase
};
