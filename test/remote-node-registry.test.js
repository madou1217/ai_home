const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  getRemoteRegistryPath,
  readRemoteRegistry
} = require('../lib/server/remote/remote-registry-store');
const {
  listRemoteNodes,
  upsertRemoteNode
} = require('../lib/server/remote/node-registry');
const {
  getTransportKindCatalog,
  listNodeTransports,
  transportSupportsRemoteRequest,
  upsertRemoteTransport
} = require('../lib/server/remote/transport-registry');
const {
  getRemoteSecretPath,
  readRemoteSecret,
  writeRemoteSecret
} = require('../lib/server/remote/secret-store');
const {
  selectTransport,
  selectTransportDecision
} = require('../lib/server/remote/transport-selector');
const { buildRemoteTransportStrategies } = require('../lib/server/remote/transport-strategies');
const {
  inferTransportPurpose,
  requestRemoteManagement,
  streamRemoteManagement
} = require('../lib/server/remote/remote-gateway');
const { appendSearch } = require('../lib/server/remote/remote-management-routes');
const { listRemoteNodeViews } = require('../lib/server/remote/remote-node-view');
const { getRemoteAuditLogPath } = require('../lib/server/remote/audit-log');
const {
  buildRemoteNodeIdentity,
  normalizeCloneRepoUrl,
  resolveMachineId
} = require('../lib/server/remote/node-defaults');

test('remote node identity prefers machine id over ai home directory', () => {
  const baseDeps = {
    hostname: () => 'Office PC',
    platform: 'linux',
    arch: 'x64',
    machineId: '12345678-90ab-cdef-1234-567890abcdef'
  };

  const first = buildRemoteNodeIdentity({}, { ...baseDeps, aiHomeDir: '/tmp/aih-a' });
  const second = buildRemoteNodeIdentity({}, { ...baseDeps, aiHomeDir: '/tmp/aih-b' });

  assert.equal(first.name, 'Office PC');
  assert.equal(first.nodeId, second.nodeId);
  assert.match(first.nodeId, /^office-pc-[a-f0-9]{8}$/);
  assert.doesNotMatch(first.nodeId, /12345678|90ab|cdef/);
});

test('remote node identity falls back to install scoped seed without machine id', () => {
  const baseDeps = {
    hostname: () => 'Office PC',
    platform: 'linux',
    arch: 'x64',
    machineId: ''
  };

  const first = buildRemoteNodeIdentity({}, { ...baseDeps, aiHomeDir: '/tmp/aih-a' });
  const second = buildRemoteNodeIdentity({}, { ...baseDeps, aiHomeDir: '/tmp/aih-b' });

  assert.notEqual(first.nodeId, second.nodeId);
  assert.match(first.nodeId, /^office-pc-[a-f0-9]{8}$/);
  assert.match(second.nodeId, /^office-pc-[a-f0-9]{8}$/);
});

test('remote node identity reads platform machine identifiers', () => {
  assert.equal(resolveMachineId({
    platform: 'linux',
    fs: {
      readFileSync(filePath) {
        if (filePath === '/etc/machine-id') return 'abcdef1234567890abcdef1234567890\n';
        throw new Error('not found');
      }
    }
  }), 'abcdef1234567890abcdef1234567890');

  assert.equal(resolveMachineId({
    platform: 'darwin',
    spawnSync: () => ({
      status: 0,
      stdout: '    "IOPlatformUUID" = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"\n'
    })
  }), 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');

  assert.equal(resolveMachineId({
    platform: 'win32',
    spawnSync: () => ({
      status: 0,
      stdout: '    MachineGuid    REG_SZ    11111111-2222-3333-4444-555555555555\r\n'
    })
  }), '11111111-2222-3333-4444-555555555555');
});

test('remote node defaults normalize git ssh origins to clone-friendly https urls', () => {
  assert.equal(
    normalizeCloneRepoUrl('git@github.com:madou1217/ai_home.git'),
    'https://github.com/madou1217/ai_home.git'
  );
  assert.equal(
    normalizeCloneRepoUrl('ssh://git@gitlab.com/group/ai_home.git'),
    'https://gitlab.com/group/ai_home.git'
  );
  assert.equal(
    normalizeCloneRepoUrl('https://github.com/madou1217/ai_home.git'),
    'https://github.com/madou1217/ai_home.git'
  );
  assert.equal(
    normalizeCloneRepoUrl('ssh://deploy@example.com/ai_home.git'),
    'ssh://deploy@example.com/ai_home.git'
  );
  assert.equal(
    normalizeCloneRepoUrl('ssh://git@example.com:2222/ai_home.git'),
    'ssh://git@example.com:2222/ai_home.git'
  );
});

test('remote node registry stores nodes and transports without credential payloads', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-registry-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  const node = upsertRemoteNode({
    id: 'home-mac',
    name: 'Home Mac',
    preferredTransports: ['tailscale', 'frp', 'direct'],
    capabilities: ['status', 'accounts']
  }, deps);
  const transport = upsertRemoteTransport({
    id: 'home-mac-tailscale',
    nodeId: node.id,
    kind: 'tailscale',
    endpoint: 'http://100.64.0.10:9527/',
    score: 70,
    status: 'up',
    provider: 'tailscale',
    routeRole: 'data-plane',
    trustLevel: 'verified'
  }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'mgmt-secret' }, deps);

  assert.equal(node.id, 'home-mac');
  assert.equal(transport.endpoint, 'http://100.64.0.10:9527');
  assert.equal(transport.provider, 'tailscale');
  assert.equal(transport.routeRole, 'data-plane');
  assert.equal(transport.trustLevel, 'verified');
  assert.equal(listRemoteNodes(deps).length, 1);
  assert.equal(listNodeTransports('home-mac', deps).length, 1);
  assert.equal(readRemoteSecret(node.authRef, deps).managementKey, 'mgmt-secret');

  const registryText = fs.readFileSync(getRemoteRegistryPath(aiHomeDir), 'utf8');
  assert.doesNotMatch(registryText, /mgmt-secret/);
  assert.match(fs.readFileSync(getRemoteSecretPath(aiHomeDir), 'utf8'), /mgmt-secret/);
  assert.equal(readRemoteRegistry(deps).version, 1);
});

