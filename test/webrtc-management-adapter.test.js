'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { upsertRemoteNode } = require('../lib/server/remote/node-registry');
const { upsertRemoteTransport, listNodeTransports } = require('../lib/server/remote/transport-registry');
const { writeRemoteSecret } = require('../lib/server/remote/secret-store');
const { requestRemoteManagement } = require('../lib/server/remote/remote-gateway');
const { getRemoteAuditLogPath } = require('../lib/server/remote/audit-log');
const { createWebrtcSessionRegistry } = require('../lib/server/remote/webrtc-session-registry');
const {
  WEBRTC_NODE_CONNECT_PATH,
  answerWebrtcNodeConnection,
  hasWebrtcManagementSession,
  maybeRefreshWebrtcPromotion,
  requestWebrtcManagement,
  upsertWebrtcTransport
} = require('../lib/server/remote/webrtc-management-adapter');
const {
  connectWebrtcOnce
} = require('../lib/cli/services/node/webrtc-client');

function readAuditEvents(aiHomeDir) {
  const filePath = getRemoteAuditLogPath(aiHomeDir);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function seedPromotedWebrtcNode(aiHomeDir, nodeId = 'office-node') {
  const deps = { fs, aiHomeDir };
  const node = upsertRemoteNode({
    id: nodeId,
    name: 'Office Node',
    preferredTransports: ['webrtc', 'relay'],
    authRef: `remote-node/${nodeId}`
  }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  upsertRemoteTransport({
    id: `${nodeId}-webrtc`,
    nodeId,
    kind: 'webrtc',
    endpoint: 'http://control.test',
    status: 'up',
    score: 88,
    routeRole: 'data-plane',
    trustLevel: 'managed',
    promotion: {
      remoteRequestReady: true,
      mode: 'direct',
      evidenceRef: 'test-webrtc-datachannel',
      promotedAt: Date.now()
    }
  }, deps);
  return node;
}

test('webrtc management adapter forwards gateway RPC over a real DataChannel and audits transportKind', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webrtc-adapter-'));
  const node = seedPromotedWebrtcNode(aiHomeDir);
  const webrtcSessionRegistry = createWebrtcSessionRegistry();
  const serverDeps = {
    fs,
    aiHomeDir,
    webrtcSessionRegistry
  };
  const localRequests = [];

  t.after(() => {
    webrtcSessionRegistry.closeAll();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === WEBRTC_NODE_CONNECT_PATH) {
      const payload = JSON.parse(String(init.body || '{}'));
      const result = await answerWebrtcNodeConnection({
        req: {
          url: `${WEBRTC_NODE_CONNECT_PATH}?nodeId=${encodeURIComponent(node.id)}`,
          headers: {
            authorization: init.headers.authorization
          },
          socket: { remoteAddress: '127.0.0.1' }
        },
        payload,
        endpoint: 'http://control.test',
        remoteAddress: '127.0.0.1'
      }, serverDeps);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result })
      };
    }

    localRequests.push({
      url: String(url),
      method: String(init.method || 'GET'),
      authorization: String(init.headers && init.headers.authorization || '')
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        rpc: 'node.status',
        result: { nodeId: node.id, service: 'aih-node' }
      })
    };
  };

  const connection = await connectWebrtcOnce({
    url: new URL(`http://control.test${WEBRTC_NODE_CONNECT_PATH}?nodeId=${node.id}`),
    nodeId: node.id,
    managementKey: 'node-secret',
    localBaseUrl: 'http://node.local',
    connectTimeoutMs: 5000,
    once: false
  }, { fetchImpl });

  assert.equal(hasWebrtcManagementSession(node.id, serverDeps), true);

  const result = await requestRemoteManagement({
    node,
    transports: listNodeTransports(node.id, serverDeps),
    pathname: '/v0/node-rpc/status',
    method: 'GET',
    rpc: 'node.status.read',
    scope: 'status:read'
  }, {
    ...serverDeps,
    fetchImpl,
    requestWebrtcManagement,
    hasWebrtcManagementSession
  });

  assert.equal(result.ok, true);
  assert.equal(result.transport.kind, 'webrtc');
  assert.equal(result.payload.result.nodeId, node.id);
  assert.equal(localRequests.length, 1);
  assert.equal(localRequests[0].url, 'http://node.local/v0/node-rpc/status');
  assert.equal(localRequests[0].authorization, 'Bearer node-secret');

  const promotedWebrtc = listNodeTransports(node.id, serverDeps)
    .find((transport) => transport.kind === 'webrtc');
  assert.equal(promotedWebrtc.promotion.remoteRequestReady, true);
  assert.equal(promotedWebrtc.promotion.mode, 'management-rpc');
  assert.match(promotedWebrtc.promotion.evidenceRef, /^runtime:webrtc-management-rpc:\/v0\/node-rpc\/status$/);
  assert.ok(promotedWebrtc.promotion.expiresAt > promotedWebrtc.promotion.promotedAt);

  const auditEvents = readAuditEvents(aiHomeDir);
  assert.equal(auditEvents.some((event) => event.transportKind === 'webrtc' && event.ok === true), true);

  connection.channel.close();
  connection.peerConnection.close();
});

