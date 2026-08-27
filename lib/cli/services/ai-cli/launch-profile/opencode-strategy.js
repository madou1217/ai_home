'use strict';

const { buildSharedCacheEnv } = require('./home-redirect-strategy');
const { isProviderPrivateEntryName } = require('../../../../runtime/provider-storage-policy');
const { readServerConfig } = require('../../../../server/server-config-store');
const { buildAihServerBaseUrl } = require('../../../../account/self-relay-account');
const { readPersistedWebUiModelsCache } = require('../../../../server/webui-model-cache');

/**
 * OpenCode launch isolation.
 *
 * OpenCode follows XDG locations for global config and data:
 *   config: $XDG_CONFIG_HOME/opencode/opencode.json
 *   data:   $XDG_DATA_HOME/opencode/*
 *
 * Only auth.json is account-owned. HOME, config, state, cache and every
 * non-auth data entry stay shared under the real host home, so OpenCode updates,
 * package stores, model catalogs and local databases have one truth.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

const OPENCODE_SHARED_DATA_DIRS = Object.freeze([
  'bin',
  'log',
  'repos',
  'snapshot',
  'storage'
]);

const OPENCODE_SHARED_DATA_FILES = Object.freeze([
  'opencode.db',
  'opencode.db-shm',
  'opencode.db-wal'
]);

// 沙箱里这些变量一律清空：账号身份只认原生 auth.json，env 里的 key 属于宿主污染，
// 留着会让 A 账号的会话用上 B 账号（或宿主）的凭据。
//
// ⚠️ 不要因为「api-key 账号启动后没凭据」就把 OPENCODE_API_KEY 从这份清单里拿掉 ——
// 正确的补法是把 key 落成原生 auth.json（lib/account/opencode-native-auth.js 的
// reconcileOpenCodeNativeAuth，在 prepareProviderRuntime 里调用）。2026-08 出过一次
// 事故：WebUI 加的 api-key 账号只写了 env、没写 auth.json，env 又在这里被剥掉，
// 于是 CLI 全程以匿名身份运行（付费模型必然 401，免费模型因为匿名可用而看不出来）。
const OPENCODE_UNSET_ENV = Object.freeze([
  'OPENCODE_API_KEY',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME'
]);

function getAccountAuthDir(ctx) {
  return ctx.path.join(ctx.sandboxDir, '.local', 'share', 'opencode');
}

function getBridgeDataHome(ctx) {
  return ctx.path.join(ctx.sandboxDir, '.local', 'share', 'aih-opencode-runtime');
}

function getBridgeDataDir(ctx) {
  return ctx.path.join(getBridgeDataHome(ctx), 'opencode');
}

function getSharedDataDir(ctx) {
  return ctx.path.join(ctx.hostHomeDir, '.local', 'share', 'opencode');
}

function getProjectedConfigDir(ctx) {
  return ctx.path.join(ctx.sandboxDir, '.config', 'opencode');
}

function getSharedConfigDir(ctx) {
  return ctx.path.join(ctx.hostHomeDir, '.config', 'opencode');
}

function ensureDirectory(fs, dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readLinkTarget(fs, path, linkPath) {
  const target = fs.readlinkSync(linkPath);
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
}

function createBridgeError(code, linkPath, targetPath, cause) {
  const error = new Error(`${code}: ${linkPath} -> ${targetPath}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function readDirectoryEntries(fs, dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function linkTypeForEntry(entry, fallbackType) {
  if (entry && typeof entry.isDirectory === 'function' && entry.isDirectory()) return 'dir';
  if (entry && typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) return fallbackType;
  return fallbackType;
}

function symlinkType(kind) {
  return kind === 'dir' && process.platform === 'win32' ? 'junction' : kind;
}

function isCanonicalSymlink(fs, path, linkPath, targetPath) {
  let stat = null;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (_error) {
    return false;
  }
  if (!stat || typeof stat.isSymbolicLink !== 'function' || !stat.isSymbolicLink()) return false;
  try {
    return readLinkTarget(fs, path, linkPath) === targetPath;
  } catch (_error) {
    return false;
  }
}

function removeStalePath(fs, targetPath) {
  try {
    if (typeof fs.rmSync === 'function') fs.rmSync(targetPath, { recursive: true, force: true });
    else fs.unlinkSync(targetPath);
  } catch (_error) {
    /* best-effort */
  }
}

