const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function loadControlPlaneProfilesModule() {
  const filename = path.join(__dirname, '../web/src/services/control-plane-profiles.ts');
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

function createStorage() {
  const values = new Map();
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

function createStorageEvent(key, oldValue, newValue) {
  const event = new Event('storage');
  Object.defineProperties(event, {
    key: { value: key },
    oldValue: { value: oldValue },
    newValue: { value: newValue }
  });
  return event;
}

function createDescriptor(endpoint = 'https://control.example.com') {
  return {
    ok: true,
    service: 'aih-control-plane',
    protocolVersion: 1,
    endpoint,
    host: 'control.example.com',
    port: 443,
    serverTime: '2026-06-19T00:00:00.000Z',
    uptimeSec: 10,
    auth: {
      managementKeyConfigured: true,
      clientKeyConfigured: false
    },
    capabilities: {
      nodeRpc: ['descriptor', 'device-profile', 'device-status', 'device-accounts', 'device-sessions', 'device-node-sessions', 'device-nodes'],
      management: ['status'],
      remoteManagement: true,
      remoteInvite: true,
      devicePairing: true,
      transports: ['direct', 'frp']
    }
  };
}

test('control plane profiles auto-seed current WebUI origin as local profile', () => {
  const eventTarget = new EventTarget();
  global.window = Object.assign(eventTarget, {
    localStorage: createStorage(),
    location: { origin: 'http://192.168.3.181:9527' }
  });
  const profiles = loadControlPlaneProfilesModule();

  const saved = profiles.listControlPlaneProfiles();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, '当前 Control Plane');
  assert.equal(saved[0].endpoint, 'http://192.168.3.181:9527');
  assert.equal(saved[0].state, 'discovered');
  assert.equal(saved[0].authState, 'unpaired');
  assert.equal(saved[0].deviceToken, '');
  assert.equal(profiles.listControlPlaneProfiles().length, 1);
  delete global.window;
});

test('control plane profiles notify same-window and storage listeners', () => {
  const eventTarget = new EventTarget();
  global.window = Object.assign(eventTarget, { localStorage: createStorage() });
  const profiles = loadControlPlaneProfilesModule();
  const events = [];
  const unsubscribe = profiles.addControlPlaneProfilesChangeListener((detail) => {
    events.push(detail);
  });

  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://home.example.com',
    descriptor: createDescriptor('https://home.example.com'),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'home-token'
  });
  profiles.saveControlPlaneProfile({
    endpoint: saved.endpoint,
    descriptor: saved.descriptor,
    state: 'paired',
    authState: 'paired',
    deviceToken: 'home-token',
    lastError: 'device_state_sync_failed'
  });
  eventTarget.dispatchEvent(createStorageEvent(
    profiles.CONTROL_PLANE_PROFILES_CHANGED_EVENT,
    JSON.stringify([{ id: 'ignored-old' }]),
    JSON.stringify([{ id: 'ignored-new' }])
  ));
  eventTarget.dispatchEvent(createStorageEvent(
    'aih:control-plane-profiles:v1',
    JSON.stringify([{ id: saved.id }]),
    JSON.stringify([{ id: 'cp-office' }])
  ));
  profiles.removeControlPlaneProfile(saved.id);
  unsubscribe();
  profiles.saveControlPlaneProfile({
    endpoint: 'https://lab.example.com',
    descriptor: createDescriptor('https://lab.example.com')
  });

  assert.deepEqual(events, [
    { profileIds: [saved.id], previousProfileIds: [] },
    { profileIds: [saved.id], previousProfileIds: [saved.id] },
    { profileIds: ['cp-office'], previousProfileIds: [saved.id] },
    { profileIds: [], previousProfileIds: [saved.id] }
  ]);
  delete global.window;
});

test('control plane profiles bootstrap ready profiles from shared local server store', async () => {
  const eventTarget = new EventTarget();
  const storage = createStorage();
  const sharedProfile = {
    id: 'cp-aws',
    name: 'AWS Current',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    connectionMode: 'direct',
    broker: null,
    state: 'paired',
    authState: 'paired',
    deviceToken: 'device-token',
    nodes: [],
    nodeCount: 1,
    accountCount: 0,
    activeAccountCount: 0,
    schedulableAccountCount: 0,
    sessionCount: 0,
    lastDeviceSyncAt: 1,
    lastStatusSyncAt: 1,
    lastAccountsSyncAt: 1,
    lastSessionsSyncAt: 1,
    descriptor: createDescriptor('http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'),
    lastCheckedAt: 1,
    lastError: '',
    createdAt: 1,
    updatedAt: 2
  };
  const requests = [];
  global.window = Object.assign(eventTarget, {
    localStorage: storage,
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method || 'GET' });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          activeProfileId: 'cp-aws',
          profiles: [sharedProfile]
        })
      };
    }
  });
  const profiles = loadControlPlaneProfilesModule();

  const result = await profiles.syncSharedControlPlaneProfiles();
  const listed = profiles.listControlPlaneProfiles();

  assert.equal(requests[0].url, '/v0/webui/control-plane/profiles');
  assert.equal(requests[0].method, 'GET');
  assert.equal(result.activeProfileId, 'cp-aws');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'cp-aws');
  assert.equal(listed[0].authState, 'paired');
  assert.equal(listed[0].deviceToken, 'device-token');
  delete global.window;
});

test('control plane profiles do not auto-seed current origin when a ready server exists', () => {
  const eventTarget = new EventTarget();
  global.window = Object.assign(eventTarget, {
    localStorage: createStorage(),
    location: { origin: 'http://127.0.0.1:9527' }
  });
  const profiles = loadControlPlaneProfilesModule();

  profiles.saveControlPlaneProfile({
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    descriptor: createDescriptor('http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'device-token'
  });
  const listed = profiles.listControlPlaneProfiles();

  assert.equal(listed.length, 1);
  assert.equal(listed[0].endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  delete global.window;
});

test('control plane profiles store discovered state after descriptor probe', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const saved = profiles.saveControlPlaneProfile({
    name: 'Home AIH',
    endpoint: 'control.example.com/ui/',
    descriptor: createDescriptor(),
    state: 'discovered',
    authState: 'unpaired'
  });

  assert.equal(saved.endpoint, 'https://control.example.com');
  assert.equal(saved.state, 'discovered');
  assert.equal(saved.authState, 'unpaired');
  assert.equal(profiles.listControlPlaneProfiles()[0].state, 'discovered');
  delete global.window;
});

test('control plane profiles save broker proxy endpoint metadata', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const proxyEndpoint = profiles.buildFabricBrokerProxyEndpoint(
    'http://broker.example.com/ui/',
    'AWS Current'
  );
  const saved = profiles.saveControlPlaneProfile({
    name: 'AWS Broker Fabric',
    endpoint: 'http://broker.example.com',
    connectionMode: 'broker-proxy',
    broker: {
      brokerEndpoint: 'http://broker.example.com/ui/',
      serverId: 'AWS Current',
      proxyEndpoint: ''
    },
    descriptor: createDescriptor(proxyEndpoint),
    state: 'discovered',
    authState: 'unpaired'
  });
  const restored = profiles.listControlPlaneProfiles()[0];

  assert.equal(proxyEndpoint, 'http://broker.example.com/v0/fabric/broker/servers/aws-current/proxy');
  assert.equal(saved.endpoint, proxyEndpoint);
  assert.equal(saved.connectionMode, 'broker-proxy');
  assert.deepEqual(saved.broker, {
    brokerEndpoint: 'http://broker.example.com',
    serverId: 'aws-current',
    proxyEndpoint
  });
  assert.equal(restored.connectionMode, 'broker-proxy');
  assert.deepEqual(restored.broker, saved.broker);
  delete global.window;
});

