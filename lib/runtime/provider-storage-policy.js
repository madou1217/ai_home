'use strict';

const path = require('node:path');

const PROVIDER_RUNTIME_HOME_DIR = '.aih-runtime-home';

/**
 * Provider-owned persistent state is account-independent. Account projections
 * may contain credentials, but every resource/session/cache path below must
 * resolve to the provider's native host directory.
 */
const PROVIDER_STORAGE_POLICIES = Object.freeze({
  codex: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({ field: 'auth', path: Object.freeze(['.codex', 'auth.json']), format: 'json' })
    ]),
    privateArtifacts: Object.freeze([
      Object.freeze({ path: Object.freeze(['.codex', 'config.toml']) }),
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.codex']),
    runtimeHomeRoot: Object.freeze(['.codex', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze(['.codex']), to: Object.freeze(['.codex']) })
    ]),
    sharedEntries: Object.freeze([
      'sessions',
      'history.jsonl',
      'archived_sessions',
      'shell_snapshots',
      'version.json',
      'models_cache.json',
      '.personality_migration',
      'log',
      'memories',
      'rules',
      'skills',
      'sqlite',
      'prompts',
      'worktrees',
      'automations',
      'backup',
      'vendor_imports',
      'internal_storage.json',
      'AGENTS.md',
      '.tmp',
      'cache',
      'tmp',
      'session_index.jsonl'
    ]),
    precreatedDirectories: Object.freeze([
      'sessions',
      'archived_sessions',
      'shell_snapshots',
      'log',
      'memories',
      'rules',
      'skills',
      'sqlite',
      'prompts',
      'worktrees',
      'automations',
      'backup',
      'vendor_imports',
      '.tmp',
      'cache',
      'tmp'
    ]),
    attachmentSubdir: Object.freeze(['.tmp', 'model', 'images'])
  }),
  claude: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({ field: 'credentials', path: Object.freeze(['.claude', '.credentials.json']), format: 'json' })
    ]),
    privateArtifacts: Object.freeze([
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.claude']),
    runtimeHomeRoot: Object.freeze(['.claude', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze(['.claude']), to: Object.freeze(['.claude']) })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze([]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  gemini: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({ field: 'oauthCreds', path: Object.freeze(['.gemini', 'oauth_creds.json']), format: 'json' }),
      Object.freeze({ field: 'googleAccounts', path: Object.freeze(['.gemini', 'google_accounts.json']), format: 'json', optional: true })
    ]),
    privateArtifacts: Object.freeze([
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.gemini']),
    runtimeHomeRoot: Object.freeze(['.gemini', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze(['.gemini']), to: Object.freeze(['.gemini']) })
    ]),
    sharedEntries: Object.freeze(['history', 'projects.json', 'tmp']),
    precreatedDirectories: Object.freeze(['history', 'tmp']),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  agy: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'oauthToken',
        path: Object.freeze(['.gemini', 'antigravity-cli', 'antigravity-oauth-token']),
        format: 'json'
      }),
      Object.freeze({
        field: 'email',
        path: Object.freeze(['.gemini', 'antigravity-cli', 'email.cache']),
        format: 'text',
        optional: true
      })
    ]),
    privateArtifacts: Object.freeze([
      // AGY runs with a fake HOME. Keychains are identity-bearing and must
      // remain account-owned even though the rest of Library is provider-shared.
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.gemini', 'antigravity-cli']),
    runtimeHomeRoot: Object.freeze([
      '.gemini',
      'antigravity-cli',
      PROVIDER_RUNTIME_HOME_DIR
    ]),
    projectionRoots: Object.freeze([
      Object.freeze({
        from: Object.freeze(['.gemini', 'antigravity-cli']),
        to: Object.freeze(['.gemini', 'antigravity-cli'])
      }),
      Object.freeze({
        from: Object.freeze(['.gemini', 'config']),
        to: Object.freeze(['.gemini', 'config'])
      }),
      Object.freeze({
        from: Object.freeze(['.gemini', 'GEMINI.md']),
        to: Object.freeze(['.gemini', 'GEMINI.md'])
      }),
      Object.freeze({
        from: Object.freeze(['.gemini']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, '.gemini'])
      }),
      Object.freeze({
        from: Object.freeze(['Library']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'Library'])
      }),
      Object.freeze({
        from: Object.freeze(['.local', 'share']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'xdg', 'data'])
      }),
      Object.freeze({
        from: Object.freeze(['.local', 'state']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'xdg', 'state'])
      }),
      Object.freeze({
        from: Object.freeze(['.cache']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'xdg', 'cache'])
      }),
      Object.freeze({
        from: Object.freeze(['.config']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'xdg', 'config'])
      }),
      Object.freeze({
        from: Object.freeze(['AppData', 'Roaming']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'AppData', 'Roaming'])
      }),
      Object.freeze({
        from: Object.freeze(['AppData', 'Local']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'AppData', 'Local'])
      }),
      Object.freeze({
        // Keep arbitrary $HOME children in their own namespace. Mapping them
        // into xdg/config would collapse `$HOME/foo` and `$HOME/.config/foo`.
        from: Object.freeze([]),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'home'])
      })
    ]),
    sharedEntries: Object.freeze([
      'brain',
      'conversations',
      'knowledge',
      'scratch',
      'implicit',
      'builtin',
      'cache',
      'log',
      'bin',
      'updater'
    ]),
    precreatedDirectories: Object.freeze([
      'brain',
      'conversations',
      'knowledge',
      'scratch',
      'implicit',
      'builtin',
      'cache',
      'log',
      'bin',
      'updater'
    ]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  opencode: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'auth',
        path: Object.freeze(['.local', 'share', 'opencode', 'auth.json']),
        format: 'json'
      })
    ]),
    privateArtifacts: Object.freeze([
      // OpenCode reads account auth through the disposable XDG bridge. This is
      // an alias of the auth artifact above, never provider-shared state.
      Object.freeze({
        path: Object.freeze(['.local', 'share', 'aih-opencode-runtime', 'opencode', 'auth.json'])
      }),
      // Older layouts may have left credential backups under the projected
      // config root. Keep the exact auth basename account-private there too.
      Object.freeze({
        path: Object.freeze(['.config', 'opencode', 'auth.json'])
      }),
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.local', 'share', 'opencode']),
    runtimeHomeRoot: Object.freeze([
      '.local',
      'share',
      'opencode',
      PROVIDER_RUNTIME_HOME_DIR
    ]),
    projectionRoots: Object.freeze([
      Object.freeze({
        from: Object.freeze(['.local', 'share', 'aih-opencode-runtime', 'opencode']),
        to: Object.freeze(['.local', 'share', 'opencode'])
      }),
      Object.freeze({
        from: Object.freeze(['.local', 'share', 'opencode']),
        to: Object.freeze(['.local', 'share', 'opencode'])
      }),
      Object.freeze({
        from: Object.freeze(['.config', 'opencode']),
        to: Object.freeze(['.config', 'opencode'])
      })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze([]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  })
});

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return PROVIDER_STORAGE_POLICIES[value] ? value : '';
}

