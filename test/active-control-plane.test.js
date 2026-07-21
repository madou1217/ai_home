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

function loadTsModule(relativePath) {
  const filename = path.join(__dirname, '..', relativePath);
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
      transports: ['direct', 'relay']
    }
  };
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

function createDeviceFetch(calls) {
  return async (url, init) => {
    const requestUrl = String(url);
    calls.push({
      url: requestUrl,
      auth: String(init && init.headers && init.headers.authorization || '')
    });
    if (requestUrl.endsWith('/v0/fabric/descriptor')) {
      return {
        ok: true,
        status: 200,
        json: async () => createDescriptor('https://control.example.com')
      };
    }
    if (requestUrl.endsWith('/v0/node-rpc/device-nodes')) {
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
                role: 'worker',
                endpointPolicy: 'auto',
                preferredTransports: ['relay'],
                capabilities: ['status', 'accounts'],
                tags: ['home'],
                transports: [
                  {
                    id: 'home-mac-relay',
                    nodeId: 'home-mac',
                    kind: 'relay',
                    status: 'up',
                    score: 80,
                    latencyMs: 90,
                    managedBy: 'aih',
                    provider: 'aih-relay',
                    routeRole: 'data-plane',
                    trustLevel: 'managed'
                  }
                ]
              }
            ]
          }
        })
      };
    }
    if (requestUrl.endsWith('/v0/node-rpc/device-status')) {
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
              uptimeSec: 20,
              backend: 'codex-adapter',
              providerMode: 'auto',
              strategy: 'round-robin',
              totalAccounts: 4,
              activeAccounts: 3,
              cooldownAccounts: 1,
              statusTotals: { healthy: 3, rate_limited: 1 },
              providers: {
                codex: { total: 4, active: 3, statuses: { healthy: 3, rate_limited: 1 } }
              },
              queue: {},
              queueTotals: {
                running: 1,
                queued: 2,
                totalScheduled: 9,
                totalRejected: 0
              },
              modelsCached: 7,
              modelsUpdatedAt: 1000,
              modelRegistryUpdatedAt: 2000,
              successRate: 0.8,
              timeoutRate: 0.05,
              totalRequests: 10
            }
          }
        })
      };
    }
    if (requestUrl.endsWith('/v0/node-rpc/device-accounts')) {
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
              }
            ],
            summary: {
              total: 1,
              active: 1,
              byProvider: { codex: 1 },
              byRuntimeStatus: { healthy: 1 },
              bySchedulableStatus: { schedulable: 1 }
            }
          }
        })
      };
    }
    if (requestUrl.endsWith('/v0/node-rpc/device-sessions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.sessions',
          result: {
            sessions: [],
            summary: {
              total: 2,
              returned: 0,
              byProvider: {},
              byStatus: { running: 2 },
              byProject: {},
              recentlyUpdatedAt: 3000
            }
          }
        })
      };
    }
    if (requestUrl.includes('/v0/node-rpc/device-session-messages?')) {
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
              title: 'Remote chat',
              projectName: 'AI Home',
              status: 'running',
              updatedAt: 2000,
              startedAt: 1000
            },
            messages: [
              { role: 'user', content: 'please continue', timestamp: 1500 },
              { role: 'assistant', content: 'continuing now', timestamp: 2000 }
            ],
            summary: {
              total: 2,
              returned: 2,
              truncated: false,
              cursor: 4096
            }
          }
        })
      };
    }
    if (requestUrl.includes('/v0/node-rpc/device-session-events?')) {
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
              title: 'Remote chat',
              projectName: 'AI Home',
              status: 'running',
              updatedAt: 2000,
              startedAt: 1000
            },
            events: [
              { type: 'user_message', content: 'please continue', timestamp: '2026-06-19T00:00:00.000Z' },
              { type: 'assistant_text', text: 'continuing now', timestamp: '2026-06-19T00:00:01.000Z' }
            ],
            cursor: 8192,
            requiresSnapshot: false,
            truncated: false
          }
        })
      };
    }
    throw new Error(`unexpected request ${requestUrl}`);
  };
}

