'use strict';

const path = require('node:path');

const REMOTE_SECRET_FILE = 'remote-node-secrets.json';

function getRemoteSecretPath(aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  return root ? path.join(root, REMOTE_SECRET_FILE) : '';
}

function normalizeAuthRef(value) {
  const ref = String(value || '').trim();
  if (!ref || ref.length > 160) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(ref)) return '';
  if (ref.includes('..')) return '';
  return ref;
}

function readSecretFile(fs, aiHomeDir) {
  const filePath = getRemoteSecretPath(aiHomeDir);
  try {
    if (!filePath || !fs || !fs.existsSync(filePath)) return { version: 1, secrets: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, secrets: {} };
    return {
      version: 1,
      secrets: parsed.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {}
    };
  } catch (_error) {
    return { version: 1, secrets: {} };
  }
}

function writeSecretFile(fs, aiHomeDir, payload) {
  const filePath = getRemoteSecretPath(aiHomeDir);
  if (!filePath || !fs) return;
  if (typeof fs.mkdirSync === 'function') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    if (typeof fs.chmodSync === 'function') fs.chmodSync(filePath, 0o600);
  } catch (_error) {}
}

function sanitizeSecret(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    managementKey: String(source.managementKey || source.nodePairToken || source.token || '').trim(),
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
  REMOTE_SECRET_FILE,
  getRemoteSecretPath,
  normalizeAuthRef,
  readRemoteSecret,
  writeRemoteSecret
};
