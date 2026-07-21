'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { codexCapabilities } = require('../lib/server/chat-runtime/codex-session-driver-support');
const {
  createAccountAuthRevisionPort,
  createDefaultAdapterDefinitions,
  createMetadataAwareRuntimeResolver,
  createProviderRuntimeMetadataPort
} = require('../lib/server/provider-runtime-metadata');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('default Codex adapter manifest comes from the driver capability source', async () => {
  const hashedPayloads = [];
  const port = createProviderRuntimeMetadataPort({
    definitions: createDefaultAdapterDefinitions(),
    hash(value) {
      hashedPayloads.push(JSON.parse(value));
      return sha256(value);
    },
    authRevisionPort: { resolve: async () => 'auth-revision' }
  });

  const metadata = await port.resolve('codex', { runtimeScope: 'account-1' });
  const snapshot = codexCapabilities({});

  assert.deepEqual(hashedPayloads, [{
    capabilities: snapshot.capabilities,
    slashCommands: snapshot.slashCommands,
    turnInterveneModes: snapshot.turnInterveneModes
  }]);
  assert.match(metadata.capabilityHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.capabilities['turn.steer.tool_boundary'], {
    support: 'emulated',
    reason: 'aih_chat_runtime_tool_boundary_queue'
  });
});

test('auth revision hashes only artifact identity and never raw hook fields', async () => {
  let sha = 'artifact-sha-v1';
  let rawCredential = 'credential-v1';
  const port = createAccountAuthRevisionPort({
    hash: sha256,
    accountArtifactHooks: {
      snapshotAccountAuthArtifacts() {
        return {
          '/profiles/codex/auth.json': {
            exists: true,
            sha256: sha,
            rawCredential
          }
        };
      }
    }
  });

  const first = await port.resolve('codex', { runtimeScope: 'account-1' });
  rawCredential = 'credential-v2';
  const rawOnlyChanged = await port.resolve('codex', { runtimeScope: 'account-1' });
  sha = 'artifact-sha-v2';
  const artifactChanged = await port.resolve('codex', { runtimeScope: 'account-1' });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(rawOnlyChanged, first);
  assert.notEqual(artifactChanged, first);
  assert.equal([first, rawOnlyChanged, artifactChanged].includes(rawCredential), false);
});

test('capability hashes are canonical across manifest key order', async () => {
  const first = createProviderRuntimeMetadataPort({
    hash: sha256,
    definitions: {
      codex: { protocolVersion: 'v1', capabilityManifest: { b: 2, a: { d: 4, c: 3 } } }
    },
    authRevisionPort: { resolve: async () => 'auth' }
  });
  const second = createProviderRuntimeMetadataPort({
    hash: sha256,
    definitions: {
      codex: { protocolVersion: 'v1', capabilityManifest: { a: { c: 3, d: 4 }, b: 2 } }
    },
    authRevisionPort: { resolve: async () => 'auth' }
  });

  const left = await first.resolve('codex', { runtimeScope: 'account-1' });
  const right = await second.resolve('codex', { runtimeScope: 'account-1' });

  assert.equal(left.capabilityHash, right.capabilityHash);
});

test('metadata-aware resolver returns a complete descriptor from one resolve call', async () => {
  const descriptorContexts = [];
  const resolver = createMetadataAwareRuntimeResolver({
    resolve(provider, context) {
      descriptorContexts.push({ provider, context });
      return { provider, ...context };
    }
  }, {
    resolve: async () => ({
      protocolVersion: 'aih-codex-app-server-adapter-v1',
      capabilityHash: 'capability-hash',
      authRevision: 'auth-revision'
    })
  });

  const descriptor = await resolver.resolve('codex', { runtimeScope: 'account-1' });

  assert.equal(descriptor.protocolVersion, 'aih-codex-app-server-adapter-v1');
  assert.equal(descriptor.capabilityHash, 'capability-hash');
  assert.equal(descriptor.authRevision, 'auth-revision');
  assert.deepEqual(descriptorContexts, [{
    provider: 'codex',
    context: {
      runtimeScope: 'account-1',
      protocolVersion: 'aih-codex-app-server-adapter-v1',
      capabilityHash: 'capability-hash',
      authRevision: 'auth-revision'
    }
  }]);
});
