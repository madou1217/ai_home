'use strict';

const { randomUUID } = require('node:crypto');

const {
  isAuthInvalidRuntimeStatus
} = require('../../../account/runtime-view');
const {
  buildAihServerProfileEnv,
  normalizeServerHost,
  normalizeServerPort,
  supportsAihServerProfile
} = require('../../../account/self-relay-account');
const { readDefaultAccountRef } = require('../../../account/default-account-store');
const { resolveRuntimeTarget } = require('../../../account/runtime-target');
const {
  captureProviderAuth,
  registerProviderAuthProjection
} = require('../../../account/native-auth-projection');
const { resolveCodexSqliteHome } = require('../../../runtime/codex-home');
const { reconcileProviderResources } = require('../../../runtime/provider-resource-reconciliation');
const { readAccountCredentials } = require('../../../server/account-credential-store');
const { resolveAccountRefByCliId } = require('../../../server/account-ref-store');
const { createCodexLaunchSupport } = require('./codex-launch-support');
const { createHeadlessSpawn } = require('./headless-spawn');
const { createLocalClipboard } = require('./local-clipboard');
const { createRuntimeStateStore } = require('./runtime-state-store');
const { createUsageStatusRuntime } = require('./usage-status-runtime');
const { createShellDrawerController } = require('./shell-drawer-controller');
const { createSshClipboardBridge } = require('./ssh-clipboard-bridge');
const { createSshClipboardShims } = require('./ssh-clipboard-shims');
const { createPersistentLaunchWrapper } = require('./persistent-launch');
const { runSshMcpServerLoop } = require('./ssh-mcp-loop');
const { repairNativeBinaryIfNeeded } = require('../ai-cli/native-binary-repair');
const {
  buildCodexProviderArgs,
  hasCodexModelProviderArg,
  injectCodexProviderArgs
} = require('../ai-cli/codex-provider-args');
const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime,
  collectLocalRuntimePathEntries,
  resolveProviderRuntimeScope,
  stripAccountScopedEnv
} = require('../ai-cli/provider-runtime-env');
const {
  buildClaudeAccountRelayEnv,
  shouldRelayClaudeAccount
} = require('../ai-cli/claude-account-relay');
const { createClaudeDiagnosticScheduler } = require('./claude-diagnostic-scheduler');
const { createClaudeRetryObserver } = require('./claude-retry-observer');
const { createCodexInteractionObserver } = require('./codex-interaction-observer');
const { postJson } = require('../../../server/provider-session-hook-sender');
const {
  fetchSshClipAgentImage: defaultFetchSshClipAgentImage
} = require('../ssh-clipboard/clip-agent-client');

function resolvePtyTermName(processImpl = {}) {
  const value = String(processImpl && processImpl.env && processImpl.env.TERM || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,80}$/.test(value) && value !== 'dumb') {
    return value;
  }
  return 'xterm-256color';
}

