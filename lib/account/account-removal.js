'use strict';

const { clearDanglingAccountPointers } = require('./account-default-pointer');
const { deleteAccountUsageSnapshot } = require('./usage-snapshot-store');
const { deleteTransferMetadata } = require('./transfer-metadata-store');
const {
  deleteAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');
const {
  resolveAccountRuntimeDir,
  resolveCodexDesktopRuntimeDir
} = require('../runtime/aih-storage-layout');
const { reconcileProviderResources } = require('../runtime/provider-resource-reconciliation');
const persistentSessionRegistry = require('../runtime/persistent-session-registry');

function createAccountRemovalService(options = {}) {
  const {
    fs,
    aiHomeDir,
    accountStateService,
    ensureSessionStoreLinks
  } = options;

  function getRuntimeProjectionDirs(provider, accountRef) {
    return [
      resolveAccountRuntimeDir(aiHomeDir, provider, accountRef),
      provider === 'codex' ? resolveCodexDesktopRuntimeDir(aiHomeDir, accountRef) : ''
    ].filter(Boolean);
  }

  function hasRuntimeProjection(provider, accountRef) {
    return getRuntimeProjectionDirs(provider, accountRef).some((runtimeDir) => {
      try {
        fs.lstatSync(runtimeDir);
        return true;
      } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
      }
    });
  }

  function removeRuntimeProjections(provider, accountRef) {
    if (!fs || typeof fs.rmSync !== 'function') {
      const error = new Error('runtime_projection_remove_unavailable');
      error.code = 'runtime_projection_remove_unavailable';
      throw error;
    }
    const runtimeDirs = getRuntimeProjectionDirs(provider, accountRef);
    runtimeDirs.forEach((runtimeDir) => {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    });
  }

  function assertNoPersistentSessionWriters(provider, accountRef) {
    const activeEntries = persistentSessionRegistry.listEntries(aiHomeDir, { fs, strict: true })
      .filter((entry) => entry.provider === provider && entry.accountRef === accountRef);
    if (activeEntries.length === 0) return;
    const error = new Error('account_runtime_active:persistent_session');
    error.code = 'account_runtime_active';
    error.provider = provider;
    error.accountRef = accountRef;
    throw error;
  }

  function deleteAccountByRef(providerName, accountRef) {
    const provider = String(providerName || '').trim().toLowerCase();
    const account = resolveAccountRef(fs, aiHomeDir, accountRef);
    if (!provider || !account || account.provider !== provider) {
      return { provider, accountRef: String(accountRef || '').trim(), deleted: false };
    }
    assertNoPersistentSessionWriters(provider, account.accountRef);
    // The auth projection is disposable, but a provider may have created a new
    // non-private entry since launch. Reconcile it before deleting the account
    // record/projection so account removal can never discard provider state.
    if (typeof ensureSessionStoreLinks !== 'function' && hasRuntimeProjection(provider, account.accountRef)) {
      reconcileProviderResources(null, provider, account.accountRef);
    }
    if (typeof ensureSessionStoreLinks === 'function') {
      reconcileProviderResources(ensureSessionStoreLinks, provider, account.accountRef);
    }
    // Remove disposable projections while the account record is still intact.
    // If filesystem cleanup fails, callers can retry and credentials remain
    // available to rematerialize any projection already removed in this pass.
    removeRuntimeProjections(provider, account.accountRef);
    clearDanglingAccountPointers({
      fs,
      aiHomeDir,
      provider,
      accountRef: account.accountRef,
      path: options.path,
      processObj: options.processObj,
      hostHomeDir: options.hostHomeDir
    });
    deleteAccountUsageSnapshot(fs, aiHomeDir, account.accountRef);
    deleteTransferMetadata(fs, aiHomeDir, account.accountRef);
    const stateDeleted = accountStateService && typeof accountStateService.deleteAccount === 'function'
      ? accountStateService.deleteAccount(account.accountRef)
      : false;

    const deleted = deleteAccountRef(fs, aiHomeDir, account.accountRef);
    return {
      provider,
      accountRef: account.accountRef,
      deleted,
      stateDeleted
    };
  }

  return {
    deleteAccountByRef
  };
}

module.exports = {
  createAccountRemovalService
};
