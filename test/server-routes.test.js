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

function loadTypeScriptModule(relativePath) {
  const filename = path.join(__dirname, '..', relativePath);
  const previous = require.extensions['.ts'];
  require.extensions['.ts'] = (mod, childFilename) => {
    mod._compile(compileTypeScript(childFilename), childFilename);
  };
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  try {
    mod._compile(compileTypeScript(filename), filename);
    return mod.exports;
  } finally {
    if (previous) require.extensions['.ts'] = previous;
    else delete require.extensions['.ts'];
  }
}

function loadServerRoutes() {
  return loadTypeScriptModule('web/src/services/server-routes/server-route-service.ts');
}

function loadNativeServerProfileRepository(invoke) {
  const filename = path.join(
    __dirname,
    '../web/src/services/native-server-profile-repository.ts'
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

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('stable Server ids enforce the canonical 2 to 64 character contract without truncation', () => {
  const routes = loadServerRoutes();
  const id63 = `a${'b'.repeat(62)}`;
  const id64 = `a${'b'.repeat(63)}`;
  const id65 = `a${'b'.repeat(64)}`;

  assert.equal(routes.normalizeStableServerId(id63), id63);
  assert.equal(routes.normalizeStableServerId(id64), id64);
  assert.equal(routes.normalizeStableServerId(id65), '');
  assert.equal(routes.normalizeStableServerId('A-server'), '');
  assert.equal(routes.normalizeStableServerId('a server'), '');
  assert.equal(routes.normalizeStableServerId('a'), '');
  assert.match(
    routes.normalizeStableServerId('', 'https://trusted.example.com'),
    /^server-[a-z0-9]+$/u
  );
});

test('route normalization separates configured addresses from verified LAN routes', () => {
  const routes = loadServerRoutes();
  const aws = routes.normalizeServerRoute({
    kind: 'direct-lan',
    endpoint: 'https://ec2.example.com:9527'
  });
  const lan = routes.normalizeServerRoute({
    kind: 'direct-lan',
    endpoint: 'http://192.168.1.20:9527'
  });
  const configured = routes.normalizeServerRoute({
    kind: 'direct',
    endpoint: 'https://server.example.com'
  });

  assert.equal(aws.kind, 'direct');
  assert.equal(lan.kind, 'direct-lan');
  assert.equal(configured.kind, 'direct');
  assert.equal(routes.classifyDirectServerEndpoint('http://127.0.0.1:9527'), 'loopback');
  assert.equal(routes.classifyDirectServerEndpoint('http://192.168.1.20:9527'), 'lan');
  assert.equal(routes.classifyDirectServerEndpoint('https://ec2.example.com:9527'), 'other');
  assert.equal(routes.classifyDirectServerEndpoint('https://fc.example.com:9527'), 'other');
  assert.equal(routes.classifyDirectServerEndpoint('http://[fd00::20]:9527'), 'lan');
});

test('legacy endpoint and broker profiles migrate to one logical server with routes', () => {
  const storage = createStorage({
    'aih:control-plane-profiles:v1': JSON.stringify([
      {
        id: 'cp-local-home',
        name: 'Local Server',
        endpoint: 'https://aws.example.com/v0/fabric/broker/servers/local-home/proxy',
        connectionMode: 'broker-proxy',
        broker: {
          brokerEndpoint: 'https://aws.example.com',
          serverId: 'local-home',
          proxyEndpoint: 'https://aws.example.com/v0/fabric/broker/servers/local-home/proxy'
        },
        managementKey: 'local-management-key',
        managementKeyConfigured: true,
        state: 'ready',
        createdAt: 1,
        updatedAt: 2
      }
    ])
  });
  global.window = { localStorage: storage };
  const profiles = loadTypeScriptModule('web/src/services/control-plane-profiles.ts');

  const [profile] = profiles.listControlPlaneProfiles();
  const persisted = storage.getItem('aih:control-plane-profiles:v1');

  assert.equal(profile.stableServerId, 'local-home');
  assert.equal(profile.authorizationState, 'authorized');
  assert.equal(profile.routes.length, 1);
  assert.equal(profile.routes[0].kind, 'relay-via-server');
  assert.equal(profile.routes[0].endpoint, profile.endpoint);
  assert.equal(profile.activeRouteId, profile.routes[0].id);
  assert.equal((persisted.match(/local-management-key/g) || []).length, 1);
  assert.equal(Object.hasOwn(profile.routes[0], 'managementKey'), false);
  delete global.window;
});

test('legacy direct profiles with different profile ids still merge by endpoint identity', () => {
  const endpoint = 'https://aws.example.com';
  const storage = createStorage({
    'aih:control-plane-profiles:v1': JSON.stringify([
      {
        id: 'legacy-local-id',
        name: 'AWS',
        endpoint,
        state: 'ready',
        managementKey: 'aws-management-key',
        createdAt: 1,
        updatedAt: 2
      },
      {
        id: 'legacy-shared-id',
        name: 'AWS duplicate',
        endpoint,
        state: 'offline',
        createdAt: 1,
        updatedAt: 1
      }
    ])
  });
  global.window = { localStorage: storage };
  const profiles = loadTypeScriptModule('web/src/services/control-plane-profiles.ts');

  const listed = profiles.listControlPlaneProfiles();

  assert.equal(listed.length, 1);
  assert.match(listed[0].stableServerId, /^server-/);
  assert.equal(listed[0].managementKey, 'aws-management-key');
  assert.equal(listed[0].routes.length, 1);
  assert.equal(listed[0].routes[0].kind, 'direct');
  delete global.window;
});

test('saving a second route for the same stable server merges routes and keeps one key', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTypeScriptModule('web/src/services/control-plane-profiles.ts');

  profiles.saveControlPlaneProfile({
    stableServerId: 'local-home',
    name: 'Local Server',
    endpoint: 'http://192.168.1.20:9527',
    managementKey: 'local-management-key',
    routes: [{
      id: 'local-lan',
      kind: 'direct-lan',
      endpoint: 'http://192.168.1.20:9527',
      health: 'healthy',
      rttMs: 8
    }]
  });
  profiles.saveControlPlaneProfile({
    stableServerId: 'local-home',
    name: 'Local Server',
    endpoint: 'https://tokyo.example.com/v0/fabric/broker/servers/local-home/proxy',
    activeRouteId: 'relay-tokyo',
    routes: [{
      id: 'relay-tokyo',
      kind: 'relay-via-server',
      endpoint: 'https://tokyo.example.com/v0/fabric/broker/servers/local-home/proxy',
      viaServerId: 'aws-tokyo',
      health: 'healthy',
      rttMs: 42
    }]
  });

  const listed = profiles.listControlPlaneProfiles();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].stableServerId, 'local-home');
  assert.equal(listed[0].managementKey, 'local-management-key');
  assert.equal(listed[0].routes.length, 2);
  assert.deepEqual(
    listed[0].routes.map((route) => route.kind).sort(),
    ['direct-lan', 'relay-via-server']
  );
  assert.equal(listed[0].endpoint, listed[0].routes.find((route) => route.id === 'relay-tokyo').endpoint);
  delete global.window;
});