function createPtyRuntime(options = {}) {
  const {
    path,
    fs,
    processObj,
    pty,
    spawn,
    spawnSync,
    execSync,
    resolveCliPath,
    readServerConfig,
    serverDaemon,
    buildPtyLaunch,
    resolveWindowsBatchLaunch,
    resolveWindowsNodeShimLaunch,
    shouldEnableShellDrawer,
    isShellDrawerToggleSequence,
    resolveShellDrawerLaunch,
    getShellDrawerPtyRows,
    getShellDrawerTotalHeight,
    readUsageConfig,
    cliConfigs,
    aiHomeDir,
    hostHomeDir,
    getAccountRuntimeDir,
    getGatewayRuntimeDir,
    getLoginRuntimeDir,
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
    checkStatus,
    markActiveAccount,
    ensureAccountUsageRefreshScheduler,
    refreshIndexedStateForAccount,
    accountArtifactHooks,
    DatabaseSync,
    fetchSshClipAgentImage = defaultFetchSshClipAgentImage
  } = options;
  let lastRuntimeEnv = {};

  function isUsageManagedCli(cliName) {
    return cliName === 'codex' || cliName === 'gemini' || cliName === 'claude';
  }

  function normalizeLoginForwardArgs(cliName, forwardArgs) {
    const input = Array.isArray(forwardArgs) ? [...forwardArgs] : [];
    const hasNoBrowser = input.some((arg) => String(arg || '').trim() === '--no-browser');
    const args = input.filter((arg) => String(arg || '').trim() !== '--no-browser');
    if (hasNoBrowser && cliName === 'codex' && !args.includes('--device-auth')) {
      args.push('--device-auth');
    }
    return args;
  }

  function waitForAihServerReady(serverDaemonRef, timeoutMs) {
    return waitForServerStatusReady(serverDaemonRef, timeoutMs);
  }

  function ensureLocalAihServerReady(serverConfig, options = {}) {
    if (!serverDaemon || typeof serverDaemon.status !== 'function') return null;
    if (typeof readServerConfig !== 'function') return null;
    let normalizedConfig = serverConfig || readServerConfig() || {};
    let port = Number(normalizedConfig.port);
    if (!Number.isFinite(port) || port <= 0) return null;

    let status = waitForAihServerReady(serverDaemon, Number(options.initialWaitMs) || 120);
    const shouldAutostart = String(processObj.env[options.autostartEnv || 'AIH_SERVER_AUTOSTART'] || '1') !== '0';
    if (
      status
      && status.running
      && status.stale
      && shouldAutostart
      && typeof serverDaemon.restart === 'function'
    ) {
      const staleMessage = typeof options.onStale === 'function'
        ? options.onStale(status)
        : 'Local AIH server source is stale';
      console.log(`\x1b[36m[aih]\x1b[0m ${staleMessage}`);
      try {
        const startPromise = serverDaemon.restart([], {
          waitForReady: false,
          readyTimeoutMs: Number(options.startReadyTimeoutMs) || 7000,
          gracefulStopWaitMs: 500
        });
        if (startPromise && typeof startPromise.catch === 'function') {
          startPromise.catch((error) => {
            const message = String((error && error.message) || error || 'unknown_error');
            console.warn(`\x1b[33m[aih]\x1b[0m Failed to restart local AIH server: ${message}`);
          });
        }
      } catch (error) {
        const message = String((error && error.message) || error || 'unknown_error');
        console.warn(`\x1b[33m[aih]\x1b[0m Failed to restart local AIH server: ${message}`);
        return null;
      }
      normalizedConfig = readServerConfig() || normalizedConfig;
      port = Number(normalizedConfig.port);
      status = waitForAihServerReady(serverDaemon, Number(options.postRestartWaitMs) || 1500);
    }
    if ((!status || !status.running) && shouldAutostart && typeof serverDaemon.start === 'function') {
      const startMessage = typeof options.onStart === 'function'
        ? options.onStart(status)
        : 'Local AIH server is not running, starting it now';
      console.log(`\x1b[36m[aih]\x1b[0m ${startMessage}`);
      try {
        const startPromise = serverDaemon.start([], {
          waitForReady: false,
          readyTimeoutMs: Number(options.startReadyTimeoutMs) || 7000
        });
        if (startPromise && typeof startPromise.catch === 'function') {
          startPromise.catch((error) => {
            const message = String((error && error.message) || error || 'unknown_error');
            console.warn(`\x1b[33m[aih]\x1b[0m Failed to autostart local AIH server: ${message}`);
          });
        }
      } catch (error) {
        const message = String((error && error.message) || error || 'unknown_error');
        console.warn(`\x1b[33m[aih]\x1b[0m Failed to autostart local AIH server: ${message}`);
        return null;
      }
      normalizedConfig = readServerConfig() || normalizedConfig;
      port = Number(normalizedConfig.port);
      status = waitForAihServerReady(serverDaemon, Number(options.postStartWaitMs) || 1500);
    }
    if (!status || !status.running || !status.ready) return null;
    return {
      host: normalizeServerHost(normalizedConfig.host),
      port,
      apiKey: String(normalizedConfig.apiKey || '').trim()
    };
  }

  function buildBuiltinServerProfileEnv(cliName) {
    if (!supportsAihServerProfile(cliName)) return {};
    const serverConfig = typeof readServerConfig === 'function' ? (readServerConfig() || {}) : {};
    const ready = ensureLocalAihServerReady(serverConfig, {
      autostartEnv: 'AIH_SERVER_AUTOSTART',
      onStart: () => 'Local AIH server profile is not running, starting it now',
      onStale: () => 'Local AIH server source is stale, restarting it now'
    });
    const effectiveConfig = ready || {
      host: normalizeServerHost(serverConfig.host),
      port: normalizeServerPort(serverConfig.port),
      apiKey: String(serverConfig.apiKey || '').trim()
    };
    const env = buildAihServerProfileEnv(cliName, effectiveConfig) || {};
    return env;
  }

  function resolveProviderHookReceiverUrl() {
    const serverConfig = typeof readServerConfig === 'function' ? (readServerConfig() || {}) : {};
    const port = normalizeServerPort(serverConfig.port);
    return `http://127.0.0.1:${port}/v0/webui/session-events/provider-hook`;
  }

  /**
   * 过滤宿主环境变量，确保账号独立性
   * 只保留系统级环境变量，移除与 AI CLI 相关的环境变量
   */
  function filterHostEnvVars(hostEnv) {
    const env = stripAccountScopedEnv(hostEnv);

    // Runtime controls are also account-local and must not leak between launches.
    const aiCliEnvKeys = [
      'AIH_CODEX_ENABLE_REMOTE_PROXY',
      'AIH_CODEX_DISABLE_REMOTE_PROXY',
      'AIH_CODEX_REMOTE_AUTOSTART',
      'AIH_CODEX_AUTO_SKIP_REPO_CHECK',
      'AIH_RUNTIME_USAGE_STATUS_BAR',
      'AIH_RUNTIME_SHOW_USAGE',
      'AIH_RUNTIME_USAGE_DISPLAY_INTERVAL_MS',
      'AIH_RUNTIME_USAGE_STALE_MS',
      'AIH_RUNTIME_USAGE_REFRESH_MIN_MS',
      'AIH_RUNTIME_AUTO_SWITCH',
      'AIH_RUNTIME_THRESHOLD_CHECK_MS',
      'AIH_RUNTIME_ENABLE_USAGE_SCHEDULER',
      'AIH_PROVIDER_SESSION_CORRELATION_ID',
      'AIH_DEBUG_CONFIG_SYNC',
      'CODEX_THREAD_ID',
      'CODEX_TURN_ID',
      'CODEX_CI',
      'CODEX_MANAGED_BY_NPM',
      'CODEX_MANAGED_BY_BUN',
      'CODEX_MANAGED_PACKAGE_ROOT',
      'CODEX_NETWORK_PROXY_ACTIVE',
      'CODEX_NETWORK_ALLOW_LOCAL_BINDING',
      'CODEX_PROXY_GIT_SSH_COMMAND'
    ];

    aiCliEnvKeys.forEach((key) => {
      delete env[key];
      // 同时删除小写版本
      delete env[key.toLowerCase()];
    });

    return env;
  }

  function normalizeRuntimeForwardArgs(cliName, forwardArgs, options = {}) {
    const args = Array.isArray(forwardArgs) ? [...forwardArgs] : [];
    if (cliName !== 'codex' || args.length === 0) return args;
    if (String(args[0] || '').trim() === '/resume') {
      if (args.length === 1 && !options.isLogin) {
        const threadId = resolveLatestCodexThreadIdForCwd(options.codexDir, processObj.cwd());
        if (threadId) return buildCodexAutoResumeArgs(threadId);
      }
      return ['resume', ...args.slice(1)];
    }
    return args;
  }

  // Headless (-p/--print) direct spawn lives in headless-spawn.js.
  const { shouldUseHeadlessDirectSpawn, spawnHeadlessDirect } = createHeadlessSpawn({
    spawn,
    processObj
  });
  function hasExplicitRemoteArg(args) {
    return (Array.isArray(args) ? args : []).some((arg) => {
      const text = String(arg || '').trim();
      return text === '--remote' || text.startsWith('--remote=');
    });
  }

  function isCodexResumeCommandArgs(args) {
    const firstArg = String((Array.isArray(args) ? args : [])[0] || '').trim();
    return firstArg === 'resume' || firstArg === '/resume';
  }

  function sleepSync(ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    if (!safeMs) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, safeMs);
  }

  function waitForServerStatusReady(serverDaemonRef, timeoutMs) {
    if (!serverDaemonRef || typeof serverDaemonRef.status !== 'function') {
      return { running: false, ready: false, state: 'stopped' };
    }
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let status = serverDaemonRef.status();
    while (status && status.running && !status.ready && Date.now() < deadline) {
      sleepSync(60);
      status = serverDaemonRef.status();
    }
    return status || { running: false, ready: false, state: 'stopped' };
  }

  function resolveCodexRemoteProxyConfig(forwardArgs, isLogin) {
    if (isLogin || hasExplicitRemoteArg(forwardArgs)) return null;
    if (String(processObj.env.AIH_CODEX_DISABLE_REMOTE_PROXY || '0') === '1') return null;
    const forceForResume = isCodexResumeCommandArgs(forwardArgs);
    if (!forceForResume && String(processObj.env.AIH_CODEX_ENABLE_REMOTE_PROXY || '0') !== '1') return null;
    const serverConfig = typeof readServerConfig === 'function' ? (readServerConfig() || {}) : {};
    const readiness = ensureLocalAihServerReady(serverConfig, {
      autostartEnv: 'AIH_CODEX_REMOTE_AUTOSTART',
      onStart: () => 'Codex remote proxy server not running, starting local aih server...',
      onStale: (status) => `Codex remote proxy server source is stale (${status.staleReason || 'source_changed'}), restarting local aih server...`
    });
    if (!readiness) return null;
    const safeHost = readiness.host;
    return {
      remoteUrl: `ws://${safeHost}:${readiness.port}`,
      authToken: readiness.apiKey
    };
  }

  function readSelectedDefaultAccountRef(cliName) {
    if (cliName !== 'codex') return '';
    return readDefaultAccountRef(fs, aiHomeDir, cliName);
  }

  // Codex on-disk state (thread resume / config sync) policy lives in
  // codex-launch-support.js.
  const {
    resolveLatestCodexThreadIdForCwd,
    buildCodexAutoResumeArgs,
    syncCodexConfigFromHost
  } = createCodexLaunchSupport({
    fs,
    path,
    hostHomeDir,
    aiHomeDir,
    getProfileDir,
    DatabaseSync,
    accountArtifactHooks
  });

  function getShellDrawerLayout() {
    const totalRows = Math.max(8, Number(processObj.stdout && processObj.stdout.rows) || 24);
    const drawerHeight = typeof getShellDrawerTotalHeight === 'function'
      ? getShellDrawerTotalHeight(processObj)
      : 7;
    const safeDrawerHeight = Math.max(5, Math.min(drawerHeight, totalRows - 3));
    const topBorderRow = Math.max(2, totalRows - safeDrawerHeight + 1);
    const headerRow = topBorderRow + 1;
    const contentTop = headerRow + 1;
    const bottomBorderRow = totalRows;
    const contentBottom = bottomBorderRow - 1;
    return {
      totalRows,
      topBorderRow,
      headerRow,
      contentTop,
      contentBottom,
      bottomBorderRow,
      ptyRows: Math.max(2, contentBottom - contentTop + 1)
    };
  }

  // SSH clipboard shim installation lives in ssh-clipboard-shims.js.
  const { installSshClipboardCommandShims } = createSshClipboardShims({
    fs,
    path,
    processObj,
    aiHomeDir
  });

  function resolveProjectionDir(cliName, accountRef, isLogin, loginSessionId, gateway = false) {
    if (gateway) {
      return typeof getGatewayRuntimeDir === 'function' ? getGatewayRuntimeDir(cliName) : hostHomeDir;
    }
    if (isLogin && loginSessionId && typeof getLoginRuntimeDir === 'function') {
      return getLoginRuntimeDir(cliName, loginSessionId);
    }
    if (accountRef) {
      return typeof getAccountRuntimeDir === 'function' ? getAccountRuntimeDir(cliName, accountRef) : '';
    }
    return isLogin && typeof getLoginRuntimeDir === 'function'
      ? getLoginRuntimeDir(cliName, loginSessionId)
      : '';
  }

  function resolveLaunchRuntimeScope(cliName, accountRef, isLogin, loginSessionId, gateway = false, accountEnv) {
    const projectionDir = resolveProjectionDir(cliName, accountRef, isLogin, loginSessionId, gateway);
    const storedEnv = accountEnv || (accountRef
      ? readAccountCredentials(fs, aiHomeDir, accountRef)
      : {});
    const authRelayed = shouldRelayClaudeAccount({
      provider: cliName,
      accountRef,
      accountEnv: storedEnv,
      isLogin,
      gateway
    });
    return resolveProviderRuntimeScope(cliName, projectionDir, processObj.env, {
      path,
      hostHomeDir,
      platform: processObj.platform,
      isLogin,
      gateway,
      authRelayed,
      accountEnv: storedEnv
    });
  }

  function resolveRuntimeDir(cliName, accountRef, isLogin, loginSessionId, gateway = false) {
    return resolveLaunchRuntimeScope(
      cliName,
      accountRef,
      isLogin,
      loginSessionId,
      gateway
    ).runtimeDir;
  }

  function spawnPty(cliName, cliBin, accountRef, forwardArgs, isLogin, spawnOptions = {}) {
    const selectedRef = String(accountRef || '').trim();
    const selectedCliAccountId = String(spawnOptions.cliAccountId || '').trim();
    const loginSessionId = String(spawnOptions.loginSessionId || '').trim();
    const pendingLogin = Boolean(isLogin && !selectedRef && loginSessionId);
    const runtimeTarget = pendingLogin
      ? { gateway: false, accountRef: '' }
      : resolveRuntimeTarget({
        gateway: spawnOptions.gateway === true,
        accountRef: selectedRef
      });
    if (!runtimeTarget) throw new Error('invalid_account_runtime_target');
    const isBuiltinServerProfile = runtimeTarget.gateway;
    const selectedAccountRef = runtimeTarget.accountRef;
    const persistentCliAccountId = isBuiltinServerProfile
      ? '.aih-server'
      : selectedCliAccountId;

    // API-key/token credentials come only from app-state.db. The built-in
    // gateway target is rebuilt from the current server config on every launch.
    var loadedEnv = {};
    if (isBuiltinServerProfile) {
      loadedEnv = buildBuiltinServerProfileEnv(cliName) || {};
    } else if (selectedAccountRef) {
      loadedEnv = readAccountCredentials(fs, aiHomeDir, selectedAccountRef);
    }
    const relayClaudeAccount = shouldRelayClaudeAccount({
      provider: cliName,
      accountRef: selectedAccountRef,
      accountEnv: loadedEnv,
      isLogin,
      gateway: isBuiltinServerProfile
    });
    const storedAccountEnv = loadedEnv;
    if (relayClaudeAccount) {
      loadedEnv = buildClaudeAccountRelayEnv(
        buildBuiltinServerProfileEnv('claude'),
        selectedAccountRef
      );
    }

    const launchRuntime = resolveLaunchRuntimeScope(
      cliName,
      selectedAccountRef,
      isLogin,
      loginSessionId,
      isBuiltinServerProfile,
      storedAccountEnv
    );
    const sandboxDir = launchRuntime.runtimeDir;
    const usesAuthProjection = launchRuntime.projectionRequired;
    if (!sandboxDir) throw new Error('invalid_account_runtime_scope');
    if (usesAuthProjection) fs.mkdirSync(sandboxDir, { recursive: true });
    if (isLogin && usesAuthProjection) {
      reconcileProviderResources(
        ensureSessionStoreLinks,
        cliName,
        selectedAccountRef || `login-${loginSessionId || 'transient'}`,
        { projectionRoot: sandboxDir }
      );
    }
    const authSnapshotBefore = usesAuthProjection && !isBuiltinServerProfile && accountArtifactHooks
      && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
      ? accountArtifactHooks.snapshotAccountAuthArtifacts(cliName, selectedAccountRef, sandboxDir)
      : null;

    const notifyDefaultAuthUpdatedIfChanged = (source, reason) => {
      if (!authSnapshotBefore || !accountArtifactHooks || typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged !== 'function') return;
      accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
        provider: cliName,
        accountRef: selectedAccountRef,
        runtimeDir: sandboxDir,
        before: authSnapshotBefore,
        source,
        reason
      });
    };

    const codexConfigDir = path.join(sandboxDir, '.codex');
    const codexSqliteHome = cliName === 'codex'
      ? resolveCodexSqliteHome({ path, hostHomeDir, aiHomeDir, profileDir: sandboxDir })
      : '';

    if (cliName === 'codex' && usesAuthProjection && !isLogin) {
      const accountBaseUrl = String(loadedEnv.OPENAI_BASE_URL || '').trim();
      const accountApiKey = String(loadedEnv.OPENAI_API_KEY || '').trim();

      reconcileProviderResources(ensureSessionStoreLinks, cliName, selectedAccountRef);
      try {
        fs.mkdirSync(codexConfigDir, { recursive: true });
        const codexHostConfigPath = codexSqliteHome ? path.join(codexSqliteHome, 'config.toml') : '';
        syncCodexConfigFromHost(
          path.join(codexConfigDir, 'config.toml'),
          codexHostConfigPath,
          selectedAccountRef,
          { fs, path },
          {
            isApiKeyMode: Boolean(accountApiKey),
            openaiBaseUrl: accountBaseUrl,
            openaiApiKey: accountApiKey,
            sqliteHome: codexSqliteHome,
            forceAihProvider: Boolean(accountBaseUrl || accountApiKey),
            providerKeyOverride: ''
          }
        );
      } catch (_error) {}
      reconcileProviderResources(ensureSessionStoreLinks, cliName, selectedAccountRef);
      notifyDefaultAuthUpdatedIfChanged('pty_runtime_configure', 'codex_auth_artifacts_updated_before_spawn');
    }
    // 账号隔离的 env 注入交由 provider 专属策略决定（见 ai-cli/launch-profile）。
    // 运行时不再分支 provider 名，新增/调整某个 provider 的隔离方式只改策略表。
    // Optional launch-time hygiene (e.g. trimming regenerable caches that a
    // fake HOME would otherwise accumulate). Non-fatal.
    const launchBaseEnv = filterHostEnvVars(processObj.env);

    try {
      prepareProviderRuntime(cliName, sandboxDir, launchBaseEnv, {
        sandboxDir,
        codexConfigDir,
        codexSqliteHome,
        hostHomeDir,
        platform: processObj.platform,
        path,
        fs,
        isLogin,
        aiHomeDir,
        accountRef: selectedAccountRef,
        accountEnv: loadedEnv,
        materializeAuth: usesAuthProjection,
        requireNativeAuth: Boolean(selectedAccountRef && Object.keys(loadedEnv).length === 0)
      });
    } catch (error) {
      if (selectedAccountRef || cliName === 'opencode') throw error;
      console.warn(`\x1b[33m[aih]\x1b[0m Launch prepare failed for ${cliName}:`, error.message);
    }
    const envOverrides = buildProviderRuntimeEnv(cliName, sandboxDir, launchBaseEnv, {
      path,
      fs,
      hostHomeDir,
      platform: processObj.platform,
      codexConfigDir,
      codexSqliteHome,
      isLogin,
      aiHomeDir,
      accountRef: selectedAccountRef,
      accountEnv: loadedEnv
    });
    const sessionCorrelationId = ['claude', 'codex'].includes(cliName) && !isLogin
      ? randomUUID()
      : '';
    if (sessionCorrelationId) {
      envOverrides.AIH_PROVIDER_SESSION_CORRELATION_ID = sessionCorrelationId;
    }

    const normalizedForwardArgs = normalizeRuntimeForwardArgs(cliName, forwardArgs, {
      codexDir: codexSqliteHome,
      isLogin
    });
    const useNativeRestoreResume = cliName === 'codex'
      && !isLogin
      && String(processObj.env.AIH_PERSIST_DETACHED || '') === '1'
      && isCodexResumeCommandArgs(normalizedForwardArgs);
    if (useNativeRestoreResume) {
      // Reboot restoration already resolves an exact local thread id. Keep the
      // resume in the credential-bearing TUI process instead of routing it
      // through the server-side app-server, which cannot inherit this launch's
      // account-scoped environment.
      envOverrides.AIH_CODEX_DISABLE_REMOTE_RESUME = '1';
    }
    const argsToRunBase = isLogin
      ? [...(cliConfigs[cliName]?.loginArgs || []), ...normalizeLoginForwardArgs(cliName, forwardArgs)]
      : normalizedForwardArgs;
    const argsToRun = Array.isArray(argsToRunBase) ? [...argsToRunBase] : [];
    if (cliName === 'codex') {
      if (
        !isLogin
        && !hasCodexModelProviderArg(argsToRun)
      ) {
        const withProviderArgs = injectCodexProviderArgs(
          argsToRun,
          buildCodexProviderArgs(loadedEnv, {
            force: isBuiltinServerProfile
          })
        );
        argsToRun.splice(0, argsToRun.length, ...withProviderArgs);
      }
      var defaultAccountRef = readSelectedDefaultAccountRef(cliName);
      var allowRemoteProxy = isBuiltinServerProfile
        || (defaultAccountRef && defaultAccountRef === selectedAccountRef);
      var remoteProxy = allowRemoteProxy && !useNativeRestoreResume
        ? resolveCodexRemoteProxyConfig(normalizedForwardArgs, isLogin)
        : null;
      if (remoteProxy) {
        argsToRun.unshift('--remote', remoteProxy.remoteUrl);
        if (remoteProxy.authToken) {
          envOverrides.AIH_CODEX_REMOTE_AUTH_TOKEN = remoteProxy.authToken;
          argsToRun.unshift('--remote-auth-token-env', 'AIH_CODEX_REMOTE_AUTH_TOKEN');
        }
      }
    }
    if (
      cliName === 'codex'
      && !isLogin
      && String(processObj.env.AIH_CODEX_AUTO_SKIP_REPO_CHECK || '0') === '1'
      && !argsToRun.includes('--skip-git-repo-check')
    ) {
      argsToRun.unshift('--skip-git-repo-check');
    }
    installSshClipboardCommandShims(envOverrides, {
      cliName,
      id: persistentCliAccountId
    });
    if (processObj.env.AIH_REMOTE_SSH && !isLogin) {
      const remoteSshStr = String(processObj.env.AIH_REMOTE_SSH).trim();
      let sshTarget = '';
      let remoteRoot = '';
      const colonIndex = remoteSshStr.indexOf(':');
      if (colonIndex !== -1) {
        sshTarget = remoteSshStr.slice(0, colonIndex);
        remoteRoot = remoteSshStr.slice(colonIndex + 1);
      } else {
        sshTarget = remoteSshStr;
        remoteRoot = '.';
      }
      if (sshTarget && remoteRoot) {
        const currentAihBin = path.resolve(__dirname, '../../../../bin/ai-home.js');
        const mcpConfigObj = {
          mcpServers: {
            "ssh-remote": {
              "command": "node",
              "args": [
                currentAihBin,
                "__ssh_mcp__",
                "--target",
                sshTarget,
                "--remote-root",
                remoteRoot
              ]
            }
          }
        };
        const tempMcpPath = path.join(sandboxDir, 'mcp_remote_ssh.json');
        try {
          fs.writeFileSync(tempMcpPath, JSON.stringify(mcpConfigObj, null, 2), 'utf8');
          argsToRun.unshift('--strict-mcp-config');
          argsToRun.unshift('--mcp-config', tempMcpPath);
        } catch (err) {
          console.warn(`\x1b[33m[aih]\x1b[0m 写入临时 MCP 配置文件失败:`, err.message);
        }
      }
    }
    const batchLaunch = resolveWindowsBatchLaunch(cliName, cliBin || cliName, envOverrides, processObj.platform);
    const launchBin = batchLaunch.launchBin || cliName;
    Object.assign(envOverrides, batchLaunch.envPatch || {});
    lastRuntimeEnv = envOverrides;
    const launch = buildPtyLaunch(launchBin, argsToRun, { platform: processObj.platform });
    const useHeadlessDirect = typeof spawn === 'function' && shouldUseHeadlessDirectSpawn(cliName, argsToRun, isLogin);
    const finalLaunch = useHeadlessDirect ? launch : maybeWrapPersistentLaunch(launch, {
      cliName,
      cliBin: cliBin || cliName,
      argsToRun,
      accountRef: selectedAccountRef,
      gateway: isBuiltinServerProfile,
      runtimeScope: runtimeTarget.runtimeScope,
      runtimeDir: launchRuntime.runtimeDir,
      usesAuthProjection,
      cliAccountId: persistentCliAccountId,
      isLogin,
      envOverrides
    });
    if (useHeadlessDirect) {
      const spawned = spawnHeadlessDirect(finalLaunch, { env: envOverrides });
      if (spawned && sessionCorrelationId) spawned.aihSessionCorrelationId = sessionCorrelationId;
      return spawned;
    }
    const spawnedPty = pty.spawn(finalLaunch.command, finalLaunch.args, {
      name: resolvePtyTermName(processObj),
      cols: processObj.stdout.columns || 80,
      rows: spawnOptions.rows || processObj.stdout.rows || 24,
      cwd: processObj.cwd(),
      env: envOverrides
    });
    if (spawnedPty && finalLaunch && finalLaunch.socket && finalLaunch.session) {
      spawnedPty.aihPersistentSession = true;
    }
    if (spawnedPty && sessionCorrelationId) {
      spawnedPty.aihSessionCorrelationId = sessionCorrelationId;
    }
    return spawnedPty;
  }

  // Persistent tmux/psmux wrapping + session registry policy lives in
  // persistent-launch.js; the runtime only asks it to wrap launches and to
  // reconcile the registry when the foreground client exits.
  const {
    maybeWrapPersistentLaunch,
    reconcileRegistryAfterExit
  } = createPersistentLaunchWrapper({
    fs,
    path,
    processObj,
    spawnSync,
    aiHomeDir,
    hostHomeDir,
    resolveCliPath,
    askYesNo,
    resolveWindowsNodeShimLaunch
  });

  function spawnShellDrawerPty() {
    const launch = typeof resolveShellDrawerLaunch === 'function'
      ? resolveShellDrawerLaunch(processObj)
      : { command: '/bin/sh', args: [] };
    const layout = getShellDrawerLayout();
    const drawerRows = typeof getShellDrawerPtyRows === 'function'
      ? getShellDrawerPtyRows(processObj)
      : layout.ptyRows;
    return pty.spawn(launch.command, Array.isArray(launch.args) ? launch.args : [], {
      name: resolvePtyTermName(processObj),
      cols: processObj.stdout.columns || 80,
      rows: Math.max(2, Math.min(drawerRows, layout.ptyRows)),
      cwd: processObj.cwd(),
      env: {
        ...processObj.env,
        AIH_SHELL_DRAWER: '1'
      }
    });
  }

  // aih 把 native CLI 装在仓库内的运行时目录（.runtime-tools/bin、.node-runtime/<ver>/bin），
  // provider spawn 时靠 collectLocalRuntimePathEntries 注入这些目录到 PATH 才找得到。但终端
  // `aih <provider>` 走的是裸 process PATH → 明明已装却报 not found → 又去跑裸 npm（新机器上系统
  // 常无 npm）。这里把运行时目录并进解析 PATH，让 resolveCliPath 先命中已装的 CLI。
  const runtimeRootDir = path.resolve(__dirname, '..', '..', '..', '..');
  function resolveCliPathWithRuntimeTools(cliName) {
    let resolved = resolveCliPath(cliName);
    if (resolved) return resolved;
    const runtimeEntries = collectLocalRuntimePathEntries({ path, fs, runtimeRootDir });
    if (runtimeEntries.length === 0) return '';
    const baseEnv = processObj.env || {};
    const sep = path.delimiter || ':';
    const augmentedPath = [...runtimeEntries, ...(String(baseEnv.PATH || '').split(sep))]
      .filter(Boolean).join(sep);
    return resolveCliPath(cliName, { env: { ...baseEnv, PATH: augmentedPath } });
  }

  // 自动安装用「内置 node 的 npm」——新机器（如 AWS）系统 PATH 常无 npm，但 aih 自带 node 运行时旁边
  // 就有 npm-cli.js。用 <bundled-node> <npm-cli.js> 调用，不依赖系统 npm；-g 装到内置 node 的 bin
  // （.node-runtime/<ver>/bin），正好是上面 resolveCliPathWithRuntimeTools 会搜的目录。
  function resolveBundledNpmInstall(pkg) {
    const nodeExec = String(processObj.execPath || '').trim();
    if (nodeExec) {
      const nodeBinDir = path.dirname(nodeExec);
      const npmCli = path.join(nodeBinDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      try {
        if (fs.existsSync(npmCli)) {
          return { command: nodeExec, args: [npmCli, 'install', '-g', pkg] };
        }
      } catch (_error) { /* 回退 */ }
      const siblingNpm = path.join(nodeBinDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
      try {
        if (fs.existsSync(siblingNpm)) {
          return { command: siblingNpm, args: ['install', '-g', pkg] };
        }
      } catch (_error) { /* 回退 */ }
    }
    // 最后兜底：系统 npm（可能仍不存在，交由 spawnSync 报错）。
    return { command: 'npm', args: ['install', '-g', pkg] };
  }

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
    let cliPath = resolveCliPathWithRuntimeTools(cliName);
    if (!cliPath) {
      console.log(`\x1b[33m[aih] Native CLI '${cliName}' not found.\x1b[0m`);
      const pkg = cliConfigs[cliName] && String(cliConfigs[cliName].pkg || '').trim();
      if (!pkg) {
        console.error(`\x1b[31m[aih] ${cliName} has no npm auto-install package configured. Install the native CLI first, then retry.\x1b[0m`);
        processObj.exit(1);
        return;
      }
      const ans = askYesNo('Do you want to automatically install it via npm?');
      if (ans) {
        const install = resolveBundledNpmInstall(pkg);
        console.log(`\n\x1b[36m[aih]\x1b[0m Installing \x1b[33m${pkg}\x1b[0m...`);
        const installResult = spawnSync(install.command, install.args, { stdio: 'inherit' });
        if (installResult.status !== 0) {
          console.error(`\x1b[31m[aih] Failed to install ${cliName} (${pkg}). Install it manually, then retry.\x1b[0m`);
          processObj.exit(1);
          return;
        }
        console.log(`\x1b[32m[aih] Successfully installed ${cliName}!\x1b[0m\n`);
      } else {
        processObj.exit(1);
      }
      cliPath = resolveCliPathWithRuntimeTools(cliName);
      if (!cliPath) {
        console.error(`\x1b[31m[aih] ${cliName} is still not in PATH after install.\x1b[0m`);
        processObj.exit(1);
      }
    }

    if (String(processObj.env.AIH_NATIVE_BINARY_REPAIR || '1') !== '0') {
      const nativeRepair = repairNativeBinaryIfNeeded(cliName, cliPath, {
        fs,
        path,
        spawnSync,
        processObj,
        nodeExecPath: processObj.execPath,
        onRepairStart: () => {
          console.log(`\x1b[36m[aih]\x1b[0m Claude native binary is missing; running @anthropic-ai/claude-code postinstall repair...`);
        }
      });
      if (nativeRepair && nativeRepair.needed) {
        if (nativeRepair.ok && nativeRepair.repaired) {
          console.log(`\x1b[36m[aih]\x1b[0m Claude native binary was missing; postinstall repair completed.`);
        } else if (!nativeRepair.ok) {
          console.error(`\x1b[33m[aih]\x1b[0m Claude native binary is missing; attempted @anthropic-ai/claude-code postinstall repair but it failed.`);
          const reason = String(nativeRepair.reason || 'unknown_error');
          console.error(`\x1b[33m[aih]\x1b[0m Reason: ${reason}`);
          if (nativeRepair.detail) {
            console.error(`\x1b[90m[aih]\x1b[0m ${nativeRepair.detail}`);
          }
          console.error(`\x1b[90m[aih]\x1b[0m Next step: reinstall Claude Code without --ignore-scripts / --omit=optional, then retry.`);
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
    console.log(`\n\x1b[36m[aih]\x1b[0m 🚀 Running \x1b[33m${cliName}\x1b[0m (${targetLabel}) via PTY`);
    const initialLaunchRuntime = resolveLaunchRuntimeScope(
      cliName,
      initialRef,
      isLogin,
      loginSessionId,
      initialGateway
    );
    const initialSessionSync = !isLogin && initialRef
      && initialLaunchRuntime.projectionRequired
      ? reconcileProviderResources(ensureSessionStoreLinks, cliName, initialRef)
      : { migrated: 0, linked: 0 };
    if (initialSessionSync.migrated > 0 || initialSessionSync.linked > 0) {
      console.log(`\x1b[36m[aih]\x1b[0m Session links ready (${cliName}): migrated ${initialSessionSync.migrated}, linked ${initialSessionSync.linked}.`);
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
      isCleanedUp: () => cleanedUp
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

    function startBootWave() {
      if (waveInterval) return;
      waveInterval = setInterval(() => {
        if (!hasReceivedData) {
          processObj.stdout.write(`\r\x1b[36m[aih]\x1b[0m Waiting for ${cliName} to boot${waveFrames[waveIdx++]}\x1b[K`);
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

    const canUseRawMode = !!(processObj.stdin && processObj.stdin.isTTY && typeof processObj.stdin.setRawMode === 'function');
    if (canUseRawMode) {
      processObj.stdin.setRawMode(true);
    }
    processObj.stdin.resume();


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
      cancelCodexAutoPrompt();
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
    let codexPromptBuffer = '';
    let lastAutoPromptSignature = '';
    let codexAutoPromptTimer = null;
    let codexAutoPromptInput = '';
    let codexAutoPromptToken = 0;
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
      getRuntimeEnv: () => lastRuntimeEnv,
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

    function cleanupTerminalHooks() {
      if (cleanedUp) return;
      cleanedUp = true;
      stopBootWave();
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
      cancelCodexAutoPrompt();
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
        if (nextRuntime.projectionRequired) {
          reconcileProviderResources(ensureSessionStoreLinks, cliName, nextAccount.accountRef);
        }
      } catch (error) {
        processObj.stdout.write(`\r\n\x1b[31m[aih] Account switch blocked: ${error.message}\x1b[0m\r\n`);
        return;
      }
      isSwapping = true;
      const fromId = activeId;
      const fromRuntimeDir = resolveRuntimeDir(cliName, activeAccountRef, false, '', activeGateway);
      const fromCodexDir = path.join(fromRuntimeDir, '.codex');
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
          runtimeDir: nextRuntime.runtimeDir,
          projectionRequired: nextRuntime.projectionRequired
        });
        startRuntimeHelpersOnce();
        emitUsageStatus(activeAccountRef, { forcePrint: true, forceRefresh: true });
        isSwapping = false;
      }, 250);
    }

    function resolveCodexAutoPromptInput(text) {
      if (cliName !== 'codex' || isLogin) return '';
      const plain = stripAnsi(String(text || '')).toLowerCase();
      if (!plain.trim()) return '';
      if (plain.includes('upgrade') && plain.includes('skip')) {
        return 'skip\r';
      }
      if (plain.includes('press enter to continue')) {
        return '\r';
      }
      return '';
    }

    function cancelCodexAutoPrompt() {
      codexAutoPromptToken += 1;
      if (codexAutoPromptTimer) {
        clearTimeout(codexAutoPromptTimer);
        codexAutoPromptTimer = null;
      }
      codexAutoPromptInput = '';
    }

    function handleCodexAutoPromptOutput(data, proc) {
      if (!proc || typeof proc.write !== 'function') return;
      codexPromptBuffer = `${codexPromptBuffer}${String(data || '')}`.slice(-4000);
      const input = resolveCodexAutoPromptInput(codexPromptBuffer);
      if (!input) return;
      const signature = `${input}|${stripAnsi(codexPromptBuffer).slice(-500)}`;
      if (signature === lastAutoPromptSignature) return;
      if (codexAutoPromptTimer && codexAutoPromptInput === input) return;
      cancelCodexAutoPrompt();
      codexAutoPromptInput = input;
      const promptToken = codexAutoPromptToken;
      codexAutoPromptTimer = setTimeout(() => {
        if (promptToken !== codexAutoPromptToken) return;
        codexAutoPromptTimer = null;
        codexAutoPromptInput = '';
        if (cleanedUp || proc !== ptyProc) return;
        lastAutoPromptSignature = signature;
        proc.write(input);
      }, 10_000);
      if (codexAutoPromptTimer && typeof codexAutoPromptTimer.unref === 'function') {
        codexAutoPromptTimer.unref();
      }
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
        handleCodexAutoPromptOutput(data, proc);
        if (attachedCodexInteractionObserver) attachedCodexInteractionObserver.observe(data);
        if (claudeRetryObserver) claudeRetryObserver.observe(data);
        scheduleClaudeHookDiagnostic(data);
        scheduleClaudeToolDiagnostic(data);
        if (!hasReceivedData) {
          hasReceivedData = true;
          stopBootWave();
          processObj.stdout.write('\r\x1b[K');
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

      proc.onExit(({ exitCode }) => {
        if (attachedCodexInteractionObserver) {
          attachedCodexInteractionObserver.clear('process-exited');
          attachedCodexInteractionObserver.stop();
        }
        if (codexInteractionObserver === attachedCodexInteractionObserver) {
          codexInteractionObserver = null;
        }
        let reconciliationError = null;
        if (spawnedProjectionRequired && spawnedAccountRef && spawnedRuntimeDir) {
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
              reconcileProviderResources(ensureSessionStoreLinks, cliName, spawnedAccountRef);
            } catch (error) {
              reconciliationError = error;
              console.error(`\x1b[31m[aih]\x1b[0m Provider resource reconciliation failed: ${error.message}`);
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
                processObj
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
            processObj.stdout.write('\r\n');
            processObj.exit(reconciliationError ? 1 : (exitCode || 0));
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
      const activeRuntimeDir = activeRuntime.runtimeDir;
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
        runtimeDir: activeRuntimeDir,
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

    sigintHandler = () => {
      stopThresholdWatcher();
      cleanupTerminalHooks();
      cleanupTransientLoginRuntime();
      processObj.exit(0);
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
    runCliPtyTracked
  };
}

module.exports = {
  createPtyRuntime,
  runSshMcpServerLoop
};
