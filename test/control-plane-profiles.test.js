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
      managementKeyConfigured: true
    },
    capabilities: {
      nodeRpc: ['descriptor', 'device-profile', 'device-status', 'device-accounts', 'device-sessions', 'device-node-sessions', 'device-nodes'],
      management: ['status'],
      remoteManagement: true,
      remoteInvite: true,
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
  assert.equal(saved[0].name, '当前 Server');
  assert.equal(saved[0].endpoint, 'http://192.168.3.181:9527');
  assert.equal(saved[0].state, 'offline');
  assert.equal(saved[0].managementKey, '');
  assert.equal(profiles.listControlPlaneProfiles().length, 1);
  delete global.window;
});

test('control plane profiles physically remove obsolete auth fields from local storage', () => {
  const storage = createStorage();
  storage.setItem('aih:control-plane-profiles:v1', JSON.stringify([{
    id: 'cp-legacy',
    name: 'Legacy Server',
    endpoint: 'https://legacy.example.com',
    state: 'paired',
    authState: 'paired',
    deviceToken: 'obsolete-secret',
    createdAt: 1,
    updatedAt: 1
  }]));
  global.window = { localStorage: storage };
  const profiles = loadControlPlaneProfilesModule();

  const [normalized] = profiles.listControlPlaneProfiles();
  const raw = String(storage.getItem('aih:control-plane-profiles:v1') || '');

  assert.equal(normalized.state, 'offline');
  assert.equal(normalized.managementKey, '');
  assert.doesNotMatch(raw, /deviceToken|authState|obsolete-secret|paired/);
  assert.deepEqual(JSON.parse(raw)[0], normalized);
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
    state: 'ready',
    managementKey: 'home-management-key'
  });
  profiles.saveControlPlaneProfile({
    endpoint: saved.endpoint,
    descriptor: saved.descriptor,
    state: 'degraded',
    managementKey: 'home-management-key',
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
    state: 'ready',
    managementKey: 'management-key',
    nodes: [],
    nodeCount: 1,
    accountCount: 0,
    activeAccountCount: 0,
    schedulableAccountCount: 0,
    sessionCount: 0,
    lastNodeSyncAt: 1,
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
  assert.equal(listed[0].state, 'ready');
  assert.equal(listed[0].managementKey, 'management-key');
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
    state: 'ready',
    managementKey: 'management-key'
  });
  const listed = profiles.listControlPlaneProfiles();

  assert.equal(listed.length, 1);
  assert.equal(listed[0].endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  delete global.window;
});

test('control plane profiles stay offline until a management key is configured', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const saved = profiles.saveControlPlaneProfile({
    name: 'Home AIH',
    endpoint: 'control.example.com/ui/',
    descriptor: createDescriptor(),
    state: 'offline'
  });

  assert.equal(saved.endpoint, 'https://control.example.com');
  assert.equal(saved.state, 'offline');
  assert.equal(saved.managementKey, '');
  assert.equal(profiles.listControlPlaneProfiles()[0].state, 'offline');
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
    state: 'offline'
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

test('control plane profiles become ready when a management key is configured', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://office.example.com',
    descriptor: createDescriptor('https://office.example.com'),
    managementKey: 'management-key'
  });

  assert.equal(saved.state, 'ready');
  assert.equal(saved.managementKey, 'management-key');
  delete global.window;
});

test('control plane profiles keep management key while marking descriptor failures degraded', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const ready = profiles.saveControlPlaneProfile({
    endpoint: 'https://lab.example.com',
    descriptor: createDescriptor('https://lab.example.com'),
    state: 'ready',
    managementKey: 'management-key'
  });
  const degraded = profiles.saveControlPlaneProfile({
    endpoint: ready.endpoint,
    descriptor: ready.descriptor,
    state: 'degraded',
    managementKey: ready.managementKey,
    lastError: 'descriptor_http_502'
  });

  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.managementKey, 'management-key');
  assert.equal(degraded.lastError, 'descriptor_http_502');
  delete global.window;
});