test('webrtc promotion refresh skips fresh same-mode evidence and upgrades stronger mode', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webrtc-promotion-refresh-'));
  const deps = {
    fs,
    aiHomeDir,
    nowMs: () => 1_000,
    webrtcPromotionTtlMs: 86_400_000,
    webrtcPromotionMinValidMs: 43_200_000
  };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  upsertRemoteTransport({
    id: 'office-node-webrtc',
    nodeId: 'office-node',
    kind: 'webrtc',
    endpoint: 'http://control.test',
    status: 'up',
    score: 88,
    routeRole: 'data-plane',
    trustLevel: 'managed',
    promotion: {
      remoteRequestReady: true,
      mode: 'management-datachannel',
      evidenceRef: 'runtime:webrtc-management-datachannel',
      promotedAt: 1_000,
      expiresAt: 86_401_000
    }
  }, deps);

  const skipped = maybeRefreshWebrtcPromotion('office-node', {
    endpoint: 'http://control.test',
    promotion: {
      mode: 'management-datachannel',
      evidenceRef: 'runtime:webrtc-management-datachannel'
    }
  }, deps);
  assert.equal(skipped, null);

  const upgraded = maybeRefreshWebrtcPromotion('office-node', {
    endpoint: 'http://control.test',
    promotion: {
      mode: 'management-rpc',
      evidenceRef: 'runtime:webrtc-management-rpc:/v0/node-rpc/status',
      rpcP95Ms: 12
    }
  }, deps);
  assert.equal(upgraded.promotion.mode, 'management-rpc');
  assert.equal(upgraded.promotion.rpcP95Ms, 12);
  assert.equal(upgraded.promotion.expiresAt, 86_401_000);

  const downgrade = maybeRefreshWebrtcPromotion('office-node', {
    endpoint: 'http://control.test',
    promotion: {
      mode: 'management-datachannel',
      evidenceRef: 'runtime:webrtc-management-datachannel'
    }
  }, deps);
  assert.equal(downgrade, null);
});

test('webrtc promotion keeps fresh RPC evidence across datachannel lifecycle refresh', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webrtc-promotion-lifecycle-'));
  const deps = {
    fs,
    aiHomeDir,
    nowMs: () => 10_000,
    webrtcPromotionTtlMs: 86_400_000,
    webrtcPromotionMinValidMs: 43_200_000
  };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  upsertRemoteTransport({
    id: 'office-node-webrtc',
    nodeId: 'office-node',
    kind: 'webrtc',
    endpoint: 'http://control.test',
    status: 'up',
    score: 88,
    routeRole: 'data-plane',
    trustLevel: 'managed',
    promotion: {
      remoteRequestReady: true,
      mode: 'management-rpc',
      evidenceRef: 'runtime:webrtc-management-rpc:/v0/node-rpc/status',
      rttP95Ms: 0,
      rpcP95Ms: 169,
      promotedAt: 1_000,
      expiresAt: 86_401_000
    }
  }, deps);

  upsertWebrtcTransport('office-node', {
    endpoint: 'http://control.test',
    status: 'up',
    score: 88,
    latencyMs: 0,
    lastError: ''
  }, deps);

  const refreshed = maybeRefreshWebrtcPromotion('office-node', {
    endpoint: 'http://control.test',
    status: 'up',
    promotion: {
      mode: 'management-datachannel',
      evidenceRef: 'runtime:webrtc-management-datachannel'
    }
  }, deps);
  assert.equal(refreshed, null);

  const transport = listNodeTransports('office-node', deps).find((entry) => entry.kind === 'webrtc');
  assert.equal(transport.promotion.mode, 'management-rpc');
  assert.equal(transport.promotion.rpcP95Ms, 169);
});

test('remote gateway falls back to relay while promoted webrtc has no open adapter session', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webrtc-fallback-'));
  const node = seedPromotedWebrtcNode(aiHomeDir, 'fallback-node');
  const deps = { fs, aiHomeDir };
  upsertRemoteTransport({
    id: 'fallback-node-relay',
    nodeId: node.id,
    kind: 'relay',
    endpoint: 'relay://fallback-node',
    status: 'up',
    score: 55,
    routeRole: 'data-plane',
    trustLevel: 'managed'
  }, deps);
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const result = await requestRemoteManagement({
    node,
    transports: listNodeTransports(node.id, deps),
    pathname: '/v0/node-rpc/status',
    method: 'GET',
    rpc: 'node.status.read',
    scope: 'status:read'
  }, {
    ...deps,
    requestWebrtcManagement,
    hasWebrtcManagementSession: () => false,
    requestRelayManagement: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, result: { transport: 'relay' } }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.transport.kind, 'relay');
  assert.deepEqual(result.transportDecision.fallbackFrom, ['webrtc']);
  assert.equal(
    result.transportDecision.rejectedTransports.some((item) => item.kind === 'webrtc' && item.reason === 'webrtc_adapter_not_available'),
    true
  );
});
