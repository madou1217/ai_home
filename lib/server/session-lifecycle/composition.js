'use strict';

const nodeFs = require('node:fs');
const { listProviderIds } = require('../../provider-catalog');
const { DefaultProviderRuntimeResolver } = require('../../runtime/default-provider-runtime');
const { resolveHostHomeDir } = require('../../runtime/host-home');
const { deleteJsonValue: defaultDeleteJsonValue } = require('../app-state-store');
const {
  createProviderSessionLifecycleRegistry,
  createSessionLifecycleService
} = require('./index');
const { createCodexNativeLifecycleStrategy } = require('./codex-native-strategy');
const { createCodexLifecycleStdioClient } = require('./codex-stdio-client');
const { createLegacyArchiveRecovery } = require('./legacy-archive-recovery');

const OBSOLETE_ARCHIVED_SNAPSHOT_KEY = 'cache:webui-archived-snapshot.json';

function createSessionLifecycleComposition(options = {}) {
  const fs = options.fs || nodeFs;
  const env = options.env || process.env;
  const hostHomeDir = String(options.hostHomeDir || resolveHostHomeDir({ env })).trim();
  const runtimeResolver = options.runtimeResolver || new DefaultProviderRuntimeResolver({
    fs,
    env,
    spawn: options.spawn,
    spawnSync: options.spawnSync,
    nativeCliOptions: { projectFallback: false },
    resolveNativeCliPath: options.resolveNativeCliPath
  });
  const codexClientFactory = options.codexClientFactory || ((runtime) => (
    createCodexLifecycleStdioClient(runtime, {
      env,
      hostHomeDir,
      onStderr: options.onCodexStderr,
      requestTimeoutMs: options.requestTimeoutMs,
      spawnImpl: options.spawn
    })
  ));
  const codexStrategy = createCodexNativeLifecycleStrategy({
    runtimeResolver,
    clientFactory: codexClientFactory
  });
  const registry = createProviderSessionLifecycleRegistry([
    codexStrategy,
    ...(Array.isArray(options.strategies) ? options.strategies : [])
  ]);
  const legacyRecovery = options.legacyRecovery || createLegacyArchiveRecovery({
    fs,
    hostHomeDir
  });

  retireObsoleteArchivedSnapshot({
    aiHomeDir: options.aiHomeDir,
    deleteJsonValue: options.deleteJsonValue || defaultDeleteJsonValue,
    fs
  });

  return createSessionLifecycleService({
    providers: options.providers || listProviderIds(),
    registry,
    identityResolver: options.identityResolver || createSessionIdentityResolver(options),
    legacyRecovery
  });
}

function createSessionIdentityResolver(options = {}) {
  const resolveIdentity = typeof options.resolveIdentity === 'function'
    ? options.resolveIdentity
    : null;
  return {
    resolve(input = {}) {
      const sessionId = String(input.sessionId || '').trim();
      if (resolveIdentity) {
        return resolveIdentity(input);
      }
      return { nativeSessionId: sessionId, active: false };
    }
  };
}

function retireObsoleteArchivedSnapshot(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir || typeof options.deleteJsonValue !== 'function') return false;
  return options.deleteJsonValue(
    options.fs,
    aiHomeDir,
    OBSOLETE_ARCHIVED_SNAPSHOT_KEY,
    { bestEffort: true }
  );
}

module.exports = {
  OBSOLETE_ARCHIVED_SNAPSHOT_KEY,
  createSessionIdentityResolver,
  createSessionLifecycleComposition,
  retireObsoleteArchivedSnapshot
};
