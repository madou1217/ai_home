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

function loadAppNavigationModule() {
  const filename = path.join(__dirname, '../web/src/services/app-navigation.ts');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === './native-server-profile-repository') {
      return { isNativeDesktopRuntime: () => false };
    }
    return originalRequire(request);
  };
  mod._compile(compileTypeScript(filename), filename);
  return mod.exports;
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
    configured: false,
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
    assert.equal(
      gate.shouldRedirectToFabricServerSetup({ ready: false, configured: false }, pathname, ''),
      true,
      pathname
    );
  });
  assert.equal(gate.shouldRedirectToFabricServerSetup({ ready: false, configured: false }, '/server-setup', ''), false);
  assert.equal(gate.shouldRedirectToFabricServerSetup({ ready: false, configured: false }, '/server-setup', '?gate=1'), false);
  assert.equal(gate.shouldRedirectToFabricServerSetup({ ready: false, configured: false }, '/future-workspace-route', ''), true);
  assert.equal(gate.shouldRedirectToFabricServerSetup({ ready: true, configured: true }, '/future-workspace-route', ''), false);
  assert.equal(gate.canRenderFabricWorkspace({ ready: false, configured: false }, '/accounts', ''), false);
  assert.equal(gate.canRenderFabricWorkspace({ ready: false, configured: false }, '/server-setup', ''), true);
  assert.equal(gate.canRenderFabricWorkspace({ ready: true, configured: true }, '/accounts', ''), true);
  assert.deepEqual(gate.resolveFabricProfileGateState([offline, ready], 'cp-ready'), {
    ready: true,
    configured: true,
    active: {
      profile: ready,
      profileId: 'cp-ready',
      source: 'stored'
    },
    profileCount: 2
  });
});

test('client profile gate does not kick configured clients on a stale persisted health state', () => {
  const gate = loadFabricProfileGateModule();
  // 回归：上一轮会话的异步刷新把 state 落盘成 degraded/offline 后，
  // 全量刷新时 gate 不得在重校验前把已配置 Key 的客户端踢回 /server-setup。
  const staleDegraded = createProfile('cp-stale', {
    state: 'degraded',
    managementKey: 'management-key',
    lastError: 'http_503'
  });
  const staleOffline = createProfile('cp-stale-offline', {
    state: 'offline',
    managementKey: 'management-key'
  });

  for (const stale of [staleDegraded, staleOffline]) {
    const state = gate.resolveFabricProfileGateState([stale], stale.id);
    assert.equal(state.ready, false, stale.id);
    assert.equal(state.configured, true, stale.id);
    assert.equal(gate.shouldRedirectToFabricServerSetup(state, '/chat', ''), false, stale.id);
    assert.equal(gate.canRenderFabricWorkspace(state, '/accounts', ''), true, stale.id);
  }

  // 未配置 Key 的 profile 仍然是真正的 setup 未完成，必须继续拦到 /server-setup。
  const keyless = createProfile('cp-keyless', { state: 'offline' });
  const keylessState = gate.resolveFabricProfileGateState([keyless], 'cp-keyless');
  assert.equal(keylessState.configured, false);
  assert.equal(gate.shouldRedirectToFabricServerSetup(keylessState, '/chat', ''), true);
});

test('app applies the profile gate to browser and native clients before mounting workspace pages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/src/app.tsx'), 'utf8');
  assert.match(source, /function enforceServerProfileGate\(\)/u);
  assert.doesNotMatch(source, /function enforceNativeServerProfileGate/u);
  assert.match(source, /menuDataRender:[\s\S]*resolveCurrentServerProfileGate\(\)\.configured/u);
  assert.match(source, /canRenderWorkspace\s*\?\s*children\s*:\s*null/u);
  assert.match(source, /const canRenderDataPlane = isGoAccountsPreview \|\| profileGate\.ready/u);
  assert.match(source, /canRenderDataPlane && <AppInstallTaskQueue \/>/u);
  assert.match(
    source,
    /pathname:\s*resolveAppRoutePathname\(history\.location\.pathname\)/u,
    'explicit Server navigation must strip the browser /ui base before Umi history.replace'
  );
});

test('Settings Toolkit navigation keeps the browser UI prefix', () => {
  const navigation = loadAppNavigationModule();
  assert.equal(navigation.buildAppHref('/toolkit'), '/ui/toolkit');
  assert.equal(
    navigation.buildServerScopedAppHref('/toolkit', 'cp-aws', 'tab=tools'),
    '/ui/toolkit?tab=tools&server=cp-aws'
  );
  assert.equal(navigation.resolveAppRoutePathname('/ui/toolkit'), '/toolkit');

  const settingsSource = fs.readFileSync(path.join(__dirname, '../web/src/pages/Settings.tsx'), 'utf8');
  const routesSource = fs.readFileSync(path.join(__dirname, '../web/config/routes.ts'), 'utf8');
  assert.match(settingsSource, /buildAppHref\(['"]\/toolkit['"]\)/u);
  assert.match(routesSource, /path:\s*["']\/toolkit["']/u);
});
