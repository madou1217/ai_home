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
const { repairNativeBinaryIfNeeded } = require('../ai-cli/native-binary-repair');

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
    DatabaseSync
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

  function normalizeProxyEnv(envObj) {
    const env = { ...(envObj || {}) };
    const keys = [
      ['http_proxy', 'HTTP_PROXY'],
      ['https_proxy', 'HTTPS_PROXY'],
      ['all_proxy', 'ALL_PROXY'],
      ['no_proxy', 'NO_PROXY']
    ];
    keys.forEach(([lower, upper]) => {
      const lowerValue = typeof env[lower] === 'string' ? env[lower].trim() : '';
      const upperValue = typeof env[upper] === 'string' ? env[upper].trim() : '';
      if (lowerValue && !upperValue) env[upper] = lowerValue;
      if (upperValue && !lowerValue) env[lower] = upperValue;
    });
    return env;
  }

  function waitForAihServerReady(serverDaemonRef, port, timeoutMs) {
    return waitForServerStatusReady(serverDaemonRef, port, timeoutMs);
  }

  function ensureLocalAihServerReady(serverConfig, options = {}) {
    if (!serverDaemon || typeof serverDaemon.status !== 'function') return null;
    if (typeof readServerConfig !== 'function') return null;
    let normalizedConfig = serverConfig || readServerConfig() || {};
    let port = Number(normalizedConfig.port);
    if (!Number.isFinite(port) || port <= 0) return null;

    let status = waitForAihServerReady(serverDaemon, port, Number(options.initialWaitMs) || 120);
    const shouldAutostart = String(processObj.env[options.autostartEnv || 'AIH_SERVER_AUTOSTART'] || '1') !== '0';
    if (
      status
      && status.running
      && status.stale
      && shouldAutostart
      && typeof serverDaemon.stop === 'function'
      && typeof serverDaemon.start === 'function'
    ) {
      const staleMessage = typeof options.onStale === 'function'
        ? options.onStale(status)
        : 'Local AIH server source is stale';
      console.log(`\x1b[36m[aih]\x1b[0m ${staleMessage}`);
      try {
        serverDaemon.stop({ gracefulStopWaitMs: 500 });
        const startPromise = serverDaemon.start(buildServerStartArgs(normalizedConfig), {
          waitForReady: false,
          readyTimeoutMs: Number(options.startReadyTimeoutMs) || 7000
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
      status = waitForAihServerReady(serverDaemon, port, Number(options.postRestartWaitMs) || 1500);
    }
    if ((!status || !status.running) && shouldAutostart && typeof serverDaemon.start === 'function') {
      const startMessage = typeof options.onStart === 'function'
        ? options.onStart(status)
        : 'Local AIH server is not running, starting it now';
      console.log(`\x1b[36m[aih]\x1b[0m ${startMessage}`);
      try {
        const startPromise = serverDaemon.start(buildServerStartArgs(normalizedConfig), {
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
      status = waitForAihServerReady(serverDaemon, port, Number(options.postStartWaitMs) || 1500);
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
      'ANTHROPIC_MODEL',
      'CLAUDE_MODEL',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'AGY_ACCESS_TOKEN',
      'GOOGLE_OAUTH_ACCESS_TOKEN',
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

  function hasExplicitRemoteArg(args) {
    return (Array.isArray(args) ? args : []).some((arg) => {
      const text = String(arg || '').trim();
      return text === '--remote' || text.startsWith('--remote=');
    });
  }

  function sleepSync(ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    if (!safeMs) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, safeMs);
  }

  function buildServerStartArgs(serverConfig = {}) {
    const host = String(serverConfig.host || '').trim() || '127.0.0.1';
    const port = Number(serverConfig.port);
    const args = ['--host', host];
    if (Number.isFinite(port) && port > 0) {
      args.push('--port', String(port));
    }
    if (String(serverConfig.apiKey || '').trim()) {
      args.push('--api-key', String(serverConfig.apiKey).trim());
    }
    if (String(serverConfig.managementKey || '').trim()) {
      args.push('--management-key', String(serverConfig.managementKey).trim());
    }
    return args;
  }

  function waitForServerStatusReady(serverDaemonRef, port, timeoutMs) {
    if (!serverDaemonRef || typeof serverDaemonRef.status !== 'function') {
      return { running: false, ready: false, state: 'stopped' };
    }
    const safePort = Number(port);
    const statusArgs = Number.isFinite(safePort) && safePort > 0 ? { port: safePort } : undefined;
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let status = serverDaemonRef.status(statusArgs);
    while (status && status.running && !status.ready && Date.now() < deadline) {
      sleepSync(60);
      status = serverDaemonRef.status(statusArgs);
    }
    return status || { running: false, ready: false, state: 'stopped' };
  }

  function resolveCodexRemoteProxyConfig(forwardArgs, isLogin) {
    if (isLogin || hasExplicitRemoteArg(forwardArgs)) return null;
    if (String(processObj.env.AIH_CODEX_ENABLE_REMOTE_PROXY || '0') !== '1') return null;
    if (String(processObj.env.AIH_CODEX_DISABLE_REMOTE_PROXY || '0') === '1') return null;
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
          sqliteHome: codexSqliteHome
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
    const envOverrides = normalizeProxyEnv({
      ...filterHostEnvVars(processObj.env),
      ...loadedEnv,
      HOME: sandboxDir,
      USERPROFILE: sandboxDir,
      CLAUDE_CONFIG_DIR: path.join(sandboxDir, '.claude'),
      CODEX_HOME: codexConfigDir,
      // 确保 Codex 使用账号专属的配置目录
      XDG_CONFIG_HOME: sandboxDir,
      XDG_DATA_HOME: path.join(sandboxDir, '.local', 'share'),
      XDG_STATE_HOME: path.join(sandboxDir, '.local', 'state'),
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(sandboxDir, '.gemini', 'settings.json')
    });
    if (cliName === 'codex' && codexSqliteHome) {
      envOverrides.CODEX_SQLITE_HOME = codexSqliteHome;
    }

    // Bypass keychain for agy provider to avoid keyring-based identity confusion
    if (cliName === 'agy') {
      envOverrides.SSH_CLIENT = '127.0.0.1 12345 22';
      envOverrides.SSH_TTY = '/dev/tty';
      envOverrides.container = 'docker';
      envOverrides.WSL_DISTRO_NAME = 'Ubuntu';
    }

    // ✅ 移除废弃的 OPENAI_BASE_URL 环境变量 (已迁移到 config.toml)
    if (cliName === 'codex' && envOverrides.OPENAI_BASE_URL) {
      delete envOverrides.OPENAI_BASE_URL;
    }

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
      const allowRemoteProxy = defaultAccountId && defaultAccountId === selectedId;
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
    const batchLaunch = resolveWindowsBatchLaunch(cliName, cliBin || cliName, envOverrides, processObj.platform);
    const launchBin = batchLaunch.launchBin || cliName;
    Object.assign(envOverrides, batchLaunch.envPatch || {});
    const launch = buildPtyLaunch(launchBin, argsToRun, { platform: processObj.platform });
    return pty.spawn(launch.command, launch.args, {
      name: 'xterm-color',
      cols: processObj.stdout.columns || 80,
      rows: spawnOptions.rows || processObj.stdout.rows || 24,
      cwd: processObj.cwd(),
      env: envOverrides
    });
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
      name: 'xterm-color',
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
      if (ptyProc) {
        try { ptyProc.resize(processObj.stdout.columns, getChildPtyRows(activeForwardArgs)); } catch (_error) {}
      }
      if (shellDrawerProc) {
        const layout = getShellDrawerLayout();
        try { shellDrawerProc.resize(processObj.stdout.columns || 80, layout.ptyRows); } catch (_error) {}
      }
      if (shellDrawerVisible) {
        clearShellDrawerRegion();
        applyShellDrawerViewport();
      } else {
        // ✅ 终端尺寸变化时，强制重新渲染状态行（使用新的尺寸）
        lastRenderedStatusLine = '';
        if (canRenderUsageStatusBar()) {
          emitUsageStatus(activeId, { forcePrint: true, forceRefresh: false });
        }
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
      const summary = shellDrawerStatusSummary || lastKnownUsageStatusSummary || `account ${activeId} usage remaining: unknown`;
      return padPlainText(`{ ${summary} }`, innerWidth);
    }

    function clearTerminalRow(row) {
      processObj.stdout.write(`\x1b[${row};1H\x1b[2K`);
    }

    function clearShellDrawerRegion() {
      const layout = getShellDrawerLayout();
      clearTerminalRow(Math.max(1, layout.topBorderRow - 1));
      for (let row = layout.topBorderRow; row <= layout.bottomBorderRow; row += 1) {
        clearTerminalRow(row);
      }
    }

    function writeShellDrawerFrame() {
      if (!shellDrawerVisible) return;
      const layout = getShellDrawerLayout();
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

    function applyShellDrawerViewport() {
      if (!shellDrawerVisible) return;
      const layout = getShellDrawerLayout();
      processObj.stdout.write(`\x1b[${layout.contentTop};${layout.contentBottom}r`);
      writeShellDrawerFrame();
    }

    function flushShellDrawerBufferedMainOutput() {
      if (!shellDrawerBufferedMainOutput) return;
      const bufferedOutput = shellDrawerBufferedMainOutput;
      const hadDroppedOutput = shellDrawerDroppedMainOutput;
      shellDrawerBufferedMainOutput = '';
      shellDrawerDroppedMainOutput = false;
      processObj.stdout.write('\x1b[r');
      processObj.stdout.write('\r\n');
      if (hadDroppedOutput) {
        processObj.stdout.write('\x1b[33m[aih] Shell Drawer 期间主会话输出过多，已截断最早部分内容。\x1b[0m\r\n');
      }
      processObj.stdout.write(bufferedOutput);
    }

    function ensureShellDrawerProc() {
      if (shellDrawerProc) return shellDrawerProc;
      shellDrawerProc = spawnShellDrawerPty();
      shellDrawerProc.onData((data) => {
        if (!shellDrawerVisible) return;
        processObj.stdout.write(data);
        writeShellDrawerFrame();
      });
      shellDrawerProc.onExit(() => {
        shellDrawerProc = null;
        if (!shellDrawerVisible || cleanedUp) return;
        shellDrawerVisible = false;
        processObj.stdout.write('\x1b[r');
        clearShellDrawerRegion();
        processObj.stdout.write('\r\n\x1b[33m[aih] Shell Drawer 已退出，回到主会话。\x1b[0m\r\n');
        flushShellDrawerBufferedMainOutput();
      });
      return shellDrawerProc;
    }

    function openShellDrawer() {
      if (!shellDrawerAvailable || shellDrawerVisible) return false;
      clearUsageStatusLine();
      shellDrawerVisible = true;
      shellDrawerStatusSummary = lastKnownUsageStatusSummary || `account ${activeId} usage remaining: unknown`;
      clearShellDrawerRegion();
      applyShellDrawerViewport();
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
      shellDrawerVisible = false;
      processObj.stdout.write('\x1b[r');
      clearTerminalRow(Math.max(1, getShellDrawerLayout().topBorderRow - 1));
      clearShellDrawerRegion();
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

    function shellSingleQuote(value) {
      return `'${String(value || '').replace(/'/g, '\'\"\'\"\'')}'`;
    }

    function isClipboardPasteTrigger(data) {
      if (!canBridgeWindowsClipboard()) return false;
      const altVPattern = /^\x1b[vV]$/;
      const altVCsiUPattern = /^\x1b\[(?:86|118);3(?:[:;]\d+)*u$/;
      const altVModifyOtherKeysPattern = /^\x1b\[27;3;(?:86|118)(?:;\d+)*~$/;
      if (Buffer.isBuffer(data)) {
        const text = data.toString('utf8');
        if (altVPattern.test(text)) return true;
        if (altVCsiUPattern.test(text)) return true;
        if (altVModifyOtherKeysPattern.test(text)) return true;
        return false;
      }
      const text = String(data || '');
      if (altVPattern.test(text)) return true;
      if (altVCsiUPattern.test(text)) return true;
      if (altVModifyOtherKeysPattern.test(text)) return true;
      return false;
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

    const onStdinData = (data) => {
      markSessionActivity();
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
      }
      if (ptyProc) ptyProc.write(data);
    };
    processObj.stdin.on('data', onStdinData);

    let outputBuffer = '';
    let isSwapping = false;
    let thresholdTimer = null;
    let usageDisplayTimer = null;
    let usageIdleStatusTimer = null;
    let usageStatusRedrawTimer = null;
    let lastUsageDisplaySignature = '';
    let idleStatusTick = 0;
    let lastKnownUsageStatusSummary = `account ${activeId} usage remaining: unknown`;
    const idleSleepFrames = ['ZzZZzz', 'zZzZZz', 'zzZzZZ', 'zzzZzZ', 'zzzzZZ', 'zzzZzZ', 'zzZzZZ', 'zZzZZz'];
    const usageRefreshFrames = ['|', '/', '-', '\\'];
    const workingStatusLabel = 'working...';
    const workingComfortMessagesPath = path.join(__dirname, 'working-comfort-messages.json');
    let workingComfortMessagesCache = null;
    let workingComfortMessagesRaw = '';
    let lastComfortBucket = '';
    let lastComfortSlot = -1;
    let lastComfortIndex = -1;
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

    function getTerminalRows() {
      return Math.max(1, Number(processObj.stdout && processObj.stdout.rows) || 24);
    }

    function shouldReserveUsageStatusRow(args = activeForwardArgs) {
      return canRenderUsageStatusBar() && shouldShowUsageInPty(args);
    }

    function getChildPtyRows(args = activeForwardArgs) {
      const rows = getTerminalRows();
      return shouldReserveUsageStatusRow(args) ? Math.max(1, rows - 1) : rows;
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
      clearUsageStatusLine();
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
      return enabled && interactive && isUsageManagedCli(cliName);
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
      const info = readCodexApiKeyAccountInfo(accountId);
      if (!info.apiKeyMode) return '';
      return `account ${accountId} api-key mode`;
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

    function formatUsageStatusLine(status, id) {
      const summary = buildUsageStatusSummary(status, id);
      if (!Number.isFinite(status && status.remainingPct)) {
        return `\x1b[90m[aih]\x1b[0m ${summary} (snapshot pending)`;
      }
      const stamp = status.capturedAt
        ? new Date(status.capturedAt).toLocaleTimeString('zh-CN', { hour12: false })
        : 'unknown';
      return `\x1b[90m[aih]\x1b[0m ${summary} (updated ${stamp})`;
    }

    let lastRenderedStatusLine = '';
    let lastRenderedStatusAt = 0;

    function writeUsageStatusLine(lineText, options = {}) {
      if (shellDrawerVisible) return;
      const text = String(lineText || '');
      const force = !!options.force;
      const canRenderFixedRow = canRenderUsageStatusBar();
      if (!canRenderFixedRow) {
        processObj.stdout.write(`\r\n${text}\r\n`);
        lastRenderedStatusLine = '';
        return;
      }

      // ✅ 防止闪烁：只有内容真正变化时才重绘
      const now = Date.now();
      if (!force && text === lastRenderedStatusLine && (now - lastRenderedStatusAt) < 800) {
        return;
      }
      lastRenderedStatusLine = text;
      lastRenderedStatusAt = now;

      // ✅ 使用实际行数，并根据终端宽度截断内容
      const rows = Math.max(1, Number(processObj.stdout.rows) || 24);
      const cols = Math.max(20, Number(processObj.stdout.columns) || 80);

      // 移除 ANSI 转义码计算实际文本长度
      const stripped = stripAnsi(text);
      const textWidth = getPlainTextWidth(stripped);

      // 如果文本超宽，截断并添加省略号
      let displayText = text;
      if (textWidth > cols) {
        // 保留 ANSI 颜色代码，只截断可见文本
        const maxPlainWidth = cols - 3; // 为 "..." 留空间
        const truncatedPlain = truncatePlainText(stripped, maxPlainWidth);
        // 简化处理：直接使用截断后的纯文本 + 省略号
        displayText = `${truncatedPlain}...`;
      }

      // Save cursor -> move to last row -> clear row -> print status -> restore cursor.
      processObj.stdout.write(`\x1b[s\x1b[${rows};1H\x1b[2K${displayText}\x1b[u`);
    }

    function getCurrentUsageStatusLine() {
      const runtimeSummary = buildRuntimeBlockedSummary(activeId);
      if (runtimeSummary) return `\x1b[90m[aih]\x1b[0m ${runtimeSummary} | ${buildWorkingSuffix()}`;
      if (usageRefreshInFlight) return formatRefreshingStatusLine(activeId);
      if (isUsageRefreshPausedByIdle()) return formatIdleStatusLine();
      return formatPlayStatusLine();
    }

    function scheduleUsageStatusBarRedraw() {
      if (usageStatusRedrawTimer) return;
      if (!canRenderUsageStatusBar()) return;
      if (!shouldShowUsageInPty()) return;
      usageStatusRedrawTimer = setTimeout(() => {
        usageStatusRedrawTimer = null;
        if (cleanedUp || shellDrawerVisible || authRecoveryPrompt) return;
        writeUsageStatusLine(getCurrentUsageStatusLine(), { force: true });
      }, 25);
      if (usageStatusRedrawTimer && typeof usageStatusRedrawTimer.unref === 'function') {
        usageStatusRedrawTimer.unref();
      }
    }

    function clearUsageStatusLine() {
      const canRenderFixedRow = canRenderUsageStatusBar();
      if (!canRenderFixedRow) return;
      const rows = Math.max(1, Number(processObj.stdout.rows) || 24);
      processObj.stdout.write(`\x1b[s\x1b[${rows};1H\x1b[2K\x1b[u`);
      lastRenderedStatusLine = '';
      lastRenderedStatusAt = 0;
    }

    function getComfortBucket(now) {
      const hour = now.getHours();
      if (hour < 6) return 'night';
      if (hour < 9) return 'dawn';
      if (hour < 12) return 'morning';
      if (hour < 14) return 'noon';
      if (hour < 19) return 'afternoon';
      if (hour < 23) return 'evening';
      return 'night';
    }

    function loadWorkingComfortMessages() {
      try {
        if (!fs.existsSync(workingComfortMessagesPath)) {
          workingComfortMessagesRaw = '';
          workingComfortMessagesCache = null;
          return workingComfortMessagesCache;
        }
        const raw = String(fs.readFileSync(workingComfortMessagesPath, 'utf8') || '');
        if (!raw || raw === workingComfortMessagesRaw) {
          return raw ? workingComfortMessagesCache : null;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
          workingComfortMessagesRaw = raw;
          workingComfortMessagesCache = null;
          return workingComfortMessagesCache;
        }
        workingComfortMessagesRaw = raw;
        workingComfortMessagesCache = parsed;
      } catch (_error) {
        workingComfortMessagesRaw = '';
        workingComfortMessagesCache = null;
      }
      return workingComfortMessagesCache;
    }

    function hashComfortSlot(input) {
      let hash = 2166136261;
      const text = String(input || '');
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }

    function getWorkingComfortMessage() {
      const now = new Date();
      const bucket = getComfortBucket(now);
      const workingComfortMessages = loadWorkingComfortMessages();
      const messages = workingComfortMessages && (workingComfortMessages[bucket] || workingComfortMessages.afternoon);
      const rotateMs = 60_000;
      if (!Array.isArray(messages) || messages.length === 0) {
        return '';
      }
      const slot = Math.floor(Date.now() / rotateMs);
      if (
        bucket === lastComfortBucket
        && slot === lastComfortSlot
        && lastComfortIndex >= 0
        && lastComfortIndex < messages.length
      ) {
        return messages[lastComfortIndex] || messages[0] || '';
      }
      let nextIndex = hashComfortSlot(`${bucket}:${slot}`) % messages.length;
      if (
        bucket === lastComfortBucket
        && messages.length > 1
        && nextIndex === lastComfortIndex
      ) {
        nextIndex = (nextIndex + 1) % messages.length;
      }
      lastComfortBucket = bucket;
      lastComfortSlot = slot;
      lastComfortIndex = nextIndex;
      return messages[lastComfortIndex] || messages[0] || '';
    }

    function formatIdleStatusLine() {
      const sleepFrame = idleSleepFrames[idleStatusTick % idleSleepFrames.length];
      return `\x1b[90m[aih]\x1b[0m sleeping... ${sleepFrame}`;
    }

    function buildWorkingSuffix() {
      const comfortMessage = getWorkingComfortMessage();
      return comfortMessage
        ? `${workingStatusLabel} ${comfortMessage}`
        : workingStatusLabel;
    }

    function formatRefreshingStatusLine(id) {
      const spinner = usageRefreshFrames[idleStatusTick % usageRefreshFrames.length];
      const targetId = String(id || activeId || '').trim();
      const runtimeSummary = buildRuntimeBlockedSummary(targetId);
      if (runtimeSummary) {
        return `\x1b[90m[aih]\x1b[0m ${runtimeSummary} | ${buildWorkingSuffix()}`;
      }
      return `\x1b[90m[aih]\x1b[0m account ${targetId} usage remaining refreshing: ${spinner}% | ${buildWorkingSuffix()}`;
    }

    function formatPlayStatusLine() {
      return `\x1b[90m[aih]\x1b[0m ${lastKnownUsageStatusSummary} | ${buildWorkingSuffix()}`;
    }

    function startUsageIdleStatusWatcher() {
      if (!shouldShowUsageInPty()) return;
      if (usageIdleStatusTimer) return;
      usageIdleStatusTimer = setInterval(() => {
        if (cleanedUp || isSwapping || !ptyProc) return;
        if (authRecoveryPrompt) return;
        idleStatusTick += 1;
        const runtimeSummary = buildRuntimeBlockedSummary(activeId);
        if (runtimeSummary) {
          lastKnownUsageStatusSummary = runtimeSummary;
          shellDrawerStatusSummary = runtimeSummary;
          writeUsageStatusLine(`\x1b[90m[aih]\x1b[0m ${runtimeSummary} | ${buildWorkingSuffix()}`);
          return;
        }
        if (usageRefreshInFlight) {
          writeUsageStatusLine(formatRefreshingStatusLine(activeId));
          return;
        }
        if (isUsageRefreshPausedByIdle()) {
          writeUsageStatusLine(formatIdleStatusLine());
          return;
        }
        writeUsageStatusLine(formatPlayStatusLine());
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
        idleStatusTick += 1;
        writeUsageStatusLine(formatIdleStatusLine());
        return;
      }
      const targetId = String(id || activeId || '').trim();
      if (!/^\d+$/.test(targetId)) return;
      const runtimeSummary = buildRuntimeBlockedSummary(targetId);
      if (runtimeSummary) {
        lastKnownUsageStatusSummary = runtimeSummary;
        shellDrawerStatusSummary = runtimeSummary;
        const signature = `${targetId}|runtime|${runtimeSummary}`;
        if (!forcePrint && signature === lastUsageDisplaySignature) return;
        lastUsageDisplaySignature = signature;
        writeUsageStatusLine(`\x1b[90m[aih]\x1b[0m ${runtimeSummary} | ${buildWorkingSuffix()}`);
        return;
      }
      const apiKeySummary = buildApiKeyStatusSummary(targetId);
      if (apiKeySummary) {
        lastKnownUsageStatusSummary = apiKeySummary;
        shellDrawerStatusSummary = apiKeySummary;
        const signature = `${targetId}|api-key`;
        if (!forcePrint && signature === lastUsageDisplaySignature) return;
        lastUsageDisplaySignature = signature;
        writeUsageStatusLine(`\x1b[90m[aih]\x1b[0m ${apiKeySummary} | ${buildWorkingSuffix()}`);
        return;
      }
      const cache = readUsageCache(cliName, targetId);
      if (forceRefresh) {
        tryRefreshUsageSnapshotInBackground(targetId);
      } else {
        refreshUsageInBackgroundIfStale(targetId, cache);
      }
      if (usageRefreshInFlight) {
        idleStatusTick += 1;
        writeUsageStatusLine(formatRefreshingStatusLine(targetId));
        return;
      }
      const status = buildUsageStatusFromCache(cache);
      lastKnownUsageStatusSummary = buildUsageStatusSummary(status, targetId);
      shellDrawerStatusSummary = lastKnownUsageStatusSummary;
      const remainingSignature = Number.isFinite(status.remainingPct) ? status.remainingPct.toFixed(3) : 'na';
      const signature = `${targetId}|${status.capturedAt || 0}|${remainingSignature}`;
      if (!forcePrint && signature === lastUsageDisplaySignature) return;
      lastUsageDisplaySignature = signature;
      writeUsageStatusLine(`${formatUsageStatusLine(status, targetId)} | ${buildWorkingSuffix()}`);
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
      if (usageStatusRedrawTimer) {
        clearTimeout(usageStatusRedrawTimer);
        usageStatusRedrawTimer = null;
      }
      cancelCodexAutoPrompt();
      stopClipboardMirrorProcess();
      stopUsageRefreshProcess();
      shellDrawerVisible = false;
      processObj.stdout.write('\x1b[r');
      clearShellDrawerRegion();
      if (shellDrawerProc) {
        try { shellDrawerProc.kill(); } catch (_error) {}
        shellDrawerProc = null;
      }
      clearUsageStatusLine();
    }

    function getThresholdPct() {
      const cfg = readUsageConfig({ filePath: path.join(aiHomeDir, 'usage-config.json') });
      const val = Number(cfg && cfg.threshold_pct);
      if (!Number.isFinite(val)) return 95;
      return Math.max(1, Math.min(100, Math.floor(val)));
    }

    function getCurrentRemainingPct(id) {
      if (buildRuntimeBlockedSummary(id)) return null;
      if (readCodexApiKeyAccountInfo(id).apiKeyMode) return null;
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
        handleCodexAutoPromptOutput(data, proc);
        markSessionActivity();
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
          processObj.stdout.write(data);
          scheduleUsageStatusBarRedraw();
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
      startClipboardImageMirrorProcess();
      startThresholdWatcher();
      startUsageIdleStatusWatcher();
      startUsageDisplayWatcher();
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

module.exports = {
  createPtyRuntime
};
