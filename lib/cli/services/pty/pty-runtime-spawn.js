'use strict';

const { randomUUID } = require('node:crypto');

const { resolveRuntimeTarget } = require('../../../account/runtime-target');

const { resolveCodexSqliteHome } = require('../../../runtime/codex-home');

const persistentSession = require('../../../runtime/persistent-session');
const { readCodexFlag, setCodexFlag } = require('../../../runtime/codex-flags');

const { reconcileProviderResources } = require('../../../runtime/provider-resource-reconciliation');

const {
  createTransientAuthProjectionLease,
  removeTransientAuthProjection
} = require('../../../runtime/transient-auth-projection');

const { readAccountCredentials } = require('../../../server/account-credential-store');
const { resolveAccountRef } = require('../../../server/account-ref-store');

const { healCodexConfigFile } = require('./codex-config-heal');

const { getProviderLaunchStrategy } = require('../ai-cli/launch-profile');

const { createHeadlessSpawn } = require('./headless-spawn');

const { createSshClipboardShims } = require('./ssh-clipboard-shims');

const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime,
  collectLocalRuntimePathEntries,
  resolveProviderRuntimeScope,
  stripAccountScopedEnv
} = require('../ai-cli/provider-runtime-env');

const {
  getCliRelayProfile,
  supportsCrossProviderHarness
} = require('../ai-cli/relay/cli-relay-profile');
const { applySessionKeyTransport } = require('../ai-cli/relay/session-key-delivery');