test('active control plane context reports readiness and unavailable reasons', () => {
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const profiles = [
    createProfile('cp-missing-key'),
    createProfile('cp-ready', {
      state: 'ready',
      managementKey: 'management-key'
    }),
    createProfile('cp-offline', {
      state: 'offline',
      managementKey: 'management-key'
    }),
    createProfile('cp-degraded', {
      state: 'degraded',
      managementKey: 'management-key'
    })
  ];

  assert.deepEqual(
    activeControlPlane.resolveActiveControlPlaneContext([], ''),
    {
      profile: null,
      profileId: '',
      source: 'none',
      ready: false,
      reason: 'missing'
    }
  );
  assert.equal(
    activeControlPlane.resolveActiveControlPlaneContext(profiles, 'cp-missing-key').reason,
    'missing-key'
  );
  assert.equal(
    activeControlPlane.resolveActiveControlPlaneContext(profiles, 'cp-offline').reason,
    'offline'
  );
  assert.equal(
    activeControlPlane.resolveActiveControlPlaneContext(profiles, 'cp-degraded').reason,
    'degraded'
  );
  const context = activeControlPlane.resolveActiveControlPlaneContext(profiles, 'cp-ready');
  assert.equal(context.ready, true);
  assert.equal(context.reason, 'ready');
  assert.equal(context.profileId, 'cp-ready');
});

test('active control plane result freshness follows current resolved profile', () => {
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const profiles = [
    createProfile('cp-home', {
      state: 'ready',
      managementKey: 'home-management-key'
    }),
    createProfile('cp-office', {
      state: 'ready',
      managementKey: 'office-management-key'
    })
  ];

  assert.equal(
    activeControlPlane.isActiveControlPlaneResultCurrent({ activeProfileId: 'cp-home' }, profiles, 'cp-home'),
    true
  );
  assert.equal(
    activeControlPlane.isActiveControlPlaneResultCurrent({ activeProfileId: 'cp-home' }, profiles, 'cp-office'),
    false
  );
  assert.equal(
    activeControlPlane.isActiveControlPlaneResultCurrent({ activeProfileId: 'cp-home' }, profiles, 'missing-profile'),
    true
  );
  assert.equal(
    activeControlPlane.isActiveControlPlaneResultCurrent({ activeProfileId: '' }, profiles, 'cp-home'),
    false
  );
});

test('active control plane context preserves an explicitly selected offline server', () => {
  global.window = { localStorage: createStorage() };
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const profiles = [
    createProfile('cp-offline', {
      state: 'offline',
      managementKey: 'management-key'
    }),
    createProfile('cp-ready', {
      state: 'ready',
      managementKey: 'management-key'
    })
  ];
  selection.setActiveControlPlaneProfileId('cp-offline', global.window.localStorage);

  const resolved = activeControlPlane.resolveActiveControlPlaneContext(profiles);

  assert.equal(resolved.profileId, 'cp-offline');
  assert.equal(resolved.profile.id, 'cp-offline');
  assert.equal(resolved.source, 'stored');
  assert.equal(resolved.ready, false);
  assert.equal(resolved.reason, 'offline');
  delete global.window;
});

test('active control plane refreshes selected server state with bearer management key', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key'
  });
  selection.setActiveControlPlaneProfileId(saved.id);
  const calls = [];

  const snapshot = await activeControlPlane.refreshActiveControlPlaneDeviceState({
    fetchImpl: createDeviceFetch(calls)
  });

  assert.equal(snapshot.activeProfileId, saved.id);
  assert.equal(snapshot.activeProfileSource, 'stored');
  assert.equal(snapshot.profile.nodeCount, 1);
  assert.equal(snapshot.profile.accountCount, 4);
  assert.equal(snapshot.profile.activeAccountCount, 3);
  assert.equal(snapshot.profile.schedulableAccountCount, 1);
  assert.equal(snapshot.profile.sessionCount, 2);
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