test('multiple relay discoveries run concurrently and merge one local server by stable id', async () => {
  const routes = loadServerRoutes();
  const pending = new Map();
  const calls = [];
  const sources = [
    { stableServerId: 'aws-tokyo', endpoint: 'https://tokyo.example.com' },
    { stableServerId: 'aws-singapore', endpoint: 'https://singapore.example.com' }
  ];
  const discoveryPromise = routes.discoverServersAcrossRelays({
    sources,
    existingServers: [{
      stableServerId: 'local-home',
      name: 'Local Server',
      managementKey: 'local-management-key',
      managementKeyConfigured: true,
      authorizationState: 'authorized',
      routes: []
    }],
    discover: (source) => {
      calls.push(source.stableServerId);
      return new Promise((resolve) => pending.set(source.stableServerId, resolve));
    }
  });

  await Promise.resolve();
  assert.deepEqual(calls.sort(), ['aws-singapore', 'aws-tokyo']);
  pending.get('aws-tokyo')({
    servers: [{
      stableServerId: 'local-home',
      name: 'Local Server',
      routes: [{
        kind: 'relay-via-server',
        endpoint: 'https://tokyo.example.com/v0/fabric/broker/servers/local-home/proxy',
        health: 'healthy',
        rttMs: 50
      }]
    }]
  });
  pending.get('aws-singapore')({
    ok: true,
    rpc: 'fabric.broker.servers.list',
    result: {
      servers: [
        {
          stableServerId: 'local-home',
          name: 'Local Server',
          routes: [{
            kind: 'relay',
            path: '/v0/fabric/broker/servers/local-home/proxy',
            health: 'healthy',
            rttMs: 35
          }]
        },
        {
          stableServerId: 'local-lab',
          name: 'Lab Server',
          routes: [{
            kind: 'relay',
            endpoint: 'https://singapore.example.com/v0/fabric/broker/servers/local-lab/proxy',
            health: 'unknown'
          }]
        }
      ]
    }
  });

  const result = await discoveryPromise;
  const home = result.servers.find((server) => server.stableServerId === 'local-home');
  const lab = result.servers.find((server) => server.stableServerId === 'local-lab');

  assert.equal(result.failures.length, 0);
  assert.equal(home.routes.length, 2);
  assert.deepEqual(home.routes.map((route) => route.viaServerId).sort(), ['aws-singapore', 'aws-tokyo']);
  assert.equal(
    home.routes.some((route) => route.endpoint === 'https://singapore.example.com/v0/fabric/broker/servers/local-home/proxy'),
    true
  );
  assert.equal(home.authorizationState, 'authorized');
  assert.equal(home.managementKey, 'local-management-key');
  assert.equal(lab.authorizationState, 'discovered-pending-auth');
  assert.equal(lab.managementKey, '');
});

