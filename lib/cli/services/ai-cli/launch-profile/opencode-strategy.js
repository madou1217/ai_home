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

function assertCanonicalSymlink(fs, path, linkPath, targetPath, code) {
  let stat = null;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (_error) {
    return false;
  }
  if (!stat || typeof stat.isSymbolicLink !== 'function' || !stat.isSymbolicLink()) {
    throw createBridgeError(code, linkPath, targetPath);
  }
  const actualTarget = readLinkTarget(fs, path, linkPath);
  if (actualTarget !== targetPath) {
    throw createBridgeError(code, linkPath, targetPath);
  }
  return true;
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

function ensureSharedEntryLink(fs, path, accountDir, sharedDir, name, kind) {
  if (!name || name === 'auth.json') return;
  const linkPath = path.join(accountDir, name);
  const targetPath = path.join(sharedDir, name);
  if (assertCanonicalSymlink(fs, path, linkPath, targetPath, 'opencode_shared_bridge_conflict')) return;

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
  if (assertCanonicalSymlink(fs, path, bridgeAuthPath, canonicalAuthPath, 'opencode_auth_bridge_conflict')) return;
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

/**
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs, hostHomeDir, sandboxDir } = ctx || {};
  if (!fs || !hostHomeDir || !sandboxDir) return;
  if (typeof fs.mkdirSync !== 'function' || typeof fs.symlinkSync !== 'function') return;

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
  const set = {
    XDG_DATA_HOME: getBridgeDataHome(ctx)
  };
  if (!hostHomeDir) return { set, unset: [...OPENCODE_UNSET_ENV] };

  Object.assign(set, {
    HOME: hostHomeDir,
    USERPROFILE: hostHomeDir,
    XDG_CONFIG_HOME: path.join(hostHomeDir, '.config'),
    XDG_STATE_HOME: path.join(hostHomeDir, '.local', 'state'),
    ...buildSharedCacheEnv(hostHomeDir, path)
  });

  return {
    set,
    unset: [...OPENCODE_UNSET_ENV]
  };
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