test('active control plane marks selected profile degraded when sync fails', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key'
  });
  selection.setActiveControlPlaneProfileId(saved.id);

  await assert.rejects(
    () => activeControlPlane.refreshActiveControlPlaneDeviceState({
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ ok: false })
      })
    }),
    /fabric_descriptor_http_503/
  );

  const [degraded] = profiles.listControlPlaneProfiles();
  assert.equal(degraded.id, saved.id);
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.managementKey, 'management-key');
  assert.equal(degraded.lastError, 'fabric_descriptor_http_503');
  delete global.window;
});

test('active control plane reads scoped account summaries without full device refresh', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    nodeCount: 9,
    sessionCount: 12
  });
  selection.setActiveControlPlaneProfileId(saved.id);
  const calls = [];

  const result = await activeControlPlane.readActiveControlPlaneDeviceAccounts({
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
                label: 'claude-key',
                status: 'down',
                authMode: 'api-key',
                planType: 'api-key',
                runtimeStatus: 'auth_invalid',
                quotaStatus: 'unknown',
                schedulableStatus: 'blocked_by_auth',
                remainingPct: null,
                modelCooldownCount: 0,
                lastRefresh: 0,
                successCount: 0,
                failCount: 3
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
  });

  assert.equal(result.activeProfileId, saved.id);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accountSummary.total, 2);
  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-accounts',
      auth: 'Bearer management-key'
    }
  ]);
  const [updated] = profiles.listControlPlaneProfiles();
  assert.equal(updated.nodeCount, 9);
  assert.equal(updated.sessionCount, 12);
  assert.equal(updated.accountCount, 2);
  assert.equal(updated.activeAccountCount, 1);
  assert.equal(updated.schedulableAccountCount, 1);
  assert.equal(updated.lastError, '');
  assert.ok(updated.lastAccountsSyncAt > 0);
  delete global.window;
});

test('active control plane reads remote node summaries without full device refresh', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    accountCount: 7,
    activeAccountCount: 6,
    sessionCount: 12
  });
  selection.setActiveControlPlaneProfileId(saved.id);
  const calls = [];

  const result = await activeControlPlane.readActiveControlPlaneDeviceNodes({
    fetchImpl: createDeviceFetch(calls)
  });

  assert.equal(result.activeProfileId, saved.id);
  assert.equal(result.activeProfileSource, 'stored');
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].id, 'home-mac');
  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-nodes',
      auth: 'Bearer management-key'
    }
  ]);
  const [updated] = profiles.listControlPlaneProfiles();
  assert.equal(updated.nodeCount, 1);
  assert.equal(updated.nodes.length, 1);
  assert.equal(updated.nodes[0].id, 'home-mac');
  assert.equal(updated.nodes[0].connection.status, 'unknown');
  assert.equal(updated.nodes[0].transports[0].kind, 'relay');
  assert.equal(updated.accountCount, 7);
  assert.equal(updated.activeAccountCount, 6);
  assert.equal(updated.sessionCount, 12);
  assert.equal(updated.lastError, '');
  assert.ok(updated.lastNodeSyncAt > 0);
  delete global.window;
});

