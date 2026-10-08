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
// which also blocks background re-adoption — a different concern. The latter
// marker is still read as a legacy retirement record when an account was
// deleted before the provider field was added; an empty provider deliberately
// means "let normal model routing choose" rather than guessing an identity.

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
  if (provider) return { provider, retiredAt: Number(value.retiredAt) || 0 };

  // Before `account:retired:*` existed, deleteAccountRef only persisted an
  // `account:deleted:*` marker. It is enough to prove that the pin belonged to
  // a real account, but it contains no provider. Keep it as a stale-affinity
  // signal and leave provider selection to the normal request router.
  const deleted = readJsonValue(fs, aiHomeDir, `account:deleted:${String(accountRef).trim()}`);
  const deletedAt = deleted && deleted.deletedAt;
  return typeof deletedAt === 'number' && Number.isFinite(deletedAt) && deletedAt > 0
    ? { provider: '', retiredAt: deletedAt }
    : null;
}

module.exports = {
  readRetiredAccountRef,
  writeRetiredAccountRefInDatabase
};
