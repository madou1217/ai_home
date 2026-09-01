'use strict';

const {
  isAuthInvalidRuntimeStatus
} = require('../../../account/runtime-view');

const { resolveRuntimeTarget } = require('../../../account/runtime-target');

const {
  captureProviderAuth,
  registerProviderAuthProjection
} = require('../../../account/native-auth-projection');

const { extractQoderLoginProjectionMetadata } = require('../../../account/qoder-auth-metadata');

const { resolveCodexSqliteHome } = require('../../../runtime/codex-home');

const { reconcileProviderResources } = require('../../../runtime/provider-resource-reconciliation');

const {
  createTransientAuthProjectionLease,
  removeTransientAuthProjection
} = require('../../../runtime/transient-auth-projection');

const { resolveAccountRefByCliId } = require('../../../server/account-ref-store');

const { detectHeadlessInvocation } = require('./headless-invocation');

const { createHeadlessProgress } = require('./headless-progress');

const { createLocalClipboard } = require('./local-clipboard');

const { createRuntimeStateStore } = require('./runtime-state-store');

const { createUsageStatusRuntime } = require('./usage-status-runtime');

const { createShellDrawerController } = require('./shell-drawer-controller');

const { createSshClipboardBridge } = require('./ssh-clipboard-bridge');

const { repairNativeBinaryIfNeeded } = require('../ai-cli/native-binary-repair');

const {
  collectNativeCliPathEntries,
  listProviderBinaryNames,
  resolveNativeCliInstallPlans
} = require('../ai-cli/native-cli-installer');

const { getAiCliBinaryName, getAiCliConfig } = require('../ai-cli/provider-registry');

const { createClaudeDiagnosticScheduler } = require('./claude-diagnostic-scheduler');

const { createClaudeRetryObserver } = require('./claude-retry-observer');

const { createCodexInteractionObserver } = require('./codex-interaction-observer');

const { postJson } = require('../../../server/provider-session-hook-sender');