test('active control plane reads scoped session summaries without full device refresh', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    nodeCount: 3,
    accountCount: 7,
    activeAccountCount: 6
  });
  selection.setActiveControlPlaneProfileId(saved.id);
  const calls = [];

  const result = await activeControlPlane.readActiveControlPlaneDeviceSessions({
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
          rpc: 'control_plane.device.sessions',
          result: {
            sessions: [
              {
                sessionRef: 'sess_0123456789abcdefabcd',
                projectRef: 'proj_0123456789abcdefabcd',
                provider: 'codex',
                title: 'Remote chat',
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
              total: 2,
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

  assert.equal(result.activeProfileId, saved.id);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessionSummary.total, 2);
  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-sessions',
      auth: 'Bearer management-key'
    }
  ]);
  const [updated] = profiles.listControlPlaneProfiles();
  assert.equal(updated.nodeCount, 3);
  assert.equal(updated.accountCount, 7);
  assert.equal(updated.activeAccountCount, 6);
  assert.equal(updated.sessionCount, 2);
  assert.equal(updated.lastError, '');
  assert.ok(updated.lastSessionsSyncAt > 0);
  delete global.window;
});

test('active control plane reads remote node sessions by node id', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    nodeCount: 3,
    accountCount: 7,
    activeAccountCount: 6,
    sessionCount: 12
  });
  selection.setActiveControlPlaneProfileId(saved.id);
  const calls = [];

  const result = await activeControlPlane.readActiveControlPlaneDeviceNodeSessions('office-pc', {
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

  assert.equal(result.activeProfileId, saved.id);
  assert.equal(result.activeProfileSource, 'stored');
  assert.equal(result.nodeId, 'office-pc');
  assert.deepEqual(result.sessions.map((session) => [session.sessionRef, session.provider, session.status]), [
    ['sess_0123456789abcdefabcd', 'codex', 'running'],
    ['sess_abcdefabcdefabcdefab', 'claude', 'idle']
  ]);
  assert.equal(result.sessionSummary.total, 3);
  assert.equal(result.sessionSummary.returned, 2);
  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-node-sessions?nodeId=office-pc&limit=2',
      auth: 'Bearer management-key'
    }
  ]);
  const [updated] = profiles.listControlPlaneProfiles();
  assert.equal(updated.nodeCount, 3);
  assert.equal(updated.accountCount, 7);
  assert.equal(updated.activeAccountCount, 6);
  assert.equal(updated.sessionCount, 12);
  assert.equal(updated.lastError, '');
  assert.ok(updated.lastSessionsSyncAt > 0);
  delete global.window;
});

test('active control plane reads scoped session messages by public session ref', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    sessionCount: 2
  });
  selection.setActiveControlPlaneProfileId(saved.id);
  const calls = [];

  const result = await activeControlPlane.readActiveControlPlaneDeviceSessionMessages(
    'sess_0123456789abcdefabcd',
    {
      limit: 2,
      fetchImpl: createDeviceFetch(calls)
    }
  );

  assert.equal(result.activeProfileId, saved.id);
  assert.equal(result.session.sessionRef, 'sess_0123456789abcdefabcd');
  assert.equal(result.messageSummary.cursor, 4096);
  assert.deepEqual(result.messages.map((message) => [message.role, message.content]), [
    ['user', 'please continue'],
    ['assistant', 'continuing now']
  ]);
  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-session-messages?sessionRef=sess_0123456789abcdefabcd&limit=2',
      auth: 'Bearer management-key'
    }
  ]);
  const [updated] = profiles.listControlPlaneProfiles();
  assert.equal(updated.id, saved.id);
  assert.equal(updated.sessionCount, 2);
  assert.equal(updated.lastError, '');
  assert.ok(updated.lastSessionsSyncAt > 0);
  delete global.window;
});

test('active control plane sends remote node session input by public refs', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    sessionCount: 2
  });
  selection.setActiveControlPlaneProfileId(saved.id);
  const calls = [];

  const result = await activeControlPlane.sendActiveControlPlaneDeviceNodeSessionInput(
    'office-pc',
    'sess_0123456789abcdefabcd',
    'remote yes',
    {
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
    }
  );

  assert.equal(result.activeProfileId, saved.id);
  assert.equal(result.nodeId, 'office-pc');
  assert.equal(result.session.sessionRef, 'sess_0123456789abcdefabcd');
  assert.equal(result.accepted, true);
  assert.equal(result.appendNewline, false);
  assert.equal(result.promptId, 'codex-plan-active');
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
  const [updated] = profiles.listControlPlaneProfiles();
  assert.equal(updated.id, saved.id);
  assert.equal(updated.lastError, '');
  assert.ok(updated.lastSessionsSyncAt > 0);
  delete global.window;
});