function getProviderStoragePolicy(provider) {
  const normalized = normalizeProvider(provider);
  return normalized ? PROVIDER_STORAGE_POLICIES[normalized] : null;
}

function getProviderAuthArtifacts(provider) {
  const policy = getProviderStoragePolicy(provider);
  return policy ? Array.from(policy.authArtifacts) : [];
}

function getProviderPrivateArtifacts(provider) {
  const policy = getProviderStoragePolicy(provider);
  return policy ? Array.from(policy.privateArtifacts || []) : [];
}

function getProviderProjectionMappings(provider) {
  const policy = getProviderStoragePolicy(provider);
  if (!policy) return [];
  const mappings = Array.from(policy.projectionRoots);
  const hasFallbackMapping = mappings.some((mapping) => (
    Array.isArray(mapping && mapping.from) && mapping.from.length === 0
  ));
  if (!hasFallbackMapping && Array.isArray(policy.runtimeHomeRoot) && policy.runtimeHomeRoot.length > 0) {
    mappings.push(Object.freeze({
      from: Object.freeze([]),
      to: policy.runtimeHomeRoot
    }));
  }
  return mappings;
}

function getProviderPrivateEntryNames(provider) {
  const policy = getProviderStoragePolicy(provider);
  if (!policy) return [];
  const root = normalizePathSegments(policy.nativeRoot);
  return [...policy.authArtifacts, ...getProviderPrivateArtifacts(provider)]
    .map((artifact) => normalizePathSegments(artifact.path))
    .filter((artifactPath) => (
      artifactPath.length > root.length
      && root.every((segment, index) => artifactPath[index] === segment)
    ))
    .map((artifactPath) => artifactPath[root.length]);
}

