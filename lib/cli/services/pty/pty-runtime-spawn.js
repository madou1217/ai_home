'use strict';

const { randomUUID } = require('node:crypto');

const { resolveRuntimeTarget } = require('../../../account/runtime-target');

const { resolveCodexSqliteHome } = require('../../../runtime/codex-home');

const { reconcileProviderResources } = require('../../../runtime/provider-resource-reconciliation');

const {
  createTransientAuthProjectionLease,
  removeTransientAuthProjection
} = require('../../../runtime/transient-auth-projection');

const { readAccountCredentials } = require('../../../server/account-credential-store');

const { healCodexConfigFile } = require('./codex-config-heal');

const { createHeadlessSpawn } = require('./headless-spawn');

const { createSshClipboardShims } = require('./ssh-clipboard-shims');

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

function resolvePtyTermName(processImpl = {}) {
  const value = String(processImpl && processImpl.env && processImpl.env.TERM || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,80}$/.test(value) && value !== 'dumb') {
    return value;
  }
  return 'xterm-256color';
}

module.exports = function createPtyRuntimeSpawnDomain(deps, launch, helpers) {

  const {
    path,
    fs,
    processObj,
    pty,
    spawn,
    buildPtyLaunch,
    resolveWindowsBatchLaunch,
    resolveShellDrawerLaunch,
    getShellDrawerPtyRows,
    cliConfigs,
    aiHomeDir,
    hostHomeDir,
    ensureSessionStoreLinks,
    accountArtifactHooks,
  } = deps;

  const {
    normalizeLoginForwardArgs,
    buildBuiltinServerProfileEnv,
    ensureAccountEgressRuntimeReady,
    filterHostEnvVars,
    normalizeRuntimeForwardArgs,
    isCodexResumeCommandArgs,
    resolveCodexRemoteProxyConfig,
    readSelectedDefaultAccountRef,
    getShellDrawerLayout,
    resolveLaunchRuntimeScope,
    injectConfigDirArgs,
  } = launch;

  const {
    shared,
    codexLaunchSupport,
    persistentWrapper,
  } = helpers;

  const {
    syncCodexConfigFromHost,
  } = codexLaunchSupport;
  const {
    maybeWrapPersistentLaunch,
  } = persistentWrapper;

  const { shouldUseHeadlessDirectSpawn, spawnHeadlessDirect } = createHeadlessSpawn({
    spawn,
    processObj
  });
  const { installSshClipboardCommandShims } = createSshClipboardShims({
    fs,
    path,
    processObj,
    aiHomeDir
  });

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
    let sandboxDir = launchRuntime.runtimeDir;
    const usesAuthProjection = launchRuntime.projectionRequired;
    if (!sandboxDir) throw new Error('invalid_account_runtime_scope');
    const transientAuthProjection = cliName === 'codex'
      && usesAuthProjection
      && !isLogin
      && !isBuiltinServerProfile;
    const transientProjectionLease = transientAuthProjection
      ? createTransientAuthProjectionLease(fs, cliName, selectedAccountRef, { path })
      : null;
    if (transientProjectionLease) sandboxDir = transientProjectionLease.runtimeDir;
    const cleanupTransientAuthProjection = () => transientProjectionLease?.release();
    if (usesAuthProjection) fs.mkdirSync(sandboxDir, { recursive: true });
    if (isLogin && usesAuthProjection) {
      reconcileProviderResources(
        ensureSessionStoreLinks,
        cliName,
        selectedAccountRef || `login-${loginSessionId || 'transient'}`,
        { projectionRoot: sandboxDir }
      );
    }
    const authSnapshotBefore = usesAuthProjection
      && !transientAuthProjection
      && !isBuiltinServerProfile
      && accountArtifactHooks
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

      try {
        reconcileProviderResources(ensureSessionStoreLinks, cliName, selectedAccountRef, {
          projectionRoot: sandboxDir
        });
      } catch (error) {
        cleanupTransientAuthProjection();
        throw error;
      }
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
            providerKeyOverride: '',
            notifyArtifactHooks: !transientAuthProjection
          }
        );
      } catch (_error) {}
      try {
        reconcileProviderResources(ensureSessionStoreLinks, cliName, selectedAccountRef, {
          projectionRoot: sandboxDir
        });
      } catch (error) {
        cleanupTransientAuthProjection();
        throw error;
      }
      notifyDefaultAuthUpdatedIfChanged('pty_runtime_configure', 'codex_auth_artifacts_updated_before_spawn');
    }
    // 账号隔离的 env 注入交由 provider 专属策略决定（见 ai-cli/launch-profile）。
    // 运行时不再分支 provider 名，新增/调整某个 provider 的隔离方式只改策略表。
    // Optional launch-time hygiene (e.g. trimming regenerable caches that a
    // fake HOME would otherwise accumulate). Non-fatal.
    const launchBaseEnv = filterHostEnvVars(processObj.env);

    try {
      ensureAccountEgressRuntimeReady(selectedAccountRef, {
        isLogin,
        gateway: isBuiltinServerProfile
      });
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
      if (selectedAccountRef || cliName === 'opencode') {
        cleanupTransientAuthProjection();
        throw error;
      }
      console.warn(`\x1b[33m[aih]\x1b[0m Launch prepare failed for ${cliName}:`, error.message);
    }
    const envOverrides = buildProviderRuntimeEnv(cliName, sandboxDir, launchBaseEnv, {
      path,
      fs,
      hostHomeDir,
      platform: processObj.platform,
      processObj,
      codexConfigDir,
      codexSqliteHome,
      isLogin,
      aiHomeDir,
      accountRef: selectedAccountRef,
      accountEnv: loadedEnv
    });
    // codex 的 managed-launch 标记由 buildProviderRuntimeEnv 统一注入（PTY / WebUI
    // 原生会话 / 登录 / 用量采集共用同一条装配线），此处不再重复设置。
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
    let argsToRun = Array.isArray(argsToRunBase) ? [...argsToRunBase] : [];
    // Providers that isolate auth via an explicit config-dir flag (Qoder).
    argsToRun = injectConfigDirArgs(cliName, argsToRun, sandboxDir);
    if (cliName === 'codex') {
      // WSL/Windows 共用宿主 config.toml 时 mcp_servers 的跨端路径自愈：
      // /mnt/<drive>/... 与 X:\... 可无损转换则启动时改写（两端启动都正确），
      // 绝对路径两种形态都不存在才清理死条目——坏 MCP 会打断 codex 启动
      // （blender os error 3 连累 codex_apps 未初始化，2026-08-22）。
      if (hostHomeDir) {
        healCodexConfigFile(path.join(hostHomeDir, '.codex', 'config.toml'), {
          fs,
          platform: processObj.platform,
          log: (message) => {
            try { processObj.stderr.write(`${message}\n`); } catch (_error) {}
          }
        });
      }
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
    shared.lastRuntimeEnv = envOverrides;
    const launch = buildPtyLaunch(launchBin, argsToRun, { platform: processObj.platform });
    const useHeadlessDirect = typeof spawn === 'function' && shouldUseHeadlessDirectSpawn(cliName, argsToRun, isLogin);
    let finalLaunch;
    try {
      finalLaunch = useHeadlessDirect ? launch : maybeWrapPersistentLaunch(launch, {
        cliName,
        cliBin: cliBin || cliName,
        argsToRun,
        accountRef: selectedAccountRef,
        gateway: isBuiltinServerProfile,
        runtimeScope: runtimeTarget.runtimeScope,
        runtimeDir: sandboxDir,
        usesAuthProjection,
        cliAccountId: persistentCliAccountId,
        isLogin,
        envOverrides
      });
    } catch (error) {
      cleanupTransientAuthProjection();
      throw error;
    }
    const attachesExistingPersistentSession = Boolean(
      finalLaunch
      && finalLaunch.socket
      && Array.isArray(finalLaunch.args)
      && finalLaunch.args.includes('attach-session')
    );
    if (transientAuthProjection && attachesExistingPersistentSession) {
      cleanupTransientAuthProjection();
    }
    const spawnedTransientAuthProjection = transientAuthProjection
      && !attachesExistingPersistentSession;
    if (useHeadlessDirect) {
      let spawned;
      try {
        spawned = spawnHeadlessDirect(finalLaunch, { env: envOverrides, provider: cliName });
      } catch (error) {
        cleanupTransientAuthProjection();
        throw error;
      }
      if (spawned && sessionCorrelationId) spawned.aihSessionCorrelationId = sessionCorrelationId;
      if (spawned) {
        spawned.aihRuntimeDir = sandboxDir;
        spawned.aihTransientAuthProjection = spawnedTransientAuthProjection;
      }
      return spawned;
    }
    let spawnedPty;
    try {
      spawnedPty = pty.spawn(finalLaunch.command, finalLaunch.args, {
        name: resolvePtyTermName(processObj),
        cols: processObj.stdout.columns || 80,
        rows: spawnOptions.rows || processObj.stdout.rows || 24,
        cwd: processObj.cwd(),
        env: envOverrides,
        ...(processObj.platform === 'win32' ? { useConptyDll: true } : {})
      });
    } catch (error) {
      cleanupTransientAuthProjection();
      throw error;
    }
    if (spawnedPty && finalLaunch && finalLaunch.socket && finalLaunch.session) {
      spawnedPty.aihPersistentSession = true;
    }
    if (spawnedPty && sessionCorrelationId) {
      spawnedPty.aihSessionCorrelationId = sessionCorrelationId;
    }
    if (spawnedPty) {
      spawnedPty.aihRuntimeDir = sandboxDir;
      spawnedPty.aihTransientAuthProjection = spawnedTransientAuthProjection;
    }
    return spawnedPty;
  }

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
      },
      ...(processObj.platform === 'win32' ? { useConptyDll: true } : {})
    });
  }

  return {
    spawnPty,
    spawnShellDrawerPty,
  };

};
