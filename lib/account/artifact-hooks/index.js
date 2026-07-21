'use strict';

const crypto = require('node:crypto');
const { createDefaultProviderArtifactHookRegistry } = require('./registry');
const { readDefaultAccountRef: readStoredDefaultAccountRef } = require('../default-account-store');
const { readAccountCredentialRecord } = require('../../server/account-credential-store');

const ACCOUNT_ARTIFACT_HOOK_EVENTS = Object.freeze({
  DEFAULT_ACCOUNT_AUTH_UPDATED: 'default_account_auth_updated',
  ACCOUNT_CONFIG_UPDATED: 'account_config_updated'
});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeAccountRef(accountRef) {
  const normalized = String(accountRef || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(normalized) ? normalized : '';
}

function normalizePathList(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));
}

function hashFileSafe(fs, filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (_error) {
    return '';
  }
}

function snapshotFile(fs, filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { exists: false, size: 0, mtimeMs: 0, sha256: '' };
    }
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: Number(stat.size) || 0,
      mtimeMs: Number(stat.mtimeMs) || 0,
      sha256: hashFileSafe(fs, filePath)
    };
  } catch (_error) {
    return { exists: false, size: 0, mtimeMs: 0, sha256: '' };
  }
}

function snapshotFiles(fs, filePaths) {
  const snapshot = {};
  normalizePathList(filePaths).forEach((filePath) => {
    snapshot[filePath] = snapshotFile(fs, filePath);
  });
  return snapshot;
}

function diffFileSnapshots(before, after) {
  const changedPaths = [];
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {})
  ]);
  keys.forEach((filePath) => {
    const left = before && before[filePath] ? before[filePath] : { exists: false, sha256: '' };
    const right = after && after[filePath] ? after[filePath] : { exists: false, sha256: '' };
    if (left.exists !== right.exists || left.sha256 !== right.sha256) {
      changedPaths.push(filePath);
    }
  });
  return changedPaths.sort();
}

function buildRelativePathTable(registry, methodName) {
  const table = {};
  registry.list().forEach((strategy) => {
    table[strategy.provider] = Object.freeze(strategy[methodName]());
  });
  return Object.freeze(table);
}