test('active control plane reads scoped session events by public session ref and cursor', async () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    sessionCount: 2
  });
  selection.setActiveControlPlaneProfileId(saved.id);
  const calls = [];

  const result = await activeControlPlane.readActiveControlPlaneDeviceSessionEvents(
    'sess_0123456789abcdefabcd',
    {
      cursor: 4096,
      limit: 20,
      fetchImpl: createDeviceFetch(calls)
    }
  );

  assert.equal(result.activeProfileId, saved.id);
  assert.equal(result.session.sessionRef, 'sess_0123456789abcdefabcd');
  assert.equal(result.cursor, 8192);
  assert.equal(result.requiresSnapshot, false);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.events, [
    { type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'please continue' },
    { type: 'assistant_text', timestamp: '2026-06-19T00:00:01.000Z', text: 'continuing now' }
  ]);
  assert.deepEqual(calls, [
    {
      url: 'https://control.example.com/v0/node-rpc/device-session-events?sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20',
      auth: 'Bearer management-key'
    }
  ]);
  const [updated] = profiles.listControlPlaneProfiles();
  assert.equal(updated.id, saved.id);
  assert.equal(updated.sessionCount, 2);
  assert.equal(updated.lastError, '');
  assert.ok(updated.lastSessionsSyncAt > 0);
  delete global.window;
});

test('active control plane builds scoped session stream request from selected profile', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com/ui',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    sessionCount: 2
  });
  selection.setActiveControlPlaneProfileId(saved.id);

  const request = activeControlPlane.buildActiveControlPlaneDeviceSessionStreamRequest(
    'sess_0123456789abcdefabcd',
    {
      cursor: 4096,
      limit: 20,
      intervalMs: 750
    }
  );

  assert.equal(request.activeProfileId, saved.id);
  assert.equal(request.activeProfileSource, 'stored');
  assert.deepEqual({
    url: request.url,
    headers: request.headers
  }, {
    url: 'https://control.example.com/v0/node-rpc/device-session-stream?sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750',
    headers: {
      accept: 'text/event-stream',
      authorization: 'Bearer management-key'
    }
  });
  assert.doesNotMatch(request.url, /management-key/);
  delete global.window;
});

test('active control plane builds scoped remote node session stream request from selected profile', () => {
  global.window = { localStorage: createStorage() };
  const profiles = loadTsModule('web/src/services/control-plane-profiles.ts');
  const selection = loadTsModule('web/src/services/control-plane-selection.ts');
  const activeControlPlane = loadTsModule('web/src/services/active-control-plane.ts');
  const saved = profiles.saveControlPlaneProfile({
    endpoint: 'https://control.example.com/ui',
    descriptor: createDescriptor(),
    state: 'ready',
    managementKey: 'management-key',
    sessionCount: 2
  });
  selection.setActiveControlPlaneProfileId(saved.id);

  const request = activeControlPlane.buildActiveControlPlaneDeviceNodeSessionStreamRequest(
    'office-pc',
    'sess_0123456789abcdefabcd',
    {
      cursor: 4096,
      limit: 20,
      intervalMs: 750
    }
  );

  assert.equal(request.activeProfileId, saved.id);
  assert.equal(request.activeProfileSource, 'stored');
  assert.deepEqual({
    url: request.url,
    headers: request.headers
  }, {
    url: 'https://control.example.com/v0/node-rpc/device-node-session-stream?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750',
    headers: {
      accept: 'text/event-stream',
      authorization: 'Bearer management-key'
    }
  });
  assert.doesNotMatch(request.url, /management-key/);
  delete global.window;
});