test('remote transport selector prefers healthy preferred HTTP transports', () => {
  const node = {
    preferredTransports: ['frp', 'direct']
  };
  const selected = selectTransport(node, [
    { id: 'relay', kind: 'relay', endpoint: 'relay://home-mac', score: 100, status: 'up' },
    { id: 'direct', kind: 'direct', endpoint: 'http://direct.example.com', score: 50, status: 'up', latencyMs: 20 },
    { id: 'frp', kind: 'frp', endpoint: 'https://frp.example.com', score: 50, status: 'up', latencyMs: 20 }
  ]);

  assert.equal(selected.id, 'frp');
});

test('remote relay transport is a normalized fallback for remote requests', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-transport-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  upsertRemoteNode({ id: 'home-mac', name: 'Home Mac' }, deps);
  const relay = upsertRemoteTransport({
    id: 'home-mac-relay',
    nodeId: 'home-mac',
    kind: 'relay',
    status: 'up',
    score: 55
  }, deps);
  assert.equal(relay.endpoint, 'relay://home-mac');
  assert.equal(transportSupportsRemoteRequest(relay), true);

  const selected = selectTransport({ preferredTransports: ['relay'] }, [
    relay
  ], { purpose: 'read' });
  assert.equal(selected.id, 'home-mac-relay');
});

test('remote transport catalog keeps WebRTC and WebTransport as candidate-only transports', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-transport-candidates-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  upsertRemoteNode({
    id: 'home-mac',
    name: 'Home Mac',
    preferredTransports: ['webrtc', 'webtransport', 'relay']
  }, deps);
  const webrtc = upsertRemoteTransport({
    id: 'home-mac-webrtc',
    nodeId: 'home-mac',
    kind: 'webrtc',
    endpoint: 'http://control.example.com:9527',
    status: 'up',
    score: 100
  }, deps);
  const webtransport = upsertRemoteTransport({
    id: 'home-mac-webtransport',
    nodeId: 'home-mac',
    kind: 'webtransport',
    endpoint: 'https://control.example.com:9527',
    status: 'up',
    score: 100
  }, deps);
  const catalog = getTransportKindCatalog();

  assert.equal(webrtc.kind, 'webrtc');
  assert.equal(webtransport.kind, 'webtransport');
  assert.equal(catalog.webrtc.lane, 'candidate');
  assert.equal(catalog.webtransport.endpointMode, 'https-h3');
  assert.equal(transportSupportsRemoteRequest(webrtc), false);
  assert.equal(transportSupportsRemoteRequest(webtransport), false);

  const promotedWebrtc = upsertRemoteTransport({
    id: 'home-mac-webrtc-promoted',
    nodeId: 'home-mac',
    kind: 'webrtc',
    endpoint: 'http://control.example.com:9527',
    status: 'up',
    score: 100,
    promotion: {
      remoteRequestReady: true,
      mode: 'direct',
      evidenceRef: 'docs/fabric/evidence/example.md',
      rttP95Ms: 201,
      rpcP95Ms: 205,
      promotedAt: 1000
    }
  }, deps);

  assert.equal(transportSupportsRemoteRequest(promotedWebrtc), true);
  assert.equal(promotedWebrtc.promotion.remoteRequestReady, true);
  assert.equal(promotedWebrtc.promotion.mode, 'direct');
});

