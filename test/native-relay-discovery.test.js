'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('../web/node_modules/typescript');

const projectRoot = path.join(__dirname, '..');

function compileTypeScript(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
}

function loadNativeRelayDiscovery(dependencies) {
  const filename = path.join(
    projectRoot,
    'web',
    'src',
    'services',
    'server-routes',
    'native-relay-discovery.ts'
  );
  const previousTsLoader = require.extensions['.ts'];
  require.extensions['.ts'] = (mod, moduleFilename) => {
    mod._compile(compileTypeScript(moduleFilename), moduleFilename);
  };
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === '../control-plane-profiles') {
      return {
        listControlPlaneProfiles: dependencies.listControlPlaneProfiles,
        saveControlPlaneProfileSecure: dependencies.saveControlPlaneProfileSecure
      };
    }
    if (request === '../native-server-transport') {
      return { requestNativeServerJson: dependencies.requestNativeServerJson };
    }
    if (request === '../native-server-profile-repository') {
      return { trustNativeRelayRoute: dependencies.trustNativeRelayRoute };
    }
    return originalRequire(request);
  };
  try {
    mod._compile(compileTypeScript(filename), filename);
    return mod.exports;
  } finally {
    if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
    else delete require.extensions['.ts'];
  }
}

function loadNativeServerProfileRepository(invoke) {
  const filename = path.join(
    projectRoot,
    'web',
    'src',
    'services',
    'native-server-profile-repository.ts'
  );
  const previousTsLoader = require.extensions['.ts'];
  require.extensions['.ts'] = (mod, childFilename) => {
    mod._compile(compileTypeScript(childFilename), childFilename);
  };
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => request === '@tauri-apps/api/tauri'
    ? { invoke }
    : originalRequire(request);
  try {
    mod._compile(compileTypeScript(filename), filename);
    return mod.exports;
  } finally {
    if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
    else delete require.extensions['.ts'];
  }
}

function profile(input) {
  return {
    id: input.id,
    stableServerId: input.stableServerId,
    name: input.name || input.stableServerId,
    endpoint: input.endpoint,
    routes: input.routes || [{
      id: `route-${input.id}`,
      kind: 'direct-lan',
      endpoint: input.endpoint,
      viaServerId: '',
      health: 'healthy'
    }],
    activeRouteId: `route-${input.id}`,
    authorizationState: input.managementKeyConfigured === false
      ? 'discovered-pending-auth'
      : 'authorized',
    managementKey: '',
    credentialRef: input.credentialRef || `profile:${input.id}`,
    managementKeyConfigured: input.managementKeyConfigured !== false,
    state: input.managementKeyConfigured === false ? 'offline' : 'ready'
  };
}

test('Desktop relay discovery queries every authorized profile concurrently through native profile ids', async () => {
  const profiles = [
    profile({
      id: 'profile-tokyo',
      stableServerId: 'aws-tokyo',
      endpoint: 'https://tokyo.example.com'
    }),
    profile({
      id: 'profile-singapore',
      stableServerId: 'aws-singapore',
      endpoint: 'https://singapore.example.com'
    }),
    profile({
      id: 'profile-local',
      stableServerId: 'local-home',
      endpoint: 'http://192.168.1.20:9527',
      credentialRef: 'profile:local-home'
    }),
    profile({
      id: 'profile-pending',
      stableServerId: 'pending-server',
      endpoint: 'https://pending.example.com',
      managementKeyConfigured: false
    })
  ];
  const requests = [];
  const pending = new Map();
  const saves = [];
  const trustedRoutes = [];
  const discovery = loadNativeRelayDiscovery({
    listControlPlaneProfiles: () => profiles,
    saveControlPlaneProfileSecure: async (input) => {
      saves.push(input);
      return input;
    },
    requestNativeServerJson: (input) => {
      requests.push(input);
      return new Promise((resolve, reject) => {
        pending.set(input.profileId, { resolve, reject });
      });
    },
    trustNativeRelayRoute: async (...args) => {
      trustedRoutes.push(args);
      return { trusted: true, routeId: 'relay-profile-tokyo', kind: 'relay-via-server' };
    }
  });

  const resultPromise = discovery.discoverNativeServersAcrossRelays({ timeoutMs: 1_500 });
  await Promise.resolve();

  assert.deepEqual(
    requests.map((request) => request.profileId).sort(),
    ['profile-local', 'profile-singapore', 'profile-tokyo']
  );
  assert.equal(requests.every((request) => (
    request.method === 'GET'
      && request.path === '/v0/fabric/broker/servers'
      && request.timeoutMs === 1_500
      && request.signal instanceof AbortSignal
  )), true);
  assert.doesNotMatch(JSON.stringify(requests), /managementKey|authorization|bearer/iu);

  pending.get('profile-tokyo').resolve({
    status: 200,
    data: {
      ok: true,
      result: {
        servers: [
          {
            stableServerId: 'local-home',
            name: 'Home Server',
            online: true,
            routes: [{
              kind: 'relay',
              path: '/v0/fabric/broker/servers/local-home/proxy'
            }]
          },
          {
            stableServerId: 'local-lab',
            name: 'Lab Server',
            online: true,
            routes: [{
              kind: 'relay',
              path: '/v0/fabric/broker/servers/local-lab/proxy'
            }]
          }
        ]
      }
    }
  });
  pending.get('profile-singapore').reject(new Error('aws_unreachable'));
  pending.get('profile-local').resolve({ status: 200, data: { ok: true, result: { servers: [] } } });

  const result = await resultPromise;
  const home = saves.find((input) => input.stableServerId === 'local-home');
  const lab = saves.find((input) => input.stableServerId === 'local-lab');

  assert.equal(result.queried, 3);
  assert.equal(result.saved, 2);
  assert.equal(result.trusted, 1);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(trustedRoutes, [[
    'profile-tokyo',
    'profile-local',
    'local-home'
  ]]);
  assert.doesNotMatch(JSON.stringify(trustedRoutes), /https?:|managementKey|authorization|bearer/iu);
  assert.equal(home.managementKeyConfigured, true);
  assert.equal(home.credentialRef, 'profile:local-home');
  assert.equal(home.authorizationState, 'authorized');
  assert.equal(
    home.routes.some((route) => (
      route.endpoint === 'https://tokyo.example.com/v0/fabric/broker/servers/local-home/proxy'
    )),
    true
  );
  assert.equal(lab.managementKeyConfigured, false);
  assert.equal(lab.authorizationState, 'discovered-pending-auth');
  assert.equal(
    lab.routes[0].endpoint,
    'https://tokyo.example.com/v0/fabric/broker/servers/local-lab/proxy'
  );
});