test('control plane profiles resolve broker proxy form input', () => {
  const profiles = loadControlPlaneProfilesModule();

  assert.deepEqual(
    profiles.resolveControlPlaneProfileEndpointInput({
      endpoint: 'https://direct.example.com/ui',
      connectionMode: 'direct'
    }),
    {
      endpoint: 'https://direct.example.com',
      connectionMode: 'direct',
      broker: null
    }
  );
  assert.deepEqual(
    profiles.resolveControlPlaneProfileEndpointInput({
      connectionMode: 'broker-proxy',
      brokerEndpoint: 'http://broker.example.com/ui/',
      brokerServerId: 'AWS Current'
    }),
    {
      endpoint: 'http://broker.example.com/v0/fabric/broker/servers/aws-current/proxy',
      connectionMode: 'broker-proxy',
      broker: {
        brokerEndpoint: 'http://broker.example.com',
        serverId: 'aws-current',
        proxyEndpoint: 'http://broker.example.com/v0/fabric/broker/servers/aws-current/proxy'
      }
    }
  );
  assert.throws(
    () => profiles.resolveControlPlaneProfileEndpointInput({
      connectionMode: 'broker-proxy',
      brokerEndpoint: 'http://broker.example.com'
    }),
    /invalid_fabric_broker_profile/
  );
});

test('control plane profiles migrate legacy paired auth state into profile state', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://office.example.com',
    descriptor: createDescriptor('https://office.example.com'),
    authState: 'paired'
  });

  assert.equal(saved.state, 'paired');
  assert.equal(saved.authState, 'paired');
  delete global.window;
});

test('control plane profiles keep auth state while marking descriptor failures degraded', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const paired = profiles.saveControlPlaneProfile({
    endpoint: 'https://lab.example.com',
    descriptor: createDescriptor('https://lab.example.com'),
    authState: 'paired'
  });
  const degraded = profiles.saveControlPlaneProfile({
    endpoint: paired.endpoint,
    descriptor: paired.descriptor,
    authState: paired.authState,
    lastError: 'descriptor_http_502'
  });

  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.authState, 'paired');
  assert.equal(degraded.lastError, 'descriptor_http_502');
  delete global.window;
});

test('control plane profiles summarize multi server client readiness', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const ready = profiles.saveControlPlaneProfile({
    endpoint: 'https://home.example.com',
    descriptor: createDescriptor('https://home.example.com'),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'home-token',
    nodeCount: 2,
    accountCount: 5,
    activeAccountCount: 4,
    schedulableAccountCount: 3,
    sessionCount: 7
  });
  const degraded = profiles.saveControlPlaneProfile({
    endpoint: 'https://office.example.com',
    descriptor: createDescriptor('https://office.example.com'),
    state: 'degraded',
    authState: 'paired',
    deviceToken: 'office-token',
    nodeCount: 1,
    accountCount: 2,
    activeAccountCount: 1,
    schedulableAccountCount: 1,
    sessionCount: 2
  });
  profiles.saveControlPlaneProfile({
    endpoint: 'https://revoked.example.com',
    descriptor: createDescriptor('https://revoked.example.com'),
    state: 'revoked',
    authState: 'unpaired',
    nodeCount: 4,
    sessionCount: 1
  });

  const summary = profiles.summarizeControlPlaneProfiles(profiles.listControlPlaneProfiles());

  assert.equal(profiles.isControlPlaneProfileReady(ready), true);
  assert.equal(profiles.isControlPlaneProfileReady(degraded), false);
  assert.deepEqual(summary, {
    total: 3,
    paired: 2,
    ready: 1,
    degraded: 1,
    revoked: 1,
    nodes: 7,
    accounts: 7,
    activeAccounts: 5,
    schedulableAccounts: 4,
    sessions: 10
  });
  delete global.window;
});

test('control plane profile bundle exports portable non-secret server descriptors', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const saved = profiles.saveControlPlaneProfile({
    name: 'Home Fabric',
    endpoint: 'https://home.example.com',
    descriptor: createDescriptor('https://home.example.com'),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'secret-device-token',
    nodeCount: 2,
    accountCount: 4,
    schedulableAccountCount: 3,
    sessionCount: 8
  });
  const text = profiles.serializeControlPlaneProfileBundle(saved);
  const bundle = JSON.parse(text);

  assert.equal(bundle.kind, 'aih-control-plane-profile-bundle');
  assert.equal(bundle.version, 1);
  assert.equal(bundle.profiles.length, 1);
  assert.equal(bundle.profiles[0].name, 'Home Fabric');
  assert.equal(bundle.profiles[0].endpoint, 'https://home.example.com');
  assert.equal(bundle.profiles[0].connectionMode, 'direct');
  assert.equal(bundle.profiles[0].broker, null);
  assert.equal(bundle.profiles[0].nodeCount, 2);
  assert.equal(bundle.profiles[0].accountCount, 4);
  assert.equal(bundle.profiles[0].schedulableAccountCount, 3);
  assert.equal(bundle.profiles[0].sessionCount, 8);
  assert.equal(bundle.profiles[0].descriptor.endpoint, 'https://home.example.com');
  assert.deepEqual(bundle.warnings, [
    'device_token_not_exported',
    'import_requires_pairing'
  ]);
  assert.doesNotMatch(text, /secret-device-token/);
  assert.equal(Object.prototype.hasOwnProperty.call(bundle.profiles[0], 'deviceToken'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(bundle.profiles[0], 'id'), false);
  delete global.window;
});

test('control plane profile bundle preserves non-secret broker metadata', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();
  const proxyEndpoint = profiles.buildFabricBrokerProxyEndpoint(
    'http://broker.example.com',
    'aws-current'
  );
  const saved = profiles.saveControlPlaneProfile({
    name: 'AWS Broker Fabric',
    endpoint: proxyEndpoint,
    descriptor: createDescriptor(proxyEndpoint),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'secret-broker-device-token',
    nodeCount: 1,
    accountCount: 3,
    schedulableAccountCount: 2,
    sessionCount: 4
  });
  const text = profiles.serializeControlPlaneProfileBundle(saved);
  const bundle = JSON.parse(text);

  assert.equal(bundle.profiles[0].connectionMode, 'broker-proxy');
  assert.deepEqual(bundle.profiles[0].broker, {
    brokerEndpoint: 'http://broker.example.com',
    serverId: 'aws-current',
    proxyEndpoint
  });
  assert.doesNotMatch(text, /secret-broker-device-token/);

  global.window = { localStorage: createStorage() };
  const result = profiles.importControlPlaneProfileBundle(text);
  const imported = result.imported[0].profile;
  assert.equal(imported.endpoint, proxyEndpoint);
  assert.equal(imported.connectionMode, 'broker-proxy');
  assert.deepEqual(imported.broker, bundle.profiles[0].broker);
  assert.equal(imported.authState, 'unpaired');
  assert.equal(imported.deviceToken, '');
  delete global.window;
});