test('LAN discovery merges direct routes without relay metadata or duplicated keys', async () => {
  const routes = loadServerRoutes();
  let calls = 0;

  const result = await routes.discoverServersOnLan({
    existingServers: [{
      stableServerId: 'local-home',
      name: 'Local Server',
      managementKey: 'local-management-key',
      managementKeyConfigured: true,
      authorizationState: 'authorized',
      routes: [{
        id: 'relay-tokyo',
        kind: 'relay-via-server',
        endpoint: 'https://tokyo.example.com/v0/fabric/broker/servers/local-home/proxy',
        viaServerId: 'aws-tokyo',
        health: 'healthy'
      }]
    }],
    discover: async () => {
      calls += 1;
      return {
        ok: true,
        servers: [
          {
            stableServerId: 'local-home',
            name: 'Local Server',
            online: true,
            routes: [{
              kind: 'direct-lan',
              endpoint: 'http://192.168.1.20:9527',
              viaServerId: 'must-be-removed',
              health: 'healthy'
            }]
          },
          {
            stableServerId: 'local-lab',
            name: 'Lab Server',
            online: true,
            routes: [{
              kind: 'direct-lan',
              endpoint: 'http://192.168.1.30:9527',
              health: 'healthy'
            }]
          }
        ]
      };
    }
  });

  const home = result.servers.find((server) => server.stableServerId === 'local-home');
  const lab = result.servers.find((server) => server.stableServerId === 'local-lab');
  const lanRoute = home.routes.find((route) => route.kind === 'direct-lan');

  assert.equal(calls, 1);
  assert.equal(result.error, '');
  assert.equal(home.routes.length, 2);
  assert.equal(lanRoute.viaServerId, '');
  assert.equal(home.authorizationState, 'authorized');
  assert.equal(home.managementKey, 'local-management-key');
  assert.equal(lab.authorizationState, 'discovered-pending-auth');
  assert.equal(lab.managementKey, '');
});

