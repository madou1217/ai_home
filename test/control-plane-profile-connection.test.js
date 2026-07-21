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

function loadConnectionService() {
  const filename = path.join(__dirname, '../web/src/services/control-plane-profile-connection.ts');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === './control-plane-profiles') {
      return {
        isControlPlaneManagementKeyConfigured: (profile) => Boolean(profile?.managementKeyConfigured),
        normalizeControlPlaneEndpoint: (value) => String(value || '').replace(/\/+$/u, ''),
        saveControlPlaneProfileSecure: async () => {
          throw new Error('unexpected_default_save');
        }
      };
    }
    if (request === './native-server-profile-repository') {
      return {
        authorizeNativeLanProfile: async () => {
          throw new Error('unexpected_default_lan_authorization');
        },
        isNativeDesktopRuntime: () => false
      };
    }
    return originalRequire(request);
  };
  mod._compile(compileTypeScript(filename), filename);
  return mod.exports;
}

function createProfile(overrides = {}) {
  return {
    id: 'aws',
    stableServerId: 'server-aws',
    name: 'AWS',
    endpoint: 'https://aws.example.com',
    routes: [{ id: 'direct-aws', kind: 'direct', endpoint: 'https://aws.example.com' }],
    activeRouteId: 'direct-aws',
    authorizationState: 'discovered-pending-auth',
    managementKeyConfigured: false,
    credentialRef: 'profile:aws',
    ...overrides
  };
}

test('authorizing an AWS Server saves its own endpoint and never runs LAN proof', async () => {
  const service = loadConnectionService();
  const calls = [];
  const aws = createProfile();
  await service.connectControlPlaneProfile({
    profiles: [aws],
    profileId: 'aws',
    endpoint: 'https://aws.example.com',
    name: 'AWS Tokyo',
    managementKey: 'management-key'
  }, {
    isNativeRuntime: () => true,
    authorizeLanProfile: async () => calls.push('lan'),
    saveProfile: async (input) => {
      calls.push(input);
      return input;
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'https://aws.example.com');
  assert.equal(calls[0].managementKey, 'management-key');
  assert.equal(calls[0].stableServerId, 'server-aws');
});

test('native LAN authorization verifies the discovered route before saving metadata', async () => {
  const service = loadConnectionService();
  const calls = [];
  const lan = createProfile({
    id: 'lan',
    stableServerId: 'server-lan',
    endpoint: 'http://192.168.1.20:9527',
    routes: [{ id: 'lan-route', kind: 'direct-lan', endpoint: 'http://192.168.1.20:9527' }]
  });
  await service.connectControlPlaneProfile({
    profiles: [lan],
    profileId: 'lan',
    endpoint: lan.endpoint,
    managementKey: 'm'.repeat(32)
  }, {
    isNativeRuntime: () => true,
    authorizeLanProfile: async (profileId, managementKey) => {
      calls.push({ type: 'proof', profileId, managementKey });
    },
    saveProfile: async (input) => {
      calls.push({ type: 'save', input });
      return input;
    }
  });

  assert.deepEqual(calls.map((call) => call.type), ['proof', 'save']);
  assert.equal(calls[1].input.managementKey, '');
  assert.equal(calls[1].input.managementKeyConfigured, true);
});

test('a pending Server cannot connect without a Management Key', async () => {
  const service = loadConnectionService();
  await assert.rejects(
    service.connectControlPlaneProfile({
      profiles: [createProfile()],
      profileId: 'aws',
      endpoint: 'https://aws.example.com'
    }, {
      isNativeRuntime: () => false,
      authorizeLanProfile: async () => {},
      saveProfile: async () => ({})
    }),
    /请输入 Management Key/u
  );
});