test('control plane profile bundle import creates unpaired portable profile', () => {
  const sourceStorage = createStorage();
  global.window = { localStorage: sourceStorage };
  const profiles = loadControlPlaneProfilesModule();
  const saved = profiles.saveControlPlaneProfile({
    name: 'Office Fabric',
    endpoint: 'https://office.example.com',
    descriptor: createDescriptor('https://office.example.com'),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'office-device-token',
    nodeCount: 1,
    accountCount: 2,
    schedulableAccountCount: 1,
    sessionCount: 3
  });
  const text = profiles.serializeControlPlaneProfileBundle(saved);

  global.window = { localStorage: createStorage() };
  const result = profiles.importControlPlaneProfileBundle(text);
  const imported = profiles.listControlPlaneProfiles()[0];

  assert.equal(result.importedCount, 1);
  assert.equal(result.updatedCount, 0);
  assert.equal(result.preservedDeviceTokenCount, 0);
  assert.equal(imported.name, 'Office Fabric');
  assert.equal(imported.endpoint, 'https://office.example.com');
  assert.equal(imported.state, 'discovered');
  assert.equal(imported.authState, 'unpaired');
  assert.equal(imported.deviceToken, '');
  assert.equal(imported.nodeCount, 1);
  assert.equal(imported.accountCount, 2);
  assert.equal(imported.schedulableAccountCount, 1);
  assert.equal(imported.sessionCount, 3);
  assert.equal(profiles.isControlPlaneProfileReady(imported), false);
  delete global.window;
});

test('control plane profile bundle parser rejects secret-bearing payloads', () => {
  const profiles = loadControlPlaneProfilesModule();

  assert.throws(
    () => profiles.parseControlPlaneProfileBundle({
      kind: 'aih-control-plane-profile-bundle',
      version: 1,
      exportedAt: '2026-06-27T00:00:00.000Z',
      profiles: [
        {
          name: 'Leaky Fabric',
          endpoint: 'https://leaky.example.com',
          deviceToken: 'must-not-import'
        }
      ]
    }),
    /control_plane_profile_bundle_contains_secret/
  );
});

test('control plane profiles summarize mobile client readiness gates', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  assert.deepEqual(
    profiles.summarizeControlPlaneClientReadiness([], ''),
    [
      {
        id: 'profile-store',
        label: '本地服务器簿',
        status: 'blocked',
        detail: '还没有保存可切换的 Control Plane'
      },
      {
        id: 'server-switching',
        label: '多服务器切换',
        status: 'blocked',
        detail: '需要先配对或添加 Control Plane'
      },
      {
        id: 'active-server',
        label: '当前服务器',
        status: 'blocked',
        detail: '未选择当前服务器'
      },
      {
        id: 'device-token',
        label: '设备身份',
        status: 'blocked',
        detail: '需要配对后保存 device token'
      },
      {
        id: 'node-data-plane',
        label: '节点数据面',
        status: 'blocked',
        detail: '未选择 server，无法读取节点'
      }
    ]
  );

  const home = profiles.saveControlPlaneProfile({
    endpoint: 'https://home.example.com',
    descriptor: createDescriptor('https://home.example.com'),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'home-token',
    nodeCount: 1,
    nodes: [
      {
        id: 'home-mac',
        name: 'Home Mac',
        connection: {
          status: 'online',
          transportKind: 'relay'
        },
        transports: [
          {
            id: 'home-mac-relay',
            nodeId: 'home-mac',
            kind: 'relay',
            routeRole: 'data-plane'
          }
        ]
      }
    ]
  });
  profiles.saveControlPlaneProfile({
    endpoint: 'https://office.example.com',
    descriptor: createDescriptor('https://office.example.com'),
    state: 'degraded',
    authState: 'paired',
    deviceToken: 'office-token',
    lastError: 'offline'
  });

  const readiness = profiles.summarizeControlPlaneClientReadiness(
    profiles.listControlPlaneProfiles(),
    home.id
  );

  assert.deepEqual(
    readiness.map((item) => [item.id, item.status]),
    [
      ['profile-store', 'ready'],
      ['server-switching', 'ready'],
      ['active-server', 'ready'],
      ['device-token', 'ready'],
      ['node-data-plane', 'ready']
    ]
  );
  assert.match(
    readiness.find((item) => item.id === 'node-data-plane').detail,
    /1\/1 节点在线，1 条数据面/
  );
  delete global.window;
});

test('control plane profiles summarize cached node health and transport roles', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://home.example.com',
    descriptor: createDescriptor('https://home.example.com'),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'home-token',
    nodeCount: 3,
    nodes: [
      {
        id: 'home-mac',
        name: 'Home Mac',
        preferredTransports: ['relay'],
        lastSeenAt: 1000,
        connection: {
          status: 'online',
          transportKind: 'relay',
          lastSeenAt: 2000
        },
        transports: [
          {
            id: 'home-mac-relay',
            nodeId: 'home-mac',
            kind: 'relay',
            routeRole: 'data-plane',
            updatedAt: 3000
          }
        ]
      },
      {
        id: 'home-router',
        name: 'Home Router',
        disabled: true,
        preferredTransports: ['mptcp'],
        connection: {
          status: 'offline'
        },
        transports: [
          {
            id: 'home-router-mptcp',
            nodeId: 'home-router',
            kind: 'mptcp',
            routeRole: 'underlay',
            createdAt: 4000
          }
        ]
      }
    ]
  });

  const summary = profiles.summarizeControlPlaneProfileNodes(saved);

  assert.deepEqual(summary, {
    total: 3,
    cached: 2,
    online: 1,
    offline: 1,
    unknown: 1,
    disabled: 1,
    dataPlaneTransports: 1,
    bootstrapTransports: 0,
    underlayTransports: 1,
    lastSeenAt: 4000,
    transportKinds: ['mptcp', 'relay']
  });
  delete global.window;
});

