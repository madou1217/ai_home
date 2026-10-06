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
 * thread UUID to an account-scoped launch. Gateway sessions carry no account
 * because their account is selected per request, not per thread; they are
 * still indexed so the scanner can tell "this thread now runs through the
 * gateway" apart from "owner unknown". A long-lived thread can be resumed
 * under a different scope (account launch, later gateway), so ownership also
 * reports `since` — the registry entry's creation time — and only transcript
 * lines written after it belong to the current scope.
 */
function createCodexSessionOwnershipIndex(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const registry = options.registry || persistentSessionRegistry;
  const ownersByThread = new Map();
  // threadId -> { accountSince: Map<accountRef, earliest createdAt>, gatewaySince }
  const scopesByThread = new Map();

  let entries = [];
  if (aiHomeDir && registry && typeof registry.listEntries === 'function') {
    try {
      entries = registry.listEntries(aiHomeDir, { fs });
    } catch (_error) {
      entries = [];
    }
  }

  const scopeFor = (threadId) => {
    let scope = scopesByThread.get(threadId);
    if (!scope) {
      scope = { accountSince: new Map(), gatewaySince: null };
      scopesByThread.set(threadId, scope);
    }
    return scope;
  };
  const earliest = (current, createdAt) => (
    current === null || current === undefined || createdAt < current ? createdAt : current
  );

  for (const entry of entries) {
    if (!entry || String(entry.provider || '').trim().toLowerCase() !== 'codex') continue;
    const threadId = resolveCodexPersistentThreadId(entry);
    if (!threadId) continue;
    const createdAt = Number.isFinite(Number(entry.createdAt)) ? Math.max(0, Number(entry.createdAt)) : 0;
    if (entry.gateway === true) {
      const scope = scopeFor(threadId);
      scope.gatewaySince = earliest(scope.gatewaySince, createdAt);
      continue;
    }
    const accountRef = String(entry.accountRef || '').trim();
    if (!isAccountRef(accountRef)) continue;
    let owners = ownersByThread.get(threadId);
    if (!owners) {
      owners = new Set();
      ownersByThread.set(threadId, owners);
    }
    owners.add(accountRef);
    const scope = scopeFor(threadId);
    scope.accountSince.set(accountRef, earliest(scope.accountSince.get(accountRef), createdAt));
  }

  function resolveAccountRef(sessionId) {
    const threadId = String(sessionId || '').trim();
    const owners = ownersByThread.get(threadId);
    return owners && owners.size === 1 ? Array.from(owners)[0] : '';
  }

  /**
   * Current scope of a thread:
   *   { accountRef, gateway: false, since }  exactly one account-scoped launch
   *   { accountRef: '', gateway: true, since } only gateway launches
   *   { accountRef: '', gateway: false, since: 0 } unknown or ambiguous —
   *     the caller keeps its stored attribution
   */
  function resolveOwnership(sessionId) {
    const threadId = String(sessionId || '').trim();
    const scope = scopesByThread.get(threadId);
    const unknown = { accountRef: '', gateway: false, since: 0 };
    if (!scope) return unknown;
    const accounts = Array.from(scope.accountSince.entries());
    if (accounts.length === 0 && scope.gatewaySince !== null) {
      return { accountRef: '', gateway: true, since: scope.gatewaySince };
    }
    // Two account owners, or an account launch alongside a gateway launch:
    // no single scope can be proven for new lines.
    if (accounts.length !== 1 || scope.gatewaySince !== null) return unknown;
    return { accountRef: accounts[0][0], gateway: false, since: accounts[0][1] };
  }

  return {
    entries,
    resolveAccountRef,
    resolveOwnership,
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