test('remote transport upsert clears previous promotion when promotion is explicitly null', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-clear-promotion-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  upsertRemoteTransport({
    id: 'home-mac-webrtc',
    nodeId: 'home-mac',
    kind: 'webrtc',
    endpoint: 'http://control.example.com:9527',
    status: 'up',
    score: 100,
    promotion: {
      remoteRequestReady: true,
      mode: 'direct',
      evidenceRef: 'docs/fabric/evidence/example.md',
      promotedAt: 1000
    }
  }, deps);

  const cleared = upsertRemoteTransport({
    id: 'home-mac-webrtc',
    nodeId: 'home-mac',
    kind: 'webrtc',
    endpoint: 'webrtc://home-mac',
    status: 'up',
    score: 80,
    promotion: null
  }, deps);

  assert.equal(cleared.promotion, undefined);
  assert.equal(transportSupportsRemoteRequest(cleared), false);
  assert.equal(listNodeTransports('home-mac', deps)[0].promotion, undefined);
});

test('remote transport selector falls back to relay when WebRTC candidate is not promoted', () => {
  const node = {
    preferredTransports: ['webrtc', 'relay']
  };
  const transports = [
    {
      id: 'home-mac-webrtc',
      kind: 'webrtc',
      endpoint: 'http://control.example.com:9527',
      status: 'up',
      score: 100
    },
    {
      id: 'home-mac-relay',
      kind: 'relay',
      endpoint: 'relay://home-mac',
      status: 'up',
      score: 55
    }
  ];

  const selected = selectTransport(node, transports, { purpose: 'runtime' });
  const decision = selectTransportDecision(node, transports, { purpose: 'runtime' });

  assert.equal(selected.id, 'home-mac-relay');
  assert.equal(decision.selectedTransportId, 'home-mac-relay');
  assert.equal(decision.fallbackUsed, true);
  assert.deepEqual(decision.fallbackFrom, ['webrtc']);
  assert.deepEqual(decision.rejected, [
    {
      id: 'home-mac-webrtc',
      kind: 'webrtc',
      reason: 'webrtc_not_promoted'
    }
  ]);
});

test('remote transport selector requires a WebRTC adapter after promotion', () => {
  const node = {
    preferredTransports: ['webrtc', 'relay']
  };
  const transports = [
    {
      id: 'home-mac-webrtc',
      kind: 'webrtc',
      endpoint: 'http://control.example.com:9527',
      status: 'up',
      score: 100,
      promotion: { remoteRequestReady: true, promotedAt: 1000 }
    },
    {
      id: 'home-mac-relay',
      kind: 'relay',
      endpoint: 'relay://home-mac',
      status: 'up',
      score: 55
    }
  ];

  const missingAdapter = selectTransportDecision(node, transports, { purpose: 'runtime' });
  assert.equal(missingAdapter.selectedTransportId, 'home-mac-relay');
  assert.deepEqual(missingAdapter.fallbackFrom, ['webrtc']);
  assert.deepEqual(missingAdapter.rejected, [
    {
      id: 'home-mac-webrtc',
      kind: 'webrtc',
      reason: 'webrtc_adapter_not_available'
    }
  ]);

  const withAdapter = selectTransportDecision(node, transports, {
    purpose: 'runtime',
    availableAdapters: ['webrtc']
  });
  assert.equal(withAdapter.selectedTransportId, 'home-mac-webrtc');
  assert.equal(withAdapter.selectedKind, 'webrtc');
  assert.equal(withAdapter.fallbackUsed, false);
  assert.deepEqual(withAdapter.rejected, []);
});

test('remote gateway records transport promotion fallback decision in result and audit', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-gateway-decision-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const node = {
    id: 'home-mac',
    preferredTransports: ['webrtc', 'relay']
  };
  const transports = [
    {
      id: 'home-mac-webrtc',
      kind: 'webrtc',
      endpoint: 'http://control.example.com:9527',
      status: 'up',
      score: 100
    },
    {
      id: 'home-mac-relay',
      kind: 'relay',
      endpoint: 'relay://home-mac',
      status: 'up',
      score: 55
    }
  ];

  const result = await requestRemoteManagement({
    node,
    transports,
    purpose: 'runtime',
    rpc: 'session-start',
    pathname: '/v0/node-rpc/session-start'
  }, {
    fs,
    aiHomeDir,
    requestRelayManagement: async () => ({
      status: 200,
      ok: true,
      payload: { ok: true }
    })
  });

  assert.equal(result.transport.id, 'home-mac-relay');
  assert.equal(result.transportDecision.transportPurpose, 'runtime');
  assert.equal(result.transportDecision.fallbackUsed, true);
  assert.deepEqual(result.transportDecision.fallbackFrom, ['webrtc']);
  assert.deepEqual(result.transportDecision.rejectedTransports, [
    {
      id: 'home-mac-webrtc',
      kind: 'webrtc',
      reason: 'webrtc_not_promoted'
    }
  ]);

  const auditLine = fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8').trim();
  const audit = JSON.parse(auditLine);
  assert.equal(audit.transportId, 'home-mac-relay');
  assert.equal(audit.transportKind, 'relay');
  assert.equal(audit.transportPurpose, 'runtime');
  assert.equal(audit.fallbackUsed, true);
  assert.deepEqual(audit.fallbackFrom, ['webrtc']);
  assert.deepEqual(audit.rejectedTransports, result.transportDecision.rejectedTransports);
});

