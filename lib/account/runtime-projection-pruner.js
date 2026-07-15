'use strict';

const nodePath = require('node:path');
const { isAccountRef } = require('./public-account-ref');
const { listAccountRefRecords } = require('../server/account-ref-store');
const { resolveAihRunPath } = require('../runtime/aih-storage-layout');

const ACCOUNT_PROVIDERS = Object.freeze(['agy', 'claude', 'codex', 'gemini', 'opencode']);

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

function pruneProviderRuntimeRoot(fs, path, rootDir, registeredByProvider, result) {
  for (const providerEntry of listEntries(fs, rootDir)) {
    const provider = String(providerEntry.name || '').trim().toLowerCase();
    const providerDir = path.join(rootDir, providerEntry.name);
    const registeredRefs = registeredByProvider.get(provider);
    if (!providerEntry.isDirectory() || !registeredRefs) {
      removeRuntimeEntry(fs, providerDir, result);
      continue;
    }

    for (const accountEntry of listEntries(fs, providerDir)) {
      const accountRef = String(accountEntry.name || '').trim();
      if (accountEntry.isDirectory() && isAccountRef(accountRef) && registeredRefs.has(accountRef)) {
        result.kept += 1;
        continue;
      }
      removeRuntimeEntry(fs, path.join(providerDir, accountEntry.name), result);
    }
  }
}

function pruneCodexDesktopRuntimeRoot(fs, path, rootDir, registeredCodexRefs, result) {
  for (const entry of listEntries(fs, rootDir)) {
    const accountRef = String(entry.name || '').trim();
    if (entry.isDirectory() && isAccountRef(accountRef) && registeredCodexRefs.has(accountRef)) {
      result.kept += 1;
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
  const registeredByProvider = new Map(ACCOUNT_PROVIDERS.map((provider) => [provider, new Set()]));
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
    result
  );
  pruneCodexDesktopRuntimeRoot(
    fs,
    path,
    resolveAihRunPath(aiHomeDir, 'codex-desktop'),
    registeredByProvider.get('codex'),
    result
  );
  return result;
}

module.exports = {
  pruneStaleAccountRuntimeProjections
};
