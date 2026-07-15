'use strict';

// Codex launch support: everything the PTY runtime needs to know about the
// Codex CLI's on-disk state — locating the newest thread id for a cwd in the
// state_*.sqlite DBs (powers `/resume` and account auto-switch continuity),
// reading model/provider from config.toml, building `codex resume` argv, and
// syncing the host config template into an account-scoped config. No PTY
// concerns live here.

const {
  extractAccountOnlyConfig,
  extractModelProviderName,
  getAihProviderKey,
  isAihManagedProviderKey,
  mergeConfigs,
  normalizeCodexConfigSyncOptions,
  scopeAccountOnlyConfig
} = require('./codex-config-sync');
const { resolveCodexSqliteHome } = require('../../../runtime/codex-home');

function createCodexLaunchSupport(deps = {}) {
  const {
    fs,
    path,
    hostHomeDir,
    aiHomeDir,
    DatabaseSync,
    accountArtifactHooks
  } = deps;

  let resolvedDatabaseSync = null;
  let didResolveDatabaseSync = false;

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

  function readCurrentCodexModel() {
    // 共享 CODEX_HOME=~/.codex，只读宿主 config.toml
    const hostCodexHome = resolveCodexSqliteHome({ path, hostHomeDir, aiHomeDir });
    const hostConfigPath = hostCodexHome ? path.join(hostCodexHome, 'config.toml') : '';
    return readCodexModelFromConfig(hostConfigPath);
  }

  function buildCodexAutoResumeArgs(threadId) {
    const model = readCurrentCodexModel();
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
   * @param {string} accountRef - 账号引用
   * @param {{fs: any, path: any}} deps - 依赖
   * @param {{openaiBaseUrl?: string, isApiKeyMode?: boolean}} options - 可选配置
   */
  function syncCodexConfigFromHost(accountConfigPath, hostConfigPath, accountRef, deps, options = {}) {
    const { fs } = deps;
    const normalizedOptions = normalizeCodexConfigSyncOptions(options);
    const providerKey = getAihProviderKey();
    const runtimeDir = path.dirname(path.dirname(accountConfigPath));
    const configSnapshotBefore = accountArtifactHooks
      && typeof accountArtifactHooks.snapshotAccountConfigArtifacts === 'function'
      ? accountArtifactHooks.snapshotAccountConfigArtifacts('codex', accountRef, runtimeDir)
      : null;

    const notifyConfigUpdatedIfChanged = (source, reason) => {
      if (!configSnapshotBefore || !accountArtifactHooks || typeof accountArtifactHooks.notifyAccountConfigUpdatedIfChanged !== 'function') return;
      accountArtifactHooks.notifyAccountConfigUpdatedIfChanged({
        provider: 'codex',
        accountRef,
        runtimeDir,
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
        const defaultConfig = '# Codex runtime configuration for ' + accountRef + '\n' +
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
          scopeAccountOnlyConfig(accountOnlyConfig, fallbackOptions),
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
      effectiveOptions
    );

    // 4. 写回账号配置
    fs.writeFileSync(accountConfigPath, mergedConfig, 'utf8');
    notifyConfigUpdatedIfChanged('pty_config_sync', 'codex_config_synced_from_host_template');
  }

  return {
    getDatabaseSyncCtor,
    listCodexStateDbPaths,
    buildLatestCodexThreadQuery,
    resolveLatestCodexThreadIdForCwd,
    readCodexModelFromConfig,
    readCodexModelProviderFromConfig,
    resolveAihServerProviderKeyOverride,
    readCurrentCodexModel,
    buildCodexAutoResumeArgs,
    syncCodexConfigFromHost
  };
}

module.exports = {
  createCodexLaunchSupport
};
