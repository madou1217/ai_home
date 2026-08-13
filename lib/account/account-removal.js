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
const persistentSession = require('../runtime/persistent-session');

function isMissingTmuxServerProbe(probe) {
  if (!probe || probe.error || probe.status === 0) return false;
  const output = `${probe.stderr || ''}\n${probe.stdout || ''}`.toLowerCase();
  return output.includes('no server running');
}

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
    const matchingEntries = persistentSessionRegistry.listEntries(aiHomeDir, { fs, strict: true })
      .filter((entry) => entry.provider === provider && entry.accountRef === accountRef);
    if (matchingEntries.length === 0) return;

    // Probe each matching entry's tmux server to verify the session is actually
    // alive. Stale registry files from exited sessions or reboots must not
    // block account deletion.
    const spawnSync = options.spawnSync || require('child_process').spawnSync;
    const tmux = persistentSession.detectTmux({ spawnSync });
    const blockingEntries = [];
    const probeCache = new Map();

    for (const entry of matchingEntries) {
      const socket = entry.socket;
      if (!probeCache.has(socket)) {
        let result = { status: 'unknown', aliveNames: new Set() };
        if (tmux.available) {
          try {
            const listCmd = persistentSession.buildListSessionsCommand({
              cliName: entry.provider,
              runtimeScope: entry.runtimeScope,
              tmuxCommand: tmux.command
            });
            const probe = spawnSync(listCmd.command, listCmd.args, {
              encoding: 'utf8',
              timeout: 1500
            });
            if (probe && !probe.error && probe.status === 0) {
              result = {
                status: 'alive',
                aliveNames: new Set(
                  persistentSession.parseSessionList(probe.stdout).map((session) => session.name)
                )
              };
            } else if (isMissingTmuxServerProbe(probe)) {
              result = { status: 'absent', aliveNames: new Set() };
            }
          } catch (_error) { /* uncertain probe must fail closed */ }
        }
        probeCache.set(socket, result);
      }

      const probeResult = probeCache.get(socket);
      const exactSessionIsAbsent = probeResult.status === 'absent'
        || (probeResult.status === 'alive' && !probeResult.aliveNames.has(entry.session));
      if (exactSessionIsAbsent) {
        // Stale entry — clean it up so it never blocks again.
        persistentSessionRegistry.removeEntry(aiHomeDir, entry.socket, entry.session, { fs });
      } else {
        // A live exact session or an uncertain probe may still own provider
        // credentials. Account deletion must preserve both cases.
        blockingEntries.push(entry);
      }
    }

    if (blockingEntries.length === 0) return;
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