test('remote gateway uses promoted WebRTC when an adapter is available', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-gateway-webrtc-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const node = {
    id: 'home-mac',
    preferredTransports: ['webrtc', 'relay']
  };
  const transports = [
    {
      id: 'home-mac-webrtc',
      kind: 'webrtc',
      endpoint: 'http://control.example.com:9527',
      status: 'up',
      score: 100,
      promotion: { remoteRequestReady: true, promotedAt: 1000 }
    },
    {
      id: 'home-mac-relay',
      kind: 'relay',
      endpoint: 'relay://home-mac',
      status: 'up',
      score: 55
    }
  ];

  const result = await requestRemoteManagement({
    node,
    transports,
    purpose: 'runtime',
    rpc: 'session-start',
    pathname: '/v0/node-rpc/session-start'
  }, {
    fs,
    aiHomeDir,
    requestWebrtcManagement: async (input) => ({
      status: 200,
      ok: true,
      payload: {
        ok: true,
        via: input.transport.kind
      }
    }),
    requestRelayManagement: async () => {
      throw new Error('relay_should_not_be_used');
    }
  });

  assert.equal(result.transport.id, 'home-mac-webrtc');
  assert.equal(result.transportDecision.selectedTransportKind, 'webrtc');
  assert.equal(result.transportDecision.fallbackUsed, false);
  assert.deepEqual(result.transportDecision.rejectedTransports, []);
  assert.deepEqual(result.payload, { ok: true, via: 'webrtc' });

  const auditLine = fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8').trim();
  const audit = JSON.parse(auditLine);
  assert.equal(audit.transportId, 'home-mac-webrtc');
  assert.equal(audit.transportKind, 'webrtc');
  assert.equal(audit.fallbackUsed, false);
});

test('remote gateway waits for a promoted WebRTC session before relay fallback for session RPC', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-gateway-webrtc-recover-gap-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const node = {
    id: 'aws-current-node',
    preferredTransports: ['webrtc', 'relay']
  };
  const transports = [
    {
      id: 'aws-current-node-webrtc',
      kind: 'webrtc',
      endpoint: 'http://control.example.com:9527',
      status: 'up',
      score: 100,
      promotion: { remoteRequestReady: true, promotedAt: 1000 }
    },
    {
      id: 'aws-current-node-relay',
      kind: 'relay',
      endpoint: 'relay://aws-current-node',
      status: 'up',
      score: 55
    }
  ];
  const calls = [];
  let webRtcOpen = false;

  const result = await requestRemoteManagement({
    node,
    transports,
    rpc: 'session-start',
    pathname: '/v0/node-rpc/session-start'
  }, {
    fs,
    aiHomeDir,
    hasWebrtcManagementSession: () => webRtcOpen,
    waitForWebrtcManagementSession: async (_nodeId, options) => {
      calls.push(`wait:${options.timeoutMs}`);
      webRtcOpen = true;
      return true;
    },
    requestWebrtcManagement: async (input) => {
      calls.push('webrtc');
      return {
        status: 200,
        ok: true,
        payload: {
          ok: true,
          via: input.transport.kind
        }
      };
    },
    requestRelayManagement: async () => {
      calls.push('relay');
      throw new Error('relay_should_not_be_used');
    }
  });

  assert.deepEqual(calls, ['wait:6000', 'webrtc']);
  assert.equal(result.transport.id, 'aws-current-node-webrtc');
  assert.equal(result.transportDecision.selectedTransportKind, 'webrtc');
  assert.equal(result.transportDecision.fallbackUsed, false);
  assert.deepEqual(result.payload, { ok: true, via: 'webrtc' });

  const audit = JSON.parse(fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8').trim());
  assert.equal(audit.transportId, 'aws-current-node-webrtc');
  assert.equal(audit.transportKind, 'webrtc');
  assert.equal(audit.fallbackUsed, false);
});

