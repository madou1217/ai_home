'use strict';

const {
  extractAccountOnlyConfig,
  extractModelProviderName,
  getAihProviderKey,
  isAihManagedProviderKey,
  mergeConfigs,
  normalizeCodexConfigSyncOptions,
  scopeAccountOnlyConfig
} = require('./codex-config-sync');
const {
  deriveRuntimeStatus,
  isBlockingRuntimeStatus,
  isAuthInvalidRuntimeStatus,
  formatRuntimeStatusSummary
} = require('../../../account/runtime-view');
const {
  buildAuthInvalidRuntimeState
} = require('../../../account/runtime-state-builders');
const {
  buildAihServerProfileEnv,
  isAihServerProfileId,
  normalizeServerHost,
  normalizeServerPort,
  supportsAihServerProfile
} = require('../../../account/self-relay-account');
const { resolveCodexSqliteHome } = require('../../../runtime/codex-home');
const persistentSession = require('../../../runtime/persistent-session');
const { repairNativeBinaryIfNeeded } = require('../ai-cli/native-binary-repair');
const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime
} = require('../ai-cli/provider-runtime-env');
const { formatUsageWindows } = require('../usage/window-format');
const {
  appendClaudeHookDiagnosticLog,
  appendClaudeToolDiagnosticLog,
  collectClaudeStopHookDiagnostics,
  collectClaudeToolProtocolDiagnostics,
  containsClaudeToolProtocolProblem,
  containsClaudeStopHookJsonValidationError
} = require('./claude-hook-diagnostics');
const {
  createClipboardFrameParser,
  DEFAULT_MAX_BYTES: SSH_CLIP_DEFAULT_MAX_BYTES
} = require('../ssh-clipboard/frames');
const {
  buildSshClipboardSessionKey,
  createSshClipboardInbox
} = require('../ssh-clipboard/inbox');
const {
  extractBracketedPastePayload,
  isAltVClipboardTrigger,
  isEmptyBracketedPaste
} = require('../ssh-clipboard/keys');
const {
  buildOsc52ClipboardReadQuery,
  buildOsc5522ClipboardListMimeTypesQuery,
  buildOsc5522ClipboardReadMimeQuery,
  buildOsc5522ClipboardReadImageQuery,
  OSC5522_IMAGE_MIME_TYPES,
  OSC5522_TEXT_IMAGE_MIME_TYPES,
  buildTerminalClipboardPasteEventsModeSequence,
  buildTerminalClipboardPasteEventsSupportQuery,
  createTerminalClipboardImageParser,
  decodeTerminalClipboardImagePayload
} = require('../ssh-clipboard/terminal-clipboard');
const {
  fetchSshClipAgentImage: defaultFetchSshClipAgentImage
} = require('../ssh-clipboard/clip-agent-client');
const {
  DEFAULT_SHIM_TIMEOUT_MS,
  createShimRequestParser,
  isSafeShimResponsePath
} = require('../ssh-clipboard/shim-protocol');
const {
  normalizeImageForInjection
} = require('../ssh-clipboard/image-normalizer');

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
    shouldEnableShellDrawer,
    isShellDrawerToggleSequence,
    resolveShellDrawerLaunch,
    getShellDrawerPtyRows,
    getShellDrawerTotalHeight,
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
    checkStatus,
    markActiveAccount,
    ensureAccountUsageRefreshScheduler,
    refreshIndexedStateForAccount,
    accountArtifactHooks,
    DatabaseSync,
    fetchSshClipAgentImage = defaultFetchSshClipAgentImage
  } = options;

  let resolvedDatabaseSync = null;
  let didResolveDatabaseSync = false;

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

  /**
   * 过滤宿主环境变量，确保账号独立性
   * 只保留系统级环境变量，移除与 AI CLI 相关的环境变量
   */
  function filterHostEnvVars(hostEnv) {
    const env = { ...(hostEnv || {}) };

    // 需要移除的 AI CLI 相关环境变量
    const aiCliEnvKeys = [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_ORGANIZATION',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'AIH_CLAUDE_CREDENTIAL_TYPE',
      'ANTHROPIC_MODEL',
      'CLAUDE_MODEL',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'AGY_ACCESS_TOKEN',
      'GOOGLE_OAUTH_ACCESS_TOKEN',
      'OPENCODE_API_KEY',
      'OPENCODE_CONFIG',
      'OPENCODE_CONFIG_DIR',
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_SERVER_PASSWORD',
      'OPENCODE_SERVER_USERNAME',
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
        if (threadId) return buildCodexAutoResumeArgs(options.accountId, threadId);
      }
      return ['resume', ...args.slice(1)];
    }
    return args;
  }

  function shouldUseHeadlessDirectSpawn(cliName, args, isLogin) {
    if (isLogin) return false;
    if (String(processObj.env.AIH_HEADLESS_DIRECT_SPAWN || '1') === '0') return false;
    if (cliName !== 'claude') return false;
    return (Array.isArray(args) ? args : []).some((arg) => {
      const token = String(arg || '').trim();
      return token === '-p' || token === '--print' || token.startsWith('--print=');
    });
  }

  function spawnHeadlessDirect(launch, options = {}) {
    const bufferedData = [];
    let dataHandler = null;
    let exitHandler = null;
    let pendingExit = null;
    let child = null;

    const emitData = (chunk) => {
      const text = String(chunk || '');
      if (!text) return;
      if (dataHandler) {
        dataHandler(text);
        return;
      }
      bufferedData.push(text);
    };
    const emitExit = (exitCode) => {
      const event = { exitCode: exitCode == null ? 1 : Number(exitCode) };
      if (exitHandler) {
        exitHandler(event);
        return;
      }
      pendingExit = event;
    };

    try {
      child = spawn(launch.command, Array.isArray(launch.args) ? launch.args : [], {
        cwd: processObj.cwd(),
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      emitData(`${String((error && error.message) || error)}\n`);
      emitExit(1);
    }

    if (child) {
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', emitData);
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', emitData);
      }
      if (typeof child.on === 'function') {
        child.on('error', (error) => {
          emitData(`${String((error && error.message) || error)}\n`);
          emitExit(1);
        });
        child.on('close', emitExit);
      }
    }

    return {
      onData(cb) {
        dataHandler = typeof cb === 'function' ? cb : null;
        while (dataHandler && bufferedData.length > 0) {
          dataHandler(bufferedData.shift());
        }
      },
      onExit(cb) {
        exitHandler = typeof cb === 'function' ? cb : null;
        if (exitHandler && pendingExit) {
          const event = pendingExit;
          pendingExit = null;
          exitHandler(event);
        }
      },
      write() {},
      resize() {},
      kill() {
        if (child && typeof child.kill === 'function') {
          child.kill();
        }
      }
    };
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

  function readSelectedDefaultAccountId(cliName, sandboxDir) {
    if (cliName !== 'codex') return '';
    const profileRoot = path.dirname(String(sandboxDir || ''));
    const defaultPath = path.join(profileRoot, '.aih_default');
    if (!fs.existsSync(defaultPath)) return '';
    try {
      return String(fs.readFileSync(defaultPath, 'utf8') || '').trim();
    } catch (_error) {
      return '';
    }
  }

  function getDatabaseSyncCtor() {
    if (DatabaseSync) return DatabaseSync;
    if (didResolveDatabaseSync) return resolvedDatabaseSync;
    didResolveDatabaseSync = true;
    try {
      ({ DatabaseSync: resolvedDatabaseSync } = require('node:sqlite'));
    } catch (_error) {
      resolvedDatabaseSync = null;
    }
    return resolvedDatabaseSync;
  }

  function normalizeProjectPathForLookup(projectPath) {
    const normalizedPath = String(projectPath || '').trim();
    if (!normalizedPath) return '';
    return normalizedPath.replace(/\/+$/, '');
  }

  function listCodexStateDbPaths(codexDir) {
    try {
      if (!fs.existsSync(codexDir)) return [];
      return fs.readdirSync(codexDir)
        .filter((entryName) => /^state_\d+\.sqlite$/i.test(entryName))
        .map((entryName) => path.join(codexDir, entryName))
        .sort((left, right) => {
          const leftVersion = Number((path.basename(left).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
          const rightVersion = Number((path.basename(right).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
          if (leftVersion !== rightVersion) return rightVersion - leftVersion;
          try {
            if (typeof fs.statSync !== 'function') return 0;
            return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
          } catch (_error) {
            return 0;
          }
        });
    } catch (_error) {
      return [];
    }
  }

  function getSqliteTableColumns(db, tableName) {
    try {
      return new Set(
        db.prepare(`PRAGMA table_info(${tableName})`).all()
          .map((row) => String(row && row.name || '').trim())
          .filter(Boolean)
      );
    } catch (_error) {
      return new Set();
    }
  }

  function buildLatestCodexThreadQuery(columns) {
    if (!columns.has('id') || !columns.has('cwd')) return '';
    const whereParts = ['cwd = ?'];
    if (columns.has('archived')) whereParts.push('archived = 0');
    const orderExpr = columns.has('updated_at_ms') && columns.has('updated_at')
      ? 'COALESCE(updated_at_ms, updated_at * 1000)'
      : columns.has('updated_at_ms')
        ? 'updated_at_ms'
        : columns.has('updated_at')
          ? 'updated_at * 1000'
          : 'id';
    return `
      SELECT id
      FROM threads
      WHERE ${whereParts.join(' AND ')}
      ORDER BY ${orderExpr} DESC, id DESC
      LIMIT 1
    `;
  }

  function resolveLatestCodexThreadIdForCwd(codexDir, cwd) {
    const normalizedCwd = normalizeProjectPathForLookup(cwd);
    if (!normalizedCwd) return '';
    const DatabaseSyncCtor = getDatabaseSyncCtor();
    if (!DatabaseSyncCtor) return '';

    for (const stateDbPath of listCodexStateDbPaths(codexDir)) {
      let db = null;
      try {
        db = new DatabaseSyncCtor(stateDbPath, { readOnly: true });
        if (typeof db.exec === 'function') db.exec('PRAGMA query_only = ON;');
        const query = buildLatestCodexThreadQuery(getSqliteTableColumns(db, 'threads'));
        if (!query) continue;
        const row = db.prepare(query).get(normalizedCwd);
        const threadId = String(row && row.id || '').trim();
        if (threadId) return threadId;
      } catch (_error) {
        continue;
      } finally {
        if (db && typeof db.close === 'function') {
          try { db.close(); } catch (_closeError) {}
        }
      }
    }

    return '';
  }

  function readCodexModelFromConfig(configPath) {
    if (!configPath || !fs.existsSync(configPath)) return '';
    try {
      const text = String(fs.readFileSync(configPath, 'utf8') || '');
      const match = text.match(/^\s*model\s*=\s*"([^"]+)"\s*$/m);
      return match ? String(match[1] || '').trim() : '';
    } catch (_error) {
      return '';
    }
  }

  function readCodexModelProviderFromConfig(configPath) {
    if (!configPath || !fs.existsSync(configPath)) return '';
    try {
      const text = String(fs.readFileSync(configPath, 'utf8') || '');
      const match = text.match(/^\s*model_provider\s*=\s*"([^"]+)"\s*$/m);
      return match ? String(match[1] || '').trim() : '';
    } catch (_error) {
      return '';
    }
  }

  function resolveAihServerProviderKeyOverride(hostConfigPath) {
    const hostProvider = readCodexModelProviderFromConfig(hostConfigPath);
    return isAihManagedProviderKey(hostProvider) ? hostProvider : '';
  }

  function readCurrentCodexModel(accountId) {
    const hostCodexHome = resolveCodexSqliteHome({ path, hostHomeDir, aiHomeDir });
    const hostConfigPath = hostCodexHome ? path.join(hostCodexHome, 'config.toml') : '';
    return readCodexModelFromConfig(hostConfigPath)
      || readCodexModelFromConfig(path.join(getProfileDir('codex', accountId), '.codex', 'config.toml'));
  }

  function buildCodexAutoResumeArgs(accountId, threadId) {
    const model = readCurrentCodexModel(accountId);
    const args = ['resume'];
    if (model) args.push('-m', model);
    if (threadId) {
      args.push(threadId);
    } else {
      args.push('--last');
    }
    return args;
  }

  /**
   * 同步宿主的非敏感配置到账号专属配置
   * @param {string} accountConfigPath - 账号配置文件路径
   * @param {string} hostConfigPath - 宿主配置文件路径
   * @param {string} accountId - 账号 ID
   * @param {{fs: any, path: any}} deps - 依赖
   * @param {{openaiBaseUrl?: string, isApiKeyMode?: boolean}} options - 可选配置
   */
  function syncCodexConfigFromHost(accountConfigPath, hostConfigPath, accountId, deps, options = {}) {
    const { fs } = deps;
    const normalizedOptions = normalizeCodexConfigSyncOptions(options);
    const providerKey = getAihProviderKey(accountId);
    const configSnapshotBefore = accountArtifactHooks
      && typeof accountArtifactHooks.snapshotAccountConfigArtifacts === 'function'
      ? accountArtifactHooks.snapshotAccountConfigArtifacts('codex', accountId)
      : null;

    const notifyConfigUpdatedIfChanged = (source, reason) => {
      if (!configSnapshotBefore || !accountArtifactHooks || typeof accountArtifactHooks.notifyAccountConfigUpdatedIfChanged !== 'function') return;
      accountArtifactHooks.notifyAccountConfigUpdatedIfChanged({
        provider: 'codex',
        accountId,
        before: configSnapshotBefore,
        source,
        reason
      });
    };

    // 1. 账号 config 只保留账号运行覆盖项；其他内容必须从全局模板重建。
    let accountOnlyConfig = {
      preferred_auth_method: null,
      model_provider: null,
      providers: [],
      model_providers: []
    };
    let accountConfigText = '';

    if (fs.existsSync(accountConfigPath)) {
      accountConfigText = fs.readFileSync(accountConfigPath, 'utf8');
      accountOnlyConfig = extractAccountOnlyConfig(accountConfigText);
    }

    // 2. 读取宿主配置
    if (!hostConfigPath || !fs.existsSync(hostConfigPath)) {
      // 如果宿主配置不存在,确保账号配置至少有头部
      if (!fs.existsSync(accountConfigPath)) {
        const defaultConfig = '# Codex configuration for account ' + accountId + '\n' +
          '# This file is managed by ai-home (aih)\n' +
          '# Synced from host config (excluding sensitive fields)\n\n';
        fs.writeFileSync(accountConfigPath, defaultConfig, 'utf8');
      }
      // ✅ 即使没有宿主配置,也要写入 API Key / shared sqlite 配置
      if (normalizedOptions.isApiKeyMode || normalizedOptions.sqliteHome) {
        const fallbackOptions = {
          ...normalizedOptions,
          forceAihProvider: Boolean(
            normalizedOptions.forceAihProvider
            || normalizedOptions.openaiBaseUrl
            || extractModelProviderName(accountOnlyConfig.model_provider) === providerKey
            || isAihManagedProviderKey(extractModelProviderName(accountOnlyConfig.model_provider))
          )
        };
        const mergedConfig = mergeConfigs(
          '',
          scopeAccountOnlyConfig(accountOnlyConfig, accountId, fallbackOptions),
          accountId,
          fallbackOptions
        );
        fs.writeFileSync(accountConfigPath, mergedConfig, 'utf8');
      }
      notifyConfigUpdatedIfChanged('pty_config_sync', 'codex_config_synced_from_missing_host_template');
      return;
    }

    const hostConfig = fs.readFileSync(hostConfigPath, 'utf8');
    const effectiveOptions = {
      ...normalizedOptions,
      forceAihProvider: Boolean(
        normalizedOptions.forceAihProvider
        || normalizedOptions.isApiKeyMode
      )
    };

    // 3. 使用宿主配置作为完整模板，仅覆盖当前账号的授权和 provider 指针。
    const mergedConfig = mergeConfigs(
      hostConfig,
      accountOnlyConfig,
      accountId,
      effectiveOptions
    );

    // 4. 写回账号配置
    fs.writeFileSync(accountConfigPath, mergedConfig, 'utf8');
    notifyConfigUpdatedIfChanged('pty_config_sync', 'codex_config_synced_from_host_template');
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

  function shellQuote(value) {
    return `'${String(value || '').replace(/'/g, '\'\"\'\"\'')}'`;
  }

  function shouldEnableSshClipboardCommandShims() {
    if (processObj.platform === 'win32') return false;
    if (!String(processObj.env.SSH_CONNECTION || '').trim() && !String(processObj.env.SSH_TTY || '').trim()) return false;
    if (String(processObj.env.AIH_SSH_IMAGE_PASTE || '1') === '0') return false;
    if (String(processObj.env.AIH_SSH_TERMINAL_CLIPBOARD || '1') === '0') return false;
    return String(processObj.env.AIH_SSH_CLIPBOARD_SHIMS || '1') !== '0';
  }

  function sshClipboardShimTools() {
    return ['xclip', 'wl-paste', 'pbpaste', 'pngpaste', 'osascript'];
  }

  function ensureSshClipboardShimBin(binDir) {
    try {
      fs.mkdirSync(binDir, { recursive: true });
      const shimBin = path.join(__dirname, '..', 'ssh-clipboard', 'shim-bin.js');
      sshClipboardShimTools().forEach((tool) => {
        const filePath = path.join(binDir, tool);
        const content = [
          '#!/bin/sh',
          `exec ${shellQuote(processObj.execPath)} ${shellQuote(shimBin)} ${shellQuote(tool)} "$@"`,
          ''
        ].join('\n');
        fs.writeFileSync(filePath, content, 'utf8');
        if (typeof fs.chmodSync === 'function') {
          try { fs.chmodSync(filePath, 0o755); } catch (_error) {}
        }
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  function realShimToolEnvKey(tool) {
    const key = String(tool || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return key ? `AIH_SSH_CLIP_REAL_${key}` : '';
  }

  function resolveRealShimToolPath(tool, currentPath, binDir) {
    const entries = String(currentPath || '').split(path.delimiter).map((item) => item.trim()).filter(Boolean);
    const resolvedBinDir = path.resolve(binDir);
    for (const entry of entries) {
      if (path.resolve(entry) === resolvedBinDir) continue;
      const candidate = path.join(entry, tool);
      try {
        const stat = fs.statSync(candidate);
        if (stat && stat.isFile && stat.isFile()) return candidate;
      } catch (_error) {}
    }
    return '';
  }

  function installSshClipboardCommandShims(envOverrides, options = {}) {
    if (!shouldEnableSshClipboardCommandShims()) return;
    const selectedId = String(options.id || '').trim();
    const sessionKey = buildSshClipboardSessionKey({
      env: processObj.env,
      cwd: processObj.cwd(),
      provider: options.cliName,
      accountId: selectedId,
      pid: processObj.pid
    });
    const inbox = createSshClipboardInbox({
      fs,
      sessionKey,
      maxBytes: Number(processObj.env.AIH_SSH_CLIP_MAX_BYTES) || undefined
    });
    const shimRoot = path.join(inbox.rootDir, 'shim');
    const responseRoot = path.join(shimRoot, 'responses');
    const binDir = path.join(aiHomeDir, 'ssh-clipboard-shims');
    try {
      fs.mkdirSync(responseRoot, { recursive: true });
    } catch (_error) {
      return;
    }
    if (!ensureSshClipboardShimBin(binDir)) return;
    const envPathKey = processObj.platform === 'win32' ? 'Path' : 'PATH';
    const currentPath = String(envOverrides[envPathKey] || envOverrides.PATH || envOverrides.Path || '');
    envOverrides[envPathKey] = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
    envOverrides.AIH_SSH_CLIP_SHIM_BIN_DIR = binDir;
    sshClipboardShimTools().forEach((tool) => {
      const key = realShimToolEnvKey(tool);
      if (!key) return;
      const realPath = resolveRealShimToolPath(tool, currentPath, binDir);
      if (realPath) envOverrides[key] = realPath;
    });
    envOverrides.AIH_SSH_CLIP_SHIM_DIR = shimRoot;
    envOverrides.AIH_SSH_CLIP_SHIM_TIMEOUT_MS = String(Number(processObj.env.AIH_SSH_CLIP_SHIM_TIMEOUT_MS) || DEFAULT_SHIM_TIMEOUT_MS);
    envOverrides.AIH_SSH_CLIP_SHIM_MAX_BYTES = String(Number(processObj.env.AIH_SSH_CLIP_MAX_BYTES) || (16 * 1024 * 1024));
  }

  function spawnPty(cliName, cliBin, id, forwardArgs, isLogin, spawnOptions = {}) {
    const sandboxDir = getProfileDir(cliName, id);
    const selectedId = String(id || '').trim();
    const isBuiltinServerProfile = isAihServerProfileId(selectedId);
    const authSnapshotBefore = accountArtifactHooks
      && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
      ? accountArtifactHooks.snapshotAccountAuthArtifacts(cliName, selectedId)
      : null;

    const notifyDefaultAuthUpdatedIfChanged = (source, reason) => {
      if (!authSnapshotBefore || !accountArtifactHooks || typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged !== 'function') return;
      accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
        provider: cliName,
        accountId: selectedId,
        before: authSnapshotBefore,
        source,
        reason
      });
    };

    let loadedEnv = {};
    const envPath = path.join(sandboxDir, '.aih_env.json');
    if (isBuiltinServerProfile) {
      const serverEnv = buildBuiltinServerProfileEnv(cliName);
      if (serverEnv && Object.keys(serverEnv).length > 0) {
        loadedEnv = serverEnv;
        try {
          fs.mkdirSync(sandboxDir, { recursive: true });
          fs.writeFileSync(envPath, JSON.stringify(serverEnv, null, 2), 'utf8');
        } catch (_error) {}
      }
    } else if (fs.existsSync(envPath)) {
      try { loadedEnv = JSON.parse(fs.readFileSync(envPath, 'utf8')); } catch (_error) {}
    }

    // ✅ Codex API Key 自动检测和持久化
    // 如果检测到当前环境有 OPENAI_API_KEY,但 .aih_env.json 中没有,则自动保存
    // ⚠️ 仅当账号没有 OAuth 凭据时才执行,避免将 OAuth 账号错误覆盖为 API Key 账号
    if (cliName === 'codex') {
      const hasApiKeyInProcess = !!(processObj.env.OPENAI_API_KEY && String(processObj.env.OPENAI_API_KEY).trim());
      const hasApiKeyInSaved = !!(loadedEnv.OPENAI_API_KEY && String(loadedEnv.OPENAI_API_KEY).trim());
      const hasBaseUrlInProcess = !!(processObj.env.OPENAI_BASE_URL && String(processObj.env.OPENAI_BASE_URL).trim());

      // 检查账号是否已有 OAuth 凭据 (access_token),避免污染 OAuth 账号
      let accountHasOAuthCredentials = false;
      try {
        const authJsonPath = path.join(sandboxDir, '.codex', 'auth.json');
        if (fs.existsSync(authJsonPath)) {
          const existingAuth = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
          const tokens = existingAuth && existingAuth.tokens && typeof existingAuth.tokens === 'object'
            ? existingAuth.tokens : existingAuth;
          accountHasOAuthCredentials = !!(tokens && tokens.access_token && String(tokens.access_token).trim());
        }
      } catch (_error) {}

      if (hasApiKeyInProcess && !hasApiKeyInSaved && !accountHasOAuthCredentials) {
        // 自动保存环境变量到 .aih_env.json
        const envToSave = { ...loadedEnv };
        envToSave.OPENAI_API_KEY = String(processObj.env.OPENAI_API_KEY).trim();
        if (hasBaseUrlInProcess) {
          envToSave.OPENAI_BASE_URL = String(processObj.env.OPENAI_BASE_URL).trim();
        }
        try {
          fs.writeFileSync(envPath, JSON.stringify(envToSave, null, 2), 'utf8');
          loadedEnv = envToSave;
          console.log('\x1b[32m[aih]\x1b[0m Detected OPENAI_API_KEY in environment, saved to account config for persistence.');
        } catch (_error) {
          // 保存失败,继续使用当前环境变量
        }
      }
    }

    const codexConfigDir = path.join(sandboxDir, '.codex');
    const codexSqliteHome = cliName === 'codex'
      ? resolveCodexSqliteHome({ path, hostHomeDir, aiHomeDir, profileDir: sandboxDir })
      : '';

    // ✅ 确保账号专属的配置目录存在,并同步宿主的非敏感配置
    if (cliName === 'codex') {
      try {
        fs.mkdirSync(codexConfigDir, { recursive: true });

        const accountConfigPath = path.join(codexConfigDir, 'config.toml');
        const hostConfigPath = codexSqliteHome
          ? path.join(codexSqliteHome, 'config.toml')
          : null;
        const providerKeyOverride = isBuiltinServerProfile
          ? resolveAihServerProviderKeyOverride(hostConfigPath)
          : '';

        if (String(processObj.env.AIH_DEBUG_CONFIG_SYNC || '0') === '1') {
          console.log(`\x1b[36m[aih:config]\x1b[0m Syncing config for account ${id}`);
          console.log(`\x1b[36m[aih:config]\x1b[0m   Account config: ${accountConfigPath}`);
          console.log(`\x1b[36m[aih:config]\x1b[0m   Host config: ${hostConfigPath || 'none'}`);
        }

        // ✅ 迁移 OPENAI_BASE_URL 环境变量到配置文件
        // ⚠️ 仅当账号已保存了 API Key 时才使用 processObj.env 回退,
        //    避免将宿主环境的 API Key 泄漏到 OAuth 账号
        const savedApiKey = String(loadedEnv.OPENAI_API_KEY || '').trim();
        const openaiBaseUrl = savedApiKey
          ? (loadedEnv.OPENAI_BASE_URL || processObj.env.OPENAI_BASE_URL || '')
          : (loadedEnv.OPENAI_BASE_URL || '');
        const openaiApiKey = savedApiKey || '';

        // ✅ 检测是否为 API Key 模式 (仅基于账号自身配置,不使用宿主环境)
        const isApiKeyMode = !!openaiApiKey;

        // ✅ 同步宿主配置到账号配置
        syncCodexConfigFromHost(accountConfigPath, hostConfigPath, id, { fs, path }, {
          openaiBaseUrl: openaiBaseUrl ? String(openaiBaseUrl).trim() : '',
          openaiApiKey: openaiApiKey ? String(openaiApiKey).trim() : '',
          isApiKeyMode,
          sqliteHome: codexSqliteHome,
          providerKeyOverride
        });

        // ✅ 如果是 API Key 模式,写入 auth.json
        // ⚠️ 仅当账号没有已有的 OAuth 凭据时才写入,防止覆盖
        if (isApiKeyMode) {
          const authJsonPath = path.join(codexConfigDir, 'auth.json');
          let existingAuthHasOAuth = false;
          try {
            if (fs.existsSync(authJsonPath)) {
              const existAuth = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
              const tokens = existAuth && existAuth.tokens && typeof existAuth.tokens === 'object'
                ? existAuth.tokens : existAuth;
              existingAuthHasOAuth = !!(tokens && tokens.access_token && String(tokens.access_token).trim());
            }
          } catch (_ignore) {}
          if (!existingAuthHasOAuth) {
            const authData = {
              OPENAI_API_KEY: String(openaiApiKey).trim()
            };
            try {
              fs.writeFileSync(authJsonPath, JSON.stringify(authData, null, 2), 'utf8');
              if (String(processObj.env.AIH_DEBUG_CONFIG_SYNC || '0') === '1') {
                console.log(`\x1b[32m[aih:config]\x1b[0m Created auth.json with OPENAI_API_KEY`);
              }
            } catch (error) {
              console.warn(`\x1b[33m[aih]\x1b[0m Failed to write auth.json:`, error.message);
            }
          }
        }

        if (String(processObj.env.AIH_DEBUG_CONFIG_SYNC || '0') === '1') {
          console.log(`\x1b[32m[aih:config]\x1b[0m Config sync completed for account ${id}`);
          console.log(`\x1b[36m[aih:config]\x1b[0m   API Key mode: ${isApiKeyMode ? 'YES' : 'NO'}`);
          if (openaiBaseUrl) {
            console.log(`\x1b[36m[aih:config]\x1b[0m   Migrated OPENAI_BASE_URL to config: ${openaiBaseUrl}`);
          }
          if (isApiKeyMode) {
            console.log(`\x1b[36m[aih:config]\x1b[0m   Auth method: apikey`);
            console.log(`\x1b[36m[aih:config]\x1b[0m   Model provider: ${openaiBaseUrl ? 'aih' : 'openai'}`);
          }
        }

        if (typeof ensureSessionStoreLinks === 'function') {
          try {
            ensureSessionStoreLinks(cliName, selectedId);
          } catch (_error) {}
        }
        notifyDefaultAuthUpdatedIfChanged('pty_runtime_configure', 'codex_auth_artifacts_updated_before_spawn');
      } catch (error) {
        // 配置同步失败,打印警告但继续执行
        console.warn(`\x1b[33m[aih]\x1b[0m Failed to sync config for account ${id}:`, error.message);
      }
    }
    // 账号隔离的 env 注入交由 provider 专属策略决定（见 ai-cli/launch-profile）。
    // 运行时不再分支 provider 名，新增/调整某个 provider 的隔离方式只改策略表。
    // Optional launch-time hygiene (e.g. trimming regenerable caches that a
    // fake HOME would otherwise accumulate). Non-fatal.
    const launchBaseEnv = {
      ...filterHostEnvVars(processObj.env),
      ...loadedEnv
    };

    try {
      prepareProviderRuntime(cliName, sandboxDir, launchBaseEnv, {
        sandboxDir,
        codexConfigDir,
        codexSqliteHome,
        hostHomeDir,
        platform: processObj.platform,
        path,
        fs
      });
    } catch (error) {
      if (cliName === 'opencode') throw error;
      console.warn(`\x1b[33m[aih]\x1b[0m Launch prepare failed for ${cliName}:`, error.message);
    }
    const envOverrides = buildProviderRuntimeEnv(cliName, sandboxDir, launchBaseEnv, {
      path,
      fs,
      hostHomeDir,
      platform: processObj.platform,
      codexConfigDir,
      codexSqliteHome
    });

    const normalizedForwardArgs = normalizeRuntimeForwardArgs(cliName, forwardArgs, {
      accountId: id,
      codexDir: codexSqliteHome,
      isLogin
    });
    const argsToRunBase = isLogin
      ? [...(cliConfigs[cliName]?.loginArgs || []), ...normalizeLoginForwardArgs(cliName, forwardArgs)]
      : normalizedForwardArgs;
    const argsToRun = Array.isArray(argsToRunBase) ? [...argsToRunBase] : [];
    if (cliName === 'codex') {
      const defaultAccountId = readSelectedDefaultAccountId(cliName, sandboxDir);
      const allowRemoteProxy = isAihServerProfileId(selectedId)
        || (defaultAccountId && defaultAccountId === selectedId);
      const remoteProxy = allowRemoteProxy
        ? resolveCodexRemoteProxyConfig(argsToRun, isLogin)
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
      id: selectedId
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
    const launch = buildPtyLaunch(launchBin, argsToRun, { platform: processObj.platform });
    const useHeadlessDirect = typeof spawn === 'function' && shouldUseHeadlessDirectSpawn(cliName, argsToRun, isLogin);
    const finalLaunch = useHeadlessDirect ? launch : maybeWrapPersistentLaunch(launch, {
      cliName,
      id: selectedId,
      isLogin,
      envOverrides
    });
    if (useHeadlessDirect) {
      return spawnHeadlessDirect(finalLaunch, { env: envOverrides });
    }
    return pty.spawn(finalLaunch.command, finalLaunch.args, {
      name: resolvePtyTermName(processObj),
      cols: processObj.stdout.columns || 80,
      rows: spawnOptions.rows || processObj.stdout.rows || 24,
      cwd: processObj.cwd(),
      env: envOverrides
    });
  }

  // Tell the user, in one line, what the persistent-session launch is about to do
  // so it is never a silent surprise (especially "second window in the same
  // project opened a parallel session instead of stealing the first").
  function announceSessionPlan(cliName, id, plan, opts = {}) {
    const hasLabel = !!(opts && opts.hasLabel);
    const cyan = (text) => `\x1b[36m[aih]\x1b[0m ${text}`;
    const yellow = (text) => `\x1b[33m[aih]\x1b[0m ${text}`;
    if (plan.action === 'new') {
      console.log(cyan('✦ 新建持久会话（本项目）。Ctrl-b d 挂后台、关终端不丢；翻历史 Ctrl-b [ 、q 退出。'));
    } else if (plan.action === 'reattach') {
      console.log(cyan('↻ 续接到本项目已有的会话。'));
    } else if (plan.action === 'new-parallel') {
      console.log(yellow('⚠ 本项目已有一个会话正在另一个窗口使用 → 已为你新开一个并发会话（原会话不受影响）。'));
      console.log(yellow(`  想接管那个会话改用 -R；查看全部：aih ${cliName} ${id} sessions 。`));
    } else if (plan.action === 'server-cycled') {
      console.log(cyan('♻ 旧的 tmux 服务器（UTF-8 配置不完整）已自动重启，中文显示已修复。'));
    } else if (plan.action === 'new-compatible') {
      console.log(yellow('⚠ 本项目已有会话来自旧的 tmux UTF-8 运行时 → 已为你新开一个兼容会话（旧会话不受影响）。'));
      console.log(yellow(`  查看或关闭旧会话后重启以彻底修复中文：aih ${cliName} ${id} sessions 。`));
    } else if (plan.action === 'fallback-parallel') {
      console.log(yellow('⚠ 无法确认本项目持久会话状态 → 已为你新开一个并发会话，避免抢占正在运行的会话。'));
      console.log(yellow(`  想接管已有会话改用 -R；查看全部：aih ${cliName} ${id} sessions 。`));
    } else if (plan.action === 'takeover') {
      const where = hasLabel
        ? `命名会话 “${String(plan.session || '').replace(/^s-/, '')}”`
        : '本项目的会话';
      console.log(yellow(`↻ 接管${where}（它正被另一处的窗口 / SSH 客户端占用，那个会被挤下线）。`));
    } else if (plan.action === 'mirror') {
      console.log(cyan('⇄ 镜像并排到本项目的会话：与另一处的窗口同屏，双方都能看、都能操作，谁都不会被挤下线（按 Ctrl-b d 仅离开你这一侧）。'));
    }
  }

  // Optionally run the provider CLI inside a per-account tmux server so the
  // session survives the foreground client and can be re-attached later (e.g.
  // over SSH). Best-effort: on Windows / without tmux this returns `launch`
  // unchanged so behaviour is identical to a plain direct spawn.
  function detectPersistentTmux() {
    return persistentSession.detectTmux({
      platform: processObj.platform,
      env: processObj.env,
      resolveCommandPath: resolveCliPath,
      existsSync: fs.existsSync
    });
  }

  function shouldOfferWindowsPsmuxInstall(tmux, ctx, isTTY) {
    if (!tmux || tmux.available || tmux.reason !== 'windows-no-tmux') return false;
    if (processObj.platform !== 'win32') return false;
    if (ctx.isLogin) return false;
    if (!isTTY) return false;
    if (String(processObj.env[persistentSession.DISABLE_ENV] || '') === '1') return false;
    if (String(processObj.env[persistentSession.MARKER_ENV] || '') === '1') return false;
    if (String(processObj.env.AIH_PSMUX_INSTALL_PROMPT || '1') === '0') return false;
    return typeof askYesNo === 'function';
  }

  function maybeInstallWindowsPsmux(tmux, ctx, isTTY) {
    if (!shouldOfferWindowsPsmuxInstall(tmux, ctx, isTTY)) return tmux;
    const install = persistentSession.buildWindowsPsmuxInstallCommand();
    console.log(`\x1b[33m[aih]\x1b[0m Windows persistent sessions need psmux: ${persistentSession.PSMUX_INSTALL_URL}`);
    console.log(`\x1b[90m[aih]\x1b[0m Install command: ${install.display}`);
    const accepted = askYesNo('未检测到 psmux，是否通过 winget 安装以启用 Windows 持久会话？', false);
    if (!accepted) {
      console.log('\x1b[33m[aih]\x1b[0m 已跳过 psmux 安装，本次使用普通 PTY 启动（会话不会由 psmux 持久化）。');
      return tmux;
    }
    console.log(`\x1b[36m[aih]\x1b[0m Installing psmux via winget...`);
    const result = persistentSession.installWindowsPsmux({ spawnSync, stdio: 'inherit' });
    if (!result.ok) {
      const status = result.status == null ? '' : ` (exit ${result.status})`;
      console.error(`\x1b[33m[aih]\x1b[0m psmux install failed: ${result.reason}${status}.`);
      console.error(`\x1b[90m[aih]\x1b[0m Manual install: ${install.display}  or see ${persistentSession.PSMUX_INSTALL_URL}`);
      return tmux;
    }
    const refreshed = detectPersistentTmux();
    if (refreshed.available) {
      console.log(`\x1b[36m[aih]\x1b[0m psmux installed and detected: ${refreshed.command}`);
      return refreshed;
    }
    console.error('\x1b[33m[aih]\x1b[0m winget finished, but psmux is still not visible to this process.');
    console.error('\x1b[90m[aih]\x1b[0m Open a new terminal or ensure WinGet Links is in PATH, then retry.');
    return refreshed;
  }

  function isNoServerSessionProbe(probe) {
    const stderr = String((probe && probe.stderr) || '');
    return /no server running|No such file or directory|error connecting to|failed to connect/i.test(stderr);
  }

  function isTrustedSessionProbe(probe) {
    if (!probe || probe.error) return false;
    if (probe.status === 0) return true;
    return isNoServerSessionProbe(probe);
  }

  function fallbackParallelPlan(baseSession) {
    return {
      session: persistentSession.deriveFallbackParallelSessionName(baseSession, {
        now: Date.now(),
        pid: processObj.pid
      }),
      action: 'fallback-parallel'
    };
  }

  function runTmuxEnvironmentSync(tmux, ctx, sessionName = '') {
    const commands = persistentSession.buildSetEnvironmentCommands({
      cliName: ctx.cliName,
      id: ctx.id,
      tmuxCommand: tmux.command,
      env: ctx.envOverrides,
      sessionName
    });
    for (const cmd of commands) {
      try {
        spawnSync(cmd.command, cmd.args, {
          stdio: 'ignore',
          env: ctx.envOverrides
        });
      } catch (_error) {}
    }
  }

  function maybeWrapPersistentLaunch(launch, ctx) {
    try {
      const isTTY = !!(processObj.stdout && processObj.stdout.isTTY);
      const tmux = maybeInstallWindowsPsmux(detectPersistentTmux(), ctx, isTTY);
      const enabled = persistentSession.shouldPersist({
        tmux,
        isLogin: ctx.isLogin,
        isTTY,
        env: processObj.env
      });
      if (!enabled) return launch;

      const confPath = path.join(aiHomeDir, 'persist', 'tmux.conf');
      const resolvedConf = persistentSession.ensureTmuxConf(confPath, fs);
      runTmuxEnvironmentSync(tmux, ctx);
      const sourceConfigCmd = persistentSession.buildSourceConfigCommand({
        cliName: ctx.cliName,
        id: ctx.id,
        tmuxCommand: tmux.command,
        confPath: resolvedConf
      });
      if (sourceConfigCmd) {
        try {
          spawnSync(sourceConfigCmd.command, sourceConfigCmd.args, {
            stdio: 'ignore',
            env: ctx.envOverrides
          });
        } catch (_error) {}
      }

      // Decide which session to land in — and tell the user, so it's never a
      // silent surprise (a second window in the same project must not steal the
      // first window's live session). Probe the account's live sessions, then
      // pick: reattach a detached one, or open a parallel session if one is live.
      const cwd = processObj.cwd();
      const label = processObj.env[persistentSession.SESSION_ENV];
      // -R/--aih-resume: take over THIS project's session even if a client is still
      // attached elsewhere (the cross-machine "grab my session back" case). It
      // targets the exact base session like a named one, so attached → takeover.
      const resume = String(processObj.env[persistentSession.RESUME_ENV] || '') === '1';
      // -M/--aih-mirror: attach to THIS project's session SHARED — both windows
      // mirror the same session, neither is kicked (cross-machine screen share).
      const mirror = String(processObj.env[persistentSession.MIRROR_ENV] || '') === '1';
      const rawTargetSession = String(processObj.env[persistentSession.TARGET_ENV] || '').trim();
      const targetSession = persistentSession.isSafeSessionName(rawTargetSession) ? rawTargetSession : '';
      const shareTarget = mirror || !!targetSession;
      const exactTarget = !!targetSession || !!label || resume || mirror;
      const baseSession = targetSession || persistentSession.deriveSessionName({ cwd, label });
      let plannedSession = baseSession;
      try {
        const listCmd = persistentSession.buildListSessionsCommand({
          cliName: ctx.cliName, id: ctx.id, tmuxCommand: tmux.command
        });
        const probe = spawnSync(listCmd.command, listCmd.args, {
          encoding: 'utf8',
          env: ctx.envOverrides
        });
        if (!isTrustedSessionProbe(probe)) throw new Error('persistent session probe failed');
        const sessions = persistentSession.parseSessionList(probe && probe.stdout);
        let plan = persistentSession.planPersistentSession(sessions, baseSession, {
          hasLabel: exactTarget,
          share: shareTarget,
          requireUtf8Runtime: true
        });
        // Server-locale fix: when every probed session predates the UTF-8 runtime
        // marker AND none of them are currently attached, the tmux server was most
        // likely started before the locale fix landed. On tmux < 3.0, the server
        // process owns the setlocale() call used by wcwidth(), so stale-locale
        // servers render CJK characters at wrong column widths even when the
        // session env carries LANG=zh_CN.UTF-8. Cycling (kill-server) forces a
        // fresh server that inherits the correct locale from our envOverrides.
        if (plan.action === 'new-compatible' && sessions.length > 0) {
          const hasAttachedSessions = sessions.some((s) => s.attached);
          if (!hasAttachedSessions) {
            const killCmd = persistentSession.buildKillServerCommand({
              cliName: ctx.cliName,
              id: ctx.id,
              tmuxCommand: tmux.command
            });
            try {
              spawnSync(killCmd.command, killCmd.args, {
                stdio: 'ignore',
                env: ctx.envOverrides
              });
              plan = { session: baseSession, action: 'server-cycled' };
            } catch (_killError) {}
          }
        }
        plannedSession = plan.session;
        announceSessionPlan(ctx.cliName, ctx.id, plan, { hasLabel: !!label || !!targetSession, resume, mirror: shareTarget });
      } catch (_probeError) {
        if (!exactTarget) {
          const plan = fallbackParallelPlan(baseSession);
          plannedSession = plan.session;
          announceSessionPlan(ctx.cliName, ctx.id, plan);
        }
      }
      runTmuxEnvironmentSync(tmux, ctx, plannedSession);

      const wrapped = persistentSession.buildTmuxLaunch(launch, {
        cliName: ctx.cliName,
        id: ctx.id,
        cwd,
        label,
        sessionName: plannedSession,
        share: shareTarget,
        tmuxCommand: tmux.command,
        confPath: resolvedConf,
        env: ctx.envOverrides
      });
      // Mark the inner environment so the CLI (or any nested aih) does not try
      // to wrap a second time.
      ctx.envOverrides[persistentSession.MARKER_ENV] = '1';
      return wrapped;
    } catch (_error) {
      return launch;
    }
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
      }
    });
  }

  function runCliPty(cliName, initialId, forwardArgs, isLogin = false) {
    const runtimeStartedAt = Date.now();
    let cliPath = resolveCliPath(cliName);
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
        console.log(`\n\x1b[36m[aih]\x1b[0m Installing \x1b[33m${pkg}\x1b[0m...`);
        execSync(`npm install -g ${pkg}`, { stdio: 'inherit' });
        console.log(`\x1b[32m[aih] Successfully installed ${cliName}!\x1b[0m\n`);
      } else {
        processObj.exit(1);
      }
      cliPath = resolveCliPath(cliName);
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

    const targetLabel = isAihServerProfileId(initialId)
      ? '\x1b[32mAIH Server\x1b[0m'
      : `Account ID: \x1b[32m${initialId}\x1b[0m`;
    console.log(`\n\x1b[36m[aih]\x1b[0m 🚀 Running \x1b[33m${cliName}\x1b[0m (${targetLabel}) via PTY Sandbox`);
    const initialSessionSync = ensureSessionStoreLinks(cliName, initialId);
    if (initialSessionSync.migrated > 0 || initialSessionSync.linked > 0) {
      console.log(`\x1b[36m[aih]\x1b[0m Session links ready (${cliName}): migrated ${initialSessionSync.migrated}, linked ${initialSessionSync.linked}.`);
    }

    let activeId = String(initialId || '').trim();
    const initialProfileDir = getProfileDir(cliName, initialId);
    const initialCodexDir = cliName === 'codex'
      ? resolveCodexSqliteHome({ path, hostHomeDir, aiHomeDir, profileDir: initialProfileDir })
      : '';
    let activeForwardArgs = normalizeRuntimeForwardArgs(cliName, forwardArgs, {
      accountId: initialId,
      codexDir: initialCodexDir,
      isLogin
    });
    let sshClipboardParser = null;
    let sshTerminalClipboardParser = null;
    let sshClipboardShimRequestParser = null;
    let sshClipboardShimRequest = null;
    let sshTerminalClipboardPromptTimer = null;
    let sshTerminalClipboardTimeoutConfig = null;
    let sshTerminalClipboardRequestSeq = 0;
    let sshTerminalClipboardRequestProtocol = '';
    let sshTerminalPasteEventsModeEnabled = false;
    let sshTerminalPasteEventsSupport = 'unknown';
    let sshClipAgentRequestInFlight = false;
    const sshClipboardInboxes = new Map();
    let ptyProc = null;
    let usageRefreshInFlight = false;
    let lastUsageRefreshStartAt = 0;
    let lastSessionActivityAt = Date.now();

    const waveFrames = ['.', '..', '...', ' ..', '  .', '   '];
    let waveIdx = 0;
    let hasReceivedData = false;
    const shellDrawerAvailable = typeof shouldEnableShellDrawer === 'function'
      ? shouldEnableShellDrawer(isLogin, activeForwardArgs, processObj)
      : false;
    let shellDrawerProc = null;
    let shellDrawerVisible = false;
    let shellDrawerBufferedMainOutput = '';
    let shellDrawerDroppedMainOutput = false;
    let shellDrawerStatusSummary = '';
    let lastAppliedViewportSignature = '';
    let lastKnownShellDrawerLayout = null;

    let waveInterval = null;

    function startBootWave() {
      if (waveInterval) return;
      waveInterval = setInterval(() => {
        if (!hasReceivedData) {
          processObj.stdout.write(`\r\x1b[36m[aih]\x1b[0m Waiting for ${cliName} to boot${waveFrames[waveIdx++]}\x1b[K`);
          waveIdx %= waveFrames.length;
        }
      }, 200);
    }

    function stopBootWave() {
      if (!waveInterval) return;
      clearInterval(waveInterval);
      waveInterval = null;
    }

    const onResize = () => {
      const previousDrawerLayout = lastKnownShellDrawerLayout;
      if (shellDrawerVisible || lastAppliedViewportSignature) {
        applyFullTerminalViewport({ force: true });
      }
      if (ptyProc) {
        try { ptyProc.resize(processObj.stdout.columns, getChildPtyRows(activeForwardArgs)); } catch (_error) {}
      }
      if (shellDrawerProc) {
        const layout = getShellDrawerLayout();
        try { shellDrawerProc.resize(processObj.stdout.columns || 80, layout.ptyRows); } catch (_error) {}
      }
      if (shellDrawerVisible) {
        const nextLayout = getShellDrawerLayout();
        clearShellDrawerLayouts([previousDrawerLayout, nextLayout]);
        applyShellDrawerViewport({ force: true });
        focusShellDrawerCursor();
      } else if (canRenderUsageStatusBar() && shouldShowUsageInPty(activeForwardArgs)) {
        // Re-publish the usage title at the new size (screen-safe).
        emitUsageStatus(activeId, { forcePrint: true, forceRefresh: false });
      }
    };
    processObj.stdout.on('resize', onResize);

    const canUseRawMode = !!(processObj.stdin && processObj.stdin.isTTY && typeof processObj.stdin.setRawMode === 'function');
    if (canUseRawMode) {
      processObj.stdin.setRawMode(true);
    }
    processObj.stdin.resume();

    function getPlainTextWidth(text) {
      const normalized = String(text || '');
      let width = 0;
      for (const ch of normalized) {
        const code = ch.codePointAt(0) || 0;
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
        width += code > 0xff ? 2 : 1;
      }
      return width;
    }

    function truncatePlainText(text, maxWidth) {
      const normalized = String(text || '');
      if (maxWidth <= 0) return '';
      let output = '';
      let width = 0;
      for (const ch of normalized) {
        const code = ch.codePointAt(0) || 0;
        const nextWidth = (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) ? 0 : (code > 0xff ? 2 : 1);
        if (width + nextWidth > maxWidth) break;
        output += ch;
        width += nextWidth;
      }
      return output;
    }

    function padPlainText(text, targetWidth) {
      const normalized = truncatePlainText(text, targetWidth);
      const width = getPlainTextWidth(normalized);
      if (width >= targetWidth) return normalized;
      return `${normalized}${' '.repeat(targetWidth - width)}`;
    }

    // The shell drawer is the only feature that sets a scroll region; this resets
    // it to the full screen. The usage surface lives in the title now, so the
    // main output path never reserves rows.
    function applyFullTerminalViewport(options = {}) {
      const force = !!options.force;
      if (!force && lastAppliedViewportSignature === 'full') return;
      processObj.stdout.write('\x1b[r');
      lastAppliedViewportSignature = 'full';
    }

    function writeMainPtyOutput(data) {
      // Returning from the shell drawer leaves a scroll region set; reset to full
      // before forwarding. Otherwise the child's output is pure passthrough.
      if (lastAppliedViewportSignature && lastAppliedViewportSignature !== 'full') {
        applyFullTerminalViewport({ force: true });
      }
      processObj.stdout.write(data);
    }

    function clearTerminalRows(rows) {
      const uniqueRows = [...new Set((rows || [])
        .map((row) => Math.floor(Number(row)))
        .filter((row) => Number.isFinite(row) && row > 0))]
        .sort((a, b) => a - b);
      if (!uniqueRows.length) return;
      // SCO save/restore (\x1b[s/\x1b[u) so we never touch the child CLI's DEC
      // save/restore slot (Ink uses \x1b7/\x1b8); used by the shell drawer only.
      processObj.stdout.write('\x1b[s');
      uniqueRows.forEach((row) => {
        processObj.stdout.write(`\x1b[${row};1H\x1b[2K`);
      });
      processObj.stdout.write('\x1b[u');
    }

    function buildShellDrawerHeaderText() {
      const hiddenSuffix = shellDrawerBufferedMainOutput
        ? ` | 主会话后台输出已缓存${shellDrawerDroppedMainOutput ? '（部分截断）' : ''}`
        : '';
      return `[aih] Shell Drawer · Ctrl+Alt+J 收起 · cwd: ${processObj.cwd()}${hiddenSuffix}`;
    }

    function buildShellDrawerTopBorder(width) {
      const safeWidth = Math.max(8, Number(width) || 80);
      const innerWidth = Math.max(2, safeWidth - 2);
      const label = ' Shell Drawer ';
      const labelWidth = Math.min(getPlainTextWidth(label), innerWidth);
      const text = truncatePlainText(label, innerWidth);
      return `┌${text}${'─'.repeat(Math.max(0, innerWidth - labelWidth))}┐`;
    }

    function buildShellDrawerHeaderLine(width) {
      const safeWidth = Math.max(8, Number(width) || 80);
      const innerWidth = Math.max(2, safeWidth - 4);
      return `│ ${padPlainText(buildShellDrawerHeaderText(), innerWidth)} │`;
    }

    function buildShellDrawerBottomBorder(width) {
      const safeWidth = Math.max(8, Number(width) || 80);
      return `└${'─'.repeat(Math.max(2, safeWidth - 2))}┘`;
    }

    function buildShellDrawerStatusLine(width) {
      const safeWidth = Math.max(8, Number(width) || 80);
      const innerWidth = Math.max(2, safeWidth);
      const summary = shellDrawerStatusSummary || lastKnownUsageStatusSummary || buildInitialUsageStatusSummary(activeId);
      return padPlainText(`{ ${summary} }`, innerWidth);
    }

    function getShellDrawerRows(layout) {
      if (!layout) return [];
      const rows = [Math.max(1, layout.topBorderRow - 1)];
      for (let row = layout.topBorderRow; row <= layout.bottomBorderRow; row += 1) {
        rows.push(row);
      }
      return rows;
    }

    function clearShellDrawerRegion(layout = getShellDrawerLayout()) {
      clearTerminalRows(getShellDrawerRows(layout));
    }

    function clearShellDrawerLayouts(layouts) {
      clearTerminalRows((layouts || []).flatMap((layout) => getShellDrawerRows(layout)));
    }

    function writeShellDrawerFrame() {
      if (!shellDrawerVisible) return;
      const layout = getShellDrawerLayout();
      lastKnownShellDrawerLayout = layout;
      const width = processObj.stdout.columns || 80;
      processObj.stdout.write('\x1b7');
      processObj.stdout.write(`\x1b[${Math.max(1, layout.topBorderRow - 1)};1H\x1b[2K${buildShellDrawerStatusLine(width)}`);
      processObj.stdout.write(`\x1b[${layout.topBorderRow};1H\x1b[2K${buildShellDrawerTopBorder(width)}`);
      processObj.stdout.write(`\x1b[${layout.headerRow};1H\x1b[2K${buildShellDrawerHeaderLine(width)}`);
      processObj.stdout.write(`\x1b[${layout.bottomBorderRow};1H\x1b[2K${buildShellDrawerBottomBorder(width)}`);
      processObj.stdout.write('\x1b8');
    }

    function focusShellDrawerCursor() {
      if (!shellDrawerVisible) return;
      const layout = getShellDrawerLayout();
      processObj.stdout.write(`\x1b[${layout.contentTop};1H`);
    }

    function applyShellDrawerViewport(options = {}) {
      if (!shellDrawerVisible) return;
      const layout = getShellDrawerLayout();
      const signature = `drawer:${layout.contentTop}:${layout.contentBottom}`;
      const force = !!options.force;
      if (force || lastAppliedViewportSignature !== signature) {
        processObj.stdout.write(`\x1b[s\x1b[${layout.contentTop};${layout.contentBottom}r\x1b[u`);
        lastAppliedViewportSignature = signature;
      }
      lastKnownShellDrawerLayout = layout;
      if (options.writeFrame !== false) writeShellDrawerFrame();
    }

    function flushShellDrawerBufferedMainOutput() {
      if (!shellDrawerBufferedMainOutput) return;
      const bufferedOutput = shellDrawerBufferedMainOutput;
      const hadDroppedOutput = shellDrawerDroppedMainOutput;
      shellDrawerBufferedMainOutput = '';
      shellDrawerDroppedMainOutput = false;
      applyFullTerminalViewport({ force: true });
      let output = '\r\n';
      if (hadDroppedOutput) {
        output += '\x1b[33m[aih] Shell Drawer 期间主会话输出过多，已截断最早部分内容。\x1b[0m\r\n';
      }
      output += bufferedOutput;
      writeMainPtyOutput(output);
    }

    function ensureShellDrawerProc() {
      if (shellDrawerProc) return shellDrawerProc;
      shellDrawerProc = spawnShellDrawerPty();
      shellDrawerProc.onData((data) => {
        if (!shellDrawerVisible) return;
        applyShellDrawerViewport({ force: true, writeFrame: false });
        processObj.stdout.write(data);
        writeShellDrawerFrame();
      });
      shellDrawerProc.onExit(() => {
        shellDrawerProc = null;
        if (!shellDrawerVisible || cleanedUp) return;
        shellDrawerVisible = false;
        applyFullTerminalViewport({ force: true });
        clearShellDrawerRegion(lastKnownShellDrawerLayout || getShellDrawerLayout());
        writeMainPtyOutput('\r\n\x1b[33m[aih] Shell Drawer 已退出，回到主会话。\x1b[0m\r\n');
        flushShellDrawerBufferedMainOutput();
        emitUsageStatus(activeId, { forcePrint: true, forceRefresh: false });
      });
      return shellDrawerProc;
    }

    function openShellDrawer() {
      if (!shellDrawerAvailable || shellDrawerVisible) return false;
      applyFullTerminalViewport({ force: true });
      shellDrawerVisible = true;
      shellDrawerStatusSummary = lastKnownUsageStatusSummary || buildInitialUsageStatusSummary(activeId);
      clearShellDrawerRegion();
      applyShellDrawerViewport({ force: true });
      ensureShellDrawerProc();
      if (shellDrawerProc) {
        const layout = getShellDrawerLayout();
        try { shellDrawerProc.resize(processObj.stdout.columns || 80, layout.ptyRows); } catch (_error) {}
      }
      focusShellDrawerCursor();
      return true;
    }

    function closeShellDrawer() {
      if (!shellDrawerVisible) return false;
      const previousLayout = lastKnownShellDrawerLayout || getShellDrawerLayout();
      shellDrawerVisible = false;
      applyFullTerminalViewport({ force: true });
      clearShellDrawerRegion(previousLayout);
      processObj.stdout.write(`\x1b[${Math.max(1, Number(processObj.stdout.rows) || 1)};1H`);
      flushShellDrawerBufferedMainOutput();
      emitUsageStatus(activeId, { forcePrint: true, forceRefresh: false });
      return true;
    }

    function toggleShellDrawer() {
      if (!shellDrawerAvailable) return false;
      if (shellDrawerVisible) return closeShellDrawer();
      return openShellDrawer();
    }

    function isWslPlatform() {
      if (processObj.platform !== 'linux') return false;
      return Boolean(processObj.env.WSL_DISTRO_NAME || processObj.env.WSL_INTEROP);
    }

    function canBridgeWindowsClipboard() {
      return processObj.platform === 'win32' || isWslPlatform();
    }

    function isSshRuntimeSession() {
      return Boolean(
        String(processObj.env.SSH_CONNECTION || '').trim()
        || String(processObj.env.SSH_TTY || '').trim()
      );
    }

    function readSshClipMaxBytes() {
      const configured = Number(processObj.env.AIH_SSH_CLIP_MAX_BYTES);
      return Number.isInteger(configured) && configured > 0 ? configured : SSH_CLIP_DEFAULT_MAX_BYTES;
    }

    function shellSingleQuote(value) {
      return `'${String(value || '').replace(/'/g, '\'\"\'\"\'')}'`;
    }

    function isClipboardPasteTrigger(data) {
      if (!canBridgeWindowsClipboard() && !isSshRuntimeSession()) return false;
      if (isAltVClipboardTrigger(data)) return true;
      return isSshRuntimeSession() && isEmptyBracketedPaste(data);
    }

    function normalizeClipboardImagePath(capturedPath) {
      const trimmed = String(capturedPath || '').trim();
      if (!trimmed) return '';
      if (!isWslPlatform()) return trimmed;
      try {
        const converted = execSync(`wslpath -u ${shellSingleQuote(trimmed)}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        return String(converted || '').trim() || trimmed;
      } catch (_error) {
        return trimmed;
      }
    }

    function tryCaptureClipboardImagePathOnWindows() {
      if (!canBridgeWindowsClipboard()) return '';
      if (String(processObj.env.AIH_WINDOWS_IMAGE_PASTE || '1') === '0') return '';
      const psScript = [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }',
        '$img = [System.Windows.Forms.Clipboard]::GetImage()',
        'if ($null -eq $img) { exit 4 }',
        '$dir = Join-Path $env:TEMP "aih-image-paste"',
        '[System.IO.Directory]::CreateDirectory($dir) | Out-Null',
        '$cutoff = [DateTime]::UtcNow.AddDays(-1)',
        'Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -lt $cutoff } | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {} }',
        '$file = Join-Path $dir ("aih_clip_" + [DateTime]::Now.ToString("yyyyMMdd_HHmmss_fff") + ".png")',
        '$img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)',
        '[System.Windows.Forms.Clipboard]::SetText($file)',
        'Write-Output $file'
      ].join('; ');

      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      const powerShellCandidates = isWslPlatform()
        ? ['powershell.exe', 'powershell']
        : ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];
      for (const psCmd of powerShellCandidates) {
        try {
          const stdout = execSync(`${psCmd} -NoProfile -STA -EncodedCommand ${encoded}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          });
          const normalized = normalizeClipboardImagePath(stdout);
          if (normalized) return normalized;
        } catch (_error) {}
      }
      return '';
    }

    function shouldEnableSshClipboardImagePaste() {
      if (!isSshRuntimeSession()) return false;
      return String(processObj.env.AIH_SSH_IMAGE_PASTE || '1') !== '0';
    }

    function shouldEnableSshTerminalClipboardImagePaste() {
      if (!shouldEnableSshClipboardImagePaste()) return false;
      return String(processObj.env.AIH_SSH_TERMINAL_CLIPBOARD || '1') !== '0';
    }

    function shouldEnableSshTerminalPasteEvents() {
      if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
      return String(processObj.env.AIH_SSH_TERMINAL_PASTE_EVENTS || '1') !== '0';
    }

    function shouldWrapSshTerminalClipboardQueryForTmux() {
      if (!String(processObj.env.TMUX || '').trim()) return false;
      return String(processObj.env.AIH_SSH_TERMINAL_CLIPBOARD_TMUX_PASSTHROUGH || '1') !== '0';
    }

    function formatSshTerminalClipboardCapabilityHint() {
      if (sshTerminalPasteEventsSupport === 'unsupported') {
        return ' Terminal reported OSC 5522 paste-events unsupported.';
      }
      if (sshTerminalPasteEventsSupport === 'supported') {
        return ' Terminal reported OSC 5522 paste-events supported.';
      }
      return ' Terminal did not report OSC 5522 paste-events support.';
    }

    function formatSshTerminalClipboardReadHint() {
      return `${formatSshTerminalClipboardCapabilityHint()} Strict zero-client image paste requires terminal clipboard read support such as OSC 5522 image MIME data or OSC 52 image/data-url data.`;
    }

    function chooseSshTerminalImageMimeType(mimeTypes) {
      const available = Array.isArray(mimeTypes)
        ? mimeTypes.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [];
      return OSC5522_IMAGE_MIME_TYPES.find((mimeType) => available.includes(mimeType))
        || available.find((mimeType) => OSC5522_IMAGE_MIME_TYPES.includes(mimeType))
        || OSC5522_TEXT_IMAGE_MIME_TYPES.find((mimeType) => available.includes(mimeType))
        || '';
    }

    function formatSshTerminalMimeTypes(notifications) {
      const seen = new Set();
      const mimeTypes = (Array.isArray(notifications) ? notifications : [])
        .flatMap((notification) => Array.isArray(notification && notification.mimeTypes) ? notification.mimeTypes : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
        .filter((value) => {
          if (seen.has(value)) return false;
          seen.add(value);
          return true;
        });
      return mimeTypes.length > 0 ? `: ${mimeTypes.join(', ')}` : '';
    }

    function shouldEnableSshClipAgentImagePaste() {
      if (!shouldEnableSshClipboardImagePaste()) return false;
      const env = processObj.env || {};
      const mode = String(env.AIH_SSH_CLIP_AGENT || '').trim().toLowerCase();
      if (mode === '0' || mode === 'false' || mode === 'off' || mode === 'no') return false;
      if (mode === '1' || mode === 'true' || mode === 'on' || mode === 'yes') return true;
      return Boolean(String(env.AIH_SSH_CLIP_AGENT_SOCKET || env.AIH_SSH_CLIP_AGENT_URL || '').trim());
    }

    function clearSshTerminalClipboardPromptTimer() {
      if (!sshTerminalClipboardPromptTimer) return;
      clearTimeout(sshTerminalClipboardPromptTimer);
      sshTerminalClipboardPromptTimer = null;
      sshTerminalClipboardTimeoutConfig = null;
    }

    function finishSshTerminalClipboardRequest() {
      clearSshTerminalClipboardPromptTimer();
      sshTerminalClipboardRequestProtocol = '';
    }

    function ensureSshTerminalClipboardParser() {
      if (!sshTerminalClipboardParser) {
        sshTerminalClipboardParser = createTerminalClipboardImageParser({
          maxBytes: readSshClipMaxBytes()
        });
      }
      return sshTerminalClipboardParser;
    }

    function writeSshTerminalClipboardSequence(sequence) {
      const text = String(sequence || '');
      if (!text) return false;
      try {
        processObj.stdout.write(text);
        return true;
      } catch (_error) {
        return false;
      }
    }

    function getSshClipboardShimRootDir() {
      const sessionKey = buildSshClipboardSessionKey({
        env: processObj.env,
        cwd: processObj.cwd(),
        provider: cliName,
        accountId: activeId,
        pid: processObj.pid
      });
      return path.join(createSshClipboardInbox({
        fs,
        sessionKey,
        maxBytes: readSshClipMaxBytes()
      }).rootDir, 'shim');
    }

    function writeSshClipboardShimResponse(request, response) {
      if (!request || !request.responsePath) return false;
      const rootDir = getSshClipboardShimRootDir();
      if (!isSafeShimResponsePath(rootDir, request.responsePath, path)) return false;
      try {
        fs.mkdirSync(path.dirname(request.responsePath), { recursive: true });
        fs.writeFileSync(request.responsePath, JSON.stringify(response), 'utf8');
        return true;
      } catch (_error) {
        return false;
      }
    }

    function finishSshClipboardShimRequest(response) {
      const request = sshClipboardShimRequest;
      sshClipboardShimRequest = null;
      finishSshTerminalClipboardRequest();
      if (request) writeSshClipboardShimResponse(request, response);
    }

    function requestSshClipboardShimMimeList(request) {
      sshClipboardShimRequest = request;
      ensureSshTerminalClipboardParser();
      const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardListMimeTypesQuery({
        id: `aih-shim-${request.id}`,
        tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
      }));
      if (!wrote) {
        finishSshClipboardShimRequest({ ok: false, error: 'ssh_clip_shim_terminal_write_failed' });
        return false;
      }
      startSshTerminalClipboardTimeout('shim-mime-list', readSshTerminalClipboardTimeoutMs(DEFAULT_SHIM_TIMEOUT_MS), () => {
        finishSshClipboardShimRequest({ ok: false, error: 'ssh_clip_shim_mime_list_timeout' });
      });
      return true;
    }

    function requestSshClipboardShimRead(request) {
      sshClipboardShimRequest = request;
      ensureSshTerminalClipboardParser();
      const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardReadMimeQuery({
        id: `aih-shim-${request.id}`,
        mimeType: request.mimeType,
        name: 'AIH clipboard shim',
        tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
      }));
      if (!wrote) {
        finishSshClipboardShimRequest({ ok: false, error: 'ssh_clip_shim_terminal_write_failed' });
        return false;
      }
      startSshTerminalClipboardTimeout('shim-read', readSshTerminalClipboardTimeoutMs(DEFAULT_SHIM_TIMEOUT_MS), () => {
        finishSshClipboardShimRequest({ ok: false, error: 'ssh_clip_shim_read_timeout' });
      });
      return true;
    }

    function handleSshClipboardShimRequest(request) {
      if (!request || !shouldEnableSshTerminalClipboardImagePaste()) return false;
      const rootDir = getSshClipboardShimRootDir();
      if (!isSafeShimResponsePath(rootDir, request.responsePath, path)) return false;
      if (sshClipboardShimRequest) {
        writeSshClipboardShimResponse(request, { ok: false, error: 'ssh_clip_shim_busy' });
        return true;
      }
      if (request.kind === 'list' || request.mimeType === 'TARGETS') {
        return requestSshClipboardShimMimeList(request);
      }
      return requestSshClipboardShimRead(request);
    }

    function handleSshClipboardShimTerminalResult(result) {
      if (!sshClipboardShimRequest || !result) return false;
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        const code = String((result.errors[0] && result.errors[0].code) || result.errors[0].message || 'ssh_clip_shim_terminal_failed');
        finishSshClipboardShimRequest({ ok: false, error: code });
        return true;
      }
      if (Array.isArray(result.images) && result.images.length > 0) {
        const image = result.images[0];
        finishSshClipboardShimRequest({
          ok: true,
          mimeType: image.mimeType,
          byteLength: image.byteLength,
          sha256: image.sha256,
          data: image.buffer.toString('base64')
        });
        return true;
      }
      if (Array.isArray(result.textPastes) && result.textPastes.length > 0) {
        const textPaste = result.textPastes[0];
        finishSshClipboardShimRequest({
          ok: true,
          mimeType: textPaste.mimeType || 'text/plain',
          byteLength: textPaste.buffer.length,
          data: textPaste.buffer.toString('base64')
        });
        return true;
      }
      if (Array.isArray(result.mimeLists) && result.mimeLists.length > 0) {
        const seen = new Set();
        const mimeTypes = result.mimeLists.flat()
          .map((value) => String(value || '').trim().toLowerCase())
          .filter(Boolean)
          .filter((value) => {
            if (seen.has(value)) return false;
            seen.add(value);
            return true;
          });
        finishSshClipboardShimRequest({ ok: true, mimeTypes });
        return true;
      }
      return false;
    }

    function consumeSshClipboardShimRequests(data) {
      if (!shouldEnableSshTerminalClipboardImagePaste()) return data;
      if (!sshClipboardShimRequestParser) {
        sshClipboardShimRequestParser = createShimRequestParser();
      }
      // The shim parser's internal Buffer uses 'latin1' for byte-string identity.
      // Passing a UTF-8 decoded JS string directly causes Buffer.from(text,'latin1')
      // inside the parser to silently truncate each CJK/emoji code point to its low
      // byte, corrupting Chinese display over SSH. Pre-convert the string to a UTF-8
      // Buffer so the parser receives raw bytes it can round-trip through latin1 losslessly.
      const dataForParser = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      const result = sshClipboardShimRequestParser.consume(dataForParser);
      if (Array.isArray(result.requests)) {
        result.requests.forEach((request) => {
          handleSshClipboardShimRequest(request);
        });
      }
      if (!result.passthrough) return null;
      return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
    }

    function startSshTerminalPasteEventsMode() {
      if (sshTerminalPasteEventsModeEnabled) return;
      if (!shouldEnableSshTerminalPasteEvents()) return;
      ensureSshTerminalClipboardParser();
      writeSshTerminalClipboardSequence(buildTerminalClipboardPasteEventsSupportQuery({
        tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
      }));
      sshTerminalPasteEventsModeEnabled = writeSshTerminalClipboardSequence(buildTerminalClipboardPasteEventsModeSequence({
        enabled: true,
        tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
      }));
    }

    function stopSshTerminalPasteEventsMode() {
      if (!sshTerminalPasteEventsModeEnabled) return;
      sshTerminalPasteEventsModeEnabled = false;
      writeSshTerminalClipboardSequence(buildTerminalClipboardPasteEventsModeSequence({
        enabled: false,
        tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
      }));
    }

    function getSshClipboardInbox() {
      const sessionKey = buildSshClipboardSessionKey({
        env: processObj.env,
        cwd: processObj.cwd(),
        provider: cliName,
        accountId: activeId,
        pid: processObj.pid
      });
      if (!sshClipboardInboxes.has(sessionKey)) {
        sshClipboardInboxes.set(sessionKey, createSshClipboardInbox({
          fs,
          sessionKey,
          maxBytes: readSshClipMaxBytes()
        }));
      }
      return sshClipboardInboxes.get(sessionKey);
    }

    function writeSshClipboardStatus(message) {
      try {
        processObj.stdout.write(`\r\n\x1b[33m[aih]\x1b[0m ${message}\r\n`);
      } catch (_error) {}
    }

    function injectSshClipboardImagePath(filePath) {
      const inbox = getSshClipboardInbox();
      const safePath = inbox.assertSafeImagePath(filePath);
      if (ptyProc) ptyProc.write(safePath);
      return safePath;
    }

    function persistSshClipboardImage(image) {
      const inbox = getSshClipboardInbox();
      const normalized = normalizeImageForInjection(image, {
        fs,
        path,
        spawnSync,
        maxBytes: readSshClipMaxBytes()
      });
      return inbox.persistImage(normalized);
    }

    function formatSshClipAgentEndpoint(reason) {
      if (!reason) return '';
      if (reason.socketPath) return String(reason.socketPath);
      if (reason.url) return String(reason.url);
      return '';
    }

    function readSshTerminalClipboardTimeoutMs(defaultMs) {
      const configured = Number(processObj.env.AIH_SSH_TERMINAL_CLIPBOARD_TIMEOUT_MS);
      return Number.isInteger(configured) && configured > 0 ? configured : defaultMs;
    }

    function formatSshClipAgentStatus(reason) {
      const endpoint = formatSshClipAgentEndpoint(reason);
      const remoteForward = endpoint && endpoint.startsWith('/')
        ? ` Add SSH config: RemoteForward ${endpoint} 127.0.0.1:17652`
        : ' Add SSH config: RemoteForward /tmp/aih-clip-%r.sock 127.0.0.1:17652';
      const startAgent = ' Start aih clip-agent on the SSH client and set AIH_SSH_CLIP_AGENT=1.';
      const code = String(reason && reason.code || '');
      if (code === 'ssh_clip_agent_socket_missing') {
        return `non-zero-client clip-agent not connected${endpoint ? ` at ${endpoint}` : ''}.${startAgent}${remoteForward}`;
      }
      if (code === 'ssh_clip_agent_no_image') {
        return 'non-zero-client clip-agent reached the SSH client, but the client clipboard has no image.';
      }
      if (code === 'ssh_clip_agent_disabled') {
        return 'non-zero-client clip-agent fallback is disabled by AIH_SSH_CLIP_AGENT=0.';
      }
      if (code === 'ssh_clip_agent_timeout') {
        return `non-zero-client clip-agent timed out${endpoint ? ` at ${endpoint}` : ''}. Check the SSH RemoteForward and local agent.`;
      }
      if (code === 'ssh_clip_agent_http_status') {
        return `non-zero-client clip-agent returned HTTP ${reason.statusCode || 'error'}${endpoint ? ` at ${endpoint}` : ''}.`;
      }
      if (code) {
        return `non-zero-client clip-agent unavailable: ${code}${endpoint ? ` at ${endpoint}` : ''}.`;
      }
      return `non-zero-client clip-agent unavailable.${startAgent}${remoteForward}`;
    }

    function formatSshClipAgentOptInHint() {
      return ' Optional non-zero-client fallback is opt-in: use aih clip-agent with SSH RemoteForward and set AIH_SSH_CLIP_AGENT=1.';
    }

    function formatSshClipboardStatus(message, clipAgentReason) {
      if (!clipAgentReason) return message;
      return `${message} ${formatSshClipAgentStatus(clipAgentReason)}`;
    }

    async function tryPasteSshClipAgentImage() {
      if (!shouldEnableSshClipAgentImagePaste()) return false;
      if (sshClipAgentRequestInFlight) return false;
      sshClipAgentRequestInFlight = true;
      try {
        let clipAgentReason = null;
        const image = await fetchSshClipAgentImage({
          env: processObj.env,
          maxBytes: readSshClipMaxBytes(),
          onUnavailable: (reason) => {
            clipAgentReason = reason;
          }
        });
        if (!image) return { handled: false, reason: clipAgentReason };
        const saved = persistSshClipboardImage(image);
        injectSshClipboardImagePath(saved.filePath);
        return { handled: true };
      } catch (_error) {
        return { handled: false };
      } finally {
        sshClipAgentRequestInFlight = false;
      }
    }

    function tryPasteSshClipAgentImageOrReport(message) {
      if (!shouldEnableSshClipAgentImagePaste()) {
        writeSshClipboardStatus(`${message}${formatSshClipAgentOptInHint()}`);
        return true;
      }
      tryPasteSshClipAgentImage().then((result) => {
        if (!result || !result.handled) {
          writeSshClipboardStatus(formatSshClipboardStatus(message, result && result.reason));
        }
      });
      return true;
    }

    function consumeSshClipboardFrames(data) {
      if (!shouldEnableSshClipboardImagePaste()) return data;
      if (!sshClipboardParser) {
        sshClipboardParser = createClipboardFrameParser({
          maxBytes: readSshClipMaxBytes()
        });
      }
      const dataForParser = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      const result = sshClipboardParser.consume(dataForParser);
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        const code = String((result.errors[0] && result.errors[0].code) || result.errors[0].message || 'ssh_clip_frame_failed');
        writeSshClipboardStatus(`SSH image paste failed: ${code}`);
      }
      if (Array.isArray(result.images)) {
        result.images.forEach((image) => {
          try {
            const saved = persistSshClipboardImage(image);
            if (image.action === 'paste') {
              injectSshClipboardImagePath(saved.filePath);
            }
          } catch (error) {
            const code = String((error && error.code) || (error && error.message) || error || 'ssh_clip_persist_failed');
            writeSshClipboardStatus(`SSH image paste failed: ${code}`);
          }
        });
      }
      if (!result.passthrough) return null;
      return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
    }

    function decodeSshBracketedPasteImage(payload) {
      const text = String(payload || '').trim();
      if (!text) return null;
      return decodeTerminalClipboardImagePayload(text, { maxBytes: readSshClipMaxBytes() })
        || decodeTerminalClipboardImagePayload(Buffer.from(text, 'utf8').toString('base64'), {
          maxBytes: readSshClipMaxBytes()
        });
    }

    function consumeSshBracketedPasteImage(data) {
      if (!shouldEnableSshClipboardImagePaste() || !isSshRuntimeSession()) return data;
      const payload = extractBracketedPastePayload(data);
      if (payload == null || payload.length === 0) return data;
      const image = decodeSshBracketedPasteImage(payload);
      if (!image) return data;
      try {
        const saved = persistSshClipboardImage(image);
        injectSshClipboardImagePath(saved.filePath);
      } catch (error) {
        const code = String((error && error.code) || (error && error.message) || error || 'ssh_clip_bracketed_paste_persist_failed');
        writeSshClipboardStatus(`SSH bracketed image paste failed: ${code}`);
      }
      return null;
    }

    function consumeSshTerminalClipboardResponse(data) {
      if (!sshTerminalClipboardParser) return data;
      const result = sshTerminalClipboardParser.consume(data);
      if (result && result.progress) {
        refreshSshTerminalClipboardTimeout();
      }
      if (result && result.pasteEventsSupport) {
        sshTerminalPasteEventsSupport = result.pasteEventsSupport.supported ? 'supported' : 'unsupported';
      }
      if (handleSshClipboardShimTerminalResult(result)) {
        if (!result.passthrough) return null;
        return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
      }
      if (Array.isArray(result.unsupportedPasteNotifications) && result.unsupportedPasteNotifications.length > 0) {
        finishSshTerminalClipboardRequest();
        const mimeTypes = formatSshTerminalMimeTypes(result.unsupportedPasteNotifications);
        const message = `SSH terminal paste event did not advertise a supported image MIME type${mimeTypes}.${formatSshTerminalClipboardReadHint()}`;
        if (requestSshTerminalClipboardOsc52ImagePaste()) {
          writeSshClipboardStatus(`${message} Trying OSC 52 fallback.`);
        } else {
          tryPasteSshClipAgentImageOrReport(message);
        }
      }
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        if (sshTerminalClipboardRequestProtocol === 'osc5522-mime-list' && requestSshTerminalClipboardOsc5522ImagePaste()) {
          if (!result.passthrough) return null;
          return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
        }
        if (sshTerminalClipboardRequestProtocol === 'osc5522' && requestSshTerminalClipboardOsc52ImagePaste()) {
          if (!result.passthrough) return null;
          return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
        }
        finishSshTerminalClipboardRequest();
        const code = String((result.errors[0] && result.errors[0].code) || result.errors[0].message || 'ssh_clip_terminal_clipboard_failed');
        tryPasteSshClipAgentImageOrReport(`SSH terminal clipboard image failed: ${code}.${formatSshTerminalClipboardReadHint()}`);
      }
      if (Array.isArray(result.images) && result.images.length > 0) {
        finishSshTerminalClipboardRequest();
        result.images.forEach((image) => {
          try {
            const saved = persistSshClipboardImage(image);
            injectSshClipboardImagePath(saved.filePath);
          } catch (error) {
            const code = String((error && error.code) || (error && error.message) || error || 'ssh_clip_terminal_clipboard_persist_failed');
            writeSshClipboardStatus(`SSH terminal clipboard image failed: ${code}`);
          }
        });
      }
      if (Array.isArray(result.textPastes) && result.textPastes.length > 0) {
        finishSshTerminalClipboardRequest();
        result.textPastes.forEach((textPaste) => {
          try {
            if (ptyProc) ptyProc.write(textPaste.buffer.toString('utf8'));
          } catch (_error) {}
        });
      }
      if (Array.isArray(result.pasteRequests) && result.pasteRequests.length > 0) {
        finishSshTerminalClipboardRequest();
        result.pasteRequests.forEach((request) => {
          requestSshTerminalClipboardMimePaste(request);
        });
      }
      if (Array.isArray(result.mimeLists) && result.mimeLists.length > 0) {
        finishSshTerminalClipboardRequest();
        const mimeType = chooseSshTerminalImageMimeType(result.mimeLists.flat());
        if (mimeType) {
          requestSshTerminalClipboardMimePaste({
            mimeType,
            name: 'AIH image paste'
          });
        } else if (!requestSshTerminalClipboardOsc52ImagePaste()) {
          tryPasteSshClipAgentImageOrReport(`SSH terminal clipboard has no supported image MIME type.${formatSshTerminalClipboardReadHint()}`);
        }
      }
      if (!result.passthrough) return null;
      return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
    }

    function requestSshTerminalClipboardMimePaste(request) {
      if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
      ensureSshTerminalClipboardParser();
      const mimeType = String(request && request.mimeType || '').trim().toLowerCase();
      const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardReadMimeQuery({
        mimeType: request && request.mimeType,
        loc: request && request.loc,
        pw: request && request.pw,
        passwordKey: request && request.passwordKey,
        name: request && request.name,
        tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
      }));
      if (!wrote) return false;
      if (mimeType === 'text/plain') {
        startSshTerminalClipboardTimeout('osc5522-text-paste', readSshTerminalClipboardTimeoutMs(1500), () => {
          sshTerminalClipboardRequestProtocol = '';
          writeSshClipboardStatus('SSH terminal paste event did not return text clipboard data. Normal paste requires terminal OSC 5522 paste-event data support.');
        });
        return true;
      }
      startSshTerminalClipboardTimeout('osc5522', readSshTerminalClipboardTimeoutMs(5000), () => {
        if (!requestSshTerminalClipboardOsc52ImagePaste()) {
          sshTerminalClipboardRequestProtocol = '';
          tryPasteSshClipAgentImageOrReport(`SSH terminal paste event did not return image clipboard data.${formatSshTerminalClipboardReadHint()}`);
        }
      });
      return true;
    }

    function startSshTerminalClipboardTimeout(protocol, timeoutMs, onTimeout) {
      sshTerminalClipboardRequestProtocol = protocol;
      clearSshTerminalClipboardPromptTimer();
      const config = { protocol, timeoutMs, onTimeout };
      sshTerminalClipboardTimeoutConfig = config;
      armSshTerminalClipboardTimeout(config);
    }

    function armSshTerminalClipboardTimeout(config) {
      const token = Symbol('ssh-terminal-clipboard-timeout');
      config.token = token;
      sshTerminalClipboardPromptTimer = setTimeout(() => {
        if (sshTerminalClipboardTimeoutConfig !== config || config.token !== token) return;
        sshTerminalClipboardPromptTimer = null;
        sshTerminalClipboardTimeoutConfig = null;
        config.onTimeout();
      }, config.timeoutMs);
      if (sshTerminalClipboardPromptTimer && typeof sshTerminalClipboardPromptTimer.unref === 'function') {
        sshTerminalClipboardPromptTimer.unref();
      }
    }

    function refreshSshTerminalClipboardTimeout() {
      const config = sshTerminalClipboardTimeoutConfig;
      if (!config || !sshTerminalClipboardPromptTimer) return;
      clearTimeout(sshTerminalClipboardPromptTimer);
      sshTerminalClipboardPromptTimer = null;
      armSshTerminalClipboardTimeout(config);
    }

    function requestSshTerminalClipboardOsc52ImagePaste() {
      if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
      ensureSshTerminalClipboardParser();
      try {
        const wrote = writeSshTerminalClipboardSequence(buildOsc52ClipboardReadQuery({
          selection: 'c',
          tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
        }));
        if (!wrote) return false;
      } catch (_error) {
        return false;
      }
      startSshTerminalClipboardTimeout('osc52', readSshTerminalClipboardTimeoutMs(5000), () => {
        sshTerminalClipboardRequestProtocol = '';
        tryPasteSshClipAgentImageOrReport(`SSH terminal did not return image clipboard data.${formatSshTerminalClipboardReadHint()}`);
      });
      return true;
    }

    function requestSshTerminalClipboardOsc5522ImagePaste() {
      if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
      ensureSshTerminalClipboardParser();
      try {
        sshTerminalClipboardRequestSeq += 1;
        const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardReadImageQuery({
          id: `aih-${processObj.pid || 'pid'}-${sshTerminalClipboardRequestSeq}`,
          tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
        }));
        if (!wrote) return false;
      } catch (_error) {
        return false;
      }
      startSshTerminalClipboardTimeout('osc5522', readSshTerminalClipboardTimeoutMs(5000), () => {
        if (!requestSshTerminalClipboardOsc52ImagePaste()) {
          sshTerminalClipboardRequestProtocol = '';
          tryPasteSshClipAgentImageOrReport(`SSH terminal did not return image clipboard data.${formatSshTerminalClipboardReadHint()}`);
        }
      });
      return true;
    }

    function requestSshTerminalClipboardOsc5522MimeList() {
      if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
      ensureSshTerminalClipboardParser();
      try {
        sshTerminalClipboardRequestSeq += 1;
        const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardListMimeTypesQuery({
          id: `aih-${processObj.pid || 'pid'}-${sshTerminalClipboardRequestSeq}`,
          tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
        }));
        if (!wrote) return false;
      } catch (_error) {
        return false;
      }
      startSshTerminalClipboardTimeout('osc5522-mime-list', readSshTerminalClipboardTimeoutMs(900), () => {
        if (!requestSshTerminalClipboardOsc5522ImagePaste() && !requestSshTerminalClipboardOsc52ImagePaste()) {
          sshTerminalClipboardRequestProtocol = '';
          tryPasteSshClipAgentImageOrReport(`SSH terminal did not return clipboard MIME data.${formatSshTerminalClipboardReadHint()}`);
        }
      });
      return true;
    }

    function requestSshTerminalClipboardImagePaste() {
      if (sshTerminalPasteEventsSupport === 'unsupported' && requestSshTerminalClipboardOsc52ImagePaste()) {
        return true;
      }
      return requestSshTerminalClipboardOsc5522MimeList()
        || requestSshTerminalClipboardOsc5522ImagePaste()
        || requestSshTerminalClipboardOsc52ImagePaste();
    }

    function tryPasteLatestSshClipboardImage() {
      if (!shouldEnableSshClipboardImagePaste()) return false;
      try {
        const latest = getSshClipboardInbox().latestImagePath();
        if (latest) {
          injectSshClipboardImagePath(latest);
          return true;
        }
      } catch (_error) {}
      if (requestSshTerminalClipboardImagePaste()) return true;
      return tryPasteSshClipAgentImageOrReport('SSH image paste in strict zero-client mode needs terminal clipboard read support such as OSC 5522 or OSC 52 image/data-url data.');
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
      cancelCodexAutoPrompt();
      if (typeof isShellDrawerToggleSequence === 'function' && isShellDrawerToggleSequence(data)) {
        toggleShellDrawer();
        return;
      }
      if (shellDrawerVisible) {
        if (shellDrawerProc) shellDrawerProc.write(data);
        return;
      }
      if (isClipboardPasteTrigger(data)) {
        const imagePath = tryCaptureClipboardImagePathOnWindows();
        if (imagePath) {
          if (ptyProc) ptyProc.write(imagePath);
          return;
        }
        if (tryPasteLatestSshClipboardImage()) return;
      }
      if (ptyProc) ptyProc.write(data);
    };
    processObj.stdin.on('data', onStdinData);

    let outputBuffer = '';
    let isSwapping = false;
    let thresholdTimer = null;
    let usageDisplayTimer = null;
    let usageIdleStatusTimer = null;
    let lastUsageDisplaySignature = '';
    let lastKnownUsageStatusSummary = buildInitialUsageStatusSummary(activeId);
    let clipboardMirrorProc = null;
    let clipboardMirrorRestartTimer = null;
    let clipboardMirrorLockPath = '';
    let clipboardMirrorLockOwned = false;
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
    let lastClaudeHookDiagnosticSignature = '';
    let lastClaudeToolDiagnosticSignature = '';
    let lastClaudeHookNoEvidenceAt = 0;
    let lastClaudeToolNoEvidenceAt = 0;
    let pendingClaudeHookDiagnosticTimer = null;
    let pendingClaudeHookDiagnosticOutput = '';
    let pendingClaudeToolDiagnosticTimer = null;
    let pendingClaudeToolDiagnosticOutput = '';

    function canRenderUsageStatusBar() {
      if (String(processObj.env.AIH_RUNTIME_USAGE_STATUS_BAR || '1') === '0') return false;
      const stdout = processObj.stdout || {};
      const stdin = processObj.stdin || {};
      if (stdout.isTTY === true) return true;
      if (stdin.isTTY === true) return true;
      return false;
    }

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

    function shouldSuppressUsageStatusForFullscreenTui(args = activeForwardArgs) {
      if (String(processObj.env.AIH_RUNTIME_FORCE_USAGE_STATUS_BAR || '0') === '1') return false;
      if (cliName !== 'codex') return false;
      return isCodexResumeForwardArgs(args) || isAihServerProfileId(activeId);
    }

    function getTerminalRows() {
      return Math.max(1, Number(processObj.stdout && processObj.stdout.rows) || 24);
    }

    function getChildPtyRows(_args = activeForwardArgs) {
      // The child always gets the full terminal height: usage lives in the title,
      // so no bottom row is reserved.
      return getTerminalRows();
    }

    function stopUsageRefreshProcess() {
      usageRefreshInFlight = false;
    }

    function getUsageIdlePauseMs() {
      return 5 * 60 * 1000;
    }

    function isUsageRefreshPausedByIdle() {
      return Date.now() - lastSessionActivityAt > getUsageIdlePauseMs();
    }

    function markSessionActivity() {
      const wasIdle = isUsageRefreshPausedByIdle();
      lastSessionActivityAt = Date.now();
      if (wasIdle) {
        emitUsageStatus(activeId, { forcePrint: true, forceRefresh: true, bypassIdleCheck: true });
      }
    }

    async function refreshUsageSnapshotNoCache(cliNameArg, idArg) {
      const cache = readUsageCache(cliNameArg, idArg);
      if (typeof ensureUsageSnapshotAsync === 'function') {
        return ensureUsageSnapshotAsync(cliNameArg, idArg, cache, { forceRefresh: true });
      }
      if (typeof ensureUsageSnapshot === 'function') {
        return ensureUsageSnapshot(cliNameArg, idArg, cache, { forceRefresh: true });
      }
      return cache;
    }

    function getPersistedAccountState(id) {
      if (typeof getAccountStateIndex !== 'function') return null;
      const index = getAccountStateIndex();
      if (!index || typeof index.getAccountState !== 'function') return null;
      return index.getAccountState(cliName, id) || null;
    }

    function getPersistedRuntimeStatus(id) {
      const row = getPersistedAccountState(id);
      if (!row) return null;
      return deriveRuntimeStatus(row);
    }

    function buildRuntimeBlockedSummary(id) {
      const runtimeStatus = getPersistedRuntimeStatus(id);
      if (!isBlockingRuntimeStatus(runtimeStatus)) return '';
      return formatRuntimeStatusSummary(runtimeStatus, id);
    }

    function buildPersistedRuntimeStateForAuthInvalid(reason) {
      return buildAuthInvalidRuntimeState(reason);
    }

    function buildRuntimeBaseState(accountId) {
      const row = getPersistedAccountState(accountId) || {};
      const apiKeyInfo = readCodexApiKeyAccountInfo(accountId);
      return {
        status: row.status || 'up',
        configured: typeof row.configured === 'boolean' ? row.configured : true,
        apiKeyMode: typeof row.apiKeyMode === 'boolean' ? row.apiKeyMode : Boolean(row.api_key_mode || apiKeyInfo.apiKeyMode),
        authMode: row.authMode || row.auth_mode || '',
        displayName: row.displayName || row.display_name || ''
      };
    }

    function persistRuntimeState(runtimeState) {
      const baseState = buildRuntimeBaseState(activeId);
      if (accountStateService && typeof accountStateService.recordRuntimeFailure === 'function') {
        return accountStateService.recordRuntimeFailure(cliName, activeId, runtimeState, baseState);
      }
      return false;
    }

    function persistAuthInvalidRuntimeState(reason) {
      return persistRuntimeState(buildPersistedRuntimeStateForAuthInvalid(reason));
    }

    function clearPersistedRuntimeState(id) {
      const accountId = String(id || activeId || '').trim();
      const baseState = buildRuntimeBaseState(accountId);
      if (accountStateService && typeof accountStateService.clearRuntimeBlock === 'function') {
        return accountStateService.clearRuntimeBlock(cliName, accountId, {
          ...baseState,
          evidence: 'login_success'
        });
      }
      return false;
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
      lastUsageDisplaySignature = '';
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
          runCliPty(cliName, activeId, [], true);
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

    function stopClipboardMirrorProcess() {
      if (clipboardMirrorRestartTimer) {
        clearTimeout(clipboardMirrorRestartTimer);
        clipboardMirrorRestartTimer = null;
      }
      if (clipboardMirrorProc) {
        const proc = clipboardMirrorProc;
        clipboardMirrorProc = null;
        try { proc.kill(); } catch (_error) {}
      }
      releaseClipboardMirrorLock();
    }

    function isProcessAlive(pid) {
      const safePid = Number(pid);
      if (!Number.isInteger(safePid) || safePid <= 0) return false;
      const killFn = typeof processObj.kill === 'function' ? processObj.kill.bind(processObj) : process.kill.bind(process);
      try {
        killFn(safePid, 0);
        return true;
      } catch (_error) {
        return false;
      }
    }

    function acquireClipboardMirrorLock() {
      if (clipboardMirrorLockOwned) return true;
      const rootDir = path.join(aiHomeDir, 'runtime-locks');
      const lockPath = path.join(rootDir, 'windows-clipboard-mirror.lock');
      try {
        fs.mkdirSync(rootDir, { recursive: true });
      } catch (_error) {
        return false;
      }

      try {
        const fd = fs.openSync(lockPath, 'wx');
        const payload = {
          pid: processObj.pid,
          createdAt: Date.now()
        };
        fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
        fs.closeSync(fd);
        clipboardMirrorLockPath = lockPath;
        clipboardMirrorLockOwned = true;
        return true;
      } catch (_error) {}

      try {
        const raw = String(fs.readFileSync(lockPath, 'utf8') || '').trim();
        const info = raw ? JSON.parse(raw) : null;
        const ownerPid = Number(info && info.pid);
        if (!isProcessAlive(ownerPid)) {
          fs.unlinkSync(lockPath);
          const fd = fs.openSync(lockPath, 'wx');
          const payload = {
            pid: processObj.pid,
            createdAt: Date.now()
          };
          fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
          fs.closeSync(fd);
          clipboardMirrorLockPath = lockPath;
          clipboardMirrorLockOwned = true;
          return true;
        }
      } catch (_error) {}

      return false;
    }

    function releaseClipboardMirrorLock() {
      if (!clipboardMirrorLockOwned || !clipboardMirrorLockPath) return;
      try { fs.unlinkSync(clipboardMirrorLockPath); } catch (_error) {}
      clipboardMirrorLockOwned = false;
      clipboardMirrorLockPath = '';
    }

    function startClipboardImageMirrorProcess() {
      if (!canBridgeWindowsClipboard()) return;
      if (String(processObj.env.AIH_WINDOWS_IMAGE_PASTE || '1') === '0') return;
      const defaultMirror = '0';
      if (String(processObj.env.AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR || defaultMirror) !== '1') return;
      if (isLogin) return;
      if (!isInteractiveRuntimeSession(activeForwardArgs)) return;
      if (typeof spawn !== 'function') return;
      // Cross-instance singleton: only one mirror poller should watch global clipboard.
      if (!acquireClipboardMirrorLock()) return;

      const wslMode = isWslPlatform();
      const ownerPid = processObj.platform === 'win32' ? Number(processObj.pid) : 0;
      const psScript = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        `$ownerPid = ${Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid : 0}`,
        '$allowedPidMap = @{}',
        '$allowedPidRefreshAt = [DateTime]::MinValue',
        'Add-Type -Namespace AihNative -Name User32 -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out int lpdwProcessId);\'',
        'function Update-AihAllowedPidMap {',
        '  $script:allowedPidMap = @{}',
        '  if ($ownerPid -le 0) { return }',
        '  $currentPid = [int]$ownerPid',
        '  for ($i = 0; $i -lt 16 -and $currentPid -gt 0; $i++) {',
        '    $script:allowedPidMap[[string]$currentPid] = $true',
        '    $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $currentPid) -ErrorAction SilentlyContinue',
        '    if ($null -eq $proc) { break }',
        '    $parentPid = [int]$proc.ParentProcessId',
        '    if ($parentPid -le 0 -or $parentPid -eq $currentPid) { break }',
        '    $currentPid = $parentPid',
        '  }',
        '  $script:allowedPidRefreshAt = [DateTime]::UtcNow.AddSeconds(2)',
        '}',
        'function Test-AihForegroundWindow {',
        '  if ($ownerPid -le 0) { return $true }',
        '  if ([DateTime]::UtcNow -ge $script:allowedPidRefreshAt -or $script:allowedPidMap.Count -eq 0) { Update-AihAllowedPidMap }',
        '  if ($script:allowedPidMap.Count -eq 0) { return $false }',
        '  $hwnd = [AihNative.User32]::GetForegroundWindow()',
        '  if ($hwnd -eq [System.IntPtr]::Zero) { return $false }',
        '  $foregroundPid = 0',
        '  [void][AihNative.User32]::GetWindowThreadProcessId($hwnd, [ref]$foregroundPid)',
        '  if ($foregroundPid -le 0) { return $false }',
        '  return $script:allowedPidMap.ContainsKey([string][int]$foregroundPid)',
        '}',
        '$pendingImage = $false',
        '$pendingSince = [DateTime]::UtcNow',
        `$wslMode = $${wslMode ? 'true' : 'false'}`,
        'while ($true) {',
        '  try {',
        '    if (-not (Test-AihForegroundWindow)) {',
        '      $pendingImage = $false',
        '      Start-Sleep -Milliseconds 60',
        '      continue',
        '    }',
        '    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
        '      if (-not $pendingImage) {',
        '        $pendingImage = $true',
        '      }',
        '      $pendingSince = [DateTime]::UtcNow',
        '    }',
        '    if ($pendingImage) {',
        '      $handled = $false',
        '      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
        '        $img = [System.Windows.Forms.Clipboard]::GetImage()',
        '        if ($null -ne $img) {',
        '          $dir = Join-Path $env:TEMP "aih-image-paste"',
        '          [System.IO.Directory]::CreateDirectory($dir) | Out-Null',
        '          $cutoff = [DateTime]::UtcNow.AddDays(-1)',
        '          Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -lt $cutoff } | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {} }',
        '          $file = Join-Path $dir ("aih_clip_" + [DateTime]::Now.ToString("yyyyMMdd_HHmmss_fff") + ".png")',
        '          $img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)',
        '          if ($wslMode) {',
        '            if ($file -match "^[A-Za-z]:\\\\") {',
        '              $drive = $file.Substring(0, 1).ToLower()',
        '              $rest = $file.Substring(2).Replace("\\\\", "/")',
        '              $pastePath = "/mnt/" + $drive + $rest',
        '            } else {',
        '              $pastePath = $file',
        '            }',
        '            [System.Windows.Forms.Clipboard]::SetText($pastePath)',
        '          } else {',
        '            [System.Windows.Forms.Clipboard]::SetText($file)',
        '          }',
        '          $handled = $true',
        '        }',
        '      }',
        '      if ($handled) {',
        '        $pendingImage = $false',
        '      } else {',
        '        $ageMs = ([DateTime]::UtcNow - $pendingSince).TotalMilliseconds',
        '        if ($ageMs -gt 3000) { $pendingImage = $false }',
        '      }',
        '    }',
        '  } catch {}',
        '  Start-Sleep -Milliseconds 30',
        '}'
      ].join('; ');

      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      const candidates = wslMode
        ? ['powershell.exe', 'powershell']
        : ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];

      const scheduleMirrorRestart = () => {
        if (cleanedUp) return;
        if (clipboardMirrorRestartTimer) return;
        clipboardMirrorRestartTimer = setTimeout(() => {
          clipboardMirrorRestartTimer = null;
          trySpawn(0);
        }, 1200);
        if (clipboardMirrorRestartTimer && typeof clipboardMirrorRestartTimer.unref === 'function') {
          clipboardMirrorRestartTimer.unref();
        }
      };

      const trySpawn = (index) => {
        if (index >= candidates.length) {
          releaseClipboardMirrorLock();
          return;
        }
        if (cleanedUp) return;
        const cmd = candidates[index];
        let child = null;
        try {
          child = spawn(cmd, ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
            cwd: processObj.cwd(),
            env: { ...processObj.env },
            stdio: ['ignore', 'ignore', 'ignore']
          });
        } catch (_error) {
          trySpawn(index + 1);
          return;
        }
        if (!child || typeof child.on !== 'function') {
          trySpawn(index + 1);
          return;
        }
        let resolved = false;
        child.on('spawn', () => {
          resolved = true;
          clipboardMirrorProc = child;
        });
        child.on('error', () => {
          if (clipboardMirrorProc === child) clipboardMirrorProc = null;
          if (!resolved) {
            trySpawn(index + 1);
            return;
          }
          releaseClipboardMirrorLock();
          scheduleMirrorRestart();
        });
        child.on('exit', () => {
          if (clipboardMirrorProc === child) clipboardMirrorProc = null;
          if (!resolved) {
            trySpawn(index + 1);
            return;
          }
          releaseClipboardMirrorLock();
          scheduleMirrorRestart();
        });
      };

      trySpawn(0);
    }

    function getUsageDisplayIntervalMs() {
      return Math.max(15_000, Number(processObj.env.AIH_RUNTIME_USAGE_DISPLAY_INTERVAL_MS) || 60_000);
    }

    function getUsageStaleMs() {
      return Math.max(60_000, Number(processObj.env.AIH_RUNTIME_USAGE_STALE_MS) || 300_000);
    }

    function shouldShowUsageInPty(args = activeForwardArgs) {
      const enabled = String(processObj.env.AIH_RUNTIME_SHOW_USAGE || '1') !== '0';
      const interactive = isInteractiveRuntimeSession(args);
      return enabled && interactive && isUsageManagedCli(cliName) && !shouldSuppressUsageStatusForFullscreenTui(args);
    }

    function readCodexApiKeyAccountInfo(id) {
      if (cliName !== 'codex') return { apiKeyMode: false, baseUrl: '' };
      const accountId = String(id || '').trim();
      if (!/^\d+$/.test(accountId)) return { apiKeyMode: false, baseUrl: '' };
      const profileDir = getProfileDir('codex', accountId);
      let baseUrl = '';

      try {
        const envPath = path.join(profileDir, '.aih_env.json');
        if (fs.existsSync(envPath)) {
          const envData = JSON.parse(fs.readFileSync(envPath, 'utf8'));
          const apiKey = String(envData && envData.OPENAI_API_KEY || '').trim();
          baseUrl = String(envData && envData.OPENAI_BASE_URL || '').trim();
          if (apiKey) return { apiKeyMode: true, baseUrl };
        }
      } catch (_error) {}

      try {
        const authPath = path.join(profileDir, '.codex', 'auth.json');
        if (fs.existsSync(authPath)) {
          const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
          const apiKey = String(authData && authData.OPENAI_API_KEY || '').trim();
          if (apiKey) return { apiKeyMode: true, baseUrl };
        }
      } catch (_error) {}

      try {
        const status = typeof checkStatus === 'function' ? checkStatus('codex', profileDir) : null;
        const accountName = String(status && status.accountName || '');
        if (accountName.startsWith('API Key')) return { apiKeyMode: true, baseUrl };
      } catch (_error) {}

      return { apiKeyMode: false, baseUrl: '' };
    }

    function buildApiKeyStatusSummary(id) {
      const accountId = String(id || '').trim();
      if (isAihServerProfileId(accountId) && supportsAihServerProfile(cliName)) {
        return `account ${accountId} api-key mode`;
      }
      const info = readCodexApiKeyAccountInfo(accountId);
      if (!info.apiKeyMode) return '';
      return `account ${accountId} api-key mode`;
    }

    function buildInitialUsageStatusSummary(id) {
      const targetId = String(id || activeId || '').trim();
      return buildApiKeyStatusSummary(targetId) || `account ${targetId} usage remaining: unknown`;
    }

    function buildUsageStatusFromCache(cache) {
      const capturedAt = Number(cache && cache.capturedAt);
      const safeCapturedAt = Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : null;
      const values = getUsageRemainingPercentValues(cache);
      if (!values.length) {
        return {
          remainingPct: null,
          capturedAt: safeCapturedAt
        };
      }
      return {
        remainingPct: Math.min(...values),
        capturedAt: safeCapturedAt
      };
    }

    function refreshUsageInBackgroundIfStale(id, cache) {
      const capturedAt = Number(cache && cache.capturedAt);
      const stale = !cache || !Number.isFinite(capturedAt) || capturedAt <= 0 || (Date.now() - capturedAt > getUsageStaleMs());
      if (stale) {
        tryRefreshUsageSnapshotInBackground(id);
      }
    }

    function buildUsageStatusSummary(status, id) {
      const accountId = String(id || '').trim();
      if (!Number.isFinite(status && status.remainingPct)) {
        return `account ${accountId} usage remaining: unknown`;
      }
      return `account ${accountId} usage remaining: ${status.remainingPct.toFixed(1)}%`;
    }

    let lastUsageTitle = '';

    function isUsageApiKeyAccount(id) {
      // buildApiKeyStatusSummary is non-empty only for API-key accounts (codex
      // api-key creds, or the built-in aih server profile); oauth → empty.
      return !!buildApiKeyStatusSummary(String(id || '').trim());
    }

    function formatUsageRemainingShort(id) {
      const cache = readUsageCache(cliName, String(id || '').trim());
      // codex/claude: every window that has a figure, compact (e.g. "5h:91% 7days:52%").
      const windows = formatUsageWindows(cache, { compact: true });
      if (windows) return windows;
      const status = buildUsageStatusFromCache(cache);
      if (!Number.isFinite(status.remainingPct)) return '?';
      const pct = Math.max(0, Math.min(100, status.remainingPct));
      return `${Math.round(pct)}%`;
    }

    // Compact, screen-safe title tag. OAuth accounts carry their remaining
    // headroom ([o:<id>:<remaining>]); API-key accounts have no usage figure
    // ([a:<id>]). This is the entire usage surface now — no working/comfort
    // suffix, no in-screen row.
    function buildUsageTitle(id = activeId) {
      const accid = String(id || '').trim();
      if (!accid) return '';
      if (isUsageApiKeyAccount(accid)) return `[a:${accid}]`;
      return `[o:${accid}:${formatUsageRemainingShort(accid)}]`;
    }

    function buildRuntimeTerminalTitle(id = activeId, options = {}) {
      const accountId = String(id || '').trim();
      const usageTitle = options.withUsage === false
        ? (accountId ? `[a:${accountId}]` : '')
        : buildUsageTitle(accountId);
      if (!usageTitle) return '';
      return usageTitle;
    }

    function writeTerminalProgress(state, progress = 0) {
      if (!processObj.env || !processObj.env.WT_SESSION) return;
      try {
        processObj.stdout.write(`\x1b]9;4;${Number(state) || 0};${Number(progress) || 0}\x07`);
      } catch (_error) {}
    }

    function clearRuntimeTerminalRunning() {
      writeTerminalProgress(0, 0);
    }

    function writeUsageStatusLine(_lineText, _options = {}) {
      if (shellDrawerVisible) return;
      if (!canRenderUsageStatusBar()) return;
      const title = buildRuntimeTerminalTitle(activeId, { withUsage: true });
      if (!title || title === lastUsageTitle) return;
      lastUsageTitle = title;
      // OSC 0 sets the window/icon title — screen-safe: never touches the buffer,
      // cursor, scroll region or SGR, so it can't disturb the child's rendering.
      processObj.stdout.write(`\x1b]0;${title}\x07`);
    }

    function shouldShowProviderRuntimeTitle(args = activeForwardArgs) {
      if (shouldShowUsageInPty(args)) return false;
      if (isLogin) return false;
      return isInteractiveRuntimeSession(args) && !shouldSuppressUsageStatusForFullscreenTui(args);
    }

    function writeProviderRuntimeTitle() {
      if (shellDrawerVisible) return;
      if (!canRenderUsageStatusBar()) return;
      if (!shouldShowProviderRuntimeTitle()) return;
      const title = buildRuntimeTerminalTitle(activeId, { withUsage: false });
      if (!title || title === lastUsageTitle) return;
      lastUsageTitle = title;
      processObj.stdout.write(`\x1b]0;${title}\x07`);
    }

    function startRuntimeTitleWatcher() {
      if (!shouldShowProviderRuntimeTitle()) return;
      writeProviderRuntimeTitle();
    }

    function startUsageIdleStatusWatcher() {
      if (!shouldShowUsageInPty()) return;
      if (usageIdleStatusTimer) return;
      // Keep the cached summary (for the shell drawer) and the title fresh, and
      // react promptly to runtime-blocked transitions. emitUsageStatus dedupes,
      // so the title is only rewritten when its tag actually changes.
      usageIdleStatusTimer = setInterval(() => {
        if (cleanedUp || isSwapping || !ptyProc) return;
        if (authRecoveryPrompt) return;
        emitUsageStatus(activeId, { forcePrint: true, forceRefresh: false });
      }, 900);
      if (usageIdleStatusTimer && typeof usageIdleStatusTimer.unref === 'function') {
        usageIdleStatusTimer.unref();
      }
    }

    function emitUsageStatus(id, options = {}) {
      if (shellDrawerVisible) return;
      if (authRecoveryPrompt) return;
      if (!shouldShowUsageInPty()) return;
      const forcePrint = !!options.forcePrint;
      const forceRefresh = !!options.forceRefresh;
      const bypassIdleCheck = !!options.bypassIdleCheck;
      if (!bypassIdleCheck && isUsageRefreshPausedByIdle()) {
        writeUsageStatusLine();
        return;
      }
      const targetId = String(id || activeId || '').trim();
      const numericAccountId = /^\d+$/.test(targetId);
      if (!numericAccountId) {
        const apiKeySummary = buildApiKeyStatusSummary(targetId);
        if (!apiKeySummary) return;
        lastKnownUsageStatusSummary = apiKeySummary;
        shellDrawerStatusSummary = apiKeySummary;
        const signature = `${targetId}|api-key`;
        if (!forcePrint && signature === lastUsageDisplaySignature) return;
        lastUsageDisplaySignature = signature;
        writeUsageStatusLine();
        return;
      }
      const runtimeSummary = buildRuntimeBlockedSummary(targetId);
      if (runtimeSummary) {
        lastKnownUsageStatusSummary = runtimeSummary;
        shellDrawerStatusSummary = runtimeSummary;
        const signature = `${targetId}|runtime|${runtimeSummary}`;
        if (!forcePrint && signature === lastUsageDisplaySignature) return;
        lastUsageDisplaySignature = signature;
        writeUsageStatusLine();
        return;
      }
      const apiKeySummary = buildApiKeyStatusSummary(targetId);
      if (apiKeySummary) {
        lastKnownUsageStatusSummary = apiKeySummary;
        shellDrawerStatusSummary = apiKeySummary;
        const signature = `${targetId}|api-key`;
        if (!forcePrint && signature === lastUsageDisplaySignature) return;
        lastUsageDisplaySignature = signature;
        writeUsageStatusLine();
        return;
      }
      const cache = readUsageCache(cliName, targetId);
      if (forceRefresh) {
        tryRefreshUsageSnapshotInBackground(targetId);
      } else {
        refreshUsageInBackgroundIfStale(targetId, cache);
      }
      if (usageRefreshInFlight) {
        writeUsageStatusLine();
        return;
      }
      const status = buildUsageStatusFromCache(cache);
      lastKnownUsageStatusSummary = buildUsageStatusSummary(status, targetId);
      shellDrawerStatusSummary = lastKnownUsageStatusSummary;
      const remainingSignature = Number.isFinite(status.remainingPct) ? status.remainingPct.toFixed(3) : 'na';
      const signature = `${targetId}|${status.capturedAt || 0}|${remainingSignature}`;
      if (!forcePrint && signature === lastUsageDisplaySignature) return;
      lastUsageDisplaySignature = signature;
      writeUsageStatusLine();
    }

    function tryRefreshUsageSnapshotInBackground(id) {
      if (!isUsageManagedCli(cliName)) return;
      if (typeof ensureUsageSnapshot !== 'function' && typeof ensureUsageSnapshotAsync !== 'function') return;
      if (usageRefreshInFlight) return;
      const minIntervalMs = Math.max(30_000, Number(processObj.env.AIH_RUNTIME_USAGE_REFRESH_MIN_MS) || 60_000);
      const now = Date.now();
      if (now - lastUsageRefreshStartAt < minIntervalMs) return;
      const targetId = String(id || '').trim();
      if (!/^\d+$/.test(targetId)) return;

      lastUsageRefreshStartAt = now;
      usageRefreshInFlight = true;
      Promise.resolve()
        .then(() => refreshUsageSnapshotNoCache(cliName, targetId))
        .catch(() => null)
        .finally(() => {
          usageRefreshInFlight = false;
          if (!cleanedUp) emitUsageStatus(targetId, { forcePrint: true });
        });
    }

    function cleanupTerminalHooks() {
      if (cleanedUp) return;
      cleanedUp = true;
      stopBootWave();
      if (lastUsageTitle) {
        try { processObj.stdout.write('\x1b]0;\x07'); } catch (_error) {}
        lastUsageTitle = '';
      }
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
      if (usageDisplayTimer) {
        clearInterval(usageDisplayTimer);
        usageDisplayTimer = null;
      }
      if (usageIdleStatusTimer) {
        clearInterval(usageIdleStatusTimer);
        usageIdleStatusTimer = null;
      }
      if (pendingClaudeHookDiagnosticTimer) {
        clearTimeout(pendingClaudeHookDiagnosticTimer);
        pendingClaudeHookDiagnosticTimer = null;
      }
      if (pendingClaudeToolDiagnosticTimer) {
        clearTimeout(pendingClaudeToolDiagnosticTimer);
        pendingClaudeToolDiagnosticTimer = null;
      }
      clearSshTerminalClipboardPromptTimer();
      stopSshTerminalPasteEventsMode();
      cancelCodexAutoPrompt();
      stopClipboardMirrorProcess();
      stopUsageRefreshProcess();
      applyFullTerminalViewport({ force: true });
      shellDrawerVisible = false;
      clearShellDrawerLayouts([lastKnownShellDrawerLayout, getShellDrawerLayout()]);
      if (shellDrawerProc) {
        try { shellDrawerProc.kill(); } catch (_error) {}
        shellDrawerProc = null;
      }
    }

    function getThresholdPct() {
      const cfg = readUsageConfig({ filePath: path.join(aiHomeDir, 'usage-config.json') });
      const val = Number(cfg && cfg.threshold_pct);
      if (!Number.isFinite(val)) return 95;
      return Math.max(1, Math.min(100, Math.floor(val)));
    }

    function getCurrentRemainingPct(id) {
      if (buildRuntimeBlockedSummary(id)) return null;
      if (buildApiKeyStatusSummary(id)) return null;
      const cache = readUsageCache(cliName, id);
      const capturedAt = Number(cache && cache.capturedAt);
      const stale = !cache || !Number.isFinite(capturedAt) || capturedAt <= 0 || (Date.now() - capturedAt > getUsageStaleMs());
      if (stale) {
        refreshUsageInBackgroundIfStale(id, cache);
        return null;
      }
      const status = buildUsageStatusFromCache(cache);
      return status.remainingPct;
    }

    function switchToAccount(targetId, reasonLabel) {
      const nextId = String(targetId || '').trim();
      if (!/^\d+$/.test(nextId) || nextId === activeId || isSwapping) return;
      isSwapping = true;
      const fromId = activeId;
      const fromCodexDir = path.join(getProfileDir(cliName, fromId), '.codex');
      const keepExplicitResume = isCodexResumeForwardArgs(activeForwardArgs);
      const resumeThreadId = cliName === 'codex' && !isLogin && !keepExplicitResume
        ? resolveLatestCodexThreadIdForCwd(fromCodexDir, processObj.cwd())
        : '';
      const switchForwardArgs = keepExplicitResume
        ? activeForwardArgs
        : cliName === 'codex' && !isLogin
        ? buildCodexAutoResumeArgs(fromId, resumeThreadId)
        : activeForwardArgs;
      processObj.stdout.write(`\r\n\x1b[33m[aih] ${reasonLabel}. Auto-switch: ${fromId} -> ${nextId}\x1b[0m\r\n`);
      if (cliName === 'codex') {
        const resumeLabel = keepExplicitResume
          ? activeForwardArgs.slice(1).join(' ')
          : resumeThreadId ? resumeThreadId : '--last';
        processObj.stdout.write(`\x1b[90m[aih] resuming Codex session ${resumeLabel} on account ${nextId}\x1b[0m\r\n`);
      }
      activeId = nextId;
      activeForwardArgs = getForwardArgList(switchForwardArgs);
      lastUsageDisplaySignature = '';
      authInvalidHandledForCurrentSpawn = false;
      resetAuthRecoveryPrompt();
      if (ptyProc) {
        try { ptyProc.kill(); } catch (_error) {}
      }
      setTimeout(() => {
        try {
          ensureSessionStoreLinks(cliName, activeId);
        } catch (_error) {}
        outputBuffer = '';
        hasReceivedData = false;
        ptyProc = spawnPty(cliName, cliPath, activeId, activeForwardArgs, isLogin, {
          rows: getChildPtyRows(activeForwardArgs)
        });
        startBootWave();
        attachOnData(ptyProc);
        startRuntimeHelpersOnce();
        emitUsageStatus(activeId, { forcePrint: true, forceRefresh: true });
        isSwapping = false;
      }, 250);
    }

    function startThresholdWatcher() {
      const enabled = String(processObj.env.AIH_RUNTIME_AUTO_SWITCH || '1') !== '0';
      const interactive = isInteractiveRuntimeSession(activeForwardArgs);
      if (!enabled || !interactive || cliName !== 'codex') return;
      const intervalMs = Math.max(30_000, Number(processObj.env.AIH_RUNTIME_THRESHOLD_CHECK_MS) || 60_000);
      thresholdTimer = setInterval(() => {
        if (isSwapping || !ptyProc) return;
        if (isUsageRefreshPausedByIdle()) return;
        const remaining = getCurrentRemainingPct(activeId);
        if (!Number.isFinite(remaining)) return;
        const usagePct = Math.max(0, Math.min(100, 100 - remaining));
        const thresholdPct = getThresholdPct();
        if (usagePct < thresholdPct) return;
        const nextId = getNextRuntimeAccountId();
        if (!nextId || String(nextId) === activeId) {
          processObj.stdout.write(`\r\n\x1b[90m[aih] usage ${remaining.toFixed(1)}% remaining (>= threshold hit), no eligible standby account.\x1b[0m\r\n`);
          return;
        }
        switchToAccount(nextId, `usage threshold reached (${remaining.toFixed(1)}% remaining)`);
      }, intervalMs);
      if (thresholdTimer && typeof thresholdTimer.unref === 'function') thresholdTimer.unref();
    }

    function stopThresholdWatcher() {
      if (thresholdTimer) {
        clearInterval(thresholdTimer);
        thresholdTimer = null;
      }
    }

    function getNextRuntimeAccountId() {
      const nextId = typeof getNextAvailableId === 'function'
        ? getNextAvailableId(cliName, activeId, { refreshSnapshot: false })
        : null;
      if (!nextId || String(nextId) === activeId) return nextId;
      const runtimeSummary = buildRuntimeBlockedSummary(nextId);
      if (runtimeSummary) return null;
      return nextId;
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

    function getClaudeHookDiagnosticDelayMs() {
      return Math.max(0, Number(processObj.env.AIH_CLAUDE_HOOK_DIAGNOSTIC_DELAY_MS) || 250);
    }

    function getClaudeDiagnosticNoEvidenceCooldownMs() {
      return Math.max(1000, Number(processObj.env.AIH_CLAUDE_DIAGNOSTIC_NO_EVIDENCE_COOLDOWN_MS) || 60_000);
    }

    function shouldPrintClaudeDiagnostic(diagnostic) {
      if (diagnostic && diagnostic.found) return true;
      return String(processObj.env.AIH_CLAUDE_DIAGNOSTIC_VERBOSE || '').trim() === '1'
        && String(processObj.env.AIH_CLAUDE_DIAGNOSTIC_STDOUT || '').trim() === '1';
    }

    function appendPendingClaudeDiagnosticOutput(currentOutput, nextOutput) {
      const joined = [currentOutput, nextOutput].filter(Boolean).join('\n');
      return joined.length > 4000 ? joined.slice(-4000) : joined;
    }

    function readActiveProfileEnv() {
      const envPath = path.join(getProfileDir(cliName, activeId), '.aih_env.json');
      try {
        const parsed = JSON.parse(fs.readFileSync(envPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (_error) {
        return {};
      }
    }

    function buildClaudeDiagnosticIdentity() {
      if (cliName !== 'claude') return {};
      const env = readActiveProfileEnv();
      const anthropicBaseUrl = String(env.ANTHROPIC_BASE_URL || '').trim();
      const relay = isAihServerProfileId(activeId)
        ? {
          kind: 'aih_server',
          baseUrl: anthropicBaseUrl,
          accountId: activeId,
          providerMode: 'auto'
        }
        : null;
      return {
        provider: 'claude',
        clientProvider: 'claude',
        ...(relay ? { relay } : {})
      };
    }

    function captureClaudeHookDiagnostic(triggerOutput) {
      if (cliName !== 'claude') return;
      const diagnostic = collectClaudeStopHookDiagnostics({
        fs,
        path,
        hostHomeDir,
        cwd: processObj.cwd(),
        sinceMs: Math.max(0, runtimeStartedAt - 60_000)
      });
      const latest = diagnostic && diagnostic.latest ? diagnostic.latest : null;
      const hasEvidence = Boolean(diagnostic && diagnostic.found);
      if (!hasEvidence) {
        const now = Date.now();
        if (now - lastClaudeHookNoEvidenceAt < getClaudeDiagnosticNoEvidenceCooldownMs()) return;
        lastClaudeHookNoEvidenceAt = now;
      }
      const signature = latest
        ? `${latest.transcriptPath || ''}:${latest.timestamp || ''}:${latest.toolUseID || ''}:${latest.stderr || ''}`
        : `no-evidence:${String(triggerOutput || '').slice(0, 240)}`;
      if (signature && signature === lastClaudeHookDiagnosticSignature) return;
      lastClaudeHookDiagnosticSignature = signature;
      const result = appendClaudeHookDiagnosticLog({
        fs,
        path,
        ...buildClaudeDiagnosticIdentity(),
        aiHomeDir,
        cwd: processObj.cwd(),
        accountId: activeId,
        cliPath,
        forwardArgs: activeForwardArgs,
        triggerOutput,
        diagnostic
      });
      if (!result || !result.ok || !result.logPath) return;
      const evidenceText = diagnostic && diagnostic.found
        ? `transcript=${path.basename(latest.transcriptPath || '')}`
        : 'transcript evidence not found yet';
      if (!shouldPrintClaudeDiagnostic(diagnostic)) return;
      processObj.stdout.write(`\r\n\x1b[33m[aih]\x1b[0m Claude Stop hook diagnostic saved: ${result.logPath} (${evidenceText})\r\n`);
    }

    function captureClaudeToolDiagnostic(triggerOutput) {
      if (cliName !== 'claude') return;
      const diagnostic = collectClaudeToolProtocolDiagnostics({
        fs,
        path,
        hostHomeDir,
        cwd: processObj.cwd(),
        sinceMs: Math.max(0, runtimeStartedAt - 60_000)
      });
      const latest = diagnostic && diagnostic.latest ? diagnostic.latest : null;
      const hasEvidence = Boolean(diagnostic && diagnostic.found);
      if (!hasEvidence) {
        const now = Date.now();
        if (now - lastClaudeToolNoEvidenceAt < getClaudeDiagnosticNoEvidenceCooldownMs()) return;
        lastClaudeToolNoEvidenceAt = now;
      }
      const signature = latest
        ? `${latest.transcriptPath || ''}:${latest.timestamp || ''}:${latest.type || ''}:${latest.toolName || ''}:${latest.text || ''}`
        : `no-evidence:${String(triggerOutput || '').slice(0, 240)}`;
      if (signature && signature === lastClaudeToolDiagnosticSignature) return;
      lastClaudeToolDiagnosticSignature = signature;
      const result = appendClaudeToolDiagnosticLog({
        fs,
        path,
        ...buildClaudeDiagnosticIdentity(),
        aiHomeDir,
        cwd: processObj.cwd(),
        accountId: activeId,
        cliPath,
        forwardArgs: activeForwardArgs,
        triggerOutput,
        diagnostic
      });
      if (!result || !result.ok || !result.logPath) return;
      const evidenceText = diagnostic && diagnostic.found
        ? `transcript=${path.basename(latest.transcriptPath || '')}`
        : 'transcript evidence not found yet';
      if (!shouldPrintClaudeDiagnostic(diagnostic)) return;
      processObj.stdout.write(`\r\n\x1b[33m[aih]\x1b[0m Claude tool protocol diagnostic saved: ${result.logPath} (${evidenceText})\r\n`);
    }

    function scheduleClaudeHookDiagnostic(data) {
      if (cliName !== 'claude') return;
      const plain = stripAnsi(String(data || ''));
      if (!containsClaudeStopHookJsonValidationError(plain)) return;
      pendingClaudeHookDiagnosticOutput = appendPendingClaudeDiagnosticOutput(pendingClaudeHookDiagnosticOutput, plain);
      if (pendingClaudeHookDiagnosticTimer) return;
      const delayMs = getClaudeHookDiagnosticDelayMs();
      pendingClaudeHookDiagnosticTimer = setTimeout(() => {
        const output = pendingClaudeHookDiagnosticOutput;
        pendingClaudeHookDiagnosticTimer = null;
        pendingClaudeHookDiagnosticOutput = '';
        if (cleanedUp) return;
        captureClaudeHookDiagnostic(output);
      }, delayMs);
      if (pendingClaudeHookDiagnosticTimer && typeof pendingClaudeHookDiagnosticTimer.unref === 'function') {
        pendingClaudeHookDiagnosticTimer.unref();
      }
    }

    function scheduleClaudeToolDiagnostic(data) {
      if (cliName !== 'claude') return;
      const plain = stripAnsi(String(data || ''));
      if (!containsClaudeToolProtocolProblem(plain)) return;
      pendingClaudeToolDiagnosticOutput = appendPendingClaudeDiagnosticOutput(pendingClaudeToolDiagnosticOutput, plain);
      if (pendingClaudeToolDiagnosticTimer) return;
      const delayMs = getClaudeHookDiagnosticDelayMs();
      pendingClaudeToolDiagnosticTimer = setTimeout(() => {
        const output = pendingClaudeToolDiagnosticOutput;
        pendingClaudeToolDiagnosticTimer = null;
        pendingClaudeToolDiagnosticOutput = '';
        if (cleanedUp) return;
        captureClaudeToolDiagnostic(output);
      }, delayMs);
      if (pendingClaudeToolDiagnosticTimer && typeof pendingClaudeToolDiagnosticTimer.unref === 'function') {
        pendingClaudeToolDiagnosticTimer.unref();
      }
    }

    function startUsageDisplayWatcher() {
      if (!shouldShowUsageInPty()) return;
      emitUsageStatus(activeId, { forcePrint: true, forceRefresh: true });
      usageDisplayTimer = setInterval(() => {
        if (isSwapping || !ptyProc) return;
        emitUsageStatus(activeId, { forcePrint: true, forceRefresh: true });
      }, getUsageDisplayIntervalMs());
      if (usageDisplayTimer && typeof usageDisplayTimer.unref === 'function') usageDisplayTimer.unref();
    }

    function attachOnData(proc) {
      proc.onData((data) => {
        const shimFilteredData = consumeSshClipboardShimRequests(data);
        markSessionActivity();
        if (shimFilteredData == null) return;
        data = shimFilteredData;
        if (String(data || '').length === 0) return;
        handleCodexAutoPromptOutput(data, proc);
        scheduleClaudeHookDiagnostic(data);
        scheduleClaudeToolDiagnostic(data);
        if (!hasReceivedData) {
          hasReceivedData = true;
          stopBootWave();
          processObj.stdout.write('\r\x1b[K');
        }

        if (shellDrawerVisible) {
          shellDrawerBufferedMainOutput += data;
          if (shellDrawerBufferedMainOutput.length > 120000) {
            shellDrawerBufferedMainOutput = shellDrawerBufferedMainOutput.slice(-120000);
            shellDrawerDroppedMainOutput = true;
          }
          writeShellDrawerFrame();
        } else {
          writeMainPtyOutput(data);
        }
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
            ptyProc = spawnPty(cliName, cliPath, activeId, [], true);
            attachOnData(ptyProc);
          }, 1500);
        }
      });

      proc.onExit(({ exitCode }) => {
        if (ignoredExitProc === proc) {
          ignoredExitProc = null;
          return;
        }
        if (!isSwapping) {
          if (isLogin && exitCode === 0) {
            clearPersistedRuntimeState(activeId);
            if (accountArtifactHooks && typeof accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
              accountArtifactHooks.notifyDefaultAccountAuthUpdated({
                provider: cliName,
                accountId: activeId,
                source: 'pty_login',
                reason: 'login_completed'
              });
            }
            stopThresholdWatcher();
            cleanupTerminalHooks();
            console.log('\n\x1b[32m[aih] Auth completed! Booting standard session...\x1b[0m');
            setTimeout(() => {
              runCliPty(cliName, activeId, forwardArgs, false);
            }, 500);
          } else {
            stopThresholdWatcher();
            cleanupTerminalHooks();
            processObj.stdout.write('\r\n');
            processObj.exit(exitCode || 0);
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
      ptyProc = spawnPty(cliName, cliPath, activeId, activeForwardArgs, isLogin, {
        rows: getChildPtyRows(activeForwardArgs)
      });
      startBootWave();
      attachOnData(ptyProc);
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
      if (readCodexApiKeyAccountInfo(activeId).apiKeyMode) return false;
      const row = getPersistedAccountState(activeId);
      if (!row) return false;
      if (row.apiKeyMode || row.api_key_mode) return false;
      return typeof ensureUsageSnapshotAsync === 'function' || typeof ensureUsageSnapshot === 'function';
    }

    async function runCodexStartupAuthPreflight() {
      let probeText = '';
      try {
        await refreshUsageSnapshotNoCache(cliName, activeId);
      } catch (error) {
        probeText = String((error && error.message) || error || '');
      }

      const runtimeStatus = getPersistedRuntimeStatus(activeId);
      if (isAuthInvalidRuntimeStatus(runtimeStatus)) {
        return {
          blocked: true,
          reason: runtimeStatus.reason || 'auth_invalid_reauth_required'
        };
      }

      const reason = resolveAuthInvalidReason(probeText || readUsageProbeError(activeId));
      if (!reason) return { blocked: false, reason: '' };
      persistAuthInvalidRuntimeState(reason);
      return { blocked: true, reason };
    }

    function startAfterStartupPreflight() {
      const initialRuntimeStatus = getPersistedRuntimeStatus(activeId);
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
      processObj.exit(0);
    };
    processObj.on('SIGINT', sigintHandler);

    startAfterStartupPreflight();
  }

  function runCliPtyTracked(cliName, id, forwardArgs, isLogin) {
    markActiveAccount(cliName, id);
    if (String(processObj.env.AIH_RUNTIME_ENABLE_USAGE_SCHEDULER || '0') === '1') {
      ensureAccountUsageRefreshScheduler();
    }
    refreshIndexedStateForAccount(cliName, id, { refreshSnapshot: false });
    return runCliPty(cliName, id, forwardArgs, isLogin);
  }

  return {
    runCliPtyTracked
  };
}

// ==========================================
// AIH 零安装纯 SSH 影子工作区 MCP Server 环路
// ==========================================
function runSshMcpServerLoop(sshTarget, remoteRoot, processObj = process) {
  const child_process = require('node:child_process');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  if (!sshTarget || !remoteRoot) {
    processObj.stderr.write(`[AIH-SSH-MCP] Error: missing sshTarget or remoteRoot\n`);
    processObj.exit(1);
    return;
  }

  // 1. 初始化本地临时影子路径与控制套接字路径
  const cleanTarget = String(sshTarget).trim();
  const cleanRoot = String(remoteRoot).trim().replace(/\/+$/, '');
  const localShadowDir = path.join(os.tmpdir(), `aih-shadow-${crypto.createHash('sha256').update(cleanTarget + cleanRoot).digest('hex').slice(0, 12)}`);
  const controlSocketPath = path.join(os.tmpdir(), `aih-ssh-ctrl-${crypto.createHash('sha256').update(cleanTarget).digest('hex').slice(0, 8)}.sock`);

  let isWindowsRemote = false;
  let fileTreeIndex = new Set();
  const fileMetadataCache = new Map();

  // 执行远程 SSH 指令
  function runRemoteCommand(commandString) {
    return new Promise((resolve, reject) => {
      const args = [];
      if (processObj.platform !== 'win32' && fs.existsSync(controlSocketPath)) {
        args.push('-o', `ControlPath=${controlSocketPath}`);
      }
      args.push(cleanTarget, commandString);

      const child = child_process.spawn('ssh', args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`远程执行失败(Exit Code ${code}): ${stderr.trim()}`));
      });
    });
  }

  // 清理生命周期
  function cleanup() {
    if (processObj.platform !== 'win32' && fs.existsSync(controlSocketPath)) {
      try {
        child_process.execSync(`ssh -O exit -o ControlPath="${controlSocketPath}" "${cleanTarget}"`, { stdio: 'ignore' });
        fs.unlinkSync(controlSocketPath);
      } catch (_e) {}
    }
    if (fs.existsSync(localShadowDir)) {
      try {
        fs.rmSync(localShadowDir, { recursive: true, force: true });
      } catch (_e) {}
    }
  }

  if (typeof processObj.on === 'function') {
    processObj.on('exit', cleanup);
    processObj.on('SIGINT', () => { cleanup(); processObj.exit(0); });
    processObj.on('SIGTERM', () => { cleanup(); processObj.exit(0); });
  }

  // 连接初始化和远端探测
  async function initializeSshConnection() {
    if (!fs.existsSync(localShadowDir)) {
      fs.mkdirSync(localShadowDir, { recursive: true });
    }

    if (processObj.platform !== 'win32') {
      const sshInitCmd = `ssh -M -f -N -o ControlPath="${controlSocketPath}" -o ControlPersist=10m "${cleanTarget}"`;
      try {
        child_process.execSync(sshInitCmd, { stdio: 'ignore' });
      } catch (err) {
        processObj.stderr.write(`[AIH-SSH-MCP] Warning: SSH ControlMaster setup failed: ${err.message}. Running without control master.\n`);
      }
    }

    try {
      const winProbe = await runRemoteCommand('cmd /c "echo %OS%"');
      if (winProbe.includes('Windows')) {
        isWindowsRemote = true;
      }
    } catch (_e) {}

    // 索引预加载
    try {
      let fileListRaw = '';
      if (isWindowsRemote) {
        fileListRaw = await runRemoteCommand(`powershell -Command "Get-ChildItem -Path '${cleanRoot}' -Recurse -File | Resolve-Path -Relative"`);
      } else {
        try {
          fileListRaw = await runRemoteCommand(`cd "${cleanRoot}" && git ls-files`);
        } catch (_e) {
          fileListRaw = await runRemoteCommand(`find "${cleanRoot}" -type f -not -path "*/node_modules/*" -not -path "*/.*"`);
        }
      }
      fileTreeIndex.clear();
      fileListRaw.split('\n').map(line => line.trim()).filter(Boolean).forEach(file => {
        fileTreeIndex.add(file.replace(/\\/g, '/'));
      });
    } catch (err) {
      processObj.stderr.write(`[AIH-SSH-MCP] File indexing failed: ${err.message}\n`);
    }
  }

  // 懒加载读文件
  async function mcpReadFile(relPath) {
    const normPath = relPath.replace(/\\/g, '/');
    const localPath = path.join(localShadowDir, normPath);
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    const remotePath = isWindowsRemote
      ? `${cleanRoot}\\${normPath.replace(/\//g, '\\')}`
      : `${cleanRoot}/${normPath}`;

    let metaString = '';
    try {
      if (isWindowsRemote) {
        metaString = await runRemoteCommand(`powershell -Command "(Get-Item '${remotePath}').LastWriteTime.Ticks.ToString() + ',' + (Get-Item '${remotePath}').Length"`);
      } else {
        metaString = await runRemoteCommand(`stat -c "%Y,%s" "${remotePath}" 2>/dev/null || stat -f "%m,%z" "${remotePath}"`);
      }
      const [mtime, size] = metaString.split(',');
      fileMetadataCache.set(normPath, { mtime: mtime.trim(), size: size.trim() });
    } catch (_e) {}

    let content = '';
    if (isWindowsRemote) {
      content = await runRemoteCommand(`powershell -Command "[System.IO.File]::ReadAllText('${remotePath}', [System.Text.Encoding]::UTF8)"`);
    } else {
      content = await runRemoteCommand(`cat "${remotePath}"`);
    }

    fs.writeFileSync(localPath, content, 'utf8');
    return content;
  }

  // 原子提交写文件 + SHA256 验证 + 乐观锁冲突检测
  async function mcpWriteFile(relPath, content) {
    const normPath = relPath.replace(/\\/g, '/');
    const localPath = path.join(localShadowDir, normPath);
    const remotePath = isWindowsRemote
      ? `${cleanRoot}\\${normPath.replace(/\//g, '\\')}`
      : `${cleanRoot}/${normPath}`;

    // 冲突检查
    const cachedMeta = fileMetadataCache.get(normPath);
    if (cachedMeta) {
      let currentMeta = '';
      try {
        if (isWindowsRemote) {
          currentMeta = await runRemoteCommand(`powershell -Command "(Get-Item '${remotePath}').LastWriteTime.Ticks.ToString() + ',' + (Get-Item '${remotePath}').Length"`);
        } else {
          currentMeta = await runRemoteCommand(`stat -c "%Y,%s" "${remotePath}" 2>/dev/null || stat -f "%m,%z" "${remotePath}"`);
        }
      } catch (_e) {}
      if (currentMeta) {
        const [curMtime, curSize] = currentMeta.split(',');
        if (curMtime.trim() !== cachedMeta.mtime || curSize.trim() !== cachedMeta.size) {
          throw new Error(`[Conflict] 远端文件已被其他人手动修改，请重试以重新拉取: ${relPath}`);
        }
      }
    }

    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    fs.writeFileSync(localPath, content, 'utf8');
    const localSha256 = crypto.createHash('sha256').update(content).digest('hex');

    const remoteTmpPath = `${remotePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
    const b64 = Buffer.from(content, 'utf8').toString('base64');

    if (isWindowsRemote) {
      await runRemoteCommand(`powershell -Command "[System.IO.File]::WriteAllBytes('${remoteTmpPath}', [System.Convert]::FromBase64String('${b64}'))"`);
    } else {
      await runRemoteCommand(`echo "${b64}" | base64 -d > "${remoteTmpPath}"`);
    }

    let remoteSha256 = '';
    try {
      if (isWindowsRemote) {
        remoteSha256 = await runRemoteCommand(`powershell -Command "(Get-FileHash -Path '${remoteTmpPath}' -Algorithm SHA256).Hash.ToLower()"`);
      } else {
        const shaOutput = await runRemoteCommand(`sha256sum "${remoteTmpPath}" 2>/dev/null || shasum -a 256 "${remoteTmpPath}"`);
        remoteSha256 = shaOutput.split(' ')[0].trim().toLowerCase();
      }
    } catch (err) {
      await runRemoteCommand(isWindowsRemote ? `del /f "${remoteTmpPath}"` : `rm -f "${remoteTmpPath}"`);
      throw new Error(`远端 SHA256 计算失败: ${err.message}`);
    }

    if (remoteSha256 !== localSha256) {
      await runRemoteCommand(isWindowsRemote ? `del /f "${remoteTmpPath}"` : `rm -f "${remoteTmpPath}"`);
      throw new Error(`[SHA mismatch] 传输损坏，已安全回滚临时文件。`);
    }

    if (isWindowsRemote) {
      await runRemoteCommand(`powershell -Command "Move-Item -Path '${remoteTmpPath}' -Destination '${remotePath}' -Force"`);
    } else {
      await runRemoteCommand(`mv -f "${remoteTmpPath}" "${remotePath}"`);
    }

    fileTreeIndex.add(normPath);
    let nextMeta = '';
    try {
      if (isWindowsRemote) {
        nextMeta = await runRemoteCommand(`powershell -Command "(Get-Item '${remotePath}').LastWriteTime.Ticks.ToString() + ',' + (Get-Item '${remotePath}').Length"`);
      } else {
        nextMeta = await runRemoteCommand(`stat -c "%Y,%s" "${remotePath}" 2>/dev/null || stat -f "%m,%z" "${remotePath}"`);
      }
      const [nextMtime, nextSize] = nextMeta.split(',');
      fileMetadataCache.set(normPath, { mtime: nextMtime.trim(), size: nextSize.trim() });
    } catch (_e) {}
  }

  // 运行远程命令
  async function mcpRunCommand(command) {
    let output = '';
    let exitCode = 0;
    try {
      let runCmd = '';
      if (isWindowsRemote) {
        runCmd = `powershell -Command "cd '${cleanRoot}'; ${command}"`;
      } else {
        runCmd = `cd "${cleanRoot}" && (${command})`;
      }
      output = await runRemoteCommand(runCmd);
    } catch (err) {
      output = err.message;
      exitCode = 1;
    }
    return { output, exitCode };
  }

  // 远程目录列表
  function mcpListDirectory(relPath) {
    const normDir = relPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const prefix = normDir ? `${normDir}/` : '';
    const files = [];
    fileTreeIndex.forEach(file => {
      if (file.startsWith(prefix)) {
        const relative = file.slice(prefix.length);
        if (!relative.includes('/')) {
          files.push({ name: relative, type: 'file' });
        } else {
          const folderName = relative.split('/')[0];
          if (!files.some(f => f.name === folderName)) {
            files.push({ name: folderName, type: 'directory' });
          }
        }
      }
    });
    return files;
  }

  // JSON-RPC 编解码状态机
  let buffer = '';
  processObj.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        handleJsonRpcMessage(line).catch((err) => {
          processObj.stderr.write(`[AIH-SSH-MCP] Message handling error: ${err.message}\n`);
        });
      }
    }
  });

  function sendResponse(id, result = {}, error = null) {
    const payload = { jsonrpc: '2.0', id };
    if (error) payload.error = error;
    else payload.result = result;
    processObj.stdout.write(JSON.stringify(payload) + '\n');
  }

  async function handleJsonRpcMessage(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      sendResponse(null, {}, { code: -32700, message: 'Parse error' });
      return;
    }

    if (req.method === 'initialize') {
      await initializeSshConnection();
      sendResponse(req.id, {
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'aih-ssh-mcp-server',
          version: '1.0.0'
        }
      });
      return;
    }

    if (req.method === 'tools/list') {
      sendResponse(req.id, {
        tools: [
          {
            name: 'view_file',
            description: 'Read the complete content of a remote file from workspace',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path of the file from remote workspace root' }
              },
              required: ['path']
            }
          },
          {
            name: 'edit_file',
            description: 'Write or replace complete file content on remote workspace',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path of the file' },
                content: { type: 'string', description: 'Complete content to write' }
              },
              required: ['path', 'content']
            }
          },
          {
            name: 'run_command',
            description: 'Execute a bash command in the remote workspace',
            inputSchema: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The bash command line to run' }
              },
              required: ['command']
            }
          },
          {
            name: 'list_directory',
            description: 'List contents of a directory in the remote workspace',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path of the directory' }
              },
              required: ['path']
            }
          }
        ]
      });
      return;
    }

    if (req.method === 'tools/call') {
      const name = req.params && req.params.name;
      const args = (req.params && req.params.arguments) || {};
      let resultText = '';
      let isError = false;

      try {
        if (name === 'view_file') {
          resultText = await mcpReadFile(args.path);
        } else if (name === 'edit_file') {
          await mcpWriteFile(args.path, args.content);
          resultText = `Successfully wrote and verified file: ${args.path}`;
        } else if (name === 'run_command') {
          const runRes = await mcpRunCommand(args.command);
          resultText = runRes.output;
          if (runRes.exitCode !== 0) isError = true;
        } else if (name === 'list_directory') {
          const listRes = mcpListDirectory(args.path);
          resultText = listRes.map(f => `[${f.type.toUpperCase()}] ${f.name}`).join('\n') || '(empty)';
        } else {
          isError = true;
          resultText = `Unknown tool: ${name}`;
        }
      } catch (err) {
        isError = true;
        resultText = err.message;
      }

      sendResponse(req.id, {
        content: [{ type: 'text', text: resultText }],
        isError
      });
      return;
    }

    // fallback for other methods
    if (req.id != null) {
      sendResponse(req.id, {}, { code: -32601, message: 'Method not found' });
    }
  }
}

module.exports = {
  createPtyRuntime,
  runSshMcpServerLoop
};
