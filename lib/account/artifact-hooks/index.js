'use strict';

const crypto = require('node:crypto');
const { createDefaultProviderArtifactHookRegistry } = require('./registry');

const ACCOUNT_ARTIFACT_HOOK_EVENTS = Object.freeze({
  DEFAULT_ACCOUNT_AUTH_UPDATED: 'default_account_auth_updated',
  ACCOUNT_CONFIG_UPDATED: 'account_config_updated'
});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeAccountId(accountId) {
  const normalized = String(accountId || '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function normalizePathList(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8') || '').trim();
  } catch (_error) {
    return '';
  }
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
    profilesDir,
    getProfileDir,
    providerHookRegistry = createDefaultProviderArtifactHookRegistry({
      providerOptions: options.providerOptions,
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    }),
    onError
  } = options;

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

  function resolveProfileDir(provider, accountId) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedAccountId = normalizeAccountId(accountId);
    if (!normalizedProvider || !normalizedAccountId) return '';
    if (typeof getProfileDir === 'function') {
      return String(getProfileDir(normalizedProvider, normalizedAccountId) || '').trim();
    }
    if (!profilesDir || !path) return '';
    return path.join(profilesDir, normalizedProvider, normalizedAccountId);
  }

  function resolveArtifactPaths(provider, accountId, pathGetterName) {
    const strategy = getProviderStrategy(provider);
    const profileDir = resolveProfileDir(provider, accountId);
    if (!strategy || !profileDir || !path || typeof strategy[pathGetterName] !== 'function') return [];
    return strategy[pathGetterName]().map((relativePath) => path.join(profileDir, relativePath));
  }

  function getAuthArtifactPaths(provider, accountId) {
    return resolveArtifactPaths(provider, accountId, 'getAuthArtifactRelativePaths');
  }

  function getConfigArtifactPaths(provider, accountId) {
    return resolveArtifactPaths(provider, accountId, 'getConfigArtifactRelativePaths');
  }

  function readDefaultAccountId(provider) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider || !profilesDir || !path) return '';
    return normalizeAccountId(readTextFileSafe(fs, path.join(profilesDir, normalizedProvider, '.aih_default')));
  }

  function isDefaultAccount(provider, accountId) {
    const normalizedAccountId = normalizeAccountId(accountId);
    if (!normalizedAccountId) return false;
    return readDefaultAccountId(provider) === normalizedAccountId;
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
    const accountId = normalizeAccountId(args.accountId);
    return {
      type,
      provider,
      accountId,
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
    const accountId = normalizeAccountId(args.accountId);
    if (!provider || !accountId) {
      return { ok: false, dispatched: false, reason: 'invalid_account' };
    }
    if (!isDefaultAccount(provider, accountId)) {
      return { ok: true, dispatched: false, reason: 'not_default_account' };
    }
    const event = buildBaseEvent(ACCOUNT_ARTIFACT_HOOK_EVENTS.DEFAULT_ACCOUNT_AUTH_UPDATED, {
      ...args,
      provider,
      accountId,
      artifactPaths: args.artifactPaths || getAuthArtifactPaths(provider, accountId)
    });
    return dispatch(provider, 'handleDefaultAccountAuthUpdated', event);
  }

  function notifyDefaultAccountAuthUpdatedIfChanged(args = {}) {
    const provider = normalizeProvider(args.provider);
    const accountId = normalizeAccountId(args.accountId);
    const before = args.before || {};
    const after = snapshotFiles(fs, getAuthArtifactPaths(provider, accountId));
    const changedPaths = diffFileSnapshots(before, after);
    if (changedPaths.length === 0) {
      return { ok: true, dispatched: false, reason: 'unchanged', changedPaths };
    }
    return notifyDefaultAccountAuthUpdated({
      ...args,
      provider,
      accountId,
      changedPaths,
      artifactPaths: changedPaths
    });
  }

  function notifyAccountConfigUpdated(args = {}) {
    const provider = normalizeProvider(args.provider);
    const accountId = normalizeAccountId(args.accountId);
    if (!provider || !accountId) {
      return { ok: false, dispatched: false, reason: 'invalid_account' };
    }
    const event = buildBaseEvent(ACCOUNT_ARTIFACT_HOOK_EVENTS.ACCOUNT_CONFIG_UPDATED, {
      ...args,
      provider,
      accountId,
      artifactPaths: args.artifactPaths || getConfigArtifactPaths(provider, accountId)
    });
    return dispatch(provider, 'handleAccountConfigUpdated', event);
  }

  function notifyAccountConfigUpdatedIfChanged(args = {}) {
    const provider = normalizeProvider(args.provider);
    const accountId = normalizeAccountId(args.accountId);
    const before = args.before || {};
    const after = snapshotFiles(fs, getConfigArtifactPaths(provider, accountId));
    const changedPaths = diffFileSnapshots(before, after);
    if (changedPaths.length === 0) {
      return { ok: true, dispatched: false, reason: 'unchanged', changedPaths };
    }
    return notifyAccountConfigUpdated({
      ...args,
      provider,
      accountId,
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
    snapshotAccountAuthArtifacts: (provider, accountId) => snapshotFiles(fs, getAuthArtifactPaths(provider, accountId)),
    snapshotAccountConfigArtifacts: (provider, accountId) => snapshotFiles(fs, getConfigArtifactPaths(provider, accountId)),
    diffFileSnapshots,
    readDefaultAccountId,
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
    normalizeAccountId,
    snapshotFiles,
    diffFileSnapshots
  }
};
