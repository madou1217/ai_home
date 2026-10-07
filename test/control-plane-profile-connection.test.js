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

function loadConnectionService(saveProfile) {
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
        saveControlPlaneProfile: saveProfile
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
    ...overrides
  };
}

test('authorizing an AWS Server saves its own endpoint and Management Key', async () => {
  const calls = [];
  const service = loadConnectionService((input) => {
    calls.push(input);
    return input;
  });
  const aws = createProfile();
  await service.connectControlPlaneProfile({
    profiles: [aws],
    profileId: 'aws',
    endpoint: 'https://aws.example.com',
    name: 'AWS Tokyo',
    managementKey: 'management-key'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'https://aws.example.com');
  assert.equal(calls[0].managementKey, 'management-key');
  assert.equal(calls[0].managementKeyConfigured, true);
  assert.equal(calls[0].stableServerId, 'server-aws');
});

test('a pending Server cannot connect without a Management Key', async () => {
  const service = loadConnectionService(() => ({}));
  await assert.rejects(
    service.connectControlPlaneProfile({
      profiles: [createProfile()],
      profileId: 'aws',
      endpoint: 'https://aws.example.com'
    }),
    /请输入 Management Key/u
  );
});
