'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFrpError } = require('./frp-config-errors');

const DEFAULT_STALE_CORRUPT_LOCK_MS = 5 * 60 * 1000;

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function resolveHome(deps = {}) {
  if (typeof deps.homedir === 'function') return String(deps.homedir() || '').trim();
  if (deps.homedir) return String(deps.homedir).trim();
  return os.homedir();
}

function buildDefaultFrpcConfigCandidates(options = {}, deps = {}) {
  const pathImpl = deps.path || path;
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const home = resolveHome(deps);
  const candidates = [];

  if (env.AIH_FRPC_CONFIG) candidates.push(String(env.AIH_FRPC_CONFIG).trim());
  if (env.FRPC_CONFIG) candidates.push(String(env.FRPC_CONFIG).trim());
  if (Array.isArray(deps.defaultCandidates)) candidates.push(...deps.defaultCandidates);
  else if (platform === 'darwin') {
    if (home) candidates.push(pathImpl.join(home, '.config', 'frp', 'frpc.toml'));
    candidates.push('/opt/homebrew/etc/frp/frpc.toml', '/usr/local/etc/frp/frpc.toml');
  } else if (platform === 'win32') {
    if (env.PROGRAMDATA) candidates.push(pathImpl.join(env.PROGRAMDATA, 'frp', 'frpc.toml'));
    if (env.APPDATA) candidates.push(pathImpl.join(env.APPDATA, 'frp', 'frpc.toml'));
    candidates.push('C:/frp/frpc.toml');
  } else {
    if (home) candidates.push(pathImpl.join(home, '.config', 'frp', 'frpc.toml'));
    candidates.push('/etc/frp/frpc.toml', '/etc/frpc.toml');
  }
  return unique(candidates.map((candidate) => String(candidate || '').trim()));
}

function isRegularFile(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

function discoverFrpcConfigPath(options = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const explicit = String(options.configPath || '').trim();
  const candidates = explicit
    ? [explicit]
    : buildDefaultFrpcConfigCandidates(options, deps);
  const configPath = candidates.find((candidate) => isRegularFile(fsImpl, candidate));
  if (configPath) return configPath;
  throw createFrpError(
    'frpc_config_not_found',
    'Unable to find frpc.toml',
    { candidates }
  );
}

function snapshotFile(fsImpl, filePath) {
  if (!fsImpl.existsSync(filePath)) return { filePath, exists: false, content: null, mode: null };
  const stat = fsImpl.statSync(filePath);
  return {
    filePath,
    exists: true,
    content: fsImpl.readFileSync(filePath),
    mode: stat.mode & 0o777
  };
}

function isModePrivate(fsImpl, filePath) {
  try {
    return (fsImpl.statSync(filePath).mode & 0o777) === 0o600;
  } catch (_error) {
    return false;
  }
}

function atomicWritePrivate(fsImpl, pathImpl, filePath, content, deps = {}) {
  fsImpl.mkdirSync(pathImpl.dirname(filePath), { recursive: true });
  const nonce = typeof deps.createNonce === 'function'
    ? String(deps.createNonce())
    : `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempPath = `${filePath}.aih-tmp-${nonce}`;
  let renamed = false;
  try {
    fsImpl.writeFileSync(tempPath, content, { mode: 0o600 });
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(tempPath, 0o600);
    fsImpl.renameSync(tempPath, filePath);
    renamed = true;
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(filePath, 0o600);
  } finally {
    if (!renamed) {
      try { fsImpl.unlinkSync(tempPath); } catch (_error) {}
    }
  }
}

function restoreSnapshot(fsImpl, pathImpl, snapshot, deps = {}) {
  if (!snapshot.exists) {
    if (fsImpl.existsSync(snapshot.filePath)) fsImpl.unlinkSync(snapshot.filePath);
    return;
  }
  atomicWritePrivate(fsImpl, pathImpl, snapshot.filePath, snapshot.content, deps);
  if (typeof fsImpl.chmodSync === 'function' && snapshot.mode != null) {
    fsImpl.chmodSync(snapshot.filePath, snapshot.mode);
  }
}

function rollbackFiles(fsImpl, pathImpl, snapshots, deps = {}) {
  const errors = [];
  for (const snapshot of snapshots.slice().reverse()) {
    try {
      restoreSnapshot(fsImpl, pathImpl, snapshot, deps);
    } catch (error) {
      errors.push({ filePath: snapshot.filePath, message: String(error && error.message || error) });
    }
  }
  return { ok: errors.length === 0, errors };
}

function defaultIsProcessAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !error || error.code !== 'ESRCH';
  }
}

function removeCorruptLockIfStale(fsImpl, lockPath, deps) {
  const configuredStaleMs = Number(deps.staleLockMs);
  const staleAfterMs = Number.isFinite(configuredStaleMs) && configuredStaleMs >= 1000
    ? configuredStaleMs
    : DEFAULT_STALE_CORRUPT_LOCK_MS;
  const nowMs = typeof deps.nowMs === 'function' ? Number(deps.nowMs()) : Date.now();
  try {
    const modifiedAt = Number(fsImpl.statSync(lockPath).mtimeMs);
    if (!Number.isFinite(nowMs)
      || !Number.isFinite(modifiedAt)
      || nowMs - modifiedAt < staleAfterMs) return false;
    fsImpl.unlinkSync(lockPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function removeStaleLock(fsImpl, lockPath, deps) {
  let raw;
  try {
    raw = fsImpl.readFileSync(lockPath, 'utf8');
  } catch (_error) {
    return false;
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch (_error) {
    return removeCorruptLockIfStale(fsImpl, lockPath, deps);
  }
  const pid = Number(owner && owner.pid);
  if (!Number.isInteger(pid) || pid < 1) {
    return removeCorruptLockIfStale(fsImpl, lockPath, deps);
  }
  const isProcessAlive = deps.isProcessAlive || defaultIsProcessAlive;
  if (isProcessAlive(pid)) return false;
  try {
    fsImpl.unlinkSync(lockPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function acquireConfigLock(managedPaths, deps = {}) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const lockPath = pathImpl.join(managedPaths.aiHomeDir, 'frp', '.aih-frpc-config.lock');
  fsImpl.mkdirSync(pathImpl.dirname(lockPath), { recursive: true });
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fsImpl.openSync(lockPath, 'wx', 0o600);
      const createdAt = typeof deps.nowMs === 'function' ? Number(deps.nowMs()) : Date.now();
      fsImpl.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt })}\n`);
      if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(lockPath, 0o600);
      break;
    } catch (cause) {
      if (descriptor !== undefined) {
        try { fsImpl.closeSync(descriptor); } catch (_error) {}
        try { fsImpl.unlinkSync(lockPath); } catch (_error) {}
        descriptor = undefined;
      }
      if (cause && cause.code === 'EEXIST') {
        if (attempt === 0 && removeStaleLock(fsImpl, lockPath, deps)) continue;
        throw createFrpError('frp_config_locked', 'Another AIH FRP configuration update is active', {
          lockPath
        });
      }
      throw createFrpError('frp_config_lock_failed', 'Unable to acquire AIH FRP configuration lock', {
        lockPath,
        cause
      });
    }
  }
  fsImpl.closeSync(descriptor);
  let released = false;
  return {
    lockPath,
    release() {
      if (released) return;
      released = true;
      try { fsImpl.unlinkSync(lockPath); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
  };
}

module.exports = {
  acquireConfigLock,
  atomicWritePrivate,
  buildDefaultFrpcConfigCandidates,
  discoverFrpcConfigPath,
  isModePrivate,
  resolveHome,
  rollbackFiles,
  snapshotFile
};