function isProviderPrivateEntryName(provider, entryName) {
  const actual = String(entryName || '').trim().toLowerCase();
  if (!actual) return false;
  return getProviderPrivateEntryNames(provider).some((expected) => (
    actual === expected || actual.startsWith(`${expected}.`)
  ));
}

function normalizePathSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => String(segment || '').trim().toLowerCase())
    .filter(Boolean);
}

function isProviderAuthArtifactSegments(provider, segments) {
  const candidate = normalizePathSegments(segments);
  return getProviderAuthArtifacts(provider).some((artifact) => {
    const expected = normalizePathSegments(artifact.path);
    if (candidate.length !== expected.length) return false;
    return expected.every((segment, index) => {
      const actual = candidate[index];
      if (index < expected.length - 1) return actual === segment;
      return actual === segment || actual.startsWith(`${segment}.`);
    });
  });
}

function isProviderAuthArtifactPath(filePath, pathImpl = path) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return false;
  const parts = normalizePathSegments(normalized.split(/[\\/]+/));

  return Object.keys(PROVIDER_STORAGE_POLICIES).some((provider) => (
    getProviderAuthArtifacts(provider).some((artifact) => {
      const expected = normalizePathSegments(artifact.path);
      if (parts.length < expected.length) return false;
      const offset = parts.length - expected.length;
      return expected.every((segment, index) => {
        const actual = parts[offset + index];
        if (index < expected.length - 1) return actual === segment;
        return actual === segment || actual.startsWith(`${segment}.`);
      });
    })
  )) || pathImpl.basename(normalized).toLowerCase() === 'credentials.json';
}

function isProviderPrivateArtifactPath(filePath, pathImpl = path) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return false;
  if (isProviderAuthArtifactPath(normalized, pathImpl)) return true;
  const parts = normalizePathSegments(normalized.split(/[\\/]+/));

  return Object.keys(PROVIDER_STORAGE_POLICIES).some((provider) => (
    getProviderPrivateArtifacts(provider).some((artifact) => {
      const expected = normalizePathSegments(artifact.path);
      if (parts.length < expected.length) return false;
      const offset = parts.length - expected.length;
      return expected.every((segment, index) => {
        const actual = parts[offset + index];
        if (index < expected.length - 1) return actual === segment;
        return actual === segment || actual.startsWith(`${segment}.`);
      });
    })
  ));
}

function resolveProviderNativeRoot(hostHomeDir, provider, pathImpl = path) {
  const root = String(hostHomeDir || '').trim();
  const policy = getProviderStoragePolicy(provider);
  return root && policy ? pathImpl.join(root, ...policy.nativeRoot) : '';
}

function resolveProviderRuntimeHomeRoot(hostHomeDir, provider, pathImpl = path) {
  const root = String(hostHomeDir || '').trim();
  const policy = getProviderStoragePolicy(provider);
  return root && policy && Array.isArray(policy.runtimeHomeRoot)
    ? pathImpl.join(root, ...policy.runtimeHomeRoot)
    : '';
}

function resolveProviderAttachmentRoot(hostHomeDir, provider, pathImpl = path) {
  const root = resolveProviderNativeRoot(hostHomeDir, provider, pathImpl);
  const policy = getProviderStoragePolicy(provider);
  return root && policy ? pathImpl.join(root, ...policy.attachmentSubdir) : '';
}

function getProviderSharedEntries(provider) {
  const policy = getProviderStoragePolicy(provider);
  return policy ? Array.from(policy.sharedEntries) : [];
}

function isProviderPrecreatedDirectory(provider, entryName) {
  const policy = getProviderStoragePolicy(provider);
  return Boolean(policy && policy.precreatedDirectories.includes(String(entryName || '')));
}

module.exports = {
  PROVIDER_RUNTIME_HOME_DIR,
  PROVIDER_STORAGE_POLICIES,
  getProviderAuthArtifacts,
  getProviderPrivateArtifacts,
  getProviderPrivateEntryNames,
  getProviderProjectionMappings,
  getProviderSharedEntries,
  getProviderStoragePolicy,
  isProviderAuthArtifactPath,
  isProviderAuthArtifactSegments,
  isProviderPrivateArtifactPath,
  isProviderPrivateEntryName,
  isProviderPrecreatedDirectory,
  normalizeProvider,
  resolveProviderAttachmentRoot,
  resolveProviderNativeRoot,
  resolveProviderRuntimeHomeRoot
};
