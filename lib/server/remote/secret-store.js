'use strict';

const { readJsonValue, writeJsonValue } = require('../app-state-store');

const REMOTE_SECRET_KEY = 'remote:secrets';

function normalizeAuthRef(value) {
  const ref = String(value || '').trim();
  if (!ref || ref.length > 160) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(ref)) return '';
  if (ref.includes('..')) return '';
  return ref;
}

function readSecretFile(fs, aiHomeDir) {
  const parsed = readJsonValue(fs, aiHomeDir, REMOTE_SECRET_KEY);
  return {
    version: 1,
    secrets: parsed && parsed.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {}
  };
}

function writeSecretFile(fs, aiHomeDir, payload) {
  if (!aiHomeDir || !fs) return;
  writeJsonValue(fs, aiHomeDir, REMOTE_SECRET_KEY, payload);
}

function sanitizeSecret(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    managementKey: String(source.managementKey || '').trim(),
    updatedAt: Number(source.updatedAt || Date.now()) || Date.now()
  };
}

function readRemoteSecret(authRef, deps = {}) {
  const ref = normalizeAuthRef(authRef);
  if (!ref) return null;
  const store = readSecretFile(deps.fs, deps.aiHomeDir);
  const secret = store.secrets[ref];
  return secret && typeof secret === 'object' ? sanitizeSecret(secret) : null;
}

function writeRemoteSecret(authRef, secret, deps = {}) {
  const ref = normalizeAuthRef(authRef);
  if (!ref) {
    const error = new Error('invalid_auth_ref');
    error.code = 'invalid_auth_ref';
    throw error;
  }
  const normalized = {
    ...sanitizeSecret(secret),
    updatedAt: Date.now()
  };
  const store = readSecretFile(deps.fs, deps.aiHomeDir);
  store.secrets[ref] = normalized;
  writeSecretFile(deps.fs, deps.aiHomeDir, store);
  return { authRef: ref, updatedAt: normalized.updatedAt };
}

module.exports = {
  REMOTE_SECRET_KEY,
  normalizeAuthRef,
  readRemoteSecret,
  writeRemoteSecret
};
