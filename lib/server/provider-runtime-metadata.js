'use strict';

const crypto = require('node:crypto');
const {
  codexCapabilities
} = require('./chat-runtime/codex-session-driver-support');

const AIH_CODEX_APP_SERVER_ADAPTER_CONTRACT_VERSION =
  'aih-codex-app-server-adapter-v1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonicalValue(value[key])
  ]));
}

function hashCanonical(hash, value) {
  return normalizedText(hash(JSON.stringify(canonicalValue(value))));
}

function adapterCapabilityManifest(snapshot) {
  return Object.freeze({
    capabilities: snapshot.capabilities,
    slashCommands: snapshot.slashCommands,
    turnInterveneModes: snapshot.turnInterveneModes
  });
}

function createDefaultAdapterDefinitions() {
  return Object.freeze({
    codex: Object.freeze({
      protocolVersion: AIH_CODEX_APP_SERVER_ADAPTER_CONTRACT_VERSION,
      capabilityManifest: adapterCapabilityManifest(codexCapabilities({}))
    })
  });
}

function sanitizedAuthSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  return Object.keys(snapshot).sort().map((artifactPath) => {
    const artifact = snapshot[artifactPath] || {};
    return Object.freeze({
      artifactPath,
      exists: artifact.exists === true,
      sha256: normalizedText(artifact.sha256)
    });
  });
}

function createAccountAuthRevisionPort(options = {}) {
  const hooks = options.accountArtifactHooks;
  const hash = options.hash || sha256;
  return Object.freeze({
    async resolve(provider, context = {}) {
      if (!hooks || typeof hooks.snapshotAccountAuthArtifacts !== 'function') return '';
      const snapshot = await hooks.snapshotAccountAuthArtifacts(
        normalizedText(provider).toLowerCase(),
        normalizedText(context.runtimeScope)
      );
      return hashCanonical(hash, sanitizedAuthSnapshot(snapshot));
    }
  });
}

function createProviderRuntimeMetadataPort(options = {}) {
  const definitions = options.definitions || createDefaultAdapterDefinitions();
  const hash = options.hash || sha256;
  const authRevisionPort = options.authRevisionPort || createAccountAuthRevisionPort(options);
  const capabilityHashes = new Map();
  return Object.freeze({
    async resolve(provider, context = {}) {
      const normalizedProvider = normalizedText(provider).toLowerCase();
      const definition = definitions[normalizedProvider];
      if (!definition) return {};
      if (!capabilityHashes.has(normalizedProvider)) {
        capabilityHashes.set(
          normalizedProvider,
          hashCanonical(hash, definition.capabilityManifest)
        );
      }
      return Object.freeze({
        protocolVersion: normalizedText(definition.protocolVersion),
        capabilityHash: capabilityHashes.get(normalizedProvider),
        authRevision: normalizedText(await authRevisionPort.resolve(normalizedProvider, context))
      });
    }
  });
}

function createMetadataAwareRuntimeResolver(descriptorResolver, metadataPort) {
  if (!descriptorResolver || typeof descriptorResolver.resolve !== 'function') {
    throw new TypeError('descriptorResolver.resolve is required');
  }
  if (!metadataPort || typeof metadataPort.resolve !== 'function') {
    throw new TypeError('metadataPort.resolve is required');
  }
  return Object.freeze({
    descriptorResolver,
    async resolve(provider, context = {}) {
      const metadata = await metadataPort.resolve(provider, context);
      return descriptorResolver.resolve(provider, { ...context, ...metadata });
    }
  });
}

module.exports = {
  AIH_CODEX_APP_SERVER_ADAPTER_CONTRACT_VERSION,
  createAccountAuthRevisionPort,
  createDefaultAdapterDefinitions,
  createMetadataAwareRuntimeResolver,
  createProviderRuntimeMetadataPort
};