function safeLstat(fs, targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function movePath(fs, pathImpl, sourcePath, targetPath) {
  ensureDirectory(fs, pathImpl.dirname(targetPath));
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!error || error.code !== 'EXDEV' || typeof fs.cpSync !== 'function') throw error;
  }
  fs.cpSync(sourcePath, targetPath, { recursive: true, errorOnExist: true, force: false });
  fs.rmSync(sourcePath, { recursive: true, force: true });
}

function migrateProjectedEntry(ctx, sourcePath, targetPath, relativePath, summary) {
  const { fs, path } = ctx;
  const sourceStat = safeLstat(fs, sourcePath);
  if (!sourceStat) return;

  if (sourceStat.isSymbolicLink()) {
    // Replacing a link cannot delete its target. The canonical link is created
    // after this migration pass.
    fs.unlinkSync(sourcePath);
    summary.migrated += 1;
    return;
  }

  const targetStat = safeLstat(fs, targetPath);
  if (!targetStat) {
    movePath(fs, path, sourcePath, targetPath);
    summary.migrated += 1;
    return;
  }

  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    for (const entry of readDirectoryEntries(fs, sourcePath)) {
      const name = String(entry && entry.name || '').trim();
      if (!name) continue;
      migrateProjectedEntry(
        ctx,
        path.join(sourcePath, name),
        path.join(targetPath, name),
        path.join(relativePath, name),
        summary
      );
    }
    if (readDirectoryEntries(fs, sourcePath).length === 0) {
      fs.rmdirSync(sourcePath);
      summary.migrated += 1;
    }
    return;
  }

  // Two independent provider states cannot be merged safely (notably SQLite).
  // The native shared file is authoritative; the account-local copy is
  // disposable projection residue and is discarded in place.
  if (sourceStat.isDirectory()) fs.rmSync(sourcePath, { recursive: true, force: true });
  else fs.unlinkSync(sourcePath);
  summary.discarded += 1;
}

function ensureSharedEntryLink(ctx, accountDir, sharedDir, name, kind, summary, relativePath = name) {
  const { fs, path } = ctx;
  if (!name || isProviderPrivateEntryName('opencode', name)) return;
  const linkPath = path.join(accountDir, name);
  const targetPath = path.join(sharedDir, name);
  if (isCanonicalSymlink(fs, path, linkPath, targetPath)) return;

  migrateProjectedEntry(ctx, linkPath, targetPath, relativePath, summary);
  if (kind === 'dir') ensureDirectory(fs, targetPath);
  try {
    fs.symlinkSync(targetPath, linkPath, symlinkType(kind));
    summary.linked += 1;
  } catch (error) {
    throw createBridgeError('opencode_shared_bridge_failed', linkPath, targetPath, error);
  }
}

function ensureAuthBridge(ctx, bridgeDir) {
  const { fs, path } = ctx;
  const accountAuthDir = getAccountAuthDir(ctx);
  ensureDirectory(fs, accountAuthDir);
  const canonicalAuthPath = path.join(accountAuthDir, 'auth.json');
  const bridgeAuthPath = path.join(bridgeDir, 'auth.json');
  if (isCanonicalSymlink(fs, path, bridgeAuthPath, canonicalAuthPath)) return;
  removeStalePath(fs, bridgeAuthPath);
  try {
    fs.symlinkSync(canonicalAuthPath, bridgeAuthPath, 'file');
  } catch (error) {
    throw createBridgeError('opencode_auth_bridge_failed', bridgeAuthPath, canonicalAuthPath, error);
  }
}

function linkProjectedEntries(ctx, accountDir, sharedDir, summary, relativePrefix) {
  const { fs, path } = ctx;
  for (const entry of readDirectoryEntries(fs, accountDir)) {
    const name = String(entry && entry.name || '').trim();
    if (!name || isProviderPrivateEntryName('opencode', name)) continue;
    ensureSharedEntryLink(
      ctx,
      accountDir,
      sharedDir,
      name,
      linkTypeForEntry(entry, 'file'),
      summary,
      path.join(relativePrefix, name)
    );
  }
}