test('control plane profiles summarize multi server client readiness', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  const ready = profiles.saveControlPlaneProfile({
    endpoint: 'https://home.example.com',
    descriptor: createDescriptor('https://home.example.com'),
    state: 'ready',
    managementKey: 'home-management-key',
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
    managementKey: 'office-management-key',
    nodeCount: 1,
    accountCount: 2,
    activeAccountCount: 1,
    schedulableAccountCount: 1,
    sessionCount: 2
  });
  profiles.saveControlPlaneProfile({
    endpoint: 'https://offline.example.com',
    descriptor: createDescriptor('https://offline.example.com'),
    state: 'offline',
    nodeCount: 4,
    sessionCount: 1
  });

  const summary = profiles.summarizeControlPlaneProfiles(profiles.listControlPlaneProfiles());

  assert.equal(profiles.isControlPlaneProfileReady(ready), true);
  assert.equal(profiles.isControlPlaneProfileReady(degraded), false);
  assert.deepEqual(summary, {
    total: 3,
    ready: 1,
    degraded: 1,
    offline: 1,
    nodes: 7,
    accounts: 7,
    activeAccounts: 5,
    schedulableAccounts: 4,
    sessions: 10
  });
  delete global.window;
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
        detail: '还没有保存可切换的 Server'
      },
      {
        id: 'server-switching',
        label: '多服务器切换',
        status: 'blocked',
        detail: '需要先添加 Server 并配置 Management Key'
      },
      {
        id: 'active-server',
        label: '当前服务器',
        status: 'blocked',
        detail: '未选择当前服务器'
      },
      {
        id: 'management-key',
        label: 'Management Key',
        status: 'blocked',
        detail: '添加 Server 时需要保存 Management Key'
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
    state: 'ready',
    managementKey: 'home-management-key',
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
    managementKey: 'office-management-key',
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
      ['management-key', 'ready'],
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
    state: 'ready',
    managementKey: 'home-management-key',
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

test('control plane profiles refresh ready servers and degrade failed profiles in bulk', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  profiles.saveControlPlaneProfile({
    endpoint: 'https://home.example.com',
    descriptor: createDescriptor('https://home.example.com'),
    state: 'ready',
    managementKey: 'home-management-key'
  });
  profiles.saveControlPlaneProfile({
    endpoint: 'https://office.example.com',
    descriptor: createDescriptor('https://office.example.com'),
    state: 'ready',
    managementKey: 'office-management-key'
  });
  profiles.saveControlPlaneProfile({
    endpoint: 'https://offline.example.com',
    descriptor: createDescriptor('https://offline.example.com'),
    state: 'offline'
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
    if (parsed.pathname.endsWith('/v0/fabric/descriptor')) {
      return {
        ok: true,
        status: 200,
        json: async () => createDescriptor('https://home.example.com')
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
  const offline = saved.find((profile) => profile.endpoint === 'https://offline.example.com');

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
  assert.equal(office.managementKey, 'office-management-key');
  assert.equal(office.lastError, 'office_unreachable');
  assert.equal(offline.state, 'offline');
  assert.equal(profiles.isControlPlaneProfileRefreshable(offline), false);
  assert.equal(calls.some((call) => call.host === 'offline.example.com'), false);
  assert.equal(calls.every((call) => [
    '',
    'Bearer home-management-key',
    'Bearer office-management-key'
  ].includes(call.auth)), true);
  assert.equal(calls.some((call) => /management-key/.test(call.path)), false);
  delete global.window;
});

test('control plane profiles persist management key and refresh server node summary', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url: String(url),
      auth: String(init && init.headers && init.headers.authorization || '')
    });
    if (String(url).endsWith('/v0/fabric/descriptor')) {
      return {
        ok: true,
        status: 200,
        json: async () => createDescriptor('https://control.example.com')
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
    state: 'ready',
    managementKey: 'management-key'
  });
  const refreshed = await profiles.refreshControlPlaneDeviceState(saved, { fetchImpl });

  assert.equal(refreshed.profile.state, 'ready');
  assert.equal(refreshed.profile.managementKey, 'management-key');
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
    'https://control.example.com/v0/fabric/descriptor',
    'https://control.example.com/v0/node-rpc/device-nodes',
    'https://control.example.com/v0/node-rpc/device-status',
    'https://control.example.com/v0/node-rpc/device-accounts',
    'https://control.example.com/v0/node-rpc/device-sessions'
  ]);
  assert.deepEqual(calls.map((call) => call.auth), [
    '',
    'Bearer management-key',
    'Bearer management-key',
    'Bearer management-key',
    'Bearer management-key'
  ]);
  assert.equal(calls.some((call) => call.url.includes('management-key')), false);
  delete global.window;
});