test('remote gateway retries WebRTC once when the selected session closes during session RPC', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-gateway-webrtc-retry-closed-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const node = {
    id: 'aws-current-node',
    preferredTransports: ['webrtc', 'relay']
  };
  const transports = [
    {
      id: 'aws-current-node-webrtc',
      kind: 'webrtc',
      endpoint: 'http://control.example.com:9527',
      status: 'up',
      score: 100,
      promotion: { remoteRequestReady: true, promotedAt: 1000 }
    },
    {
      id: 'aws-current-node-relay',
      kind: 'relay',
      endpoint: 'relay://aws-current-node',
      status: 'up',
      score: 55
    }
  ];
  const calls = [];
  let requestCount = 0;

  const result = await requestRemoteManagement({
    node,
    transports,
    rpc: 'session-start',
    pathname: '/v0/node-rpc/session-start'
  }, {
    fs,
    aiHomeDir,
    hasWebrtcManagementSession: () => true,
    waitForWebrtcManagementSession: async (_nodeId, options) => {
      calls.push(`wait:${options.timeoutMs}`);
      return true;
    },
    requestWebrtcManagement: async (input) => {
      requestCount += 1;
      calls.push(`webrtc:${requestCount}`);
      if (requestCount === 1) {
        const error = new Error('remote_webrtc_session_closed');
        error.code = 'remote_webrtc_session_closed';
        error.status = 503;
        throw error;
      }
      return {
        status: 200,
        ok: true,
        payload: {
          ok: true,
          via: input.transport.kind
        }
      };
    },
    requestRelayManagement: async () => {
      calls.push('relay');
      throw new Error('relay_should_not_be_used');
    }
  });

  assert.deepEqual(calls, ['webrtc:1', 'wait:6000', 'webrtc:2']);
  assert.equal(result.transport.id, 'aws-current-node-webrtc');
  assert.equal(result.transportDecision.selectedTransportKind, 'webrtc');
  assert.equal(result.transportDecision.fallbackUsed, false);
  assert.deepEqual(result.payload, { ok: true, via: 'webrtc' });

  const audit = JSON.parse(fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8').trim());
  assert.equal(audit.transportId, 'aws-current-node-webrtc');
  assert.equal(audit.transportKind, 'webrtc');
  assert.equal(audit.fallbackUsed, false);
});

test('remote gateway falls back to relay when selected WebRTC session closes during request', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-gateway-webrtc-closed-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const node = {
    id: 'aws-current-node',
    preferredTransports: ['webrtc', 'relay']
  };
  const transports = [
    {
      id: 'aws-current-node-webrtc',
      kind: 'webrtc',
      endpoint: 'http://control.example.com:9527',
      status: 'up',
      score: 100,
      promotion: { remoteRequestReady: true, promotedAt: 1000 }
    },
    {
      id: 'aws-current-node-relay',
      kind: 'relay',
      endpoint: 'relay://aws-current-node',
      status: 'up',
      score: 55
    }
  ];
  const calls = [];

  const result = await requestRemoteManagement({
    node,
    transports,
    purpose: 'runtime',
    rpc: 'session-start',
    pathname: '/v0/node-rpc/session-start'
  }, {
    fs,
    aiHomeDir,
    requestWebrtcManagement: async () => {
      calls.push('webrtc');
      const error = new Error('remote_webrtc_session_closed');
      error.code = 'remote_webrtc_session_closed';
      error.status = 503;
      throw error;
    },
    requestRelayManagement: async (input) => {
      calls.push('relay');
      return {
        status: 200,
        ok: true,
        payload: {
          ok: true,
          via: input.transport.kind
        }
      };
    }
  });

  assert.deepEqual(calls, ['webrtc', 'relay']);
  assert.equal(result.transport.id, 'aws-current-node-relay');
  assert.equal(result.transportDecision.selectedTransportKind, 'relay');
  assert.equal(result.transportDecision.fallbackUsed, true);
  assert.deepEqual(result.transportDecision.fallbackFrom, ['webrtc']);
  assert.deepEqual(result.transportDecision.rejectedTransports, [
    {
      id: 'aws-current-node-webrtc',
      kind: 'webrtc',
      reason: 'remote_webrtc_session_closed'
    }
  ]);
  assert.deepEqual(result.payload, { ok: true, via: 'relay' });

  const audit = JSON.parse(fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8').trim());
  assert.equal(audit.transportId, 'aws-current-node-relay');
  assert.equal(audit.transportKind, 'relay');
  assert.equal(audit.fallbackUsed, true);
  assert.deepEqual(audit.fallbackFrom, ['webrtc']);
  assert.deepEqual(audit.rejectedTransports, result.transportDecision.rejectedTransports);
});

