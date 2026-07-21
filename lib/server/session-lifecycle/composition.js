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
const ACTIVE_SESSION_STATES = new Set([
  'starting', 'running', 'waiting_input', 'interrupting', 'completing', 'recovering'
]);

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
  const chatRuntimeService = options.chatRuntimeService;
  return {
    resolve(input = {}) {
      const provider = String(input.provider || '').trim().toLowerCase();
      const sessionId = String(input.sessionId || '').trim();
      const store = chatRuntimeService && chatRuntimeService.store;
      const session = store && typeof store.getSession === 'function'
        ? store.getSession(sessionId)
        : null;
      if (!session || String(session.provider || '').trim().toLowerCase() !== provider) {
        return { nativeSessionId: sessionId, active: false };
      }
      const nativeSessionId = String(
        session.runtimeBinding && session.runtimeBinding.nativeSessionId || sessionId
      ).trim();
      return {
        nativeSessionId,
        active: ACTIVE_SESSION_STATES.has(String(session.state || '').trim().toLowerCase())
      };
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
