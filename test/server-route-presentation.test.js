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

function loadPublicEntryModule() {
  return loadTypeScriptModule('../web/src/services/public-server-entry.ts');
}

function readServerManagementUiSource() {
  return [
    '../web/src/pages/Settings.tsx',
    '../web/src/components/settings/PublicServerEntryCard.tsx'
  ].map((relativePath) => fs.readFileSync(path.join(__dirname, relativePath), 'utf8')).join('\n');
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

test('LAN discovery save inputs preserve credential metadata without copying key material', () => {
  const presentation = loadPresentationModule();
  const relay = createRoute({
    id: 'relay-tokyo',
    kind: 'relay-via-server',
    endpoint: 'https://tokyo.example.com/v0/fabric/broker/servers/local-home/proxy',
    viaServerId: 'aws-tokyo',
    rttMs: 42
  });
  const existing = createProfile({
    endpoint: relay.endpoint,
    routes: [relay],
    activeRouteId: relay.id,
    managementKey: 'must-not-be-copied'
  });
  const discovered = {
    stableServerId: 'local-home',
    name: 'Local Server',
    managementKey: 'must-not-be-copied',
    credentialRef: existing.credentialRef,
    managementKeyConfigured: true,
    authorizationState: 'authorized',
    routes: [relay, createRoute()]
  };

  const inputs = presentation.buildLanDiscoveryProfileInputs(
    [existing],
    [discovered],
    ['local-home']
  );

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].stableServerId, 'local-home');
  assert.equal(inputs[0].activeRouteId, 'relay-tokyo');
  assert.equal(inputs[0].endpoint, relay.endpoint);
  assert.equal(inputs[0].credentialRef, 'keychain://local-home');
  assert.equal(inputs[0].managementKeyConfigured, true);
  assert.equal(Object.hasOwn(inputs[0], 'managementKey'), false);
  assert.equal(inputs[0].routes.length, 2);
});

test('Server management UI wires native LAN discovery and stable logical server rows', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../web/src/pages/Settings.tsx'),
    'utf8'
  );
  const connectionSource = fs.readFileSync(
    path.join(__dirname, '../web/src/services/control-plane-profile-connection.ts'),
    'utf8'
  );

  assert.match(source, /discoverNativeServers/u);
  assert.match(source, /discoverServersOnLan/u);
  assert.match(source, /buildLanDiscoveryProfileInputs/u);
  assert.match(source, /buildServerRouteRows/u);
  assert.match(source, /connectControlPlaneProfile/u);
  assert.match(connectionSource, /authorizeLanProfile\(existing\.id,\s*managementKey\)/u);
  assert.match(source, /refreshNativeLanRoutes\(authorizedProfileIds\)/u);
  assert.match(connectionSource, /endpoint\s*!==\s*existing\.endpoint/u);
  assert.match(source, /isNativeDesktopRuntime\(\)\s*&&[\s\S]*发现局域网 Server/u);
  assert.match(source, /dataSource=\{serverRouteRows\}/u);
  assert.match(source, /rowKey="stableServerId"/u);
  assert.match(source, /authorizationPending[\s\S]*授权/u);
});

