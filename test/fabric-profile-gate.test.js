const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function compileTypeScript(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
}

function installTsRequireHook() {
  const previous = require.extensions['.ts'];
  require.extensions['.ts'] = (mod, filename) => {
    mod._compile(compileTypeScript(filename), filename);
  };
  return () => {
    if (previous) {
      require.extensions['.ts'] = previous;
      return;
    }
    delete require.extensions['.ts'];
  };
}

function loadFabricProfileGateModule() {
  const filename = path.join(__dirname, '../web/src/services/fabric-profile-gate.ts');
  const restore = installTsRequireHook();
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  try {
    mod._compile(compileTypeScript(filename), filename);
    return mod.exports;
  } finally {
    restore();
  }
}

function createProfile(id, overrides = {}) {
  return {
    id,
    name: id,
    endpoint: `https://${id}.example.com`,
    state: 'offline',
    managementKey: '',
    nodes: [],
    nodeCount: 0,
    accountCount: 0,
    activeAccountCount: 0,
    schedulableAccountCount: 0,
    sessionCount: 0,
    lastNodeSyncAt: 0,
    lastStatusSyncAt: 0,
    lastAccountsSyncAt: 0,
    lastSessionsSyncAt: 0,
    descriptor: null,
    lastCheckedAt: 0,
    lastError: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

test('fabric profile gate uses dedicated server setup route', () => {
  const gate = loadFabricProfileGateModule();

  assert.equal(gate.FABRIC_SERVER_SETUP_PATH, '/server-setup');
  assert.equal(gate.FABRIC_SERVER_SETUP_TARGET, '/server-setup');
  assert.equal(gate.FABRIC_SERVER_SETUP_HREF, '/ui/server-setup');
  assert.equal(gate.isFabricServerSetupLocation('/server-setup', ''), true);
  assert.equal(gate.isFabricServerSetupLocation('/ui/server-setup', ''), true);
  assert.equal(gate.isFabricServerSetupLocation('/ui/server-setup/', ''), true);
  assert.equal(gate.isFabricServerSetupLocation('/server-setup', '?tab=control-planes'), true);
  assert.equal(gate.isFabricServerSetupLocation('/settings', '?tab=control-planes'), false);
});

test('fabric profile gate redirects to one canonical setup target', () => {
  const gate = loadFabricProfileGateModule();

  assert.equal(gate.resolveFabricServerSetupTarget(''), '/server-setup');
  assert.equal(gate.resolveFabricServerSetupTarget('?tab=control-planes'), '/server-setup');
});

test('client profile gate protects the workspace until the active Server is authorized', () => {
  const gate = loadFabricProfileGateModule();
  const ready = createProfile('cp-ready', {
    state: 'ready',
    managementKey: 'management-key'
  });
  const offline = createProfile('cp-offline');

  assert.deepEqual(gate.resolveFabricProfileGateState([offline], 'cp-offline'), {
    ready: false,
    active: {
      profile: offline,
      profileId: 'cp-offline',
      source: 'stored'
    },
    profileCount: 1
  });
  [
    '/',
    '/accounts',
    '/chat',
    '/usage',
    '/models',
    '/settings',
    '/fabric',
    '/fabric/servers',
    '/fabric/control-planes',
    '/fabric/remote-nodes',
    '/fabric/ssh-hosts',
    '/fabric/nodes',
    '/fabric/webrtc-diagnostics'
  ].forEach((pathname) => {
    assert.equal(gate.shouldRedirectToFabricServerSetup({ ready: false }, pathname, ''), true, pathname);
  });
  assert.equal(gate.shouldRedirectToFabricServerSetup({ ready: false }, '/server-setup', ''), false);
  assert.equal(gate.shouldRedirectToFabricServerSetup({ ready: false }, '/server-setup', '?gate=1'), false);
  assert.equal(gate.shouldRedirectToFabricServerSetup({ ready: false }, '/future-workspace-route', ''), true);
  assert.equal(gate.shouldRedirectToFabricServerSetup({ ready: true }, '/future-workspace-route', ''), false);
  assert.equal(gate.canRenderFabricWorkspace({ ready: false }, '/accounts', ''), false);
  assert.equal(gate.canRenderFabricWorkspace({ ready: false }, '/server-setup', ''), true);
  assert.equal(gate.canRenderFabricWorkspace({ ready: true }, '/accounts', ''), true);
  assert.deepEqual(gate.resolveFabricProfileGateState([offline, ready], 'cp-ready'), {
    ready: true,
    active: {
      profile: ready,
      profileId: 'cp-ready',
      source: 'stored'
    },
    profileCount: 2
  });
});

test('app applies the profile gate to browser and native clients before mounting workspace pages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/src/app.tsx'), 'utf8');
  assert.match(source, /function enforceServerProfileGate\(\)/u);
  assert.doesNotMatch(source, /function enforceNativeServerProfileGate/u);
  assert.match(source, /menuDataRender:[\s\S]*resolveCurrentServerProfileGate\(\)\.ready/u);
  assert.match(source, /canRenderWorkspace\s*\?\s*children\s*:\s*null/u);
});
