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

function createAccountRemovalService(options = {}) {
  const {
    fs,
    aiHomeDir,
    accountStateService
  } = options;

  function removeRuntimeProjections(provider, accountRef) {
    if (!fs || typeof fs.rmSync !== 'function') return;
    const runtimeDirs = [
      resolveAccountRuntimeDir(aiHomeDir, provider, accountRef),
      provider === 'codex' ? resolveCodexDesktopRuntimeDir(aiHomeDir, accountRef) : ''
    ].filter(Boolean);
    runtimeDirs.forEach((runtimeDir) => {
      try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (_error) {}
    });
  }

  function deleteAccountByRef(providerName, accountRef) {
    const provider = String(providerName || '').trim().toLowerCase();
    const account = resolveAccountRef(fs, aiHomeDir, accountRef);
    if (!provider || !account || account.provider !== provider) {
      return { provider, accountRef: String(accountRef || '').trim(), deleted: false };
    }
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
    if (accountStateService && typeof accountStateService.deleteAccount === 'function') {
      accountStateService.deleteAccount(account.accountRef);
    }

    const deleted = deleteAccountRef(fs, aiHomeDir, account.accountRef);
    if (deleted) removeRuntimeProjections(provider, account.accountRef);
    return {
      provider,
      accountRef: account.accountRef,
      deleted
    };
  }

  return {
    deleteAccountByRef
  };
}

module.exports = {
  createAccountRemovalService
};
