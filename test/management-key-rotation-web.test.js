const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ts = require('../web/node_modules/typescript');

function compileTypeScript(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
}

function loadRotationService(stubs) {
  const filename = path.join(__dirname, '../web/src/services/management-key-rotation.ts');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (request) => {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    throw new Error(`Unexpected management key rotation dependency: ${request}`);
  };
  mod._compile(compileTypeScript(filename), filename);
  return mod.exports;
}

function createProfile(overrides = {}) {
  return {
    id: 'server-home',
    name: 'Home',
    endpoint: 'https://home.example.com',
    connectionMode: 'direct',
    broker: null,
    state: 'ready',
    managementKey: 'old-management-key-that-is-long-enough',
    credentialRef: 'profile:server-home',
    managementKeyConfigured: true,
    nodes: [],
    nodeCount: 0,
    accountCount: 1,
    activeAccountCount: 1,
    schedulableAccountCount: 1,
    sessionCount: 0,
    lastNodeSyncAt: 0,
    lastStatusSyncAt: 1,
    lastAccountsSyncAt: 1,
    lastSessionsSyncAt: 0,
    descriptor: null,
    lastCheckedAt: 1,
    lastError: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

test('browser management key rotation updates Server before the saved profile', async () => {
  const calls = [];
  const savedInputs = [];
  const profile = createProfile();
  const replacement = 'new-management-key-that-is-long-enough';
  const service = loadRotationService({
    './api': {
      configAPI: {
        rotateManagementKey: async (key, authorizationKey) => {
          calls.push({ key, authorizationKey });
          return { ok: true, managementKeyConfigured: true, rotatedAt: 2 };
        }
      }
    },
    './control-plane-profiles': {
      initializeNativeControlPlaneProfiles: async () => {},
      listControlPlaneProfiles: () => [],
      saveControlPlaneProfileSecure: async (input) => {
        savedInputs.push(input);
        return createProfile({ managementKey: input.managementKey, updatedAt: 2 });
      }
    },
    './native-server-profile-repository': {
      isNativeDesktopRuntime: () => false,
      rotateNativeServerManagementKey: async () => {
        throw new Error('unexpected_native_rotation');
      }
    }
  });

  const saved = await service.rotateManagementKey(profile, replacement);

  assert.deepEqual(calls, [{ key: replacement, authorizationKey: undefined }]);
  assert.equal(savedInputs.length, 1);
  assert.equal(savedInputs[0].managementKey, replacement);
  assert.equal(saved.managementKey, replacement);
});

test('browser management key rotation compensates Server when local persistence fails', async () => {
  const calls = [];
  const profile = createProfile();
  const replacement = 'new-management-key-that-is-long-enough';
  const service = loadRotationService({
    './api': {
      configAPI: {
        rotateManagementKey: async (key, authorizationKey) => {
          calls.push({ key, authorizationKey });
          return { ok: true };
        }
      }
    },
    './control-plane-profiles': {
      initializeNativeControlPlaneProfiles: async () => {},
      listControlPlaneProfiles: () => [],
      saveControlPlaneProfileSecure: async () => {
        throw new Error('storage_unavailable');
      }
    },
    './native-server-profile-repository': {
      isNativeDesktopRuntime: () => false,
      rotateNativeServerManagementKey: async () => {
        throw new Error('unexpected_native_rotation');
      }
    }
  });

  await assert.rejects(
    service.rotateManagementKey(profile, replacement),
    (error) => error && error.code === 'management_key_client_save_failed'
  );
  assert.deepEqual(calls, [
    { key: replacement, authorizationKey: undefined },
    { key: profile.managementKey, authorizationKey: replacement }
  ]);
});

test('native management key rotation uses only the dedicated Rust command', async () => {
  const profile = createProfile({ managementKey: '' });
  const replacement = 'new-management-key-that-is-long-enough';
  const rotatedProfile = createProfile({ managementKey: '', updatedAt: 2 });
  const nativeCalls = [];
  let initialized = false;
  const service = loadRotationService({
    './api': {
      configAPI: {
        rotateManagementKey: async () => {
          throw new Error('generic_transport_must_not_receive_credentials');
        }
      }
    },
    './control-plane-profiles': {
      initializeNativeControlPlaneProfiles: async () => { initialized = true; },
      listControlPlaneProfiles: () => initialized ? [rotatedProfile] : [profile],
      saveControlPlaneProfileSecure: async () => {
        throw new Error('unexpected_renderer_profile_write');
      }
    },
    './native-server-profile-repository': {
      isNativeDesktopRuntime: () => true,
      rotateNativeServerManagementKey: async (profileId, managementKey) => {
        nativeCalls.push({ profileId, managementKey });
        return { rotated: true, profile: {} };
      }
    }
  });

  const saved = await service.rotateManagementKey(profile, replacement);

  assert.deepEqual(nativeCalls, [{ profileId: profile.id, managementKey: replacement }]);
  assert.equal(initialized, true);
  assert.equal(saved.managementKey, '');
});

test('management key generator produces a 32-byte base64url credential', () => {
  const service = loadRotationService({
    './api': { configAPI: {} },
    './control-plane-profiles': {},
    './native-server-profile-repository': {}
  });
  const generated = service.generateManagementKey({
    getRandomValues(bytes) {
      bytes.forEach((_, index) => { bytes[index] = index; });
      return bytes;
    }
  });

  assert.equal(generated.length, 43);
  assert.match(generated, /^[A-Za-z0-9_-]+$/);
  assert.equal(service.normalizeReplacementManagementKey(generated), generated);
});
