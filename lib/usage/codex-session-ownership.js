'use strict';

const { isAccountRef } = require('../account/public-account-ref');
const {
  resolveCodexPersistentThreadId
} = require('../runtime/codex-persistent-thread');
const persistentSessionRegistry = require('../runtime/persistent-session-registry');

/**
 * Build the exact ownership index available for Codex persistent sessions.
 *
 * Codex writes native transcripts into the shared host `~/.codex/sessions`
 * tree, so the transcript path itself is not an account boundary. The
 * persistent-session registry is the only durable source that ties a native
 * thread UUID to an account-scoped launch. Gateway sessions are deliberately
 * excluded because their account is selected per request, not per thread.
 */
function createCodexSessionOwnershipIndex(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const registry = options.registry || persistentSessionRegistry;
  const ownersByThread = new Map();

  let entries = [];
  if (aiHomeDir && registry && typeof registry.listEntries === 'function') {
    try {
      entries = registry.listEntries(aiHomeDir, { fs });
    } catch (_error) {
      entries = [];
    }
  }

  for (const entry of entries) {
    if (!entry || String(entry.provider || '').trim().toLowerCase() !== 'codex') continue;
    const accountRef = String(entry.accountRef || '').trim();
    if (entry.gateway === true || !isAccountRef(accountRef)) continue;
    const threadId = resolveCodexPersistentThreadId(entry);
    if (!threadId) continue;
    let owners = ownersByThread.get(threadId);
    if (!owners) {
      owners = new Set();
      ownersByThread.set(threadId, owners);
    }
    owners.add(accountRef);
  }

  function resolveAccountRef(sessionId) {
    const threadId = String(sessionId || '').trim();
    const owners = ownersByThread.get(threadId);
    return owners && owners.size === 1 ? Array.from(owners)[0] : '';
  }

  return {
    entries,
    resolveAccountRef,
    ambiguousThreadIds: new Set(
      Array.from(ownersByThread.entries())
        .filter(([, owners]) => owners.size > 1)
        .map(([threadId]) => threadId)
    )
  };
}

module.exports = {
  createCodexSessionOwnershipIndex
};