test('control plane profiles refresh paired servers and degrade failed profiles in bulk', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  profiles.saveControlPlaneProfile({
    endpoint: 'https://home.example.com',
    descriptor: createDescriptor('https://home.example.com'),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'home-token'
  });
  profiles.saveControlPlaneProfile({
    endpoint: 'https://office.example.com',
    descriptor: createDescriptor('https://office.example.com'),
    state: 'paired',
    authState: 'paired',
    deviceToken: 'office-token'
  });
  profiles.saveControlPlaneProfile({
    endpoint: 'https://draft.example.com',
    descriptor: createDescriptor('https://draft.example.com'),
    state: 'discovered',
    authState: 'unpaired'
  });

  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({
      host: parsed.host,
      path: parsed.pathname,
      auth: String(init && init.headers && init.headers.authorization || '')
    });
    if (parsed.host === 'office.example.com') {
      throw new Error('office_unreachable');
    }
    if (parsed.pathname.endsWith('/v0/node-rpc/device-profile')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.profile',
          result: {
            device: {
              id: 'device-phone',
              name: 'Phone',
              platform: 'ios',
              scopes: ['control-plane:read', 'nodes:read'],
              state: 'paired'
            },
            controlPlane: createDescriptor('https://home.example.com')
          }
        })
      };
    }
    if (parsed.pathname.endsWith('/v0/node-rpc/device-nodes')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.nodes',
          result: {
            nodes: [
              {
                id: 'home-mac',
                name: 'Home Mac',
                role: 'workstation',
                endpointPolicy: 'auto',
                preferredTransports: ['relay'],
                capabilities: ['status'],
                tags: [],
                transports: []
              }
            ]
          }
        })
      };
    }
    if (parsed.pathname.endsWith('/v0/node-rpc/device-status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.status',
          result: {
            status: {
              ok: true,
              service: 'aih-control-plane',
              serverTime: '2026-06-19T00:00:00.000Z',
              uptimeSec: 10,
              backend: 'codex-adapter',
              providerMode: 'auto',
              strategy: 'round-robin',
              totalAccounts: 2,
              activeAccounts: 1,
              cooldownAccounts: 1,
              statusTotals: {},
              providers: {},
              queue: {},
              queueTotals: {
                running: 0,
                queued: 0,
                totalScheduled: 0,
                totalRejected: 0
              },
              modelsCached: 0,
              modelsUpdatedAt: 0,
              modelRegistryUpdatedAt: 0,
              successRate: 0,
              timeoutRate: 0,
              totalRequests: 0
            }
          }
        })
      };
    }
    if (parsed.pathname.endsWith('/v0/node-rpc/device-accounts')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.accounts',
          result: {
            accounts: [],
            summary: {
              total: 2,
              active: 1,
              byProvider: {},
              byRuntimeStatus: {},
              bySchedulableStatus: { schedulable: 1 }
            }
          }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        rpc: 'control_plane.device.sessions',
        result: {
          sessions: [],
          summary: {
            total: 3,
            returned: 0,
            byProvider: {},
            byStatus: {},
            byProject: {},
            recentlyUpdatedAt: 0
          }
        }
      })
    };
  };

  const result = await profiles.refreshControlPlaneProfileStates(profiles.listControlPlaneProfiles(), { fetchImpl });
  const saved = profiles.listControlPlaneProfiles();
  const home = saved.find((profile) => profile.endpoint === 'https://home.example.com');
  const office = saved.find((profile) => profile.endpoint === 'https://office.example.com');
  const draft = saved.find((profile) => profile.endpoint === 'https://draft.example.com');

  assert.equal(result.refreshed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(profiles.isControlPlaneProfileRefreshable(home), true);
  assert.equal(home.nodeCount, 1);
  assert.equal(home.accountCount, 2);
  assert.equal(home.activeAccountCount, 1);
  assert.equal(home.schedulableAccountCount, 1);
  assert.equal(home.sessionCount, 3);
  assert.equal(office.state, 'degraded');
  assert.equal(office.authState, 'paired');
  assert.equal(office.deviceToken, 'office-token');
  assert.equal(office.lastError, 'office_unreachable');
  assert.equal(draft.authState, 'unpaired');
  assert.equal(profiles.isControlPlaneProfileRefreshable(draft), false);
  assert.equal(calls.some((call) => call.host === 'draft.example.com'), false);
  assert.equal(calls.every((call) => call.auth === 'Bearer home-token' || call.auth === 'Bearer office-token'), true);
  delete global.window;
});

