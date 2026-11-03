'use strict';

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { isAccountRef } = require('../account/public-account-ref');

const MARKER_FILE = '.aih-transient-auth-projection.json';
const MARKER_VERSION = 1;

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function projectionPrefix(provider, accountRef) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedRef = String(accountRef || '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(normalizedProvider) || !isAccountRef(normalizedRef)) return '';
  return `aih-auth-${normalizedProvider}-${normalizedRef}-`;
}

function resolveRealPath(fs, path, targetPath) {
  if (fs && typeof fs.realpathSync === 'function') {
    try {
      return fs.realpathSync(targetPath);
    } catch (_error) {}
  }
  return path.resolve(targetPath);
}

function readMarker(fs, path, runtimeDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runtimeDir, MARKER_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function isTransientAuthProjection(fs = nodeFs, runtimeDir, provider, accountRef, options = {}) {
  const path = options.path || nodePath;
  const os = options.os || nodeOs;
  const prefix = projectionPrefix(provider, accountRef);
  const candidate = String(runtimeDir || '').trim();
  if (!prefix || !candidate || !path.isAbsolute(candidate)) return false;

  let stat;
  try {
    stat = typeof fs.lstatSync === 'function' ? fs.lstatSync(candidate) : fs.statSync(candidate);
  } catch (_error) {
    return false;
  }
  if (!stat.isDirectory() || (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink())) return false;

  const tempRoot = String(options.tempRoot || os.tmpdir() || '').trim();
  if (!tempRoot) return false;
  const realCandidate = resolveRealPath(fs, path, candidate);
  const realTempRoot = resolveRealPath(fs, path, tempRoot);
  if (path.dirname(realCandidate) !== realTempRoot || !path.basename(realCandidate).startsWith(prefix)) {
    return false;
  }

  const marker = readMarker(fs, path, candidate);
  return Boolean(
    marker
    && marker.version === MARKER_VERSION
    && marker.provider === normalizeProvider(provider)
    && marker.accountRef === String(accountRef || '').trim()
  );
}

function createTransientAuthProjection(fs = nodeFs, provider, accountRef, options = {}) {
  const path = options.path || nodePath;
  const os = options.os || nodeOs;
  const prefix = projectionPrefix(provider, accountRef);
  const tempRoot = String(options.tempRoot || os.tmpdir() || '').trim();
  if (!prefix || !tempRoot) throw new Error('transient_auth_projection_invalid_context');

  const runtimeDir = fs.mkdtempSync(path.join(tempRoot, prefix));
  try {
    if (typeof fs.chmodSync === 'function') fs.chmodSync(runtimeDir, 0o700);
    const markerPath = path.join(runtimeDir, MARKER_FILE);
    fs.writeFileSync(markerPath, `${JSON.stringify({
      version: MARKER_VERSION,
      provider: normalizeProvider(provider),
      accountRef: String(accountRef || '').trim()
    })}\n`, 'utf8');
    if (typeof fs.chmodSync === 'function') fs.chmodSync(markerPath, 0o600);
    return runtimeDir;
  } catch (error) {
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (_cleanupError) {}
    throw error;
  }
}

function createTransientAuthProjectionLease(fs = nodeFs, provider, accountRef, options = {}) {
  const runtimeDir = createTransientAuthProjection(fs, provider, accountRef, options);
  let released = false;
  return {
    runtimeDir,
    get active() {
      return !released;
    },
    release() {
      if (released) return false;
      removeTransientAuthProjection(fs, runtimeDir, provider, accountRef, options);
      released = true;
      return true;
    }
  };
}

function removeTransientAuthProjection(fs = nodeFs, runtimeDir, provider, accountRef, options = {}) {
  if (!isTransientAuthProjection(fs, runtimeDir, provider, accountRef, options)) {
    const error = new Error('transient_auth_projection_cleanup_rejected');
    error.code = 'transient_auth_projection_cleanup_rejected';
    error.path = String(runtimeDir || '').trim();
    throw error;
  }
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  return true;
}

module.exports = {
  MARKER_FILE,
  createTransientAuthProjection,
  createTransientAuthProjectionLease,
  isTransientAuthProjection,
  removeTransientAuthProjection
};