function createAccountArtifactHookService(options = {}) {
  const {
    fs,
    path,
    aiHomeDir: configuredAiHomeDir,
    getProfileDir,
    providerHookRegistry = createDefaultProviderArtifactHookRegistry({
      providerOptions: options.providerOptions,
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    }),
    onError
  } = options;
  const aiHomeDir = String(configuredAiHomeDir || '').trim();

  function reportError(error, event) {
    if (typeof onError !== 'function') return;
    try {
      onError(error, event);
    } catch (_error) {}
  }

  function getProviderStrategy(provider) {
    return providerHookRegistry && typeof providerHookRegistry.get === 'function'
      ? providerHookRegistry.get(provider)
      : null;
  }

  function resolveRuntimeDir(provider, accountRef, explicitRuntimeDir = '') {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedAccountRef = normalizeAccountRef(accountRef);
    const runtimeDir = String(explicitRuntimeDir || '').trim();
    if (!normalizedProvider || !normalizedAccountRef) return '';
    if (runtimeDir) return runtimeDir;
    if (typeof getProfileDir === 'function') {
      return String(getProfileDir(normalizedProvider, normalizedAccountRef) || '').trim();
    }
    return '';
  }

  function resolveArtifactPaths(provider, accountRef, pathGetterName, runtimeDir = '') {
    const strategy = getProviderStrategy(provider);
    const resolvedRuntimeDir = resolveRuntimeDir(provider, accountRef, runtimeDir);
    if (!strategy || !resolvedRuntimeDir || !path || typeof strategy[pathGetterName] !== 'function') return [];
    return strategy[pathGetterName]().map((relativePath) => path.join(resolvedRuntimeDir, relativePath));
  }

  function getAuthArtifactPaths(provider, accountRef, runtimeDir = '') {
    return resolveArtifactPaths(provider, accountRef, 'getAuthArtifactRelativePaths', runtimeDir);
  }

  function getConfigArtifactPaths(provider, accountRef, runtimeDir = '') {
    return resolveArtifactPaths(provider, accountRef, 'getConfigArtifactRelativePaths', runtimeDir);
  }

  function snapshotAccountAuthArtifacts(provider, accountRef, runtimeDir = '') {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedAccountRef = normalizeAccountRef(accountRef);
    const snapshot = snapshotFiles(fs, getAuthArtifactPaths(normalizedProvider, normalizedAccountRef, runtimeDir));
    if (!aiHomeDir || !normalizedProvider || !normalizedAccountRef) return snapshot;
    const record = readAccountCredentialRecord(fs, aiHomeDir, normalizedAccountRef);
    const virtualPath = `app-state://account/${String(record && record.accountRef || 'missing')}`;
    const serialized = record ? JSON.stringify({ env: record.env, nativeAuth: record.nativeAuth }) : '';
    snapshot[virtualPath] = {
      exists: Boolean(serialized),
      size: Buffer.byteLength(serialized),
      mtimeMs: Number(record && record.updatedAt) || 0,
      sha256: serialized ? crypto.createHash('sha256').update(serialized).digest('hex') : ''
    };
    return snapshot;
  }

  function readDefaultAccountRef(provider) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider || !aiHomeDir) return '';
    return readStoredDefaultAccountRef(fs, aiHomeDir, normalizedProvider);
  }

  function isDefaultAccount(provider, accountRef) {
    const normalizedAccountRef = normalizeAccountRef(accountRef);
    if (!normalizedAccountRef) return false;
    return readDefaultAccountRef(provider) === normalizedAccountRef;
  }

  function dispatch(provider, methodName, event) {
    const strategy = getProviderStrategy(provider);
    if (!strategy || typeof strategy[methodName] !== 'function') {
      return { ok: true, dispatched: false, reason: 'unsupported_provider', event };
    }
    try {
      return strategy[methodName](event);
    } catch (error) {
      reportError(error, event);
      return {
        ok: false,
        dispatched: true,
        reason: 'handler_failed',
        error: String((error && error.message) || error || 'unknown_error'),
        event
      };
    }
  }

  function buildBaseEvent(type, args = {}) {
    const provider = normalizeProvider(args.provider);
    const accountRef = normalizeAccountRef(args.accountRef);
    return {
      type,
      provider,
      accountRef,
      source: String(args.source || '').trim(),
      reason: String(args.reason || '').trim(),
      artifactPath: String(args.artifactPath || '').trim(),
      artifactPaths: normalizePathList(args.artifactPaths || args.changedPaths || args.artifactPath),
      changedPaths: normalizePathList(args.changedPaths || args.artifactPaths || args.artifactPath),
      at: new Date().toISOString()
    };
  }

  function notifyDefaultAccountAuthUpdated(args = {}) {
    const provider = normalizeProvider(args.provider);
    const accountRef = normalizeAccountRef(args.accountRef);
    if (!provider || !accountRef) {
      return { ok: false, dispatched: false, reason: 'invalid_account' };
    }
    if (!isDefaultAccount(provider, accountRef)) {
      return { ok: true, dispatched: false, reason: 'not_default_account' };
    }
    const event = buildBaseEvent(ACCOUNT_ARTIFACT_HOOK_EVENTS.DEFAULT_ACCOUNT_AUTH_UPDATED, {
      ...args,
      provider,
      accountRef,
      artifactPaths: args.artifactPaths || getAuthArtifactPaths(provider, accountRef, args.runtimeDir)
    });
    return dispatch(provider, 'handleDefaultAccountAuthUpdated', event);
  }

  function notifyDefaultAccountAuthUpdatedIfChanged(args = {}) {
    const provider = normalizeProvider(args.provider);
    const accountRef = normalizeAccountRef(args.accountRef);
    const before = args.before || {};
    const after = snapshotAccountAuthArtifacts(provider, accountRef, args.runtimeDir);
    const changedPaths = diffFileSnapshots(before, after);
    if (changedPaths.length === 0) {
      return { ok: true, dispatched: false, reason: 'unchanged', changedPaths };
    }
    return notifyDefaultAccountAuthUpdated({
      ...args,
      provider,
      accountRef,
      changedPaths,
      artifactPaths: changedPaths
    });
  }

  function notifyAccountConfigUpdated(args = {}) {
    const provider = normalizeProvider(args.provider);
    const accountRef = normalizeAccountRef(args.accountRef);
    if (!provider || !accountRef) {
      return { ok: false, dispatched: false, reason: 'invalid_account' };
    }
    const event = buildBaseEvent(ACCOUNT_ARTIFACT_HOOK_EVENTS.ACCOUNT_CONFIG_UPDATED, {
      ...args,
      provider,
      accountRef,
      artifactPaths: args.artifactPaths || getConfigArtifactPaths(provider, accountRef, args.runtimeDir)
    });
    return dispatch(provider, 'handleAccountConfigUpdated', event);
  }

  function notifyAccountConfigUpdatedIfChanged(args = {}) {
    const provider = normalizeProvider(args.provider);
    const accountRef = normalizeAccountRef(args.accountRef);
    const before = args.before || {};
    const after = snapshotFiles(fs, getConfigArtifactPaths(provider, accountRef, args.runtimeDir));
    const changedPaths = diffFileSnapshots(before, after);
    if (changedPaths.length === 0) {
      return { ok: true, dispatched: false, reason: 'unchanged', changedPaths };
    }
    return notifyAccountConfigUpdated({
      ...args,
      provider,
      accountRef,
      changedPaths,
      artifactPaths: changedPaths
    });
  }

  return {
    events: ACCOUNT_ARTIFACT_HOOK_EVENTS,
    getProviderStrategy,
    getAuthArtifactPaths,
    getConfigArtifactPaths,
    snapshotFiles: (filePaths) => snapshotFiles(fs, filePaths),
    snapshotAccountAuthArtifacts,
    snapshotAccountConfigArtifacts: (provider, accountRef, runtimeDir = '') => snapshotFiles(fs, getConfigArtifactPaths(provider, accountRef, runtimeDir)),
    diffFileSnapshots,
    readDefaultAccountRef,
    isDefaultAccount,
    notifyDefaultAccountAuthUpdated,
    notifyDefaultAccountAuthUpdatedIfChanged,
    notifyAccountConfigUpdated,
    notifyAccountConfigUpdatedIfChanged
  };
}

const defaultRegistry = createDefaultProviderArtifactHookRegistry();
const AUTH_ARTIFACT_RELATIVE_PATHS = buildRelativePathTable(defaultRegistry, 'getAuthArtifactRelativePaths');
const CONFIG_ARTIFACT_RELATIVE_PATHS = buildRelativePathTable(defaultRegistry, 'getConfigArtifactRelativePaths');

module.exports = {
  ACCOUNT_ARTIFACT_HOOK_EVENTS,
  AUTH_ARTIFACT_RELATIVE_PATHS,
  CONFIG_ARTIFACT_RELATIVE_PATHS,
  createAccountArtifactHookService,
  createDefaultProviderArtifactHookRegistry,
  __private: {
    normalizeProvider,
    normalizeAccountRef,
    snapshotFiles,
    diffFileSnapshots
  }
};