function linkExistingSharedEntries(ctx, accountDir, sharedDir, summary, relativePrefix) {
  const { fs, path } = ctx;
  for (const entry of readDirectoryEntries(fs, sharedDir)) {
    const name = String(entry && entry.name || '').trim();
    if (!name) continue;
    ensureSharedEntryLink(
      ctx,
      accountDir,
      sharedDir,
      name,
      linkTypeForEntry(entry, 'file'),
      summary,
      path.join(relativePrefix, name)
    );
  }
}

function linkKnownSharedEntries(ctx, accountDir, sharedDir, summary, relativePrefix) {
  const { path } = ctx;
  for (const name of OPENCODE_SHARED_DATA_DIRS) {
    ensureSharedEntryLink(ctx, accountDir, sharedDir, name, 'dir', summary, path.join(relativePrefix, name));
  }
  for (const name of OPENCODE_SHARED_DATA_FILES) {
    ensureSharedEntryLink(ctx, accountDir, sharedDir, name, 'file', summary, path.join(relativePrefix, name));
  }
}

function reconcileSharedData(ctx) {
  const { fs } = ctx || {};
  if (!fs || typeof fs.mkdirSync !== 'function' || typeof fs.symlinkSync !== 'function') {
    return { migrated: 0, linked: 0, discarded: 0 };
  }
  const bridgeDir = getBridgeDataDir(ctx);
  const accountDataDir = getAccountAuthDir(ctx);
  const sharedDir = getSharedDataDir(ctx);
  const projections = [
    { source: bridgeDir, target: sharedDir, relativePrefix: 'bridge-data', linkKnown: true },
    { source: accountDataDir, target: sharedDir, relativePrefix: 'account-data', linkKnown: true },
    {
      source: getProjectedConfigDir(ctx),
      target: getSharedConfigDir(ctx),
      relativePrefix: 'config',
      linkKnown: false
    }
  ].filter((projection) => {
    const sourceStat = safeLstat(fs, projection.source);
    // Removing the account projection deletes only the link, never its target.
    // Do not traverse a root link and accidentally migrate provider-native data
    // back through itself.
    return sourceStat && !sourceStat.isSymbolicLink();
  });
  if (projections.length === 0) {
    return { migrated: 0, linked: 0, discarded: 0 };
  }
  const summary = { migrated: 0, linked: 0, discarded: 0 };
  projections.forEach((projection) => {
    ensureDirectory(fs, projection.target);
    linkProjectedEntries(
      ctx,
      projection.source,
      projection.target,
      summary,
      projection.relativePrefix
    );
    linkExistingSharedEntries(
      ctx,
      projection.source,
      projection.target,
      summary,
      projection.relativePrefix
    );
    if (projection.linkKnown) {
      linkKnownSharedEntries(
        ctx,
        projection.source,
        projection.target,
        summary,
        projection.relativePrefix
      );
    }
  });
  return summary;
}

// ---- OpenCode AIH Gateway BYOK Overlay -------------------------------------
const AIH_GATEWAY_FALLBACK_MODELS = Object.freeze([
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-5.5',
  'deepseek-v4-pro'
]);

const AIH_GATEWAY_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';

function resolveHealthyGatewayModels(ctx) {
  try {
    const fsImpl = ctx && ctx.fs || fs;
    const aiHomeDir = String((ctx && ctx.aiHomeDir) || (ctx && ctx.sandboxDir ? ctx.path.join(ctx.sandboxDir, '..', '..', '..') : '') || '').trim();
    const cache = readPersistedWebUiModelsCache({ fs: fsImpl, aiHomeDir });
    const models = new Set();
    const byProvider = (cache && cache.byProvider) || {};
    Object.values(byProvider).forEach((list) => {
      if (Array.isArray(list)) {
        list.forEach((m) => {
          if (typeof m === 'string' && m.trim()) models.add(m.trim());
        });
      }
    });
    if (models.size > 0) return Array.from(models).sort();
  } catch (_error) {
    /* best effort */
  }
  return [...AIH_GATEWAY_FALLBACK_MODELS];
}