test('native LAN discovery repository calls one bounded Tauri command without credentials', async (t) => {
  const previousWindow = global.window;
  global.window = { __TAURI_IPC__: () => {} };
  t.after(() => {
    global.window = previousWindow;
  });
  const calls = [];
  const repository = loadNativeServerProfileRepository(async (command, payload) => {
    calls.push({ command, payload });
    return {
      ok: true,
      servers: [{
        stableServerId: 'local-home',
        name: 'Local Server',
        online: true,
        capabilities: ['client-api'],
        routes: [{
          kind: 'direct-lan',
          endpoint: 'http://192.168.1.20:9527',
          health: 'healthy'
        }]
      }]
    };
  });

  const discovered = await repository.discoverNativeServers(2500);

  assert.equal(discovered.servers[0].stableServerId, 'local-home');
  assert.deepEqual(calls, [{
    command: 'desktop_discover_servers',
    payload: { input: { timeoutMs: 2500 } }
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /managementKey|authorization|bearer/i);
});

test('native profile repository shares the complete Tauri runtime detector', (t) => {
  const previousWindow = global.window;
  global.window = { __TAURI_INTERNALS__: {} };
  t.after(() => {
    global.window = previousWindow;
  });
  const repository = loadNativeServerProfileRepository(async () => ({}));
  assert.equal(repository.isNativeDesktopRuntime(), true);
});

test('native LAN trust keeps endpoint decisions inside Rust', async (t) => {
  const previousWindow = global.window;
  global.window = { __TAURI_IPC__: () => {} };
  t.after(() => {
    global.window = previousWindow;
  });
  const calls = [];
  const repository = loadNativeServerProfileRepository(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'desktop_lan_profile_authorize') {
      return { profile: { id: 'local-home', managementKeyConfigured: true } };
    }
    return { ok: true, partial: false, profiles: [] };
  });

  await repository.authorizeNativeLanProfile('local-home', 'm'.repeat(32), 2_500);
  await repository.refreshNativeLanRoutes([' local-home ', 'local-home'], 2_500);

  assert.deepEqual(calls, [
    {
      command: 'desktop_lan_profile_authorize',
      payload: {
        input: {
          profileId: 'local-home',
          managementKey: 'm'.repeat(32),
          timeoutMs: 2500
        }
      }
    },
    {
      command: 'desktop_lan_routes_refresh',
      payload: {
        input: {
          profileIds: ['local-home'],
          timeoutMs: 2500
        }
      }
    }
  ]);
  assert.doesNotMatch(JSON.stringify(calls[1]), /https?:|endpoint|path|authorization|bearer/iu);
});

test('native outbound Server configuration passes only profile ids across IPC', async (t) => {
  const previousWindow = global.window;
  global.window = { __TAURI_IPC__: () => {} };
  t.after(() => {
    global.window = previousWindow;
  });
  const calls = [];
  const repository = loadNativeServerProfileRepository(async (command, payload) => {
    calls.push({ command, payload });
    return { ok: true, config: { relays: [] }, runtime: { running: true, relays: [] } };
  });

  const result = await repository.configureNativeOutboundRelays(
    'local-profile',
    ['aws-tokyo', 'aws-singapore']
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    command: 'desktop_outbound_relays_configure',
    payload: {
      input: {
        localProfileId: 'local-profile',
        relayProfileIds: ['aws-tokyo', 'aws-singapore']
      }
    }
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /managementKey|authorization|bearer/i);
});

test('native FRP route configuration passes only provider and visitor profile ids across IPC', async (t) => {
  const previousWindow = global.window;
  global.window = { __TAURI_IPC__: () => {} };
  t.after(() => {
    global.window = previousWindow;
  });
  const calls = [];
  const repository = loadNativeServerProfileRepository(async (command, payload) => {
    calls.push({ command, payload });
    return {
      ok: true,
      stableServerId: 'server-local-home',
      provider: { profileId: 'local-profile', action: 'restart' },
      visitors: [{ profileId: 'aws-tokyo', action: 'reload', bindPort: 19588 }]
    };
  });

  const result = await repository.configureNativeFrpRoute(
    'local-profile',
    ['aws-tokyo']
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    command: 'desktop_frp_route_configure',
    payload: {
      input: {
        providerProfileId: 'local-profile',
        visitorProfileIds: ['aws-tokyo']
      }
    }
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /managementKey|secretKey|authorization|bearer/i);
});