test('remote node view derives relay connection state from active sessions', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-node-view-relay-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  upsertRemoteNode({ id: 'nat-node', name: 'NAT Node' }, deps);
  upsertRemoteTransport({
    id: 'nat-node-relay',
    nodeId: 'nat-node',
    kind: 'relay',
    status: 'degraded',
    score: 0
  }, deps);

  const offline = listRemoteNodeViews(deps)[0];
  assert.equal(offline.connection.status, 'offline');
  assert.equal(offline.connection.transportKind, 'relay');
  assert.equal(offline.connection.transportId, 'nat-node-relay');
  assert.equal(offline.connection.sessionId, '');

  const online = listRemoteNodeViews({
    ...deps,
    relaySessionRegistry: {
      getRelaySession: () => ({
        sessionId: 'session-1',
        nodeId: 'nat-node',
        transportId: 'nat-node-relay',
        remoteAddress: '192.0.2.10',
        connectedAt: 1000,
        lastSeenAt: 1500
      })
    }
  })[0];
  assert.equal(online.connection.status, 'online');
  assert.equal(online.connection.sessionId, 'session-1');
  assert.equal(online.connection.remoteAddress, '192.0.2.10');
  assert.equal(online.connection.connectedAt, 1000);
  assert.equal(online.connection.lastSeenAt, 1500);
});

test('remote transport selector applies purpose-specific transport roles', () => {
  const streamSelected = selectTransport({}, [
    { id: 'frp', kind: 'frp', endpoint: 'https://frp.example.com', score: 62, status: 'up', latencyMs: 20 },
    { id: 'mptcp', kind: 'mptcp', endpoint: 'https://mptcp.example.com', score: 56, status: 'up', latencyMs: 20 }
  ], { purpose: 'stream' });
  assert.equal(streamSelected.id, 'mptcp');

  const bootstrapSelected = selectTransport({}, [
    { id: 'frp', kind: 'frp', endpoint: 'https://frp.example.com', score: 64, status: 'up', latencyMs: 20 },
    { id: 'ssh', kind: 'ssh', endpoint: 'http://127.0.0.1:19527', score: 58, status: 'up', latencyMs: 20 }
  ], { purpose: 'bootstrap' });
  assert.equal(bootstrapSelected.id, 'ssh');
});

test('remote transport strategies classify data-plane, bootstrap, and underlay lanes', () => {
  const strategies = buildRemoteTransportStrategies();
  const byId = new Map(strategies.map((strategy) => [strategy.id, strategy]));

  assert.deepEqual(byId.get('no-public-ip-default').dataPlaneTransports, ['relay']);
  assert.deepEqual(byId.get('no-public-ip-default').bootstrapTransports, ['ssh']);
  assert.deepEqual(byId.get('underlay-optimization').underlayTransports, ['omr', 'mptcp']);
  assert.equal(byId.get('underlay-optimization').dataPlaneTransports.length, 0);
});

test('remote transport selector keeps non-data-plane routes out of normal rpc selection', () => {
  const readSelected = selectTransport({}, [
    {
      id: 'ssh-bootstrap',
      kind: 'ssh',
      endpoint: 'http://127.0.0.1:19527',
      status: 'up',
      score: 100,
      routeRole: 'bootstrap'
    },
    {
      id: 'frp',
      kind: 'frp',
      endpoint: 'https://frp.example.com',
      status: 'up',
      score: 40
    }
  ], { purpose: 'read' });
  assert.equal(readSelected.id, 'frp');

  const bootstrapSelected = selectTransport({}, [
    {
      id: 'ssh-bootstrap',
      kind: 'ssh',
      endpoint: 'http://127.0.0.1:19528',
      status: 'up',
      score: 40,
      routeRole: 'bootstrap'
    },
    {
      id: 'underlay',
      kind: 'omr',
      endpoint: 'http://10.0.0.2:9527',
      status: 'up',
      score: 100,
      routeRole: 'underlay'
    }
  ], { purpose: 'bootstrap' });
  assert.equal(bootstrapSelected.id, 'ssh-bootstrap');

  const statusSelected = selectTransport({}, [
    {
      id: 'ssh-bootstrap',
      kind: 'ssh',
      endpoint: 'http://127.0.0.1:19528',
      status: 'up',
      score: 100,
      routeRole: 'bootstrap'
    }
  ], { purpose: 'status' });
  assert.equal(statusSelected, null);
});

test('remote gateway infers transport purpose from rpc and path', () => {
  assert.equal(inferTransportPurpose({ rpc: 'node.status.read' }), 'status');
  assert.equal(inferTransportPurpose({ rpc: 'node.chat.start', streamKind: 'sse' }), 'stream');
  assert.equal(inferTransportPurpose({ pathname: '/v0/management/files/read' }), 'file');
  assert.equal(inferTransportPurpose({ scope: 'runtime:restart' }), 'runtime');
  assert.equal(inferTransportPurpose({ pathname: '/v0/node-rpc/join' }), 'bootstrap');
});