test('one stalled AWS directory reaches its finite budget without blocking successful peers', async () => {
  const profiles = [
    profile({
      id: 'profile-fast',
      stableServerId: 'aws-fast',
      endpoint: 'https://fast.example.com'
    }),
    profile({
      id: 'profile-stalled',
      stableServerId: 'aws-stalled',
      endpoint: 'https://stalled.example.com'
    })
  ];
  const saves = [];
  let stalledTimeoutMs = 0;
  const discovery = loadNativeRelayDiscovery({
    listControlPlaneProfiles: () => profiles,
    saveControlPlaneProfileSecure: async (input) => {
      saves.push(input);
      return input;
    },
    requestNativeServerJson: async ({ profileId, timeoutMs }) => {
      if (profileId === 'profile-stalled') {
        stalledTimeoutMs = timeoutMs;
        return new Promise(() => {});
      }
      return {
        status: 200,
        data: {
          result: {
            servers: [{
              stableServerId: 'reachable-home',
              name: 'Reachable Home',
              routes: [{
                kind: 'relay',
                path: '/v0/fabric/broker/servers/reachable-home/proxy'
              }]
            }]
          }
        }
      };
    },
    trustNativeRelayRoute: async () => {
      throw new Error('pending targets must not register trusted routes');
    }
  });

  const startedAt = Date.now();
  const result = await discovery.discoverNativeServersAcrossRelays({ timeoutMs: 40 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(stalledTimeoutMs, 1000);
  assert.ok(elapsedMs >= 900 && elapsedMs < 1600);
  assert.equal(result.saved, 1);
  assert.equal(result.trusted, 0);
  assert.equal(saves[0].stableServerId, 'reachable-home');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].source.stableServerId, 'aws-stalled');
  assert.equal(result.failures[0].error, 'relay_directory_timeout');
});

test('native trusted relay registration passes only source and target identities across IPC', async (t) => {
  const previousWindow = global.window;
  global.window = { __TAURI_IPC__: () => {} };
  t.after(() => {
    global.window = previousWindow;
  });
  const calls = [];
  const repository = loadNativeServerProfileRepository(async (command, payload) => {
    calls.push({ command, payload });
    return {
      trusted: true,
      routeId: 'relay-profile-tokyo',
      kind: 'relay-via-server'
    };
  });

  const result = await repository.trustNativeRelayRoute(
    'profile-tokyo',
    'profile-local',
    'local-home'
  );

  assert.equal(result.trusted, true);
  assert.deepEqual(calls, [{
    command: 'desktop_relay_route_trust',
    payload: {
      input: {
        sourceProfileId: 'profile-tokyo',
        targetProfileId: 'profile-local',
        targetStableServerId: 'local-home'
      }
    }
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /https?:|managementKey|authorization|bearer|path/iu);
});

test('Desktop startup schedules relay discovery without awaiting it and Settings observes profile updates', () => {
  const appSource = fs.readFileSync(path.join(projectRoot, 'web', 'src', 'app.tsx'), 'utf8');
  const settingsSource = fs.readFileSync(
    path.join(projectRoot, 'web', 'src', 'pages', 'Settings.tsx'),
    'utf8'
  );

  assert.match(appSource, /startNativeRelayDiscovery\(\{\s*profiles:\s*native\.profiles\s*\}\);/u);
  assert.doesNotMatch(appSource, /await\s+startNativeRelayDiscovery/u);
  assert.match(appSource, /startNativeLanRouteRefresh\(\);/u);
  assert.doesNotMatch(appSource, /await\s+startNativeLanRouteRefresh/u);
  assert.match(settingsSource, /addControlPlaneProfilesChangeListener\(/u);
});