test('control plane profiles persist device token and refresh device node summary', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url: String(url),
      auth: String(init && init.headers && init.headers.authorization || '')
    });
    if (String(url).endsWith('/v0/node-rpc/device-profile')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.profile',
          result: {
            device: {
              id: 'device-phone',
              name: 'Phone',
              platform: 'ios',
              scopes: ['control-plane:read', 'nodes:read'],
              state: 'paired'
            },
            controlPlane: createDescriptor('https://control.example.com')
          }
        })
      };
    }
    if (String(url).endsWith('/v0/node-rpc/device-status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.status',
          result: {
            status: {
              ok: true,
              service: 'aih-control-plane',
              serverTime: '2026-06-19T00:00:00.000Z',
              uptimeSec: 10,
              backend: 'codex-adapter',
              providerMode: 'auto',
              strategy: 'round-robin',
              totalAccounts: 3,
              activeAccounts: 2,
              cooldownAccounts: 1,
              statusTotals: { healthy: 2, rate_limited: 1 },
              providers: {
                codex: { total: 3, active: 2, statuses: { healthy: 2, rate_limited: 1 } }
              },
              queue: {
                codex: {
                  name: 'codex',
                  running: 1,
                  queued: 0,
                  maxConcurrency: 2,
                  queueLimit: 20,
                  totalScheduled: 5,
                  totalRejected: 0
                }
              },
              queueTotals: {
                running: 1,
                queued: 0,
                totalScheduled: 5,
                totalRejected: 0
              },
              modelsCached: 8,
              modelsUpdatedAt: 1000,
              modelRegistryUpdatedAt: 2000,
              successRate: 0.9,
              timeoutRate: 0.1,
              totalRequests: 10
            }
          }
        })
      };
    }
    if (String(url).endsWith('/v0/node-rpc/device-accounts')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.accounts',
          result: {
            accounts: [
              {
                accountRef: 'acct_0123456789abcdefabcd',
                provider: 'codex',
                label: 'user@example.com',
                status: 'up',
                authMode: 'oauth',
                planType: 'plus',
                runtimeStatus: 'healthy',
                quotaStatus: 'available',
                schedulableStatus: 'schedulable',
                remainingPct: 72,
                modelCooldownCount: 0,
                lastRefresh: 1234,
                successCount: 5,
                failCount: 1
              },
              {
                accountRef: 'acct_abcdefabcdefabcdefab',
                provider: 'claude',
                label: 'claude api-key',
                status: 'down',
                authMode: 'api-key',
                planType: 'api-key',
                runtimeStatus: 'auth_invalid',
                quotaStatus: 'unknown',
                schedulableStatus: 'blocked_by_auth',
                remainingPct: null,
                modelCooldownCount: 1,
                lastRefresh: 0,
                successCount: 0,
                failCount: 2
              }
            ],
            summary: {
              total: 2,
              active: 1,
              byProvider: { codex: 1, claude: 1 },
              byRuntimeStatus: { healthy: 1, auth_invalid: 1 },
              bySchedulableStatus: { schedulable: 1, blocked_by_auth: 1 }
            }
          }
        })
      };
    }
    if (String(url).endsWith('/v0/node-rpc/device-sessions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.sessions',
          result: {
            sessions: [
              {
                sessionRef: 'sess_0123456789abcdefabcd',
                projectRef: 'proj_0123456789abcdefabcd',
                provider: 'codex',
                title: 'Remote control design',
                projectName: 'AI Home',
                status: 'running',
                updatedAt: 2000,
                startedAt: 1000
              }
            ],
            summary: {
              total: 1,
              returned: 1,
              byProvider: { codex: 1 },
              byStatus: { running: 1 },
              byProject: { proj_0123456789abcdefabcd: 1 },
              recentlyUpdatedAt: 2000
            }
          }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        rpc: 'control_plane.device.nodes',
        result: {
          nodes: [
            {
              id: 'office-pc',
              name: 'Office PC',
              role: 'workstation',
              endpointPolicy: 'auto',
              preferredTransports: ['tailscale'],
              capabilities: ['status'],
              tags: ['office'],
              transports: [
                {
                  id: 'office-pc-tailnet',
                  nodeId: 'office-pc',
                  kind: 'tailscale',
                  status: 'up',
                  score: 91,
                  latencyMs: 24,
                  managedBy: 'aih',
                  provider: 'tailscale',
                  routeRole: 'data-plane',
                  trustLevel: 'verified'
                }
              ]
            }
          ]
        }
      })
    };
  };

  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    authState: 'paired',
    deviceToken: 'device-token'
  });
  const refreshed = await profiles.refreshControlPlaneDeviceState(saved, { fetchImpl });

  assert.equal(refreshed.profile.state, 'paired');
  assert.equal(refreshed.profile.authState, 'paired');
  assert.equal(refreshed.profile.deviceToken, 'device-token');
  assert.equal(refreshed.profile.nodeCount, 1);
  assert.equal(refreshed.profile.accountCount, 3);
  assert.equal(refreshed.profile.activeAccountCount, 2);
  assert.equal(refreshed.profile.schedulableAccountCount, 1);
  assert.equal(refreshed.profile.sessionCount, 1);
  assert.equal(refreshed.profile.nodes.length, 1);
  assert.equal(refreshed.profile.nodes[0].id, 'office-pc');
  assert.equal(refreshed.profile.nodes[0].connection.status, 'unknown');
  assert.equal(refreshed.nodes[0].id, 'office-pc');
  assert.equal(refreshed.nodes[0].transports[0].kind, 'tailscale');
  assert.equal(refreshed.nodes[0].transports[0].provider, 'tailscale');
  assert.equal(refreshed.nodes[0].transports[0].routeRole, 'data-plane');
  assert.equal(refreshed.nodes[0].transports[0].trustLevel, 'verified');
  assert.equal(refreshed.status.totalAccounts, 3);
  assert.equal(refreshed.status.queueTotals.running, 1);
  assert.equal(refreshed.accounts.length, 2);
  assert.equal(refreshed.accountSummary.byProvider.codex, 1);
  assert.equal(refreshed.sessions.length, 1);
  assert.equal(refreshed.sessionSummary.byStatus.running, 1);
  assert.equal(profiles.listControlPlaneProfiles()[0].nodeCount, 1);
  assert.equal(profiles.listControlPlaneProfiles()[0].accountCount, 3);
  assert.equal(profiles.listControlPlaneProfiles()[0].schedulableAccountCount, 1);
  assert.equal(profiles.listControlPlaneProfiles()[0].sessionCount, 1);
  assert.equal(profiles.listControlPlaneProfiles()[0].nodes[0].transports[0].kind, 'tailscale');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://control.example.com/v0/node-rpc/device-profile',
    'https://control.example.com/v0/node-rpc/device-nodes',
    'https://control.example.com/v0/node-rpc/device-status',
    'https://control.example.com/v0/node-rpc/device-accounts',
    'https://control.example.com/v0/node-rpc/device-sessions'
  ]);
  assert.deepEqual(calls.map((call) => call.auth), [
    'Bearer device-token',
    'Bearer device-token',
    'Bearer device-token',
    'Bearer device-token',
    'Bearer device-token'
  ]);
  delete global.window;
});

test('control plane profiles fetch scoped session messages by public session ref', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const result = await profiles.fetchControlPlaneDeviceSessionMessages({
    endpoint: 'https://control.example.com',
    deviceToken: 'device-token'
  }, 'sess_0123456789abcdefabcd', {
    limit: 2,
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        auth: String(init && init.headers && init.headers.authorization || '')
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.session_messages',
          result: {
            session: {
              sessionRef: 'sess_0123456789abcdefabcd',
              projectRef: 'proj_0123456789abcdefabcd',
              provider: 'codex',
              title: 'Remote control design',
              projectName: 'AI Home',
              status: 'running',
              updatedAt: 2000,
              startedAt: 1000
            },
            messages: [
              { role: 'user', content: 'please continue', timestamp: 1500, images: ['/hidden.png'] },
              { role: 'assistant', content: 'continuing now', timestamp: 2000, localPath: '/tmp/hidden' }
            ],
            summary: {
              total: 3,
              returned: 2,
              truncated: true,
              cursor: 4096
            }
          }
        })
      };
    }
  });

  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-session-messages?sessionRef=sess_0123456789abcdefabcd&limit=2',
      auth: 'Bearer device-token'
    }
  ]);
  assert.equal(result.session.sessionRef, 'sess_0123456789abcdefabcd');
  assert.equal(result.session.provider, 'codex');
  assert.deepEqual(result.messages, [
    { role: 'user', content: 'please continue', timestamp: 1500 },
    { role: 'assistant', content: 'continuing now', timestamp: 2000 }
  ]);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.returned, 2);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.summary.cursor, 4096);
});

test('control plane profiles fetch remote node sessions by node id', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const result = await profiles.fetchControlPlaneDeviceNodeSessions({
    endpoint: 'https://control.example.com/ui',
    deviceToken: 'device-token'
  }, 'office-pc', {
    limit: 2,
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        auth: String(init && init.headers && init.headers.authorization || '')
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.node_sessions',
          nodeId: 'office-pc',
          result: {
            sessions: [
              {
                sessionRef: 'sess_0123456789abcdefabcd',
                projectRef: 'proj_0123456789abcdefabcd',
                provider: 'codex',
                title: 'Remote control design',
                projectName: 'AI Home',
                status: 'running',
                updatedAt: 2000,
                startedAt: 1000
              },
              {
                sessionRef: 'sess_abcdefabcdefabcdefab',
                projectRef: 'proj_abcdefabcdefabcdefab',
                provider: 'claude',
                title: 'Remote plan',
                projectName: 'AI Home',
                status: 'idle',
                updatedAt: 1500,
                startedAt: 900
              }
            ],
            summary: {
              total: 3,
              returned: 2,
              byProvider: { codex: 1, claude: 1 },
              byStatus: { running: 1, idle: 1 },
              byProject: { proj_0123456789abcdefabcd: 1, proj_abcdefabcdefabcdefab: 1 },
              recentlyUpdatedAt: 2000
            }
          }
        })
      };
    }
  });

  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-node-sessions?nodeId=office-pc&limit=2',
      auth: 'Bearer device-token'
    }
  ]);
  assert.equal(result.nodeId, 'office-pc');
  assert.deepEqual(result.sessions.map((session) => [session.sessionRef, session.provider, session.status]), [
    ['sess_0123456789abcdefabcd', 'codex', 'running'],
    ['sess_abcdefabcdefabcdefab', 'claude', 'idle']
  ]);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.returned, 2);
  assert.equal(result.summary.byStatus.running, 1);
  assert.equal(result.summary.recentlyUpdatedAt, 2000);
  assert.doesNotMatch(calls[0].url, /device-token/);
});

