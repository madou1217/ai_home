'use strict';

// 账号删除的宿主清理正在迁 Go（internal/adapters/accountremoval）：
//   - 已迁：运行时投影目录（run/auth-projections、run/codex-desktop）与会话写者
//     探测（run/persistent-sessions + tmux 活/陈旧/不确定三态）；
//   - 仍留 Node：account_refs 行、app_kv 指针、usage snapshot / transfer metadata、
//     窗口激活设置、zcode 出口绑定、codex app-server 停机与重启、生命周期事件。
// Go 删除路径（goDeletionMode === 'go'）在调用本服务之前已经跑过同一份 guard 与
// 投影准备，此时下面的会话写者探测、资源对账与投影删除属于重复劳动。删除路由按
// 「本次删除是否由 Go 承接」算出 hostCleanupHandledByGo 传进来，为 true 时跳过
// 这三段实现；它是单次调用的事实，不是配置开关，Node 承接（含 Go 不可用回落）
// 时行为完全不变。

const { clearDanglingAccountPointers } = require('./account-default-pointer');
const { deleteAccountUsageSnapshot } = require('./usage-snapshot-store');
const { deleteTransferMetadata } = require('./transfer-metadata-store');
const { deleteAccountEgressBinding } = require('./zcode-egress-binding-store');
const {
  deleteWindowActivationConfig,
  deleteWindowActivationState
} = require('./window-activation-store');
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
const { invalidateCodexAppServerEndpoint: defaultInvalidateCodexAppServerEndpoint } = require('../server/codex-app-server-endpoint');
const { createCodexDesktopHookService } = require('../server/codex-desktop-hook');
const { publishAccountLifecycleEvent } = require('../server/account-lifecycle-bus');

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
    ensureSessionStoreLinks,
    // 本次删除是否已由 Go 承接宿主清理：删除路由按 goDeletionMode 算出的单次事实。
    hostCleanupHandledByGo = false
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
    // Go 承接时 Core 已在删除前用同一份语义校验过会话写者并清掉陈旧登记。
    if (hostCleanupHandledByGo !== true) {
      assertNoPersistentSessionWriters(provider, account.accountRef);
    }
    const invalidateCodexAppServerEndpoint = typeof options.invalidateCodexAppServerEndpoint === 'function'
      ? options.invalidateCodexAppServerEndpoint
      : defaultInvalidateCodexAppServerEndpoint;
    const invalidationOptions = {
      aiHomeDir,
      accountRef: account.accountRef,
      spawnSyncImpl: options.spawnSync || require('child_process').spawnSync
    };
    if (provider === 'codex') {
      // A resident app-server captures its provider URL and account context at
      // process start.  Stop both account-scoped native runners and the
      // desktop stdio app-server before deleting the account, otherwise a
      // later thread/resume can continue sending with the removed key.
      invalidateCodexAppServerEndpoint(invalidationOptions);
    }
    // Chat uses the Codex harness for every inference provider, with a separate
    // `chat-<accountRef>` scope. Stop it before any provider's credentials vanish.
    invalidateCodexAppServerEndpoint({
      ...invalidationOptions,
      runtimeNamespace: 'chat'
    });
    // 资源对账与投影删除只有 Node 承接删除时才做：Go 的 deletionprojection 已在
    // 删库前完成同一份对账与投影回收，重复执行只会对着已经消失的投影再扫一遍。
    if (hostCleanupHandledByGo !== true) {
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
    // 窗口激活的账号级设置与状态也属于「账号私有、删号即失效」的 app_kv 记录：accountRef 由
    // 身份派生，不清理的话同一身份重新添加会继承旧账号的开关与间隔。
    deleteWindowActivationConfig(fs, aiHomeDir, account.accountRef);
    deleteWindowActivationState(fs, aiHomeDir, account.accountRef);
    if (provider === 'zcode') {
      deleteAccountEgressBinding(fs, aiHomeDir, account.accountRef);
    }
    const stateDeleted = accountStateService && typeof accountStateService.deleteAccount === 'function'
      ? accountStateService.deleteAccount(account.accountRef)
      : false;

    const deleted = deleteAccountRef(fs, aiHomeDir, account.accountRef);
    if (provider === 'codex' && deleted) {
      // Restart only after the DB and projections are gone. Restarting before
      // deletion would let a fresh desktop app-server capture the account we
      // are in the middle of removing.
      const desktopHook = createCodexDesktopHookService({
        fs,
        path: options.path,
        processObj: options.processObj,
        hostHomeDir: options.hostHomeDir,
        aiHomeDir,
        spawnSync: options.spawnSync || require('child_process').spawnSync
      });
      if (desktopHook && typeof desktopHook.restartRunningAppServers === 'function') {
        desktopHook.restartRunningAppServers();
      }
    }
    // 删除事实在数据库与投影都清完之后才发布：监听者读到的必须是「已经不存在」的状态。
    if (deleted) {
      publishAccountLifecycleEvent('deleted', {
        provider,
        accountRef: account.accountRef,
        source: String(options.source || 'removal').trim()
      });
    }
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
