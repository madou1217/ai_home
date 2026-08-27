'use strict';

const {
  buildAihServerProfileEnv,
  normalizeServerHost,
  normalizeServerPort,
  supportsAihServerProfile
} = require('../../../account/self-relay-account');

const { readDefaultAccountRef } = require('../../../account/default-account-store');

const { CODEX_MANAGED_LAUNCH_ENV } = require('../../../runtime/codex-launch-context');

const { readAccountCredentials } = require('../../../server/account-credential-store');

const {
  collectNativeCliPathEntries,
  listProviderBinaryNames,
  resolveNativeCliInstallPlans
} = require('../ai-cli/native-cli-installer');

const { getAiCliBinaryName, getAiCliConfig } = require('../ai-cli/provider-registry');

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

module.exports = function createPtyRuntimeLaunchDomain(deps, helpers) {

  const {
    path,
    fs,
    processObj,
    spawnSync,
    resolveCliPath,
    readServerConfig,
    serverDaemon,
    getShellDrawerTotalHeight,
    aiHomeDir,
    hostHomeDir,
    getAccountRuntimeDir,
    getGatewayRuntimeDir,
    getLoginRuntimeDir,
  } = deps;

  const { codexLaunchSupport } = helpers;

  const {
    resolveLatestCodexThreadIdForCwd,
    buildCodexAutoResumeArgs,
  } = codexLaunchSupport;

  const runtimeRootDir = path.resolve(__dirname, '..', '..', '..', '..');

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
    if (cliName === 'opencode' && !useBuiltinServerProfile) {
      env.AIH_OPENCODE_GATEWAY_BYOK = '1';
    }
    return env;
  }

  function resolveProviderHookReceiverUrl() {
    const serverConfig = typeof readServerConfig === 'function' ? (readServerConfig() || {}) : {};
    const port = normalizeServerPort(serverConfig.port);
    return `http://127.0.0.1:${port}/v0/webui/session-events/provider-hook`;
  }

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
      CODEX_MANAGED_LAUNCH_ENV,
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

  function resolveCliPathWithRuntimeTools(cliName) {
    // Providers whose PATH binary differs from the aih provider id (e.g. qoder →
    // qodercli, zcode → zcode.cjs) resolve through binaryName plus the strategy
    // declared binary names. Fallback remains the provider id.
    const binaryName = getAiCliBinaryName(cliName) || cliName;
    const strategyBinaryNames = listProviderBinaryNames(cliName, { processObj })
      .filter((name) => name && name !== binaryName && name !== cliName);
    const nativeEntries = collectNativeCliPathEntries(cliName, { path, hostHomeDir, processObj });
    const runtimeEntries = collectLocalRuntimePathEntries({ path, fs, runtimeRootDir });
    const preferredEntries = [...nativeEntries, ...runtimeEntries];
    const candidateNames = [binaryName, ...strategyBinaryNames, cliName];
    if (preferredEntries.length > 0) {
      const baseEnv = processObj.env || {};
      const sep = path.delimiter || ':';
      const augmentedPath = [...preferredEntries, ...(String(baseEnv.PATH || baseEnv.Path || '').split(sep))]
        .filter(Boolean).join(sep);
      for (const candidate of candidateNames) {
        const preferred = resolveCliPath(candidate, { env: { ...baseEnv, PATH: augmentedPath } });
        if (preferred) return preferred;
      }
    }
    for (const candidate of candidateNames) {
      const resolved = resolveCliPath(candidate);
      if (resolved) return resolved;
    }
    const allEntries = [...nativeEntries, ...runtimeEntries];
    if (allEntries.length === 0) return '';
    const baseEnv = processObj.env || {};
    const sep = path.delimiter || ':';
    const augmentedPath = [...allEntries, ...(String(baseEnv.PATH || baseEnv.Path || '').split(sep))]
      .filter(Boolean).join(sep);
    for (const candidate of candidateNames) {
      const resolved = resolveCliPath(candidate, { env: { ...baseEnv, PATH: augmentedPath } });
      if (resolved) return resolved;
    }
    return '';
  }

  function injectConfigDirArgs(cliName, args, configDir) {
    const config = getAiCliConfig(cliName);
    const flag = config && String(config.configDirFlag || '').trim();
    const dir = String(configDir || '').trim();
    if (!flag || !dir) return Array.isArray(args) ? [...args] : [];
    const next = Array.isArray(args) ? [...args] : [];
    // Avoid double-injecting when the user already passed --config-dir.
    if (next.some((arg) => String(arg || '').trim() === flag)) return next;
    next.unshift(flag, dir);
    return next;
  }

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
      const platform = String(processObj.platform || process.platform || '').trim();
      const siblingNpm = path.join(nodeBinDir, platform === 'win32' ? 'npm.cmd' : 'npm');
      try {
        if (fs.existsSync(siblingNpm)) {
          return { command: siblingNpm, args: ['install', '-g', pkg] };
        }
      } catch (_error) { /* 回退 */ }
    }
    // 最后兜底：系统 npm（可能仍不存在，交由 spawnSync 报错）。
    return { command: 'npm', args: ['install', '-g', pkg] };
  }

  return {
    isUsageManagedCli,
    normalizeLoginForwardArgs,
    waitForAihServerReady,
    ensureLocalAihServerReady,
    buildBuiltinServerProfileEnv,
    resolveProviderHookReceiverUrl,
    filterHostEnvVars,
    normalizeRuntimeForwardArgs,
    hasExplicitRemoteArg,
    isCodexResumeCommandArgs,
    sleepSync,
    waitForServerStatusReady,
    resolveCodexRemoteProxyConfig,
    readSelectedDefaultAccountRef,
    getShellDrawerLayout,
    resolveProjectionDir,
    resolveLaunchRuntimeScope,
    resolveRuntimeDir,
    resolveCliPathWithRuntimeTools,
    injectConfigDirArgs,
    resolveBundledNpmInstall,
  };

};
