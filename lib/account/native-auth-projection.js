'use strict';

const nodePath = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../server/account-credential-store');
const {
  isAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');
const { resolveNativeAuthIdentitySeed } = require('./account-identity');
const { registerAccountIdentity } = require('./account-registration');
const { readClaudeKeychainCredentials } = require('./claude-keychain');
const { PROVIDER_STORAGE_POLICIES } = require('../runtime/provider-storage-policy');

const PROVIDER_ARTIFACTS = Object.freeze(Object.fromEntries(
  Object.entries(PROVIDER_STORAGE_POLICIES).map(([provider, policy]) => [provider, policy.authArtifacts])
));

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return PROVIDER_ARTIFACTS[value] ? value : '';
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasProjectionData(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function resolveProjectionContext(runtimeDir, provider) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedRuntimeDir = String(runtimeDir || '').trim();
  if (!normalizedProvider || !normalizedRuntimeDir) return null;
  return {
    artifacts: PROVIDER_ARTIFACTS[normalizedProvider],
    provider: normalizedProvider,
    runtimeDir: normalizedRuntimeDir
  };
}

function resolveStorageContext(fs, provider, options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const accountRef = String(options.accountRef || '').trim();
  if (!aiHomeDir || !isAccountRef(accountRef)) return null;
  const account = resolveAccountRef(fs, aiHomeDir, accountRef, { bestEffort: true });
  if (!account || account.provider !== provider) return null;
  return { aiHomeDir, accountRef: account.accountRef };
}

function readArtifact(fs, artifactPath, format) {
  try {
    if (!fs.existsSync(artifactPath)) return null;
    if (format === 'binary-base64') {
      const raw = fs.readFileSync(artifactPath);
      if (!raw || !raw.length) return null;
      return Buffer.from(raw).toString('base64');
    }
    const raw = fs.readFileSync(artifactPath, 'utf8');
    if (format === 'text') return String(raw || '').trim();
    const parsed = JSON.parse(String(raw || ''));
    return isPlainObject(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function writeArtifactAtomic(fs, path, artifactPath, format, value) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const tempPath = `${artifactPath}.aih-tmp-${process.pid}-${Date.now()}`;
  let renamed = false;
  try {
    if (format === 'binary-base64') {
      let bytes = null;
      if (Buffer.isBuffer(value)) bytes = value;
      else {
        const text = String(value || '').trim();
        if (!text) return;
        bytes = Buffer.from(text, 'base64');
      }
      fs.writeFileSync(tempPath, bytes);
    } else {
      const content = format === 'text'
        ? String(value || '').trim()
        : `${JSON.stringify(value, null, 2)}\n`;
      fs.writeFileSync(tempPath, content, 'utf8');
    }
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(tempPath, 0o600); } catch (_chmodError) {}
    }
    try {
      fs.renameSync(tempPath, artifactPath);
    } catch (error) {
      if (!error || !['EEXIST', 'EPERM'].includes(error.code)) throw error;
      fs.unlinkSync(artifactPath);
      fs.renameSync(tempPath, artifactPath);
    }
    renamed = true;
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(artifactPath, 0o600); } catch (_chmodError) {}
    }
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(tempPath); } catch (_cleanupError) {}
    }
  }
}