test('remote management appendSearch preserves existing diagnostic query params', () => {
  assert.equal(
    appendSearch('/v0/node-rpc/status?diagnostics=1', new URL('https://control.example.com/test?summary=1')),
    '/v0/node-rpc/status?diagnostics=1&summary=1'
  );
  assert.equal(
    appendSearch('/v0/node-rpc/status', new URL('https://control.example.com/test?summary=1')),
    '/v0/node-rpc/status?summary=1'
  );
});

test('remote gateway requires relay rpc handler before using relay transport', async () => {
  await assert.rejects(
    requestRemoteManagement({
      node: {
        id: 'nat-node',
        preferredTransports: ['relay']
      },
      transports: [
        {
          id: 'nat-node-relay',
          nodeId: 'nat-node',
          kind: 'relay',
          endpoint: 'relay://nat-node',
          status: 'up',
          score: 55
        }
      ],
      pathname: '/v0/management/status',
      audit: false
    }),
    { code: 'remote_relay_rpc_not_implemented', status: 501 }
  );
});

test('remote gateway keeps transport decision when relay request throws', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-error-decision-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const relayError = new Error('remote_relay_session_unavailable');
  relayError.code = 'remote_relay_session_unavailable';
  relayError.status = 503;

  await assert.rejects(
    requestRemoteManagement({
      node: {
        id: 'nat-node',
        preferredTransports: ['webrtc', 'relay']
      },
      transports: [
        {
          id: 'nat-node-webrtc',
          nodeId: 'nat-node',
          kind: 'webrtc',
          endpoint: 'http://control.example.com:9527',
          status: 'up',
          score: 100
        },
        {
          id: 'nat-node-relay',
          nodeId: 'nat-node',
          kind: 'relay',
          endpoint: 'relay://nat-node',
          status: 'up',
          score: 55
        }
      ],
      pathname: '/v0/node-rpc/session-start',
      rpc: 'session-start',
      purpose: 'runtime'
    }, {
      fs,
      aiHomeDir,
      requestRelayManagement: async () => {
        throw relayError;
      }
    }),
    (error) => {
      assert.equal(error.code, 'remote_relay_session_unavailable');
      assert.equal(error.status, 503);
      assert.equal(error.details.transportDecision.fallbackUsed, true);
      assert.deepEqual(error.details.transportDecision.fallbackFrom, ['webrtc']);
      assert.deepEqual(error.details.transportDecision.rejectedTransports, [
        {
          id: 'nat-node-webrtc',
          kind: 'webrtc',
          reason: 'webrtc_not_promoted'
        }
      ]);
      return true;
    }
  );

  const audit = JSON.parse(fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8').trim());
  assert.equal(audit.error, 'remote_relay_session_unavailable');
  assert.equal(audit.status, 503);
  assert.equal(audit.fallbackUsed, true);
  assert.deepEqual(audit.fallbackFrom, ['webrtc']);
});

test('remote gateway posts direct session input with management bearer and audit', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-input-direct-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const node = upsertRemoteNode({
    id: 'direct-input-node',
    name: 'Direct Input Node',
    preferredTransports: ['direct'],
    capabilities: ['sessions']
  }, deps);
  upsertRemoteTransport({
    id: 'direct-input-node-http',
    nodeId: node.id,
    kind: 'direct',
    endpoint: 'http://127.0.0.1:9527',
    status: 'up',
    score: 80
  }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'direct-secret' }, deps);

  const body = JSON.stringify({
    sessionRef: 'sess_0123456789abcdefabcd',
    input: 'remote yes',
    appendNewline: true
  });
  const calls = [];
  const result = await requestRemoteManagement({
    node,
    transports: listNodeTransports(node.id, deps),
    pathname: '/v0/node-rpc/session-input',
    method: 'POST',
    body,
    rpc: 'control_plane.device.node_session_input',
    scope: 'sessions:write'
  }, {
    ...deps,
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        method: init && init.method,
        authorization: init && init.headers && init.headers.authorization,
        contentType: init && init.headers && init.headers['content-type'],
        body: init && init.body
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_input', result: { accepted: true } })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      url: 'http://127.0.0.1:9527/v0/node-rpc/session-input',
      method: 'POST',
      authorization: 'Bearer direct-secret',
      contentType: 'application/json',
      body
    }
  ]);
  const auditText = fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8');
  assert.match(auditText, /control_plane\.device\.node_session_input/);
  assert.match(auditText, /sessions:write/);
  assert.doesNotMatch(auditText, /remote yes/);
  assert.doesNotMatch(auditText, /direct-secret/);
});