test('public Server selection requires one authorized local Server and one to five distinct peers', () => {
  const presentation = loadPublicEntryModule();
  const local = createProfile({ id: 'local-profile', stableServerId: 'local-home' });
  const tokyo = createProfile({
    id: 'aws-tokyo',
    stableServerId: 'aws-tokyo',
    name: 'Tokyo',
    endpoint: 'https://tokyo.example.com',
    routes: [createRoute({ id: 'tokyo-direct', endpoint: 'https://tokyo.example.com' })],
    activeRouteId: 'tokyo-direct'
  });
  const singapore = createProfile({
    id: 'aws-singapore',
    stableServerId: 'aws-singapore',
    name: 'Singapore',
    endpoint: 'https://singapore.example.com',
    routes: [createRoute({ id: 'singapore-direct', endpoint: 'https://singapore.example.com' })],
    activeRouteId: 'singapore-direct'
  });
  const pending = createProfile({
    id: 'aws-pending',
    stableServerId: 'aws-pending',
    managementKeyConfigured: false,
    authorizationState: 'discovered-pending-auth'
  });
  const profiles = [local, tokyo, singapore, pending];

  assert.equal(
    presentation.validatePublicServerSelection(profiles, '', ['aws-tokyo', 'aws-singapore']).message,
    '请选择需要外网访问的 Server'
  );
  assert.equal(
    presentation.validatePublicServerSelection(profiles, 'local-profile', []).message,
    '请选择 1 至 5 个公网 Server'
  );
  assert.equal(
    presentation.validatePublicServerSelection(
      profiles,
      'local-profile',
      ['aws-tokyo', 'aws-singapore', 'aws-pending', 'missing', 'fifth', 'sixth']
    ).message,
    '请选择 1 至 5 个公网 Server'
  );
  assert.equal(
    presentation.validatePublicServerSelection(profiles, 'local-profile', ['local-profile', 'aws-tokyo']).message,
    '需要外网访问的 Server 不能同时作为公网 Server'
  );
  assert.equal(
    presentation.validatePublicServerSelection(profiles, 'local-profile', ['aws-tokyo', 'aws-tokyo']).message,
    '公网 Server 不能重复选择'
  );
  assert.equal(
    presentation.validatePublicServerSelection(profiles, 'local-profile', ['aws-tokyo', 'aws-pending']).message,
    '所选 Server 均需先配置 Management Key'
  );

  const valid = presentation.validatePublicServerSelection(
    profiles,
    'local-profile',
    ['aws-tokyo']
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.localProfile.id, 'local-profile');
  assert.deepEqual(valid.publicProfiles.map((profile) => profile.id), ['aws-tokyo']);
});

test('public Server status rows expose connection and retry diagnostics without internal transport terms', () => {
  const presentation = loadPublicEntryModule();
  const tokyo = createProfile({
    id: 'aws-tokyo',
    stableServerId: 'aws-tokyo',
    name: 'Tokyo',
    endpoint: 'https://tokyo.example.com',
    routes: [createRoute({ id: 'tokyo-direct', endpoint: 'https://tokyo.example.com' })]
  });
  const singapore = createProfile({
    id: 'aws-singapore',
    stableServerId: 'aws-singapore',
    name: 'Singapore',
    endpoint: 'https://singapore.example.com',
    routes: [createRoute({ id: 'singapore-direct', endpoint: 'https://singapore.example.com' })]
  });

  const rows = presentation.buildPublicServerStatusRows([tokyo, singapore], {
    ok: true,
    runtime: {
      running: true,
      relays: [{
        endpoint: 'https://tokyo.example.com',
        status: 'online',
        attempts: 1,
        retryDelayMs: 0,
        lastError: ''
      }, {
        endpoint: 'https://singapore.example.com',
        status: 'waiting',
        attempts: 3,
        retryDelayMs: 1500,
        lastError: 'connection_timeout'
      }]
    }
  });

  assert.deepEqual(rows.map((row) => row.statusLabel), ['已连接', '等待重试']);
  assert.equal(rows[1].retryLabel, '2 秒后重试');
  assert.equal(rows[1].lastError, 'connection_timeout');
  assert.doesNotMatch(JSON.stringify(rows), /broker|control.?plane|node/iu);
});