function removeArtifact(fs, artifactPath) {
  try {
    if (!fs.existsSync(artifactPath)) return false;
    fs.unlinkSync(artifactPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function hasRequiredProjectionData(artifacts, source) {
  return artifacts
    .filter((artifact) => !artifact.optional)
    .every((artifact) => hasProjectionData(source && source[artifact.field]));
}

function readProviderAuthProjection(fs, runtimeDir, provider, options = {}) {
  const path = options.path || nodePath;
  const context = resolveProjectionContext(runtimeDir, provider);
  if (!context) return {};
  const output = {};
  context.artifacts.forEach((artifact) => {
    const value = readArtifact(fs, path.join(context.runtimeDir, ...artifact.path), artifact.format);
    if (hasProjectionData(value)) output[artifact.field] = value;
  });
  if (context.provider === 'claude') {
    const credentials = readClaudeKeychainCredentials({
      processObj: options.processObj || process,
      execFileSync: options.execFileSync,
      configDir: path.join(context.runtimeDir, '.claude'),
      includeDefaultService: false
    });
    if (hasProjectionData(credentials)) output.credentials = credentials;
  }
  return output;
}

function materializeProviderAuth(fs, runtimeDir, provider, options = {}) {
  const path = options.path || nodePath;
  const context = resolveProjectionContext(runtimeDir, provider);
  if (!context) {
    return { materialized: 0, removed: 0, missing: true, reason: 'invalid_projection_context' };
  }
  const storage = resolveStorageContext(fs, context.provider, options);
  if (!storage) {
    return { materialized: 0, removed: 0, missing: true, reason: 'unknown_account_ref' };
  }
  const nativeAuth = readAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef);
  let materialized = 0;
  let removed = 0;
  const hasRequiredData = isPlainObject(nativeAuth)
    && hasRequiredProjectionData(context.artifacts, nativeAuth);
  context.artifacts.forEach((artifact) => {
    const artifactPath = path.join(context.runtimeDir, ...artifact.path);
    const value = nativeAuth[artifact.field];
    if (!hasRequiredData || !hasProjectionData(value)) {
      if (removeArtifact(fs, artifactPath)) removed += 1;
      return;
    }
    writeArtifactAtomic(
      fs,
      path,
      artifactPath,
      artifact.format,
      value
    );
    materialized += 1;
  });
  return { materialized, removed, missing: !hasRequiredData };
}

function captureProviderAuth(fs, runtimeDir, provider, options = {}) {
  const context = resolveProjectionContext(runtimeDir, provider);
  if (!context) return { captured: false, reason: 'unsupported_provider' };
  const storage = resolveStorageContext(fs, context.provider, options);
  if (!storage) return { captured: false, reason: 'unknown_account' };
  const projection = readProviderAuthProjection(fs, runtimeDir, context.provider, options);
  if (!hasRequiredProjectionData(context.artifacts, projection)) {
    return { captured: false, reason: 'missing_projection' };
  }
  const current = readAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef);
  const next = { ...current, ...projection };
  if (isDeepStrictEqual(current, next)) {
    return { captured: false, reason: 'unchanged', nativeAuth: current };
  }
  writeAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef, next);
  return { captured: true, reason: 'updated', nativeAuth: next };
}

function registerProviderAuthProjection(fs, runtimeDir, provider, options = {}) {
  const context = resolveProjectionContext(runtimeDir, provider);
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const requestedCliAccountId = String(options.cliAccountId || '').trim();
  if (!context || !aiHomeDir || (requestedCliAccountId && !/^\d+$/.test(requestedCliAccountId))) {
    return { registered: false, reason: 'invalid_registration_context' };
  }
  const projection = readProviderAuthProjection(fs, runtimeDir, context.provider, options);
  if (!hasRequiredProjectionData(context.artifacts, projection)) {
    return { registered: false, reason: 'missing_projection' };
  }
  const identity = resolveNativeAuthIdentitySeed(context.provider, projection);
  if (!identity.identitySeed || identity.degraded) {
    return { registered: false, reason: 'missing_stable_identity' };
  }
  let registration;
  try {
    registration = registerAccountIdentity(fs, aiHomeDir, {
      provider: context.provider,
      identitySeed: identity.identitySeed,
      cliAccountId: requestedCliAccountId
    });
  } catch (_error) {
    return { registered: false, reason: 'account_ref_registration_failed' };
  }
  const accountRef = registration.accountRef;
  const current = readAccountNativeAuth(fs, aiHomeDir, accountRef);
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { ...current, ...projection });
  return {
    registered: true,
    reason: registration.created ? 'created' : 'existing_account',
    accountRef,
    cliAccountId: registration.cliAccountId
  };
}

module.exports = {
  PROVIDER_ARTIFACTS,
  captureProviderAuth,
  materializeProviderAuth,
  readProviderAuthProjection,
  registerProviderAuthProjection
};