test('control plane profiles fetch remote node session messages by public refs', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const result = await profiles.fetchControlPlaneDeviceNodeSessionMessages({
    endpoint: 'https://control.example.com/ui',
    deviceToken: 'device-token'
  }, 'office-pc', 'sess_0123456789abcdefabcd', {
    limit: 2,
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        auth: String(init && init.headers && init.headers.authorization || '')
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.node_session_messages',
          nodeId: 'office-pc',
          result: {
            session: {
              sessionRef: 'sess_0123456789abcdefabcd',
              projectRef: 'proj_0123456789abcdefabcd',
              provider: 'codex',
              title: 'Remote control design',
              projectName: 'AI Home',
              status: 'running',
              updatedAt: 2000,
              startedAt: 1000
            },
            messages: [
              { role: 'system', content: 'system prompt', timestamp: 1000 },
              { role: 'user', content: 'please continue', timestamp: 1500, images: ['/hidden.png'] },
              { role: 'assistant', content: 'continuing now', timestamp: 2000 }
            ],
            summary: {
              total: 3,
              returned: 2,
              truncated: true,
              cursor: 4096
            }
          }
        })
      };
    }
  });

  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-node-session-messages?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd&limit=2',
      auth: 'Bearer device-token'
    }
  ]);
  assert.equal(result.nodeId, 'office-pc');
  assert.equal(result.session.sessionRef, 'sess_0123456789abcdefabcd');
  assert.deepEqual(result.messages, [
    { role: 'user', content: 'please continue', timestamp: 1500 },
    { role: 'assistant', content: 'continuing now', timestamp: 2000 }
  ]);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.returned, 2);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.summary.cursor, 4096);
  assert.doesNotMatch(calls[0].url, /device-token/);
});

test('control plane profiles send remote node session input by public refs', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const result = await profiles.sendControlPlaneDeviceNodeSessionInput({
    endpoint: 'https://control.example.com/ui',
    deviceToken: 'device-token'
  }, 'office-pc', 'sess_0123456789abcdefabcd', 'remote yes', {
    appendNewline: false,
    promptId: 'codex-plan-active',
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        method: init && init.method,
        auth: String(init && init.headers && init.headers.authorization || ''),
        body: String(init && init.body || '')
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.node_session_input',
          nodeId: 'office-pc',
          result: {
            session: {
              sessionRef: 'sess_0123456789abcdefabcd',
              projectRef: 'proj_0123456789abcdefabcd',
              provider: 'codex',
              title: 'Remote control design',
              projectName: 'AI Home',
              status: 'running',
              updatedAt: 2000,
              startedAt: 1000
            },
            accepted: true,
            appendNewline: false,
            promptId: 'codex-plan-active'
          }
        })
      };
    }
  });

  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-node-session-input',
      method: 'POST',
      auth: 'Bearer device-token',
      body: JSON.stringify({
        nodeId: 'office-pc',
        sessionRef: 'sess_0123456789abcdefabcd',
        input: 'remote yes',
        appendNewline: false,
        promptId: 'codex-plan-active'
      })
    }
  ]);
  assert.equal(result.nodeId, 'office-pc');
  assert.equal(result.session.sessionRef, 'sess_0123456789abcdefabcd');
  assert.equal(result.accepted, true);
  assert.equal(result.appendNewline, false);
  assert.equal(result.promptId, 'codex-plan-active');
  assert.doesNotMatch(calls[0].url, /device-token/);
});

test('control plane profiles fetch scoped session events by public session ref and cursor', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const result = await profiles.fetchControlPlaneDeviceSessionEvents({
    endpoint: 'https://control.example.com',
    deviceToken: 'device-token'
  }, 'sess_0123456789abcdefabcd', {
    cursor: 4096,
    limit: 20,
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        auth: String(init && init.headers && init.headers.authorization || '')
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.session_events',
          result: {
            session: {
              sessionRef: 'sess_0123456789abcdefabcd',
              projectRef: 'proj_0123456789abcdefabcd',
              provider: 'codex',
              title: 'Remote control design',
              projectName: 'AI Home',
              status: 'running',
              updatedAt: 2000,
              startedAt: 1000
            },
            events: [
              { type: 'user_message', content: 'please continue', timestamp: '2026-06-19T00:00:00.000Z', images: ['/hidden.png'] },
              { type: 'assistant_text', text: 'continuing now', timestamp: '2026-06-19T00:00:01.000Z' },
              { type: 'assistant_tool_result', content: '# cwd: /tmp/hidden', timestamp: '2026-06-19T00:00:02.000Z' }
            ],
            cursor: 8192,
            requiresSnapshot: true,
            truncated: false
          }
        })
      };
    }
  });

  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-session-events?sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20',
      auth: 'Bearer device-token'
    }
  ]);
  assert.equal(result.session.sessionRef, 'sess_0123456789abcdefabcd');
  assert.deepEqual(result.events, [
    { type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'please continue' },
    { type: 'assistant_text', timestamp: '2026-06-19T00:00:01.000Z', text: 'continuing now' }
  ]);
  assert.equal(result.cursor, 8192);
  assert.equal(result.requiresSnapshot, true);
  assert.equal(result.truncated, false);
});

test('control plane profiles build authorized scoped session stream request without query token', () => {
  const profiles = loadControlPlaneProfilesModule();
  const request = profiles.buildControlPlaneDeviceSessionStreamRequest({
    endpoint: 'https://control.example.com/ui',
    deviceToken: 'device-token'
  }, 'sess_0123456789abcdefabcd', {
    cursor: 4096,
    limit: 20,
    intervalMs: 750
  });

  assert.deepEqual(request, {
    url: 'https://control.example.com/v0/node-rpc/device-session-stream?sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750',
    headers: {
      accept: 'text/event-stream',
      authorization: 'Bearer device-token'
    }
  });
  assert.doesNotMatch(request.url, /device-token/);
});