const { buildToolPermissionLaunchArgs } = require('../toolkit/tool-permission-launch');

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

    // 会话关联 id：本会话的稳定身份。网关模式下它还要作为**会话键**
    // 送到网关，标题才能把服务端的选号结果关联回本会话（见
    // lib/runtime/route-observation.js），所以必须在网关 env 构造之前生成。
    const sessionCorrelationId = ['claude', 'codex'].includes(cliName) && !isLogin
      ? randomUUID()
      : '';

    // API-key/token credentials come only from app-state.db. The built-in
    // gateway target is rebuilt from the current server config on every launch.
    var loadedEnv = {};
    if (isBuiltinServerProfile) {
      const relayProfileForGateway = getCliRelayProfile(cliName);
      // 会话键送达：送达通道由 relay profile 声明（claude 的 ANTHROPIC_CUSTOM_HEADERS、
      // codex 的 AIH_CODEX_GATEWAY_SESSION_KEY）。送达失败只是标题少一帧，绝不影响启动。
      loadedEnv = applySessionKeyTransport(
        relayProfileForGateway,
        buildBuiltinServerProfileEnv(cliName) || {},
        sessionCorrelationId
      );
    } else if (selectedAccountRef) {
      loadedEnv = readAccountCredentials(fs, aiHomeDir, selectedAccountRef);
    }
    // 跨 Provider harness：accountRef 属于身份账号，可能不是 cliName 的 provider。
    // 这类启动的唯一合法上游是本地网关（钉选 x-account-ref），因此不读取、不投影
    // 身份账号的原生凭据；否则 Claude 的 token 会被塞进 Codex 的 auth.json。
    const identityRecord = selectedAccountRef
      ? resolveAccountRef(fs, aiHomeDir, selectedAccountRef, { bestEffort: true })
      : null;
    const identityProvider = String(identityRecord && identityRecord.provider || '').trim().toLowerCase();
    const crossProvider = Boolean(
      identityProvider && identityProvider !== cliName && !isBuiltinServerProfile
    );
    if (crossProvider && isLogin) {
      throw new Error(`cross_provider_login_unsupported:${cliName}`);
    }
    if (crossProvider) loadedEnv = {};

    // 账号 relay 判定与 env 构造经 CliRelayProfile 注册表分发（策略模式），
    // 不再按 provider 名硬编码分支。
    const relayProfile = getCliRelayProfile(cliName);
    if (crossProvider && !supportsCrossProviderHarness(cliName)) {
      throw new Error(`cross_provider_relay_unsupported:${cliName}`);
    }
    const relayAccount = crossProvider
      ? true
      : Boolean(relayProfile) && relayProfile.shouldRelayAccount({
        provider: cliName,
        accountRef: selectedAccountRef,
        accountEnv: loadedEnv,
        args: forwardArgs,
        isLogin,
        gateway: isBuiltinServerProfile
      });
    const storedAccountEnv = loadedEnv;
    if (relayAccount) {
      const gatewayEnv = buildBuiltinServerProfileEnv(cliName) || {};
      if (crossProvider && Object.keys(gatewayEnv).length === 0) {
        throw new Error(`cross_provider_gateway_unavailable:${cliName}`);
      }
      // 会话键已在网关 env 构造时送达（见上方 isBuiltinServerProfile 分支）。
      loadedEnv = crossProvider
        ? relayProfile.buildCrossProviderEnv(gatewayEnv, selectedAccountRef)
        : relayProfile.buildAccountRelayEnv(gatewayEnv, selectedAccountRef);
    }

    const launchRuntime = resolveLaunchRuntimeScope(
      cliName,
      selectedAccountRef,
      isLogin,
      loginSessionId,
      isBuiltinServerProfile,
      storedAccountEnv,
      { crossProvider }
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
        authRelayed: relayAccount,
        gateway: isBuiltinServerProfile,
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
      codexConfigDir,
      codexSqliteHome,
      isLogin,
      aiHomeDir,
      accountRef: selectedAccountRef,
      accountEnv: loadedEnv,
      authRelayed: relayAccount,
      // 当前网络被账号上游按地区拒绝时拒绝启动（见 runtime/egress-launch-guard）。
      networkGuard: true,
      // 本进程就是会话本身：出口池「会话独占」策略下认领一条独立车道（见 runtime/egress-pool-session-lease）。
      egressSession: !isLogin
    });
    if (sessionCorrelationId) {
      persistentSession.setSessionIntentField(envOverrides, 'correlation', sessionCorrelationId);
    }
    // codex 的 managed-launch 标记由 buildProviderRuntimeEnv 统一注入（PTY / WebUI
    // 原生会话 / 登录 / 用量采集共用同一条装配线），此处不再重复设置。

    const normalizedForwardArgs = normalizeRuntimeForwardArgs(cliName, forwardArgs, {
      codexDir: codexSqliteHome,
      isLogin
    });
    const useNativeRestoreResume = cliName === 'codex'
      && !isLogin
      && persistentSession.readSessionIntentField(processObj.env, 'detached') === '1'
      && isCodexResumeCommandArgs(normalizedForwardArgs);
    if (useNativeRestoreResume) {
      // Reboot restoration already resolves an exact local thread id. Keep the
      // resume in the credential-bearing TUI process instead of routing it
      // through the server-side app-server, which cannot inherit this launch's
      // account-scoped environment.
      setCodexFlag(envOverrides, 'disableRemoteResume', '1');
    }
    const argsToRunBase = isLogin
      ? [...(cliConfigs[cliName]?.loginArgs || []), ...normalizeLoginForwardArgs(cliName, forwardArgs)]
      : normalizedForwardArgs;
    let argsToRun = Array.isArray(argsToRunBase) ? [...argsToRunBase] : [];
    // Providers that isolate auth via an explicit config-dir flag (Qoder).
    argsToRun = injectConfigDirArgs(cliName, argsToRun, sandboxDir);
    // provider 专属启动参数（例如 cline 的 `-P <槽位>` 推导）由启动策略声明，
    // 运行时依旧不分支 provider 名 —— 新增 provider 只改它自己的策略。
    const launchArgsStrategy = getProviderLaunchStrategy(cliName);
    if (typeof launchArgsStrategy.buildLaunchArgs === 'function') {
      const providerLaunchArgs = launchArgsStrategy.buildLaunchArgs({ cliName, sandboxDir, path, fs, argv: argsToRun });
      if (Array.isArray(providerLaunchArgs) && providerLaunchArgs.length > 0) {
        argsToRun = [...providerLaunchArgs, ...argsToRun];
      }
    }
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
    }
    // provider relay 的启动整形（codex 的 -c model_provider 参数手术、claude 的
    // --settings）经 CliRelayProfile 注册表分发；kimi 不实现 buildRelayLaunch，此处为 null。
    const relayLaunchPatch = relayProfile && typeof relayProfile.buildRelayLaunch === 'function'
      ? relayProfile.buildRelayLaunch({
        args: argsToRun,
        accountEnv: loadedEnv,
        isLogin,
        gateway: isBuiltinServerProfile,
        crossProvider,
        accountRef: selectedAccountRef,
        identityProvider,
        launchStorage: { fs, aiHomeDir }
      })
      : null;
    if (relayLaunchPatch) {
      if (Array.isArray(relayLaunchPatch.args)) {
        argsToRun.splice(0, argsToRun.length, ...relayLaunchPatch.args);
      }
      if (relayLaunchPatch.env && typeof relayLaunchPatch.env === 'object') {
        Object.assign(envOverrides, relayLaunchPatch.env);
      }
    }
    if (cliName === 'codex') {
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
      && String(readCodexFlag(processObj.env, 'autoSkipRepoCheck', '0')) === '1'
      && !argsToRun.includes('--skip-git-repo-check')
    ) {
      argsToRun.unshift('--skip-git-repo-check');
    }
    // 默认最大权限：合同声明的免确认参数 + 用户在 WebUI 的逐 Provider 开关。
    // 用户显式传了任何权限旗标时不覆盖（尊重原生参数）。
    const permissionLaunch = buildToolPermissionLaunchArgs({
      provider: cliName,
      argv: argsToRun,
      isLogin,
      fs,
      aiHomeDir,
      // 宿主 home 是「读谁的 CLI 配置」的显式依据：配置里已经表达的权限不再用命令行重复
      // （见 permission-host-state）。不传就等于不读配置、照常注入最大权限。
      hostHomeDir,
      env: processObj.env,
      // 账户级权限设置只作用于这一个账号，优先级高于 provider 级（见 tool-app-settings）。
      // 缺了它，账户级设置存得下、读得到（API 层），启动时却永远用不上。
      // 内置 AIH Server profile（不带号）没有账户级设置可言，传空即只读 provider 级。
      accountRef: selectedAccountRef,
      // 组合根可注入设置读取器（测试或未来的设置后端）；缺省读 app-state。
      readSettings: typeof deps.readToolPermissionSettings === 'function'
        ? deps.readToolPermissionSettings
        : undefined
    });
    if (permissionLaunch.applied && permissionLaunch.args.length) {
      // 旗标落点由 provider 启动策略决定（opencode 的 `--auto` 只认 `run` 之后）；
      // 没声明的 provider 放最前 —— 它们的权限旗标都是根级参数（子命令前后都认）。
      argsToRun = typeof launchArgsStrategy.placePermissionArgs === 'function'
        ? launchArgsStrategy.placePermissionArgs(argsToRun, permissionLaunch.args)
        : [...permissionLaunch.args, ...argsToRun];
    } else if (permissionLaunch.notice) {
      // 跳过注入必须可见：否则用户只会看到「怎么又在问我权限」。
      try {
        processObj.stderr.write(`\x1b[90m[aih]\x1b[0m ${permissionLaunch.notice}\n`);
      } catch (_error) {}
    }
    installSshClipboardCommandShims(envOverrides, {
      cliName,
      id: persistentCliAccountId
    });
    const remoteSshStr = String(persistentSession.readSessionIntentField(processObj.env, 'remoteSsh')).trim();
    if (remoteSshStr && !isLogin) {
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
      // 终端标题里要有会话名：这个名字只有这里算得出来（裸启动名带
      // 时间戳/pid 后缀，事后无法重算），所以随 pty 一起带出去。
      spawnedPty.aihSessionName = String(finalLaunch.session);
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