test('control plane profiles fetch scoped session messages by public session ref', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const result = await profiles.fetchControlPlaneDeviceSessionMessages({
    endpoint: 'https://control.example.com',
    managementKey: 'management-key'
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
      auth: 'Bearer management-key'
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
    managementKey: 'management-key'
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
      auth: 'Bearer management-key'
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
  assert.doesNotMatch(calls[0].url, /management-key/);
});

test('control plane profiles fetch remote node session messages by public refs', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const result = await profiles.fetchControlPlaneDeviceNodeSessionMessages({
    endpoint: 'https://control.example.com/ui',
    managementKey: 'management-key'
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
      auth: 'Bearer management-key'
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
  assert.doesNotMatch(calls[0].url, /management-key/);
});

test('control plane profiles send remote node session input by public refs', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const result = await profiles.sendControlPlaneDeviceNodeSessionInput({
    endpoint: 'https://control.example.com/ui',
    managementKey: 'management-key'
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
      auth: 'Bearer management-key',
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
  assert.doesNotMatch(calls[0].url, /management-key/);
});

test('control plane profiles fetch scoped session events by public session ref and cursor', async () => {
  const profiles = loadControlPlaneProfilesModule();
  const calls = [];
  const result = await profiles.fetchControlPlaneDeviceSessionEvents({
    endpoint: 'https://control.example.com',
    managementKey: 'management-key'
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
      auth: 'Bearer management-key'
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
    managementKey: 'management-key'
  }, 'sess_0123456789abcdefabcd', {
    cursor: 4096,
    limit: 20,
    intervalMs: 750
  });

  assert.deepEqual(request, {
    url: 'https://control.example.com/v0/node-rpc/device-session-stream?sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750',
    headers: {
      accept: 'text/event-stream',
      authorization: 'Bearer management-key'
    }
  });
  assert.doesNotMatch(request.url, /management-key/);
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
    managementKey: 'management-key'
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
      auth: 'Bearer management-key',
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
    managementKey: 'management-key'
  }, 'office-pc', 'sess_0123456789abcdefabcd', {
    cursor: 4096,
    limit: 20,
    intervalMs: 750
  });

  assert.deepEqual(request, {
    url: 'https://control.example.com/v0/node-rpc/device-node-session-stream?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750',
    headers: {
      accept: 'text/event-stream',
      authorization: 'Bearer management-key'
    }
  });
  assert.doesNotMatch(request.url, /management-key/);
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
    managementKey: 'management-key'
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
      auth: 'Bearer management-key',
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

test('control plane profiles preserve management key during descriptor-only updates', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadControlPlaneProfilesModule();

  profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    nodeCount: 2,
    sessionCount: 8,
    lastNodeSyncAt: 1234
  });
  const updated = profiles.saveControlPlaneProfile({
    name: 'Renamed AIH',
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor()
  });

  assert.equal(updated.name, 'Renamed AIH');
  assert.equal(updated.state, 'ready');
  assert.equal(updated.managementKey, 'management-key');
  assert.equal(updated.nodeCount, 2);
  assert.equal(updated.sessionCount, 8);
  assert.equal(updated.lastNodeSyncAt, 1234);
  delete global.window;
});
