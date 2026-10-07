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

function loadTypeScriptModule(relativePath) {
  const filename = path.join(__dirname, relativePath);
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

function loadPresentationModule() {
  return loadTypeScriptModule('../web/src/services/server-route-presentation.ts');
}

function createRoute(overrides = {}) {
  return {
    id: 'lan-home',
    kind: 'direct-lan',
    endpoint: 'http://192.168.1.20:9527',
    viaServerId: '',
    health: 'healthy',
    rttMs: 8,
    failureRate: 0,
    consecutiveFailures: 0,
    lastCheckedAt: 100,
    lastSuccessAt: 100,
    lastFailureAt: 0,
    updatedAt: 100,
    ...overrides
  };
}

function createProfile(overrides = {}) {
  const routes = overrides.routes || [createRoute()];
  return {
    id: 'cp-local-home',
    stableServerId: 'local-home',
    name: 'Local Server',
    endpoint: routes[0].endpoint,
    routes,
    activeRouteId: routes[0].id,
    authorizationState: 'authorized',
    connectionMode: 'direct',
    broker: null,
    state: 'ready',
    managementKey: '',
    credentialRef: 'keychain://local-home',
    managementKeyConfigured: true,
    nodes: [],
    nodeCount: 0,
    accountCount: 2,
    activeAccountCount: 2,
    schedulableAccountCount: 2,
    sessionCount: 3,
    lastNodeSyncAt: 0,
    lastStatusSyncAt: 100,
    lastAccountsSyncAt: 100,
    lastSessionsSyncAt: 100,
    descriptor: null,
    lastCheckedAt: 100,
    lastError: '',
    createdAt: 1,
    updatedAt: 100,
    ...overrides
  };
}

test('server route rows merge duplicate stable server ids and mark the configured Server address', () => {
  const presentation = loadPresentationModule();
  const lan = createRoute();
  const relay = createRoute({
    id: 'relay-tokyo',
    kind: 'relay-via-server',
    endpoint: 'https://tokyo.example.com/v0/fabric/broker/servers/local-home/proxy',
    viaServerId: 'aws-tokyo',
    rttMs: 42
  });
  const frp = createRoute({
    id: 'frp-home',
    kind: 'frp',
    endpoint: 'http://127.0.0.1:19527',
    health: 'degraded',
    rttMs: 66
  });

  const rows = presentation.buildServerRouteRows([
    createProfile({ routes: [lan, relay], activeRouteId: lan.id }),
    createProfile({
      id: 'legacy-duplicate',
      routes: [lan, frp],
      activeRouteId: lan.id,
      updatedAt: 90
    })
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableServerId, 'local-home');
  assert.equal(rows[0].routes.length, 3);
  assert.equal(rows[0].routes[0].id, 'lan-home');
  assert.equal(rows[0].routes[0].roleLabel, 'Server 地址');
  assert.equal(rows[0].routes[0].kindLabel, '局域网直连');
  assert.equal(rows[0].routes[0].healthLabel, '正常');
  assert.equal(rows[0].routes[0].rttLabel, '8 ms');
  assert.deepEqual(
    rows[0].routes.slice(1).map((route) => route.roleLabel),
    ['可用路径', '可用路径']
  );
  assert.equal(rows[0].routes.find((route) => route.id === 'relay-tokyo').kindLabel, '经 Server 中转');
  assert.equal(rows[0].routes.find((route) => route.id === 'relay-tokyo').endpointLabel, 'https://tokyo.example.com');
  assert.doesNotMatch(rows[0].routes.find((route) => route.id === 'relay-tokyo').endpointLabel, /broker/iu);
  assert.equal(rows[0].routes.find((route) => route.id === 'frp-home').kindLabel, 'FRP 隧道');
});

test('public and loopback Server addresses are never mislabeled as LAN routes', () => {
  const presentation = loadPresentationModule();
  const publicRoute = createRoute({
    id: 'aws-direct',
    kind: 'direct-lan',
    endpoint: 'https://ec2.example.com:9527'
  });
  const loopbackRoute = createRoute({
    id: 'local-direct',
    kind: 'direct',
    endpoint: 'http://127.0.0.1:9527'
  });
  const rows = presentation.buildServerRouteRows([
    createProfile({
      id: 'aws',
      stableServerId: 'server-aws',
      name: 'AWS',
      endpoint: publicRoute.endpoint,
      routes: [publicRoute],
      activeRouteId: publicRoute.id
    }),
    createProfile({
      id: 'local',
      stableServerId: 'server-local',
      name: 'Local',
      endpoint: loopbackRoute.endpoint,
      routes: [loopbackRoute],
      activeRouteId: loopbackRoute.id
    })
  ]);
  const aws = rows.find((row) => row.stableServerId === 'server-aws');
  const local = rows.find((row) => row.stableServerId === 'server-local');

  assert.equal(aws.routes[0].kindLabel, '直接连接');
  assert.equal(aws.routes[0].roleLabel, 'Server 地址');
  assert.equal(local.routes[0].kindLabel, '本机直连');
  assert.doesNotMatch(JSON.stringify(rows), /当前路径/u);
});

test('pending authorization and unknown route health use explicit user-facing labels', () => {
  const presentation = loadPresentationModule();
  const profile = createProfile({
    stableServerId: 'local-lab',
    managementKeyConfigured: false,
    credentialRef: '',
    authorizationState: 'discovered-pending-auth',
    state: 'offline',
    routes: [createRoute({ health: 'unknown', rttMs: 0 })]
  });

  const [row] = presentation.buildServerRouteRows([profile]);

  assert.equal(row.authorizationPending, true);
  assert.equal(row.authorizationLabel, '已发现，待授权');
  assert.equal(row.routes[0].healthLabel, '未检测');
  assert.equal(row.routes[0].rttLabel, '未测速');
});

test('Server management UI wires stable logical server rows', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../web/src/pages/Settings.tsx'),
    'utf8'
  );
  const serverListSource = fs.readFileSync(
    path.join(__dirname, '../web/src/components/settings/ControlPlaneServerList.tsx'),
    'utf8'
  );

  assert.match(source, /buildServerRouteRows/u);
  assert.match(source, /connectControlPlaneProfile/u);
  assert.match(source, /<ControlPlaneServerList[\s\S]*rows=\{serverRouteRows\}/u);
  assert.match(source, /onAuthorize=\{openDiscoveredServerAuthorization\}/u);
  assert.match(serverListSource, /key=\{row\.stableServerId\}/u);
  assert.match(serverListSource, /authorizationPending[\s\S]*授权/u);
  assert.match(serverListSource, /buildServerScopedAppHref\(['"]\/dashboard['"],\s*profile\.id\)/u);
  assert.match(serverListSource, /target=["']_blank["']/u);
  assert.match(serverListSource, />\s*打开\s*</u);
  assert.match(serverListSource, />\s*设为默认\s*</u);
});

test('initial Server setup exposes only Server URL and Management Key', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../web/src/pages/FabricServerSetup.tsx'),
    'utf8'
  );

  assert.match(source, /Server 网关地址/u);
  assert.match(source, /Management Key/u);
  assert.doesNotMatch(source, /Broker Proxy|Broker Endpoint|Proxy Endpoint/u);
  assert.doesNotMatch(source, /name="brokerEndpoint"|name="brokerServerId"|name="connectionMode"/u);
});