function resolveGatewayProfile(ctx) {
  const env = ctx && ctx.baseEnv;
  const explicitBaseUrl = String((env && env.AIH_OPENCODE_GATEWAY_BASE_URL) || '').trim();
  const explicitApiKey = String((env && env.AIH_OPENCODE_GATEWAY_KEY) || '').trim();
  if (explicitBaseUrl) {
    return {
      baseUrl: explicitBaseUrl,
      apiKey: explicitApiKey || 'dummy',
      isExplicitServerProfile: true
    };
  }

  // 数字账号 (aih opencode 1) 自动注入 local gateway BYOK
  try {
    const fsImpl = ctx && ctx.fs || fs;
    const aiHomeDir = String((ctx && ctx.aiHomeDir) || '').trim();
    const serverConfig = readServerConfig({ fs: fsImpl, aiHomeDir });
    const baseUrl = buildAihServerBaseUrl(serverConfig);
    if (baseUrl) {
      return {
        baseUrl,
        apiKey: String(serverConfig.apiKey || serverConfig.clientKey || '').trim() || 'dummy',
        isExplicitServerProfile: false
      };
    }
  } catch (_error) {
    /* best effort */
  }

  return null;
}

// Layer the gateway through OPENCODE_CONFIG_CONTENT so endpoint/key changes and
// dynamically discovered healthy models are injected for this process.
function buildGatewayConfig(profile, ctx) {
  const healthyModels = resolveHealthyGatewayModels(ctx);
  const modelsMap = {};
  healthyModels.forEach((id) => {
    modelsMap[id] = { name: `${id} (AIH)` };
  });

  const anthropicModels = {};
  healthyModels.filter((m) => m.startsWith('claude-')).forEach((id) => {
    anthropicModels[id] = {};
  });

  const config = {
    provider: {
      aih: {
        npm: '@ai-sdk/openai-compatible',
        name: 'AI Home Gateway',
        options: {
          baseURL: profile.baseUrl,
          apiKey: profile.apiKey
        },
        models: modelsMap
      }
    }
  };

  if (Object.keys(anthropicModels).length > 0) {
    config.provider.anthropic = {
      options: {
        baseURL: profile.baseUrl,
        apiKey: profile.apiKey
      },
      models: anthropicModels
    };
  }

  if (profile.isExplicitServerProfile) {
    config.model = AIH_GATEWAY_DEFAULT_MODEL;
  }

  return config;
}

/**
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs, hostHomeDir, sandboxDir } = ctx || {};
  if (!fs || !hostHomeDir || !sandboxDir) return;
  if (typeof fs.mkdirSync !== 'function' || typeof fs.symlinkSync !== 'function') return;

  const gateway = resolveGatewayProfile(ctx);
  // Default server profile auth is fully process-injected; it must not create an auth bridge
  // or a provider-local runtime directory. Numeric accounts still need auth bridge for auth.json.
  if (gateway && gateway.isExplicitServerProfile) return;

  const bridgeDir = getBridgeDataDir(ctx);
  ensureDirectory(fs, bridgeDir);
  ensureAuthBridge(ctx, bridgeDir);
  reconcileSharedData(ctx);

}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { hostHomeDir, path } = ctx;
  const gateway = resolveGatewayProfile(ctx);
  const set = {};
  const unset = gateway
    ? OPENCODE_UNSET_ENV.filter((key) => key !== 'OPENCODE_CONFIG_CONTENT')
    : [...OPENCODE_UNSET_ENV];

  if (gateway) {
    set.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildGatewayConfig(gateway, ctx));
  }
  if (!gateway || !gateway.isExplicitServerProfile) {
    set.XDG_DATA_HOME = getBridgeDataHome(ctx);
  }

  if (!hostHomeDir) return { set, unset };

  Object.assign(set, {
    HOME: hostHomeDir,
    USERPROFILE: hostHomeDir,
    XDG_CONFIG_HOME: path.join(hostHomeDir, '.config'),
    ...(gateway ? { XDG_DATA_HOME: path.join(hostHomeDir, '.local', 'share') } : {}),
    XDG_STATE_HOME: path.join(hostHomeDir, '.local', 'state'),
    ...buildSharedCacheEnv(hostHomeDir, path)
  });

  return { set, unset };
}

const opencodeStrategy = Object.freeze({
  name: 'opencode-auth-bridge',
  prepare,
  buildEnvPatch
});

module.exports = {
  opencodeStrategy,
  reconcileSharedData,
  prepare,
  buildEnvPatch,
  resolveHealthyGatewayModels,
  resolveGatewayProfile,
  buildGatewayConfig
};