test('remote gateway streams direct session events with management bearer and audit', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-stream-direct-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const node = upsertRemoteNode({
    id: 'direct-node',
    name: 'Direct Node',
    preferredTransports: ['direct'],
    capabilities: ['sessions']
  }, deps);
  upsertRemoteTransport({
    id: 'direct-node-http',
    nodeId: node.id,
    kind: 'direct',
    endpoint: 'http://127.0.0.1:9527',
    status: 'up',
    score: 60
  }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'direct-secret' }, deps);
  const encoder = new TextEncoder();
  const chunks = [];
  const opened = [];
  const result = await streamRemoteManagement({
    node,
    transports: listNodeTransports(node.id, deps),
    pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd',
    method: 'GET',
    rpc: 'control_plane.device.node_session_stream',
    scope: 'sessions:read'
  }, {
    onOpen: (message) => opened.push(message),
    onChunk: (payload) => chunks.push(payload)
  }, {
    ...deps,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:9527/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.authorization, 'Bearer direct-secret');
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"ok":true,"type":"events","result":{"cursor":8192}}\n\n'));
            controller.close();
          }
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.transport.kind, 'direct');
  assert.deepEqual(opened, [{ type: 'remote.stream.opened', status: 200, ok: true }]);
  assert.deepEqual(chunks, [
    { ok: true, type: 'events', result: { cursor: 8192 } }
  ]);
  const auditText = fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8');
  assert.match(auditText, /control_plane\.device\.node_session_stream/);
  assert.match(auditText, /sessions:read/);
  assert.doesNotMatch(auditText, /direct-secret/);
});

test('remote gateway falls back to relay when selected WebRTC stream session closes', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-stream-webrtc-closed-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const node = {
    id: 'aws-current-node',
    preferredTransports: ['webrtc', 'relay']
  };
  const transports = [
    {
      id: 'aws-current-node-webrtc',
      kind: 'webrtc',
      endpoint: 'http://control.example.com:9527',
      status: 'up',
      score: 100,
      promotion: { remoteRequestReady: true, promotedAt: 1000 }
    },
    {
      id: 'aws-current-node-relay',
      kind: 'relay',
      endpoint: 'relay://aws-current-node',
      status: 'up',
      score: 55
    }
  ];
  const calls = [];
  const chunks = [];

  const result = await streamRemoteManagement({
    node,
    transports,
    purpose: 'stream',
    rpc: 'session-stream',
    pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd'
  }, {
    onChunk: (payload) => chunks.push(payload)
  }, {
    fs,
    aiHomeDir,
    requestWebrtcManagement: async () => {
      throw new Error('request_webrtc_should_not_be_called_for_stream');
    },
    requestWebrtcManagementStream: async () => {
      calls.push('webrtc');
      const error = new Error('remote_webrtc_session_closed');
      error.code = 'remote_webrtc_session_closed';
      error.status = 503;
      throw error;
    },
    requestRelayManagementStream: async (input, handlers) => {
      calls.push('relay');
      if (handlers && typeof handlers.onChunk === 'function') {
        handlers.onChunk({ ok: true, type: 'events', result: { via: input.transport.kind } });
      }
      return {
        status: 200,
        ok: true
      };
    }
  });

  assert.deepEqual(calls, ['webrtc', 'relay']);
  assert.equal(result.transport.id, 'aws-current-node-relay');
  assert.equal(result.transportDecision.selectedTransportKind, 'relay');
  assert.equal(result.transportDecision.fallbackUsed, true);
  assert.deepEqual(result.transportDecision.fallbackFrom, ['webrtc']);
  assert.deepEqual(result.transportDecision.rejectedTransports, [
    {
      id: 'aws-current-node-webrtc',
      kind: 'webrtc',
      reason: 'remote_webrtc_session_closed'
    }
  ]);
  assert.deepEqual(chunks, [
    { ok: true, type: 'events', result: { via: 'relay' } }
  ]);

  const audit = JSON.parse(fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8').trim());
  assert.equal(audit.transportId, 'aws-current-node-relay');
  assert.equal(audit.transportKind, 'relay');
  assert.equal(audit.fallbackUsed, true);
  assert.deepEqual(audit.fallbackFrom, ['webrtc']);
  assert.deepEqual(audit.rejectedTransports, result.transportDecision.rejectedTransports);
});

test('remote gateway requires relay stream handler before using relay stream transport', async () => {
  await assert.rejects(
    streamRemoteManagement({
      node: {
        id: 'nat-node',
        preferredTransports: ['relay']
      },
      transports: [
        {
          id: 'nat-node-relay',
          nodeId: 'nat-node',
          kind: 'relay',
          endpoint: 'relay://nat-node',
          status: 'up',
          score: 55
        }
      ],
      pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd',
      audit: false
    }),
    { code: 'remote_relay_stream_not_implemented', status: 501 }
  );
});