test('control plane profiles stream scoped session events with bearer fetch stream', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const frames = [];
  const calls = [];
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.session_stream',
        type: 'events',
        result: {
          session: {
            sessionRef: 'sess_0123456789abcdefabcd',
            projectRef: 'proj_0123456789abcdefabcd',
            provider: 'codex',
            title: 'Remote control design',
            projectName: 'AI Home',
            status: 'running',
            updatedAt: 2000,
            startedAt: 1000
          },
          events: [
            { type: 'user_message', content: 'please continue', timestamp: '2026-06-19T00:00:00.000Z', localPath: '/hidden' },
            { type: 'assistant_text', text: 'continuing now', timestamp: '2026-06-19T00:00:01.000Z' },
            { type: 'assistant_tool_result', content: '# cwd: /tmp/hidden', timestamp: '2026-06-19T00:00:02.000Z' }
          ],
          cursor: 8192,
          requiresSnapshot: true,
          truncated: false
        }
      })}\n\n`));
      controller.close();
    }
  });

  await profiles.streamControlPlaneDeviceSessionEvents({
    endpoint: 'https://control.example.com',
    deviceToken: 'device-token'
  }, 'sess_0123456789abcdefabcd', {
    onFrame: (frame) => frames.push(frame)
  }, {
    cursor: 4096,
    limit: 20,
    intervalMs: 750,
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        auth: String(init && init.headers && init.headers.authorization || ''),
        accept: String(init && init.headers && init.headers.accept || ''),
        credentials: String(init && init.credentials || '')
      });
      return {
        ok: true,
        status: 200,
        body
      };
    }
  });

  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-session-stream?sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750',
      auth: 'Bearer device-token',
      accept: 'text/event-stream',
      credentials: 'omit'
    }
  ]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].session.sessionRef, 'sess_0123456789abcdefabcd');
  assert.equal(frames[0].cursor, 8192);
  assert.equal(frames[0].requiresSnapshot, true);
  assert.deepEqual(frames[0].events, [
    { type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'please continue' },
    { type: 'assistant_text', timestamp: '2026-06-19T00:00:01.000Z', text: 'continuing now' }
  ]);
});

test('control plane profiles build authorized remote node session stream request without query token', () => {
  const profiles = loadControlPlaneProfilesModule();
  const request = profiles.buildControlPlaneDeviceNodeSessionStreamRequest({
    endpoint: 'https://control.example.com/ui',
    deviceToken: 'device-token'
  }, 'office-pc', 'sess_0123456789abcdefabcd', {
    cursor: 4096,
    limit: 20,
    intervalMs: 750
  });

  assert.deepEqual(request, {
    url: 'https://control.example.com/v0/node-rpc/device-node-session-stream?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750',
    headers: {
      accept: 'text/event-stream',
      authorization: 'Bearer device-token'
    }
  });
  assert.doesNotMatch(request.url, /device-token/);
});

test('control plane profiles stream remote node session events with bearer fetch stream', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const frames = [];
  const calls = [];
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_stream',
        type: 'events',
        nodeId: 'office-pc',
        result: {
          session: {
            sessionRef: 'sess_0123456789abcdefabcd',
            projectRef: 'proj_0123456789abcdefabcd',
            provider: 'codex',
            title: 'Remote control design',
            projectName: 'AI Home',
            status: 'running',
            updatedAt: 2000,
            startedAt: 1000
          },
          events: [
            { type: 'user_message', content: 'please continue', timestamp: '2026-06-19T00:00:00.000Z', localPath: '/hidden' },
            { type: 'assistant_text', text: 'continuing now', timestamp: '2026-06-19T00:00:01.000Z' },
            { type: 'assistant_tool_result', content: '# cwd: /tmp/hidden', timestamp: '2026-06-19T00:00:02.000Z' }
          ],
          cursor: 8192,
          requiresSnapshot: false,
          truncated: false
        }
      })}\n\n`));
      controller.close();
    }
  });

  await profiles.streamControlPlaneDeviceNodeSessionEvents({
    endpoint: 'https://control.example.com',
    deviceToken: 'device-token'
  }, 'office-pc', 'sess_0123456789abcdefabcd', {
    onFrame: (frame) => frames.push(frame)
  }, {
    cursor: 4096,
    limit: 20,
    intervalMs: 750,
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        auth: String(init && init.headers && init.headers.authorization || ''),
        accept: String(init && init.headers && init.headers.accept || ''),
        credentials: String(init && init.credentials || '')
      });
      return {
        ok: true,
        status: 200,
        body
      };
    }
  });

  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-node-session-stream?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750',
      auth: 'Bearer device-token',
      accept: 'text/event-stream',
      credentials: 'omit'
    }
  ]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].nodeId, 'office-pc');
  assert.equal(frames[0].session.sessionRef, 'sess_0123456789abcdefabcd');
  assert.equal(frames[0].cursor, 8192);
  assert.equal(frames[0].requiresSnapshot, false);
  assert.deepEqual(frames[0].events, [
    { type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'please continue' },
    { type: 'assistant_text', timestamp: '2026-06-19T00:00:01.000Z', text: 'continuing now' }
  ]);
});

test('control plane profiles preserve device token during descriptor-only updates', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    authState: 'paired',
    deviceToken: 'device-token',
    nodeCount: 2,
    sessionCount: 8,
    lastDeviceSyncAt: 1234
  });
  const updated = profiles.saveControlPlaneProfile({
    name: 'Renamed AIH',
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    authState: 'paired'
  });

  assert.equal(updated.name, 'Renamed AIH');
  assert.equal(updated.state, 'paired');
  assert.equal(updated.authState, 'paired');
  assert.equal(updated.deviceToken, 'device-token');
  assert.equal(updated.nodeCount, 2);
  assert.equal(updated.sessionCount, 8);
  assert.equal(updated.lastDeviceSyncAt, 1234);
  delete global.window;
});

test('control plane profiles parse pair urls and code fallback', () => {
  const profiles = loadControlPlaneProfilesModule();

  assert.deepEqual(
    profiles.parseControlPlanePairInput('https://control.example.com/v0/node-rpc/device-pair?code=pair-code'),
    {
      endpoint: 'https://control.example.com',
      code: 'pair-code'
    }
  );
  assert.deepEqual(
    profiles.parseControlPlanePairInput('https://control.example.com/aih/v0/node-rpc/device-pair?code=path-code'),
    {
      endpoint: 'https://control.example.com/aih',
      code: 'path-code'
    }
  );
  assert.deepEqual(
    profiles.parseControlPlanePairInput('https://control.example.com/fabric/v0/fabric/device-pair?code=fabric-code'),
    {
      endpoint: 'https://control.example.com/fabric',
      code: 'fabric-code'
    }
  );
  const rawWebPairTarget = 'https://control.example.com/v0/node-rpc/device-pair?code=web-pair-code';
  const webPairUrl = `https://control.example.com/ui/settings?pair=${encodeURIComponent(rawWebPairTarget)}`;
  assert.deepEqual(
    profiles.parseControlPlanePairInput(webPairUrl),
    {
      endpoint: 'https://control.example.com',
      code: 'web-pair-code'
    }
  );
  const webCodeUrl = 'https://phone.example.com/ui/settings?code=manual-code&endpoint=https%3A%2F%2Fcontrol.example.com%2Fui%2F';
  assert.deepEqual(
    profiles.parseControlPlanePairInput(webCodeUrl),
    {
      endpoint: 'https://control.example.com',
      code: 'manual-code'
    }
  );
  assert.deepEqual(
    profiles.parseControlPlanePairInput('manual-code', 'https://control.example.com/ui/'),
    {
      endpoint: 'https://control.example.com',
      code: 'manual-code'
    }
  );
});

