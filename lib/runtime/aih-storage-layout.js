'use strict';

const path = require('node:path');
const { isAccountRef } = require('../account/public-account-ref');

const AIH_STORAGE_DIRS = Object.freeze({
  logs: 'logs',
  run: 'run'
});
const ACCOUNT_PROVIDERS = new Set(['agy', 'claude', 'codex', 'gemini', 'opencode']);

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return ACCOUNT_PROVIDERS.has(value) ? value : '';
}

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return isAccountRef(value) ? value : '';
}

function normalizeRuntimeLabel(label) {
  const value = String(label || '').trim();
  return /^[A-Za-z0-9._-]{1,96}$/.test(value) ? value : '';
}

function normalizePathSegment(segment) {
  const value = String(segment || '').trim();
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) return '';
  return value;
}

function normalizePathSegments(segments) {
  const values = segments.map(normalizePathSegment);
  return values.length > 0 && values.every(Boolean) ? values : [];
}

function resolveAihStorageDir(aiHomeDir, kind) {
  const root = String(aiHomeDir || '').trim();
  const dirName = AIH_STORAGE_DIRS[kind];
  return root && dirName ? path.join(root, dirName) : '';
}

function resolveAihLogPath(aiHomeDir, ...segments) {
  const logsDir = resolveAihStorageDir(aiHomeDir, 'logs');
  const safeSegments = normalizePathSegments(segments);
  return logsDir && safeSegments.length > 0 ? path.join(logsDir, ...safeSegments) : '';
}

function resolveAihRunPath(aiHomeDir, ...segments) {
  const runDir = resolveAihStorageDir(aiHomeDir, 'run');
  const safeSegments = normalizePathSegments(segments);
  return runDir && safeSegments.length > 0 ? path.join(runDir, ...safeSegments) : '';
}

function resolveAccountRuntimeDir(aiHomeDir, provider, accountRef) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedRef = normalizeAccountRef(accountRef);
  return normalizedProvider && normalizedRef
    ? resolveAihRunPath(aiHomeDir, 'auth-projections', normalizedProvider, normalizedRef)
    : '';
}

function resolveCodexDesktopRuntimeDir(aiHomeDir, accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  return normalizedRef
    ? resolveAihRunPath(aiHomeDir, 'codex-desktop', normalizedRef)
    : '';
}

function resolveLoginRuntimeDir(aiHomeDir, provider, sessionId) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSessionId = normalizeRuntimeLabel(sessionId);
  return normalizedProvider && normalizedSessionId
    ? resolveAihRunPath(aiHomeDir, 'login', normalizedProvider, normalizedSessionId)
    : '';
}

module.exports = {
  AIH_STORAGE_DIRS,
  resolveAccountRuntimeDir,
  resolveAihLogPath,
  resolveAihRunPath,
  resolveAihStorageDir,
  resolveCodexDesktopRuntimeDir,
  resolveLoginRuntimeDir
};