module.exports = function createPtyRuntimeRunDomain(deps, launch, spawnDomain, helpers) {

  const {
    path,
    fs,
    processObj,
    pty,
    spawn,
    spawnSync,
    execSync,
    shouldEnableShellDrawer,
    isShellDrawerToggleSequence,
    readUsageConfig,
    cliConfigs,
    aiHomeDir,
    hostHomeDir,
    getProfileDir,
    askYesNo,
    stripAnsi,
    ensureSessionStoreLinks,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    readUsageCache,
    getLastUsageProbeError,
    getLastUsageProbeState,
    getUsageRemainingPercentValues,
    getNextAvailableId,
    getAccountStateIndex,
    accountStateService,
    markActiveAccount,
    ensureAccountUsageRefreshScheduler,
    refreshIndexedStateForAccount,
    accountArtifactHooks,
    fetchSshClipAgentImage,
  } = deps;

  const {
    isUsageManagedCli,
    resolveProviderHookReceiverUrl,
    normalizeRuntimeForwardArgs,
    getShellDrawerLayout,
    resolveLaunchRuntimeScope,
    resolveRuntimeDir,
    resolveCliPathWithRuntimeTools,
    collectCliPathSearchEntries,
    findCliBinaryInSearchEntries,
    resolveBundledNpmInstall,
  } = launch;

  const {
    spawnPty,
    spawnShellDrawerPty,
  } = spawnDomain;

  const {
    shared,
    codexLaunchSupport,
    persistentWrapper,
  } = helpers;

  const {
    resolveLatestCodexThreadIdForCwd,
    buildCodexAutoResumeArgs,
  } = codexLaunchSupport;
  const {
    reconcileRegistryAfterExit,
  } = persistentWrapper;



  function runCliPty(cliName, initialAccountRef, forwardArgs, isLogin = false, runtimeOptions = {}) {
    const runtimeStartedAt = Date.now();
    const initialCliAccountId = String(runtimeOptions.cliAccountId || '').trim();
    const loginSessionId = String(runtimeOptions.loginSessionId || '').trim();
    const initialTarget = resolveRuntimeTarget({
      gateway: runtimeOptions.gateway === true,
      accountRef: initialAccountRef
    });
    const pendingLogin = Boolean(isLogin && !initialTarget && loginSessionId);
    if (!initialTarget && !pendingLogin) throw new Error('invalid_account_runtime_target');
    const initialRef = initialTarget ? initialTarget.accountRef : '';
    const initialGateway = Boolean(initialTarget && initialTarget.gateway);
    // Non-interactive run (`-p`, `codex exec`, …): stdout belongs to the model's
    // answer alone. Every aih-owned line goes to stderr, no terminal chrome is
    // installed, and nothing paints the screen — the output has to survive being
    // piped, captured, or scrolled past.
    const headlessRun = detectHeadlessInvocation(cliName, forwardArgs, {
      isLogin,
      env: processObj.env
    }).headless;
    const noticeLog = headlessRun
      ? (message) => console.error(message)
      : (message) => console.log(message);
    let cliPath = resolveCliPathWithRuntimeTools(cliName);
    if (!cliPath) {
      const binaryName = getAiCliBinaryName(cliName) || cliName;
      console.log(`\x1b[33m[aih] Native CLI '${binaryName}' (${cliName}) not found.\x1b[0m`);
      const pkg = cliConfigs[cliName] && String(cliConfigs[cliName].pkg || '').trim();
      const platform = String(processObj.platform || process.platform || '').trim();
      const installPlans = resolveNativeCliInstallPlans(cliName, pkg, {
        path,
        processObj,
        hostHomeDir,
        resolveNpmInstall: pkg ? resolveBundledNpmInstall : null
      });
      if (installPlans.length === 0) {
        console.error(`\x1b[31m[aih] ${cliName} has no auto-install path configured. Install the native CLI first, then retry.\x1b[0m`);
        processObj.exit(1);
        return;
      }
      const preferredInstall = installPlans[0];
      const installPrompt = preferredInstall && preferredInstall.label
        ? `Do you want to automatically install it using ${preferredInstall.label}?`
        : 'Do you want to automatically install it using the provider official installer?';
      const ans = askYesNo(installPrompt);
      if (ans) {
        let installed = false;
        for (const install of installPlans) {
          const installLabel = pkg || binaryName;
          console.log(`\n\x1b[36m[aih]\x1b[0m Installing \x1b[33m${installLabel}\x1b[0m via ${install.label}...`);
          const installResult = spawnSync(install.command, install.args, {
            stdio: 'inherit',
            timeout: install.timeoutMs,
            windowsHide: platform === 'win32'
          });
          if (installResult && installResult.status === 0) {
            installed = true;
            break;
          }
          console.error(`\x1b[33m[aih]\x1b[0m ${install.label} failed; trying the next supported installer...`);
        }
        if (!installed) {
          console.error(`\x1b[31m[aih] Failed to install ${cliName}${pkg ? ` (${pkg})` : ''}. Install it manually, then retry.\x1b[0m`);
          processObj.exit(1);
          return;
        }
        console.log(`\x1b[32m[aih] Successfully installed ${cliName}!\x1b[0m\n`);
      } else {
        // 用户拒绝安装：明确告知后退出，避免下次运行无提示地再次弹安装。
        console.log(`\x1b[33m[aih] ${cliName} install skipped. Install it manually, then retry.\x1b[0m`);
        processObj.exit(1);
        return;
      }
      cliPath = resolveCliPathWithRuntimeTools(cliName);
      if (!cliPath) {
        // 装完仍解析不到：给出实际查找过的路径与已发现的二进制位置，
        // 让用户能把落点目录加入 PATH，而不是重跑后再弹一次安装。
        console.error(`\x1b[31m[aih] ${binaryName} was installed but is still not resolvable from the detected paths.\x1b[0m`);
        const searchEntries = typeof collectCliPathSearchEntries === 'function'
          ? collectCliPathSearchEntries(cliName)
          : [];
        if (searchEntries.length > 0) {
          console.error(`\x1b[90m[aih] Searched directories:\x1b[0m`);
          for (const entry of searchEntries) {
            console.error(`\x1b[90m  - ${entry}\x1b[0m`);
          }
        }
        const foundBinary = typeof findCliBinaryInSearchEntries === 'function'
          ? findCliBinaryInSearchEntries(cliName, searchEntries)
          : '';
        if (foundBinary) {
          console.error(`\x1b[33m[aih] Found ${binaryName} at ${foundBinary}, but it is not executable from PATH.\x1b[0m`);
          console.error(`\x1b[90m[aih] Add ${path.dirname(foundBinary)} to PATH, then retry.\x1b[0m`);
        } else {
          console.error(`\x1b[90m[aih] Add the directory containing ${binaryName} to PATH, then retry.\x1b[0m`);
        }
        processObj.exit(1);
        return;
      }
    }

    if (String(processObj.env.AIH_NATIVE_BINARY_REPAIR || '1') !== '0') {
      const nativeRepair = repairNativeBinaryIfNeeded(cliName, cliPath, {
        fs,
        path,
        spawnSync,
        processObj,
        nodeExecPath: processObj.execPath,
        hostHomeDir,
        onRepairStart: (context = {}) => {
          const action = context.strategy === 'claude_windows_native'
            ? 'running the official Windows installer'
            : 'running @anthropic-ai/claude-code postinstall repair';
          console.log(`\x1b[36m[aih]\x1b[0m Claude native binary is missing; ${action}...`);
        }
      });
      if (nativeRepair && nativeRepair.needed) {
        if (nativeRepair.ok && nativeRepair.repaired) {
          cliPath = String(nativeRepair.cliPath || cliPath).trim();
          console.log(`\x1b[36m[aih]\x1b[0m Claude native binary was missing; repair completed.`);
        } else if (!nativeRepair.ok) {
          console.error(`\x1b[33m[aih]\x1b[0m Claude native binary is missing; attempted @anthropic-ai/claude-code postinstall repair but it failed.`);
          const reason = String(nativeRepair.reason || 'unknown_error');
          console.error(`\x1b[33m[aih]\x1b[0m Reason: ${reason}`);
          if (nativeRepair.detail) {
            console.error(`\x1b[90m[aih]\x1b[0m ${nativeRepair.detail}`);
          }
          const nextStep = String(processObj.platform || process.platform || '').trim() === 'win32'
            ? 'run the official Claude Code Windows installer, then retry'
            : 'reinstall Claude Code without --ignore-scripts / --omit=optional, then retry';
          console.error(`\x1b[90m[aih]\x1b[0m Next step: ${nextStep}.`);
          processObj.exit(1);
          return;
        }
      }
    }

    const targetLabel = initialGateway
      ? '\x1b[32mAIH Server\x1b[0m'
      : initialCliAccountId
        ? `Account ID: \x1b[32m${initialCliAccountId}\x1b[0m`
        : '\x1b[32mPending login\x1b[0m';
    const runBanner = `Running \x1b[33m${cliName}\x1b[0m (${targetLabel})${headlessRun ? ' headless' : ' via PTY'}`;
    // A headless run has no TUI to prove it is alive, and a long prompt or a slow
    // upstream can keep it silent for many seconds. Animate the line (on stderr,
    // TTY only) so waiting never looks like a failed launch.
    const headlessProgress = headlessRun
      ? createHeadlessProgress({ processObj, label: runBanner })
      : null;
    if (headlessProgress) {
      headlessProgress.start();
    } else {
      console.log(`\n\x1b[36m[aih]\x1b[0m 🚀 ${runBanner}`);
    }
    const initialLaunchRuntime = resolveLaunchRuntimeScope(
      cliName,
      initialRef,
      isLogin,
      loginSessionId,
      initialGateway
    );
    const initialSessionSync = !isLogin && initialRef
      && initialLaunchRuntime.projectionRequired
      && cliName !== 'codex'
      ? reconcileProviderResources(ensureSessionStoreLinks, cliName, initialRef)
      : { migrated: 0, linked: 0 };
    if (initialSessionSync.migrated > 0 || initialSessionSync.linked > 0) {
      noticeLog(`\x1b[36m[aih]\x1b[0m Session links ready (${cliName}): migrated ${initialSessionSync.migrated}, linked ${initialSessionSync.linked}.`);
    }

    let activeAccountRef = initialRef;
    let activeGateway = initialGateway;
    let activeId = initialCliAccountId;
    const initialProfileDir = initialLaunchRuntime.runtimeDir;
    const transientLoginRuntimeDir = isLogin && loginSessionId ? initialProfileDir : '';
    let transientLoginRuntimeRemoved = false;
    const cleanupTransientLoginRuntime = (reconcileAccountRef = '') => {
      if (!transientLoginRuntimeDir || transientLoginRuntimeRemoved) {
        return { migrated: 0, linked: 0 };
      }
      const result = reconcileProviderResources(
        ensureSessionStoreLinks,
        cliName,
        reconcileAccountRef || `login-${loginSessionId || 'transient'}`,
        { projectionRoot: transientLoginRuntimeDir }
      );
      fs.rmSync(transientLoginRuntimeDir, { recursive: true, force: true });
      transientLoginRuntimeRemoved = true;
      return result;
    };
    const initialCodexDir = cliName === 'codex'
      ? resolveCodexSqliteHome({ path, hostHomeDir, aiHomeDir, profileDir: initialProfileDir })
      : '';
    let activeForwardArgs = normalizeRuntimeForwardArgs(cliName, forwardArgs, {
      codexDir: initialCodexDir,
      isLogin
    });
    // Remote-clipboard handling lives in ssh-clipboard-bridge.js; exported
    // names match the original closure functions so call sites are unchanged.
    const {
      isSshRuntimeSession,
      startSshTerminalPasteEventsMode,
      stopSshTerminalPasteEventsMode,
      clearSshTerminalClipboardPromptTimer,
      consumeSshClipboardFrames,
      consumeSshBracketedPasteImage,
      consumeSshTerminalClipboardResponse,
      consumeSshClipboardShimRequests,
      tryPasteLatestSshClipboardImage
    } = createSshClipboardBridge({
      fs,
      path,
      processObj,
      spawnSync,
      fetchSshClipAgentImage,
      provider: cliName,
      getCliAccountId: () => activeId,
      writePtyInput: (text) => { if (ptyProc) ptyProc.write(text); }
    });
    // Local (Windows/WSL) clipboard capture + mirror poller lives in
    // local-clipboard.js; exported names match the original closure functions.
    const {
      isClipboardPasteTrigger,
      tryCaptureClipboardImagePathOnWindows,
      startClipboardImageMirrorProcess,
      stopClipboardMirrorProcess
    } = createLocalClipboard({
      fs,
      path,
      processObj,
      spawn,
      execSync,
      aiHomeDir,
      isLogin,
      isSshRuntimeSession,
      isInteractiveSession: () => isInteractiveRuntimeSession(activeForwardArgs),
      isCleanedUp: () => cleanedUp
    });
    let ptyProc = null;
    let codexInteractionObserver = null;

    const waveFrames = ['.', '..', '...', ' ..', '  .', '   '];
    let waveIdx = 0;
    let hasReceivedData = false;
    // Bottom shell drawer (viewport/frames/drawer PTY) lives in
    // shell-drawer.js; the runtime routes stdin, pty output, resize and
    // cleanup through this interface.
    const {
      isShellDrawerVisible,
      setShellDrawerStatusSummary,
      writeChildMainOutput,
      handleDrawerStdin,
      handleTerminalResize,
      destroyShellDrawer
    } = createShellDrawerController({
      processObj,
      available: typeof shouldEnableShellDrawer === 'function'
        ? shouldEnableShellDrawer(isLogin, activeForwardArgs, processObj)
        : false,
      getShellDrawerLayout,
      spawnShellDrawerPty,
      isToggleSequence: isShellDrawerToggleSequence,
      getStatusSummaryFallback: () => getUsageStatusSummaryFallback(),
      republishUsage: () => emitUsageStatus(activeAccountRef, { forcePrint: true, forceRefresh: false }),
      isCleanedUp: () => cleanedUp,
      isHeadlessRun: () => headlessRun
    });
    // Persisted account-state reads/writes live in runtime-state-store.js.
    const runtimeStateStore = createRuntimeStateStore({
      fs,
      aiHomeDir,
      provider: cliName,
      getAccountStateIndex,
      accountStateService,
      getActiveAccountRef: () => activeAccountRef,
      getActiveCliAccountId: () => activeId
    });
    const {
      readCodexApiKeyAccountInfo,
      getPersistedAccountState,
      getPersistedRuntimeStatus,
      buildRuntimeBlockedSummary,
      persistRuntimeState,
      persistAuthInvalidRuntimeState,
      clearPersistedRuntimeState
    } = runtimeStateStore;
    // Usage summaries/title/watchers and the threshold auto-switch POLICY live
    // in usage-status-runtime.js; the switch ACTION (switchToAccount) stays
    // here and is invoked through requestAccountSwitch.
    const {
      canRenderUsageStatusBar,
      shouldShowUsageInPty,
      markSessionActivity,
      isUsageRefreshPausedByIdle,
      stopUsageRefreshProcess,
      refreshUsageSnapshotNoCache,
      getUsageStaleMs,
      buildApiKeyStatusSummary,
      buildInitialUsageStatusSummary,
      buildUsageStatusFromCache,
      writeUsageStatusLine,
      writeTerminalProgress,
      clearRuntimeTerminalRunning,
      startRuntimeTitleWatcher,
      startUsageIdleStatusWatcher,
      startUsageDisplayWatcher,
      startThresholdWatcher,
      stopThresholdWatcher,
      getNextRuntimeAccountId,
      emitUsageStatus,
      stopUsageWatchers,
      resetUsageTitle,
      resetUsageDisplaySignature,
      getUsageStatusSummaryFallback
    } = createUsageStatusRuntime({
      fs,
      path,
      processObj,
      aiHomeDir,
      provider: cliName,
      isLogin,
      isUsageManagedCli,
      readUsageConfig,
      readUsageCache,
      ensureUsageSnapshot,
      ensureUsageSnapshotAsync,
      getUsageRemainingPercentValues,
      getNextAvailableId,
      stateStore: runtimeStateStore,
      getActiveAccountRef: () => activeAccountRef,
      isGateway: () => activeGateway,
      getActiveCliAccountId: () => activeId,
      getForwardArgs: () => activeForwardArgs,
      isInteractiveSession: (args) => isInteractiveRuntimeSession(args),
      isCodexResumeArgs: (args) => isCodexResumeForwardArgs(args),
      isSwapping: () => isSwapping,
      hasActivePty: () => Boolean(ptyProc),
      isCleanedUp: () => cleanedUp,
      isAuthRecoveryPromptOpen: () => Boolean(authRecoveryPrompt),
      isShellDrawerVisible,
      setShellDrawerStatusSummary,
      requestAccountSwitch: (nextId, reason) => switchToAccount(nextId, reason)
    });

    let waveInterval = null;
    let bootWaveDrawn = false;

    function startBootWave() {
      // The spinner is terminal chrome written to stdout; a headless run must
      // not mix it into the captured answer. Codex's normal/resume UI is an
      // inline TUI, so any out-of-band cursor write can corrupt its screen
      // model before the first frame arrives.
      if (headlessRun || isCodexInteractiveSession()) return;
      if (waveInterval) return;
      bootWaveDrawn = false;
      waveInterval = setInterval(() => {
        if (!hasReceivedData) {
          processObj.stdout.write(`\r\x1b[36m[aih]\x1b[0m Waiting for ${cliName} to boot${waveFrames[waveIdx++]}\x1b[K`);
          bootWaveDrawn = true;
          waveIdx %= waveFrames.length;
        }
      }, 200);
      if (waveInterval && typeof waveInterval.unref === 'function') {
        waveInterval.unref();
      }
    }

    function stopBootWave() {
      if (!waveInterval) return;
      clearInterval(waveInterval);
      waveInterval = null;
    }

    function clearDrawnBootWave() {
      if (!bootWaveDrawn) return;
      bootWaveDrawn = false;
      processObj.stdout.write('\r\x1b[K');
    }

    const onResize = () => {
      const drawerHandledRedraw = handleTerminalResize({
        resizeMainPty: () => {
          if (ptyProc) {
            try { ptyProc.resize(processObj.stdout.columns, getChildPtyRows(activeForwardArgs)); } catch (_error) {}
          }
        }
      });
      if (!drawerHandledRedraw && canRenderUsageStatusBar() && shouldShowUsageInPty(activeForwardArgs)) {
        // Re-publish the usage title at the new size (screen-safe).
        emitUsageStatus(activeAccountRef, { forcePrint: true, forceRefresh: false });
      }
    };
    processObj.stdout.on('resize', onResize);

    // Headless runs own no keyboard: raw mode and a resumed stdin would only
    // steal the terminal from whatever launched them.
    const canUseRawMode = !headlessRun
      && !!(processObj.stdin && processObj.stdin.isTTY && typeof processObj.stdin.setRawMode === 'function');
    if (canUseRawMode) {
      processObj.stdin.setRawMode(true);
    }
    if (!headlessRun) {
      processObj.stdin.resume();
    }


    const onStdinData = (data) => {
      markSessionActivity();
      const terminalClipboardData = consumeSshTerminalClipboardResponse(data);
      if (terminalClipboardData == null) return;
      data = terminalClipboardData;
      const filteredData = consumeSshClipboardFrames(data);
      if (filteredData == null) return;
      data = filteredData;
      const bracketedPasteData = consumeSshBracketedPasteImage(data);
      if (bracketedPasteData == null) return;
      data = bracketedPasteData;
      if (authRecoveryPrompt) {
        handleAuthRecoveryPromptInput(data);
        return;
      }
      if (handleDrawerStdin(data)) return;
      if (isClipboardPasteTrigger(data)) {
        const imagePath = tryCaptureClipboardImagePathOnWindows();
        if (imagePath) {
          if (ptyProc) ptyProc.write(imagePath);
          return;
        }
        if (tryPasteLatestSshClipboardImage()) return;
      }
      if (codexInteractionObserver) codexInteractionObserver.observeInput(data);
      if (ptyProc) ptyProc.write(data);
    };
    processObj.stdin.on('data', onStdinData);

    let outputBuffer = '';
    let isSwapping = false;
    let sigintHandler = null;
    let cleanedUp = false;
    let authRecoveryPrompt = null;
    let authInvalidHandledForCurrentSpawn = false;
    let ignoredExitProc = null;
    let runtimeHelpersStarted = false;
    // Claude Stop-hook / tool-protocol diagnostic scheduling lives in
    // claude-diagnostic-scheduler.js; exported names match the original
    // closure functions so call sites are unchanged.
    const {
      scheduleClaudeHookDiagnostic,
      scheduleClaudeToolDiagnostic,
      clearClaudeDiagnosticTimers
    } = createClaudeDiagnosticScheduler({
      fs,
      path,
      processObj,
      stripAnsi,
      aiHomeDir,
      hostHomeDir,
      getProfileDir,
      provider: cliName,
      runtimeStartedAt,
      getAccountRef: () => activeAccountRef,
      isGateway: () => activeGateway,
      getCliPath: () => cliPath,
      getForwardArgs: () => activeForwardArgs,
      getRuntimeEnv: () => shared.lastRuntimeEnv,
      isCleanedUp: () => cleanedUp
    });

    function getForwardArgList(args) {
      return Array.isArray(args) ? args : [];
    }

    function isCodexResumeForwardArgs(args) {
      const list = getForwardArgList(args);
      const firstArg = String(list[0] || '').trim();
      return cliName === 'codex' && (firstArg === 'resume' || firstArg === '/resume');
    }

    function isBareInteractiveRuntimeSession(args = activeForwardArgs) {
      if (isLogin) return false;
      return getForwardArgList(args).length === 0;
    }

    function isInteractiveRuntimeSession(args = activeForwardArgs) {
      if (isLogin) return false;
      const list = getForwardArgList(args);
      return list.length === 0 || isCodexResumeForwardArgs(list);
    }

    function getTerminalRows() {
      return Math.max(1, Number(processObj.stdout && processObj.stdout.rows) || 24);
    }

    function getChildPtyRows(_args = activeForwardArgs) {
      // The child always gets the full terminal height: usage lives in the title,
      // so no bottom row is reserved.
      return getTerminalRows();
    }

    function resolveAuthInvalidReason(text) {
      const plain = stripAnsi(String(text || '')).toLowerCase();
      if (!plain.trim()) return '';
      if (plain.includes('token_expired') || plain.includes('authentication token is expired')) {
        return 'token_expired';
      }
      if (
        plain.includes('auth_invalid_reauth_required')
        || plain.includes('reauth_required')
        || plain.includes('direct_http_status_401')
        || plain.includes('http_status_401')
        || plain.includes('status_401')
        || plain.includes('provided authentication token is expired')
        || (plain.includes('401') && (plain.includes('auth') || plain.includes('token') || plain.includes('unauthorized') || plain.includes('expired')))
      ) {
        return 'auth_invalid_reauth_required';
      }
      return '';
    }

    function resetAuthRecoveryPrompt() {
      authRecoveryPrompt = null;
      resetUsageDisplaySignature();
    }

    function getEnabledAuthRecoveryOptions() {
      const nextId = typeof getNextAvailableId === 'function'
        ? getNextAvailableId(cliName, activeId, { refreshSnapshot: false })
        : null;
      return [
        {
          key: 'login',
          label: '重新登录当前账号',
          enabled: true
        },
        {
          key: 'switch',
          label: nextId ? `自动切换到可用账号 ${nextId}` : '自动切换到可用账号（当前没有可用账号）',
          enabled: Boolean(nextId),
          nextId
        },
        {
          key: 'exit',
          label: '退出',
          enabled: true
        }
      ];
    }

    function renderAuthRecoveryPrompt() {
      if (!authRecoveryPrompt) return;
      const options = authRecoveryPrompt.options;
      const selectedIndex = authRecoveryPrompt.selectedIndex;
      const lines = [
        '',
        `\x1b[33m[aih]\x1b[0m account ${activeId} auth expired (${authRecoveryPrompt.reason}).`,
        '\x1b[90m[aih]\x1b[0m 使用 ↑/↓ 移动，输入序号选择，Enter 确认。',
        ...options.map((option, index) => {
          const cursor = index === selectedIndex ? '>' : ' ';
          const disabled = option.enabled ? '' : ' \x1b[90m[不可用]\x1b[0m';
          const label = option.enabled ? option.label : `\x1b[90m${option.label}\x1b[0m`;
          return `${cursor} ${index + 1}. ${label}${disabled}`;
        })
      ];
      processObj.stdout.write(`\r\n${lines.join('\r\n')}\r\n`);
    }

    function openAuthRecoveryPrompt(reason) {
      if (authRecoveryPrompt || cleanedUp) return;
      const interactive = isInteractiveRuntimeSession(activeForwardArgs);
      if (!interactive || cliName !== 'codex') {
        processObj.stdout.write(`\r\n\x1b[31m[aih]\x1b[0m account ${activeId} auth expired (${reason}).\r\n`);
        return;
      }
      authRecoveryPrompt = {
        reason,
        selectedIndex: 0,
        options: getEnabledAuthRecoveryOptions()
      };
      renderAuthRecoveryPrompt();
    }

    function moveAuthRecoveryPrompt(delta) {
      if (!authRecoveryPrompt) return;
      const options = authRecoveryPrompt.options;
      let nextIndex = authRecoveryPrompt.selectedIndex;
      for (let i = 0; i < options.length; i += 1) {
        nextIndex = (nextIndex + delta + options.length) % options.length;
        if (options[nextIndex].enabled) break;
      }
      authRecoveryPrompt.selectedIndex = nextIndex;
      renderAuthRecoveryPrompt();
    }

    function applyAuthRecoveryPromptChoice() {
      if (!authRecoveryPrompt) return;
      const choice = authRecoveryPrompt.options[authRecoveryPrompt.selectedIndex];
      if (!choice || !choice.enabled) {
        renderAuthRecoveryPrompt();
        return;
      }
      resetAuthRecoveryPrompt();
      if (choice.key === 'login') {
        processObj.stdout.write(`\r\n\x1b[36m[aih]\x1b[0m restarting login for account ${activeId}...\r\n`);
        stopThresholdWatcher();
        cleanupTerminalHooks();
        setTimeout(() => {
          runCliPty(cliName, activeAccountRef, [], true, {
            cliAccountId: activeId,
            loginSessionId: `auth-recovery-${Date.now()}-${processObj.pid || 'aih'}`
          });
        }, 0);
        return;
      }
      if (choice.key === 'switch') {
        switchToAccount(choice.nextId, 'current account auth expired');
        return;
      }
      stopThresholdWatcher();
      cleanupTerminalHooks();
      processObj.exit(0);
    }

    function handleAuthRecoveryPromptInput(data) {
      const input = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
      if (!input) return;
      if (input.includes('\u0003') || input === '\x1b') {
        if (authRecoveryPrompt) authRecoveryPrompt.selectedIndex = 2;
        applyAuthRecoveryPromptChoice();
        return;
      }
      if (input.includes('\x1b[A')) {
        moveAuthRecoveryPrompt(-1);
        return;
      }
      if (input.includes('\x1b[B')) {
        moveAuthRecoveryPrompt(1);
        return;
      }
      const digit = input.match(/[1-9]/);
      if (digit && authRecoveryPrompt) {
        const index = Number(digit[0]) - 1;
        if (index >= 0 && index < authRecoveryPrompt.options.length) {
          authRecoveryPrompt.selectedIndex = index;
          renderAuthRecoveryPrompt();
        }
      }
      if (input.includes('\r') || input.includes('\n')) {
        applyAuthRecoveryPromptChoice();
      }
    }

    // process.exit() discards whatever is still queued on stdout/stderr, and on
    // a pipe (`out=$(aih … -p …)`, `| tee`) those writes are asynchronous — the
    // tail of the answer, or all of it, would never reach the caller. Wait for
    // the streams to drain, with a bounded fallback so a stuck consumer cannot
    // hang the process.
    function exitAfterFlush(code) {
      const finalCode = Number.isInteger(code) ? code : 0;
      processObj.exitCode = finalCode;
      const pendingStreams = [processObj.stdout, processObj.stderr].filter((stream) => (
        stream && typeof stream.writableLength === 'number' && stream.writableLength > 0
      ));
      if (pendingStreams.length === 0) {
        processObj.exit(finalCode);
        return;
      }
      let remaining = pendingStreams.length;
      let exited = false;
      const finish = () => {
        if (exited) return;
        exited = true;
        processObj.exit(finalCode);
      };
      const fallbackTimer = setTimeout(finish, 2000);
      if (fallbackTimer && typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
      pendingStreams.forEach((stream) => {
        const onDrained = () => {
          remaining -= 1;
          if (remaining <= 0) {
            clearTimeout(fallbackTimer);
            finish();
          }
        };
        try {
          stream.write('', onDrained);
        } catch (_error) {
          onDrained();
        }
      });
    }

    function cleanupTerminalHooks() {
      if (cleanedUp) return;
      cleanedUp = true;
      stopBootWave();
      clearDrawnBootWave();
      if (headlessProgress) headlessProgress.stop();
      resetUsageTitle();
      clearRuntimeTerminalRunning();
      try { processObj.stdout.off('resize', onResize); } catch (_error) {}
      try { processObj.stdin.off('data', onStdinData); } catch (_error) {}
      if (sigintHandler) {
        try { processObj.off('SIGINT', sigintHandler); } catch (_error) {}
      }
      try { processObj.stdin.pause(); } catch (_error) {}
      if (canUseRawMode) {
        try { processObj.stdin.setRawMode(false); } catch (_error) {}
      }
      stopUsageWatchers();
      if (codexInteractionObserver) {
        codexInteractionObserver.stop();
        codexInteractionObserver = null;
      }
      clearClaudeDiagnosticTimers();
      clearSshTerminalClipboardPromptTimer();
      stopSshTerminalPasteEventsMode();
      stopClipboardMirrorProcess();
      stopUsageRefreshProcess();
      destroyShellDrawer();
    }

    function switchToAccount(targetId, reasonLabel) {
      const nextId = String(targetId || '').trim();
      if (!/^\d+$/.test(nextId) || nextId === activeId || isSwapping) return;
      const nextAccount = resolveAccountRefByCliId(fs, aiHomeDir, cliName, nextId, { bestEffort: true });
      if (!nextAccount) return;
      const nextRuntime = resolveLaunchRuntimeScope(
        cliName,
        nextAccount.accountRef,
        isLogin,
        loginSessionId,
        false
      );
      try {
        if (nextRuntime.projectionRequired && cliName !== 'codex') {
          reconcileProviderResources(ensureSessionStoreLinks, cliName, nextAccount.accountRef);
        }
      } catch (error) {
        processObj.stdout.write(`\r\n\x1b[31m[aih] Account switch blocked: ${error.message}\x1b[0m\r\n`);
        return;
      }
      isSwapping = true;
      const fromId = activeId;
      const fromRuntimeDir = resolveRuntimeDir(cliName, activeAccountRef, false, '', activeGateway);
      const fromCodexDir = cliName === 'codex'
        ? resolveCodexSqliteHome({ path, hostHomeDir, aiHomeDir, profileDir: fromRuntimeDir })
        : path.join(fromRuntimeDir, '.codex');
      const keepExplicitResume = isCodexResumeForwardArgs(activeForwardArgs);
      const resumeThreadId = cliName === 'codex' && !isLogin && !keepExplicitResume
        ? resolveLatestCodexThreadIdForCwd(fromCodexDir, processObj.cwd())
        : '';
      const switchForwardArgs = keepExplicitResume
        ? activeForwardArgs
        : cliName === 'codex' && !isLogin
        ? buildCodexAutoResumeArgs(resumeThreadId)
        : activeForwardArgs;
      processObj.stdout.write(`\r\n\x1b[33m[aih] ${reasonLabel}. Auto-switch: ${fromId} -> ${nextId}\x1b[0m\r\n`);
      if (cliName === 'codex') {
        const resumeLabel = keepExplicitResume
          ? activeForwardArgs.slice(1).join(' ')
          : resumeThreadId ? resumeThreadId : '--last';
        processObj.stdout.write(`\x1b[90m[aih] resuming Codex session ${resumeLabel} on account ${nextId}\x1b[0m\r\n`);
      }
      activeId = nextId;
      activeAccountRef = nextAccount.accountRef;
      activeGateway = false;
      activeForwardArgs = getForwardArgList(switchForwardArgs);
      resetUsageDisplaySignature();
      authInvalidHandledForCurrentSpawn = false;
      resetAuthRecoveryPrompt();
      if (ptyProc) {
        try { ptyProc.kill(); } catch (_error) {}
      }
      setTimeout(() => {
        outputBuffer = '';
        hasReceivedData = false;
        ptyProc = spawnPty(cliName, cliPath, activeAccountRef, activeForwardArgs, isLogin, {
          rows: getChildPtyRows(activeForwardArgs),
          cliAccountId: activeId,
          gateway: activeGateway
        });
        startBootWave();
        attachOnData(ptyProc, {
          accountRef: activeAccountRef,
          cliAccountId: activeId,
          runtimeDir: ptyProc.aihRuntimeDir || nextRuntime.runtimeDir,
          projectionRequired: nextRuntime.projectionRequired
        });
        startRuntimeHelpersOnce();
        emitUsageStatus(activeAccountRef, { forcePrint: true, forceRefresh: true });
        isSwapping = false;
      }, 250);
    }

    function attachOnData(proc, spawnedScope = {}) {
      const spawnedAccountRef = String(spawnedScope.accountRef || '').trim();
      const spawnedCliAccountId = String(spawnedScope.cliAccountId || activeId || '').trim();
      const spawnedRuntimeDir = String(spawnedScope.runtimeDir || '').trim();
      const spawnedProjectionRequired = spawnedScope.projectionRequired === true;
      const sessionCorrelationId = String(proc && proc.aihSessionCorrelationId || '').trim();
      const claudeRetryObserver = cliName === 'claude' && sessionCorrelationId
        ? createClaudeRetryObserver({
          onRetry(retryStatus) {
            postJson(resolveProviderHookReceiverUrl(), {
              provider: 'claude',
              eventName: 'AihRetryStatus',
              correlationId: sessionCorrelationId,
              retryStatus
            }, { timeoutMs: 1000 });
          }
        })
        : null;
      if (codexInteractionObserver) codexInteractionObserver.stop();
      const attachedCodexInteractionObserver = cliName === 'codex' && sessionCorrelationId
        ? createCodexInteractionObserver({
          correlationId: sessionCorrelationId,
          accountRef: spawnedAccountRef,
          receiverUrl: resolveProviderHookReceiverUrl(),
          postJson,
          writeInput(input, writeOptions = {}) {
            if (cleanedUp || proc !== ptyProc) return;
            proc.write(input);
            if (writeOptions.appendNewline !== false) {
              const timer = setTimeout(() => {
                if (!cleanedUp && proc === ptyProc) proc.write('\r');
              }, 40);
              if (timer && typeof timer.unref === 'function') timer.unref();
            }
          }
        })
        : null;
      codexInteractionObserver = attachedCodexInteractionObserver;
      if (attachedCodexInteractionObserver) attachedCodexInteractionObserver.start();
      proc.onData((data) => {
        const shimFilteredData = consumeSshClipboardShimRequests(data);
        markSessionActivity();
        if (shimFilteredData == null) return;
        data = shimFilteredData;
        if (String(data || '').length === 0) return;
        if (attachedCodexInteractionObserver) attachedCodexInteractionObserver.observe(data);
        if (claudeRetryObserver) claudeRetryObserver.observe(data);
        scheduleClaudeHookDiagnostic(data);
        scheduleClaudeToolDiagnostic(data);
        if (!hasReceivedData) {
          hasReceivedData = true;
          stopBootWave();
          if (headlessProgress) headlessProgress.markFirstOutput();
          clearDrawnBootWave();
        }

        writeChildMainOutput(data);
        outputBuffer += stripAnsi(data);
        if (outputBuffer.length > 4000) outputBuffer = outputBuffer.slice(-4000);

        const lowerOut = outputBuffer.toLowerCase();
        if (isLogin && (lowerOut.includes('failed to login') || lowerOut.includes('socket disconnected') || lowerOut.includes('connection error'))) {
          outputBuffer = '';
          processObj.stdout.write('\r\n\x1b[33m[aih] Detected Network/Auth Error. Attempting to auto-restart the auth process...\x1b[0m\r\n');
          isSwapping = true;
          proc.kill();
          setTimeout(() => {
            isSwapping = false;
            ptyProc = spawnPty(cliName, cliPath, activeAccountRef, [], true, {
              cliAccountId: activeId,
              loginSessionId
            });
            attachOnData(ptyProc, {
              accountRef: activeAccountRef,
              cliAccountId: activeId,
              runtimeDir: resolveRuntimeDir(cliName, activeAccountRef, true, loginSessionId, false),
              projectionRequired: true
            });
          }, 1500);
        }
      });

      // Headless children keep stderr separate so `out=$(aih … -p …)` captures
      // the answer only. The text still feeds outputBuffer, because auth/error
      // detection reads it.
      if (typeof proc.onErrorData === 'function') {
        proc.onErrorData((data) => {
          const text = String(data || '');
          if (!text) return;
          markSessionActivity();
          const firstOutput = !hasReceivedData;
          hasReceivedData = true;
          stopBootWave();
          clearDrawnBootWave();
          // stderr counts as proof of life too — stop the spinner before the
          // child's own text lands on the same line.
          if (firstOutput && headlessProgress) headlessProgress.markFirstOutput();
          if (processObj.stderr && typeof processObj.stderr.write === 'function') {
            processObj.stderr.write(text);
          }
          outputBuffer += stripAnsi(text);
          if (outputBuffer.length > 4000) outputBuffer = outputBuffer.slice(-4000);
        });
      }

      proc.onExit(({ exitCode }) => {
        if (attachedCodexInteractionObserver) {
          attachedCodexInteractionObserver.clear('process-exited');
          attachedCodexInteractionObserver.stop();
        }
        if (codexInteractionObserver === attachedCodexInteractionObserver) {
          codexInteractionObserver = null;
        }
        let reconciliationError = null;
        if (
          spawnedProjectionRequired
          && spawnedAccountRef
          && spawnedRuntimeDir
          && proc.aihProjectionFinalized !== true
        ) {
          try {
            captureProviderAuth(fs, spawnedRuntimeDir, cliName, {
              path,
              aiHomeDir,
              accountRef: spawnedAccountRef,
              processObj
            });
          } catch (error) {
            console.warn(`\x1b[33m[aih]\x1b[0m Failed to persist ${cliName} auth projection: ${error.message}`);
          }
          if (!isLogin && proc.aihPersistentSession !== true) {
            try {
              reconcileProviderResources(ensureSessionStoreLinks, cliName, spawnedAccountRef, {
                projectionRoot: spawnedRuntimeDir
              });
            } catch (error) {
              reconciliationError = error;
              console.error(`\x1b[31m[aih]\x1b[0m Provider resource reconciliation failed: ${error.message}`);
            }
            if (proc.aihTransientAuthProjection === true && !reconciliationError) {
              try {
                removeTransientAuthProjection(fs, spawnedRuntimeDir, cliName, spawnedAccountRef, { path });
              } catch (error) {
                reconciliationError = error;
                console.error(`\x1b[31m[aih]\x1b[0m Transient auth cleanup failed: ${error.message}`);
              }
            }
          }
        }
        if (ignoredExitProc === proc) {
          ignoredExitProc = null;
          return;
        }
        if (!isSwapping) {
          if (isLogin && exitCode === 0) {
            let completedAccountRef = spawnedAccountRef;
            let completedCliAccountId = spawnedCliAccountId;
            if (!completedAccountRef) {
              const registration = registerProviderAuthProjection(fs, spawnedRuntimeDir, cliName, {
                path,
                aiHomeDir,
                cliAccountId: spawnedCliAccountId,
                processObj,
                projectionMetadata: extractQoderLoginProjectionMetadata(cliName, outputBuffer)
              });
              if (!registration.registered) {
                stopThresholdWatcher();
                cleanupTerminalHooks();
                try {
                  cleanupTransientLoginRuntime();
                } catch (error) {
                  console.error(`\n\x1b[31m[aih]\x1b[0m Login resource reconciliation failed: ${error.message}`);
                }
                console.error(`\n\x1b[31m[aih]\x1b[0m Login completed but account identity could not be persisted (${registration.reason}).`);
                processObj.exit(1);
                return;
              }
              completedAccountRef = registration.accountRef;
              completedCliAccountId = registration.cliAccountId;
            }
            activeAccountRef = completedAccountRef;
            activeGateway = false;
            activeId = completedCliAccountId;
            clearPersistedRuntimeState(activeAccountRef);
            if (accountArtifactHooks && typeof accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
              accountArtifactHooks.notifyDefaultAccountAuthUpdated({
                provider: cliName,
                accountRef: activeAccountRef,
                source: 'pty_login',
                reason: 'login_completed'
              });
            }
            stopThresholdWatcher();
            cleanupTerminalHooks();
            try {
              cleanupTransientLoginRuntime(completedAccountRef);
            } catch (error) {
              console.error(`\n\x1b[31m[aih]\x1b[0m Login resource reconciliation failed: ${error.message}`);
              processObj.exit(1);
              return;
            }
            console.log('\n\x1b[32m[aih] Auth completed! Booting standard session...\x1b[0m');
            setTimeout(() => {
              runCliPty(cliName, activeAccountRef, forwardArgs, false, {
                cliAccountId: activeId
              });
            }, 500);
          } else {
            if (isLogin && Number.isInteger(exitCode) && exitCode !== 0) {
              const providerLabel = cliName === 'codex'
                ? 'Codex'
                : cliName.charAt(0).toUpperCase() + cliName.slice(1);
              console.error(`\n\x1b[31m[aih]\x1b[0m native ${providerLabel} login exited with code ${exitCode} before account registration. No account was created.`);
            }
            stopThresholdWatcher();
            cleanupTerminalHooks();
            try {
              cleanupTransientLoginRuntime(spawnedAccountRef);
            } catch (error) {
              reconciliationError = error;
              console.error(`\x1b[31m[aih]\x1b[0m Login resource reconciliation failed: ${error.message}`);
            }
            reconcileRegistryAfterExit();
            if (!headlessRun) processObj.stdout.write('\r\n');
            exitAfterFlush(reconciliationError ? 1 : (exitCode || 0));
          }
        }
      });
    }

    function startRuntimeHelpersOnce() {
      if (runtimeHelpersStarted) return;
      runtimeHelpersStarted = true;
      clearRuntimeTerminalRunning();
      startSshTerminalPasteEventsMode();
      startClipboardImageMirrorProcess();
      startThresholdWatcher();
      startUsageIdleStatusWatcher();
      startUsageDisplayWatcher();
      startRuntimeTitleWatcher();
    }

    function startActivePty(forwardArgsToRun = forwardArgs) {
      activeForwardArgs = getForwardArgList(forwardArgsToRun);
      outputBuffer = '';
      hasReceivedData = false;
      authInvalidHandledForCurrentSpawn = false;
      const activeRuntime = resolveLaunchRuntimeScope(
        cliName,
        activeAccountRef,
        isLogin,
        loginSessionId,
        activeGateway
      );
      ptyProc = spawnPty(cliName, cliPath, activeAccountRef, activeForwardArgs, isLogin, {
        rows: getChildPtyRows(activeForwardArgs),
        cliAccountId: activeId,
        loginSessionId,
        gateway: activeGateway
      });
      startBootWave();
      attachOnData(ptyProc, {
        accountRef: activeAccountRef,
        cliAccountId: activeId,
        runtimeDir: ptyProc.aihRuntimeDir || activeRuntime.runtimeDir,
        projectionRequired: activeRuntime.projectionRequired
      });
      startRuntimeHelpersOnce();
    }

    function isCodexInteractiveSession() {
      return cliName === 'codex'
        && isInteractiveRuntimeSession(activeForwardArgs);
    }

    function isCodexStartupAuthPreflightEnabled() {
      return String(processObj.env.AIH_CODEX_AUTH_PREFLIGHT || '1') !== '0';
    }

    function readUsageProbeError(id) {
      if (typeof getLastUsageProbeState === 'function') {
        const state = getLastUsageProbeState(cliName, id);
        if (state && state.error) return String(state.error || '');
      }
      if (typeof getLastUsageProbeError === 'function') {
        return String(getLastUsageProbeError(cliName, id) || '');
      }
      return '';
    }

    function shouldProbeCodexAuthBeforeStartup() {
      if (!isCodexInteractiveSession()) return false;
      if (!isBareInteractiveRuntimeSession(activeForwardArgs)) return false;
      if (!isCodexStartupAuthPreflightEnabled()) return false;
      if (readCodexApiKeyAccountInfo(activeAccountRef).apiKeyMode) return false;
      const row = getPersistedAccountState(activeAccountRef);
      if (!row) return false;
      if (row.apiKeyMode) return false;
      return typeof ensureUsageSnapshotAsync === 'function' || typeof ensureUsageSnapshot === 'function';
    }

    async function runCodexStartupAuthPreflight() {
      let probeText = '';
      try {
        await refreshUsageSnapshotNoCache(cliName, activeAccountRef);
      } catch (error) {
        probeText = String((error && error.message) || error || '');
      }

      const runtimeStatus = getPersistedRuntimeStatus(activeAccountRef);
      if (isAuthInvalidRuntimeStatus(runtimeStatus)) {
        return {
          blocked: true,
          reason: runtimeStatus.reason || 'auth_invalid_reauth_required'
        };
      }

      const reason = resolveAuthInvalidReason(probeText || readUsageProbeError(activeAccountRef));
      if (!reason) return { blocked: false, reason: '' };
      persistAuthInvalidRuntimeState(reason);
      return { blocked: true, reason };
    }

    function startAfterStartupPreflight() {
      const initialRuntimeStatus = getPersistedRuntimeStatus(activeAccountRef);
      if (isCodexInteractiveSession() && isAuthInvalidRuntimeStatus(initialRuntimeStatus)) {
        authInvalidHandledForCurrentSpawn = true;
        const nextId = getNextRuntimeAccountId();
        if (nextId && String(nextId) !== activeId) {
          switchToAccount(nextId, `account ${activeId} auth expired (${initialRuntimeStatus.reason || 'auth_invalid_reauth_required'})`);
          return;
        }
        openAuthRecoveryPrompt(initialRuntimeStatus.reason || 'auth_invalid_reauth_required');
        return;
      }

      if (!shouldProbeCodexAuthBeforeStartup()) {
        startActivePty(forwardArgs);
        return;
      }

      processObj.stdout.write(`\x1b[90m[aih]\x1b[0m checking account ${activeId} auth before starting Codex...\r\n`);
      Promise.resolve()
        .then(() => runCodexStartupAuthPreflight())
        .then((result) => {
          if (cleanedUp) return;
          if (result && result.blocked) {
            authInvalidHandledForCurrentSpawn = true;
            const nextId = getNextRuntimeAccountId();
            if (nextId && String(nextId) !== activeId) {
              switchToAccount(nextId, `account ${activeId} auth expired (${result.reason || 'auth_invalid_reauth_required'})`);
              return;
            }
            openAuthRecoveryPrompt(result.reason || 'auth_invalid_reauth_required');
            return;
          }
          startActivePty(forwardArgs);
        })
        .catch(() => {
          if (!cleanedUp) startActivePty(forwardArgs);
        });
    }

    function finalizeActiveTransientProjection() {
      if (
        !ptyProc
        || ptyProc.aihTransientAuthProjection !== true
        || ptyProc.aihPersistentSession === true
        || ptyProc.aihProjectionFinalized === true
      ) return;
      const runtimeDir = String(ptyProc.aihRuntimeDir || '').trim();
      if (!runtimeDir || !activeAccountRef) return;
      try { ptyProc.kill(); } catch (_error) {}
      captureProviderAuth(fs, runtimeDir, cliName, {
        path,
        aiHomeDir,
        accountRef: activeAccountRef,
        processObj
      });
      reconcileProviderResources(ensureSessionStoreLinks, cliName, activeAccountRef, {
        projectionRoot: runtimeDir
      });
      removeTransientAuthProjection(fs, runtimeDir, cliName, activeAccountRef, { path });
      ptyProc.aihProjectionFinalized = true;
    }

    sigintHandler = () => {
      stopThresholdWatcher();
      cleanupTerminalHooks();
      try {
        finalizeActiveTransientProjection();
      } catch (error) {
        console.error(`\x1b[31m[aih]\x1b[0m Transient auth cleanup failed: ${error.message}`);
      }
      cleanupTransientLoginRuntime();
      // An interactive Ctrl-C is a normal way to leave the session (exit 0), but
      // a headless run is a command in a script: report the interrupt honestly.
      exitAfterFlush(headlessRun ? 130 : 0);
    };
    processObj.on('SIGINT', sigintHandler);

    startAfterStartupPreflight();
  }

  function runCliPtyTracked(cliName, accountRef, forwardArgs, isLogin, runtimeOptions = {}) {
    const isGateway = runtimeOptions.gateway === true;
    if (accountRef && !isGateway) markActiveAccount(cliName, accountRef);
    if (String(processObj.env.AIH_RUNTIME_ENABLE_USAGE_SCHEDULER || '0') === '1') {
      ensureAccountUsageRefreshScheduler();
    }
    if (accountRef && !isGateway) {
      refreshIndexedStateForAccount(cliName, accountRef, { refreshSnapshot: false });
    }
    return runCliPty(cliName, accountRef, forwardArgs, isLogin, runtimeOptions);
  }

  return {
    runCliPty,
    runCliPtyTracked,
  };

};
