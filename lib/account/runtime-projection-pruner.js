'use strict';

const nodePath = require('node:path');
const { isAccountRef } = require('./public-account-ref');
const { listAccountRefRecords } = require('../server/account-ref-store');
const { resolveAihRunPath } = require('../runtime/aih-storage-layout');
const { reconcileProviderResources } = require('../runtime/provider-resource-reconciliation');
const { providerCatalog } = require('../provider-catalog');

function listEntries(fs, dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function removeRuntimeEntry(fs, entryPath, result) {
  try {
    fs.rmSync(entryPath, { recursive: true, force: true });
    result.removed += 1;
  } catch (_error) {
    result.failed += 1;
  }
}

function reconcileRuntimeEntry(ensureSessionStoreLinks, provider, accountRef, result) {
  if (typeof ensureSessionStoreLinks !== 'function') {
    result.failed += 1;
    return false;
  }
  try {
    reconcileProviderResources(ensureSessionStoreLinks, provider, accountRef);
    return true;
  } catch (_error) {
    result.failed += 1;
    return false;
  }
}

function pruneProviderRuntimeRoot(
  fs,
  path,
  rootDir,
  registeredByProvider,
  ensureSessionStoreLinks,
  result
) {
  for (const providerEntry of listEntries(fs, rootDir)) {
    const provider = String(providerEntry.name || '').trim().toLowerCase();
    const providerDir = path.join(rootDir, providerEntry.name);
    const registeredRefs = registeredByProvider.get(provider);
    if (!providerEntry.isDirectory() || !registeredRefs) {
      // Unknown/invalid roots have no provider policy to migrate through.
      // Keep them for manual recovery instead of guessing that they are safe.
      result.failed += 1;
      continue;
    }

    for (const accountEntry of listEntries(fs, providerDir)) {
      const accountRef = String(accountEntry.name || '').trim();
      if (accountEntry.isDirectory() && isAccountRef(accountRef) && registeredRefs.has(accountRef)) {
        result.kept += 1;
        continue;
      }
      if (
        !accountEntry.isDirectory()
        || !isAccountRef(accountRef)
        || !reconcileRuntimeEntry(ensureSessionStoreLinks, provider, accountRef, result)
      ) {
        if (!accountEntry.isDirectory() || !isAccountRef(accountRef)) result.failed += 1;
        continue;
      }
      removeRuntimeEntry(fs, path.join(providerDir, accountEntry.name), result);
    }
  }
}

function pruneCodexDesktopRuntimeRoot(
  fs,
  path,
  rootDir,
  registeredCodexRefs,
  ensureSessionStoreLinks,
  result
) {
  for (const entry of listEntries(fs, rootDir)) {
    const accountRef = String(entry.name || '').trim();
    if (entry.isDirectory() && isAccountRef(accountRef) && registeredCodexRefs.has(accountRef)) {
      result.kept += 1;
      continue;
    }
    if (
      !entry.isDirectory()
      || !isAccountRef(accountRef)
      || !reconcileRuntimeEntry(ensureSessionStoreLinks, 'codex', accountRef, result)
    ) {
      if (!entry.isDirectory() || !isAccountRef(accountRef)) result.failed += 1;
      continue;
    }
    removeRuntimeEntry(fs, path.join(rootDir, entry.name), result);
  }
}

function pruneStaleAccountRuntimeProjections(options = {}) {
  const fs = options.fs;
  const path = options.path || nodePath;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!fs || !aiHomeDir) throw new Error('runtime_projection_prune_missing_context');

  // Load the complete canonical set before deleting anything. Schema errors must
  // abort the prune so a damaged DB can never look like an empty account set.
  const registeredByProvider = new Map(providerCatalog.listIds().map((provider) => [provider, new Set()]));
  for (const record of listAccountRefRecords(fs, aiHomeDir)) {
    const refs = registeredByProvider.get(String(record && record.provider || '').trim());
    const accountRef = String(record && record.accountRef || '').trim();
    if (refs && isAccountRef(accountRef)) refs.add(accountRef);
  }

  const result = { removed: 0, kept: 0, failed: 0 };
  pruneProviderRuntimeRoot(
    fs,
    path,
    resolveAihRunPath(aiHomeDir, 'auth-projections'),
    registeredByProvider,
    options.ensureSessionStoreLinks,
    result
  );
  pruneCodexDesktopRuntimeRoot(
    fs,
    path,
    resolveAihRunPath(aiHomeDir, 'codex-desktop'),
    registeredByProvider.get('codex'),
    options.ensureSessionStoreLinks,
    result
  );
  return result;
}

module.exports = {
  pruneStaleAccountRuntimeProjections
};
