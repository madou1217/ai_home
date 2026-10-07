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
