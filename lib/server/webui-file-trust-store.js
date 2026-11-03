'use strict';

const path = require('node:path');
const { readJsonValue, writeJsonValue } = require('./app-state-store');
const { isPathWithinRoot } = require('./webui-file-access-policy');

const WEBUI_FILE_TRUSTED_ROOTS_KEY = 'webui-file-trusted-roots';

function normalizeTrustedRootEntries(value, pathImpl = path) {
  const entries = Array.isArray(value) ? value : [];
  const seen = new Set();
  return entries.reduce((normalized, entry) => {
    const candidate = String(entry && entry.path || '').trim();
    if (!candidate || !pathImpl.isAbsolute(candidate)) return normalized;
    const trustedPath = pathImpl.resolve(candidate);
    if (seen.has(trustedPath)) return normalized;
    seen.add(trustedPath);
    normalized.push({
      path: trustedPath,
      trustedAt: Number(entry && entry.trustedAt) || 0
    });
    return normalized;
  }, []);
}

function readTrustedFileRoots(deps = {}) {
  const value = readJsonValue(deps.fs, deps.aiHomeDir, WEBUI_FILE_TRUSTED_ROOTS_KEY, deps);
  return normalizeTrustedRootEntries(value).map((entry) => entry.path);
}

function addTrustedFileRoot(rootPath, deps = {}) {
  const candidate = String(rootPath || '').trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error('webui_file_trust_root_invalid');
  }
  const trustedPath = path.resolve(candidate);
  const current = normalizeTrustedRootEntries(
    readJsonValue(deps.fs, deps.aiHomeDir, WEBUI_FILE_TRUSTED_ROOTS_KEY, deps)
  );
  const coveringEntry = current.find((entry) => isPathWithinRoot(entry.path, trustedPath, path));
  if (coveringEntry) return coveringEntry.path;

  const next = [
    { path: trustedPath, trustedAt: Date.now() },
    ...current.filter((entry) => !isPathWithinRoot(trustedPath, entry.path, path))
  ];
  if (!writeJsonValue(deps.fs, deps.aiHomeDir, WEBUI_FILE_TRUSTED_ROOTS_KEY, next, deps)) {
    throw new Error('webui_file_trust_write_failed');
  }
  return trustedPath;
}

module.exports = {
  WEBUI_FILE_TRUSTED_ROOTS_KEY,
  addTrustedFileRoot,
  normalizeTrustedRootEntries,
  readTrustedFileRoots
};
