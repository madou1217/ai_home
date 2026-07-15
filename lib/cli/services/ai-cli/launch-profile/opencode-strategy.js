'use strict';

const { buildSharedCacheEnv } = require('./home-redirect-strategy');

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
  } catch (_error) {
    return [];
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

function ensureSharedEntryLink(fs, path, accountDir, sharedDir, name, kind) {
  if (!name || name === 'auth.json') return;
  const linkPath = path.join(accountDir, name);
  const targetPath = path.join(sharedDir, name);
  if (isCanonicalSymlink(fs, path, linkPath, targetPath)) return;

  // The account runtime directory is a disposable projection. Never import or
  // merge data from it; rebuild links from the shared source of truth.
  removeStalePath(fs, linkPath);
  if (kind === 'dir') ensureDirectory(fs, targetPath);
  try {
    fs.symlinkSync(targetPath, linkPath, symlinkType(kind));
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

function linkExistingSharedEntries(ctx, accountDir, sharedDir) {
  const { fs, path } = ctx;
  for (const entry of readDirectoryEntries(fs, sharedDir)) {
    const name = String(entry && entry.name || '').trim();
    ensureSharedEntryLink(fs, path, accountDir, sharedDir, name, linkTypeForEntry(entry, 'file'));
  }
}

function linkKnownSharedEntries(ctx, accountDir, sharedDir) {
  const { fs, path } = ctx;
  for (const name of OPENCODE_SHARED_DATA_DIRS) {
    ensureSharedEntryLink(fs, path, accountDir, sharedDir, name, 'dir');
  }
  for (const name of OPENCODE_SHARED_DATA_FILES) {
    ensureSharedEntryLink(fs, path, accountDir, sharedDir, name, 'file');
  }
}

// ---- .aih-server gateway overlay --------------------------------------------
// Curated set of gateway-served Claude models exposed to the `.aih-server`
// opencode profile. We deliberately do NOT enumerate /v1/models: many gateway
// models (gpt/gemini/opencode-go) don't speak the anthropic wire protocol this
// overlay uses, and a sync launch must never do HTTP. Which of these actually
// resolve still depends on the accounts the gateway has — a listed-but-unbacked
// model just errors on use, same as any picker entry.
const AIH_GATEWAY_CLAUDE_MODELS = Object.freeze([
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001'
]);

// Default the `.aih-server` profile to a gateway model so bare `aih opencode`
// actually routes through the gateway — otherwise opencode would open on its own
// `opencode-go` upstream and the alignment would be cosmetic.
const AIH_GATEWAY_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';

// Only the `.aih-server` builtin profile carries these markers (set by
// self-relay-account.buildAihServerProfileEnv provides these runtime-only markers. A plain
// numeric account has none → returns null → no overlay, unchanged behaviour.
function resolveGatewayProfile(ctx) {
  const env = ctx && ctx.baseEnv;
  const baseUrl = String((env && env.AIH_OPENCODE_GATEWAY_BASE_URL) || '').trim();
  if (!baseUrl) return null;
  const apiKey = String((env && env.AIH_OPENCODE_GATEWAY_KEY) || '').trim() || 'dummy';
  return { baseUrl, apiKey };
}

// Layer the gateway through OPENCODE_CONFIG_CONTENT so endpoint/key changes are
// injected for this process without creating an `.aih-server` config file.
function buildGatewayConfig(profile) {
  const models = {};
  for (const id of AIH_GATEWAY_CLAUDE_MODELS) models[id] = {};
  return {
    model: AIH_GATEWAY_DEFAULT_MODEL,
    provider: {
      anthropic: {
        options: { baseURL: profile.baseUrl, apiKey: profile.apiKey },
        models
      }
    }
  };
}

/**
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs, hostHomeDir, sandboxDir } = ctx || {};
  if (!fs || !hostHomeDir || !sandboxDir) return;
  if (typeof fs.mkdirSync !== 'function' || typeof fs.symlinkSync !== 'function') return;

  // Gateway auth is fully process-injected; it must not create an auth bridge
  // or a provider-local runtime directory.
  if (resolveGatewayProfile(ctx)) return;

  const bridgeDir = getBridgeDataDir(ctx);
  const sharedDir = getSharedDataDir(ctx);
  ensureDirectory(fs, bridgeDir);
  ensureDirectory(fs, sharedDir);
  ensureAuthBridge(ctx, bridgeDir);
  linkExistingSharedEntries(ctx, bridgeDir, sharedDir);
  linkKnownSharedEntries(ctx, bridgeDir, sharedDir);

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
    set.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildGatewayConfig(gateway));
  } else {
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
  prepare,
  buildEnvPatch
};