test('control plane profiles parse web pair search intent', () => {
  const profiles = loadControlPlaneProfilesModule();
  const encodedPairUrl = encodeURIComponent('https://control.example.com/v0/node-rpc/device-pair?code=pair-code');

  assert.deepEqual(
    profiles.parseControlPlanePairIntentFromSearch(`?pair=${encodedPairUrl}`),
    {
      pairUrlOrCode: 'https://control.example.com/v0/node-rpc/device-pair?code=pair-code',
      endpoint: 'https://control.example.com',
      code: 'pair-code',
      autoSubmit: true
    }
  );
  assert.deepEqual(
    profiles.parseControlPlanePairIntentFromSearch('?code=manual-code&endpoint=https%3A%2F%2Fcontrol.example.com%2Fui%2F'),
    {
      pairUrlOrCode: 'manual-code',
      endpoint: 'https://control.example.com',
      code: 'manual-code',
      autoSubmit: true
    }
  );
  assert.equal(
    profiles.parseControlPlanePairIntentFromSearch('?code=manual-code').autoSubmit,
    false
  );
});

test('control plane profiles consume device pair invite and persist profile token', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const requestUrl = String(url);
    calls.push({
      url: requestUrl,
      method: String(init && init.method || 'GET'),
      body: init && init.body ? JSON.parse(String(init.body)) : null
    });
    if (requestUrl.endsWith('/v0/fabric/device-pair')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'fabric.device.pair',
          result: {
            device: {
              id: 'device-phone',
              name: 'Phone',
              platform: 'ios',
              publicKeyFingerprint: '',
              scopes: ['control-plane:read', 'nodes:read'],
              state: 'paired',
              pairedAt: 1000,
              revokedAt: 0,
              lastSeenAt: 0,
              createdAt: 1000,
              updatedAt: 1000
            },
            token: 'device-token'
          }
        })
      };
    }
    if (requestUrl.endsWith('/v0/fabric/descriptor')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'fabric.descriptor.read',
          result: {
            ok: true,
            service: 'aih-fabric',
            protocolVersion: 1,
            server: {
              id: 'fabric-control',
              name: 'Control',
              endpoint: 'https://control.example.com',
              host: 'control.example.com',
              port: 443,
              serverTime: '2026-06-19T00:00:00.000Z',
              uptimeSec: 10
            },
            roles: ['server', 'relay'],
            auth: {
              methods: ['device-pair'],
              devicePairing: true,
              managementKeyConfigured: true,
              clientKeyConfigured: false
            },
            capabilities: {
              client: ['server-profile', 'device-pairing'],
              roles: {
                server: ['identity'],
                relay: ['wss-relay'],
                node: ['remote-runtime'],
                client: ['profile-selection']
              },
              transports: ['direct', 'frp'],
              legacyControlPlane: {
                protocolVersion: 1,
                nodeRpc: ['descriptor', 'device-profile', 'device-nodes'],
                management: ['status']
              }
            }
          }
        })
      };
    }
    throw new Error(`unexpected request ${requestUrl}`);
  };

  const paired = await profiles.pairControlPlaneDevice({
    pairUrlOrCode: 'https://control.example.com/v0/node-rpc/device-pair?code=pair-code',
    deviceId: 'device-ios-1011121314151617',
    deviceName: 'Phone',
    platform: 'ios'
  }, { fetchImpl });

  assert.equal(paired.profile.endpoint, 'https://control.example.com');
  assert.equal(paired.profile.state, 'paired');
  assert.equal(paired.profile.authState, 'paired');
  assert.equal(paired.profile.deviceToken, 'device-token');
  assert.equal(paired.device.id, 'device-phone');
  assert.equal(profiles.listControlPlaneProfiles()[0].deviceToken, 'device-token');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://control.example.com/v0/fabric/device-pair',
    'https://control.example.com/v0/fabric/descriptor'
  ]);
  assert.deepEqual(calls[0].body, {
    code: 'pair-code',
    device: {
      id: 'device-ios-1011121314151617',
      name: 'Phone',
      platform: 'ios'
    }
  });
  delete global.window;
});

test('control plane profiles pair through broker proxy when broker mode is selected', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();
  const proxyEndpoint = profiles.buildFabricBrokerProxyEndpoint(
    'http://broker.example.com',
    'aws-current'
  );
  const calls = [];
  const fetchImpl = async (url, init) => {
    const requestUrl = String(url);
    calls.push({
      url: requestUrl,
      method: String(init && init.method || 'GET'),
      body: init && init.body ? JSON.parse(String(init.body)) : null
    });
    if (requestUrl.endsWith('/v0/fabric/device-pair')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'fabric.device.pair',
          result: {
            device: {
              id: 'device-phone',
              name: 'Phone',
              platform: 'ios',
              publicKeyFingerprint: '',
              scopes: ['control-plane:read', 'nodes:read'],
              state: 'paired',
              pairedAt: 1000,
              revokedAt: 0,
              lastSeenAt: 0,
              createdAt: 1000,
              updatedAt: 1000
            },
            token: 'broker-device-token'
          }
        })
      };
    }
    if (requestUrl.endsWith('/v0/fabric/descriptor')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'fabric.descriptor.read',
          result: {
            ok: true,
            service: 'aih-fabric',
            protocolVersion: 1,
            server: {
              id: 'fabric-control',
              name: 'Control',
              endpoint: proxyEndpoint,
              host: 'broker.example.com',
              port: 80,
              serverTime: '2026-06-19T00:00:00.000Z',
              uptimeSec: 10
            },
            roles: ['server', 'relay'],
            auth: {
              methods: ['device-pair'],
              devicePairing: true,
              managementKeyConfigured: true,
              clientKeyConfigured: false
            },
            capabilities: {
              client: ['server-profile', 'device-pairing'],
              roles: {},
              transports: ['relay'],
              legacyControlPlane: {
                protocolVersion: 1,
                nodeRpc: ['descriptor', 'device-profile', 'device-nodes'],
                management: ['status']
              }
            }
          }
        })
      };
    }
    throw new Error(`unexpected request ${requestUrl}`);
  };

  const paired = await profiles.pairControlPlaneDevice({
    pairUrlOrCode: 'https://direct.example.com/v0/fabric/device-pair?code=pair-code',
    endpoint: proxyEndpoint,
    connectionMode: 'broker-proxy',
    broker: {
      brokerEndpoint: 'http://broker.example.com',
      serverId: 'aws-current',
      proxyEndpoint
    },
    deviceId: 'device-ios-1011121314151617',
    deviceName: 'Phone',
    platform: 'ios'
  }, { fetchImpl });

  assert.equal(paired.profile.endpoint, proxyEndpoint);
  assert.equal(paired.profile.connectionMode, 'broker-proxy');
  assert.equal(paired.profile.broker.serverId, 'aws-current');
  assert.equal(paired.profile.deviceToken, 'broker-device-token');
  assert.deepEqual(calls.map((call) => call.url), [
    `${proxyEndpoint}/v0/fabric/device-pair`,
    `${proxyEndpoint}/v0/fabric/descriptor`
  ]);
  assert.equal(calls[0].body.code, 'pair-code');
  delete global.window;
});