test('route selection uses health RTT and failure rate with hysteresis and debounce', () => {
  const routes = loadServerRoutes();
  const direct = {
    id: 'lan',
    kind: 'direct-lan',
    endpoint: 'http://192.168.1.20:9527',
    health: 'healthy',
    rttMs: 12,
    failureRate: 0.01,
    consecutiveFailures: 0
  };
  const relay = {
    id: 'relay',
    kind: 'relay-via-server',
    endpoint: 'https://aws.example.com/v0/fabric/broker/servers/local-home/proxy',
    health: 'healthy',
    rttMs: 80,
    failureRate: 0.05,
    consecutiveFailures: 0
  };

  const initial = routes.selectServerRoute([relay, direct], { operation: 'read', now: 0 });
  assert.equal(initial.route.id, 'lan');

  const slightlyBetterRelay = { ...relay, rttMs: 1, failureRate: 0 };
  const heldByHysteresis = routes.selectServerRoute([direct, slightlyBetterRelay], {
    operation: 'read',
    now: 100,
    previous: initial.state,
    stickyMs: 0,
    hysteresisScore: 20,
    debounceMs: 0
  });
  assert.equal(heldByHysteresis.route.id, 'lan');
  assert.equal(heldByHysteresis.reason, 'hysteresis');

  const degradedDirect = { ...direct, health: 'degraded', rttMs: 300, failureRate: 0.4 };
  const debouncing = routes.selectServerRoute([degradedDirect, slightlyBetterRelay], {
    operation: 'read',
    now: 1000,
    previous: initial.state,
    stickyMs: 0,
    hysteresisScore: 5,
    debounceMs: 2000
  });
  assert.equal(debouncing.route.id, 'lan');
  assert.equal(debouncing.reason, 'debouncing');

  const switched = routes.selectServerRoute([degradedDirect, slightlyBetterRelay], {
    operation: 'read',
    now: 3100,
    previous: debouncing.state,
    stickyMs: 0,
    hysteresisScore: 5,
    debounceMs: 2000
  });
  assert.equal(switched.route.id, 'relay');
  assert.equal(switched.switched, true);
});

test('automatic failover is safe for reads and gated for writes and streams', () => {
  const routes = loadServerRoutes();
  const offline = {
    id: 'lan',
    kind: 'direct-lan',
    endpoint: 'http://192.168.1.20:9527',
    health: 'offline'
  };
  const relay = {
    id: 'relay',
    kind: 'relay-via-server',
    endpoint: 'https://aws.example.com/v0/fabric/broker/servers/local-home/proxy',
    health: 'healthy',
    rttMs: 30
  };
  const previous = {
    selectedRouteId: 'lan',
    selectedAt: 1,
    challengerRouteId: '',
    challengerSince: 0
  };

  assert.equal(routes.selectServerRoute([offline, relay], {
    operation: 'read', previous, now: 10
  }).route.id, 'relay');

  const unsafeWrite = routes.selectServerRoute([offline, relay], {
    operation: 'write', previous, now: 10
  });
  assert.equal(unsafeWrite.route, null);
  assert.equal(unsafeWrite.reason, 'unsafe-failover');
  assert.equal(routes.selectServerRoute([offline, relay], {
    operation: 'write', idempotencyKey: 'request-1', previous, now: 10
  }).route.id, 'relay');

  const unsafeStream = routes.selectServerRoute([offline, relay], {
    operation: 'stream', previous, now: 10
  });
  assert.equal(unsafeStream.route, null);
  assert.equal(unsafeStream.reason, 'unsafe-failover');
  assert.equal(routes.selectServerRoute([offline, relay], {
    operation: 'stream', sessionResumeId: 'session-1', previous, now: 10
  }).route.id, 'relay');

  const pinnedStream = routes.selectServerRoute([
    { ...offline, health: 'healthy', rttMs: 100 },
    relay
  ], {
    operation: 'stream',
    sessionResumeId: 'session-1',
    previous,
    now: 60000,
    stickyMs: 0,
    debounceMs: 0,
    hysteresisScore: 0
  });
  assert.equal(pinnedStream.route.id, 'lan');
  assert.equal(pinnedStream.reason, 'session-sticky');
});