test('Server management UI configures public entry using profile ids only', () => {
  const source = readServerManagementUiSource();

  assert.match(source, /configureNativeOutboundRelays/u);
  assert.match(source, /公网入口/u);
  assert.match(source, /需要外网访问的 Server/u);
  assert.match(source, /公网 Server（1–5 个）/u);
  assert.match(source, /configureNativeOutboundRelays\([\s\S]*\.id[\s\S]*\.map\(\(profile\) => profile\.id\)/u);
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

test('FRP public entry selection requires one to five authorized peers and rejects self selection', () => {
  const presentation = loadPublicEntryModule();
  const local = createProfile({ id: 'local-profile', stableServerId: 'local-home' });
  const tokyo = createProfile({ id: 'aws-tokyo', stableServerId: 'aws-tokyo', name: 'Tokyo' });
  const pending = createProfile({
    id: 'aws-pending',
    stableServerId: 'aws-pending',
    managementKeyConfigured: false,
    authorizationState: 'discovered-pending-auth'
  });
  const profiles = [local, tokyo, pending];

  assert.equal(
    presentation.validateFrpPublicServerSelection(profiles, 'local-profile', []).message,
    '请选择 1 至 5 个已配置 frpc 的公网 Server'
  );
  assert.equal(
    presentation.validateFrpPublicServerSelection(
      profiles,
      'local-profile',
      ['aws-tokyo', 'two', 'three', 'four', 'five', 'six']
    ).message,
    '请选择 1 至 5 个已配置 frpc 的公网 Server'
  );
  assert.equal(
    presentation.validateFrpPublicServerSelection(profiles, 'local-profile', ['local-profile']).message,
    '需要外网访问的 Server 不能同时作为公网 Server'
  );
  assert.equal(
    presentation.validateFrpPublicServerSelection(profiles, 'local-profile', ['aws-pending']).message,
    '所选 Server 均需先配置 Management Key'
  );

  const valid = presentation.validateFrpPublicServerSelection(
    profiles,
    'local-profile',
    ['aws-tokyo']
  );
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.publicProfiles.map((profile) => profile.id), ['aws-tokyo']);
});

test('FRP public entry status rows expose per-Server readiness without leaking internal details', () => {
  const presentation = loadPublicEntryModule();
  const tokyo = createProfile({ id: 'aws-tokyo', stableServerId: 'aws-tokyo', name: 'Tokyo' });
  const singapore = createProfile({ id: 'aws-singapore', stableServerId: 'aws-singapore', name: 'Singapore' });

  const rows = presentation.buildFrpPublicServerStatusRows([tokyo, singapore], {
    ok: true,
    partial: true,
    stableServerId: 'local-home',
    provider: { profileId: 'local-profile', action: 'reload' },
    visitors: [{
      profileId: 'aws-tokyo',
      action: 'reload',
      bindPort: 19588,
      status: 'ready',
      lastError: ''
    }, {
      profileId: 'aws-singapore',
      action: 'reload',
      bindPort: 19589,
      status: 'failed',
      lastError: 'frp_descriptor_identity_mismatch'
    }]
  });

  assert.deepEqual(rows.map((row) => row.statusLabel), ['已连通', '连接失败']);
  assert.equal(rows[0].bindPortLabel, '本机端口 19588');
  assert.equal(rows[1].bindPortLabel, '本机端口 19589');
  assert.equal(rows[0].lastError, '');
  assert.equal(rows[1].lastError, '连接到了其他 Server');
  assert.doesNotMatch(JSON.stringify(rows), /stcp|provider|visitor|secret|frp_descriptor/iu);
});

test('Server management UI configures the no-new-port path using profile ids only', () => {
  const source = readServerManagementUiSource();

  assert.match(source, /configureNativeFrpRoute/u);
  assert.match(source, /复用现有 FRP 连接，无需新增端口/u);
  assert.match(source, /同一 FRPS/u);
  assert.match(source, /已配置 frpc 的公网 Server（1–5 个）/u);
  assert.match(source, /configureNativeFrpRoute\([\s\S]*\.id[\s\S]*\.map\(\(profile\) => profile\.id\)/u);
  assert.doesNotMatch(source, />[^<{]*(?:STCP|Provider|Visitor|secret)[^<{]*</iu);
});
