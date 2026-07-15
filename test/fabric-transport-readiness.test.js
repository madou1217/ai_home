'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTransportReadinessReport,
  canonicalizeWebTransportBlockers,
  statusFromHealth,
  toSelectorTransport
} = require('../lib/server/fabric-transport-readiness');

test('fabric transport readiness canonicalizes WebTransport endpoint blockers', () => {
  assert.deepEqual(canonicalizeWebTransportBlockers([
    'webtransport_endpoint_not_configured',
    'webtransport_not_promoted'
  ], []), ['webtransport_h3_endpoint_missing']);

  assert.deepEqual(canonicalizeWebTransportBlockers([
    'webtransport_not_promoted'
  ], [
    { lastError: 'webtransport_connect_failed' }
  ]), ['webtransport_h3_endpoint_missing', 'webtransport_connect_failed']);
});

test('fabric transport readiness summarizes relay fallback and advanced blockers', () => {
  const report = buildTransportReadinessReport({
    nodes: [
      { id: 'aws-current-node', name: 'AWS Current Node', roles: ['node', 'relay-node'], status: 'online' }
    ],
    relayNodes: [
      { id: 'aws-current-node-relay', nodeId: 'aws-current-node', status: 'online' }
    ],
    projects: [],
    runtimes: [],
    transports: [
      {
        id: 'aws-current-node-relay',
        nodeId: 'aws-current-node',
        kind: 'relay',
        endpoint: 'relay://aws-current-node',
        health: 'online',
        priority: 100,
        measurement: {
          status: 'ws_echo_pass',
          sampleCount: 20,
          successes: 20,
          failures: 0,
          successRate: 1,
          rttMs: { p50: 104, p95: 116, p99: 117 }
        }
      },
      {
        id: 'aws-current-node-webrtc',
        nodeId: 'aws-current-node',
        kind: 'webrtc',
        endpoint: 'signaling://aws-current-node',
        health: 'online'
      },
      {
        id: 'aws-current-node-webtransport',
        nodeId: 'aws-current-node',
        kind: 'webtransport',
        endpoint: 'https://aws.example.com:9527/v0/fabric/webtransport/echo',
        health: 'down',
        lastError: 'webtransport_connect_failed'
      }
    ],
    networkMeasurements: []
  }, { purpose: 'runtime' });

  assert.equal(report.summary.nodes, 1);
  assert.equal(report.summary.defaultTransport, 'relay');
  assert.equal(report.summary.fallbackReady, true);
  assert.equal(report.summary.promotionReady, false);
  assert.equal(report.summary.blockers.includes('webrtc:webrtc_not_promoted'), true);
  assert.equal(report.summary.blockers.includes('webrtc:turn_relay_gate_not_ready'), true);
  assert.equal(report.summary.blockers.includes('webtransport:webtransport_h3_endpoint_missing'), true);
  assert.equal(report.summary.blockers.includes('webtransport:webtransport_connect_failed'), true);
  assert.equal(report.summary.blockers.includes('webtransport:webtransport_not_promoted'), false);

  const node = report.nodes[0];
  assert.equal(node.defaultTransport, 'relay');
  assert.equal(node.relayFallback.ready, true);
  assert.equal(node.relayFallback.measurementPass, true);
  assert.equal(node.relayFallback.measurement.rttMs.p95, 116);
  assert.equal(node.decision.rejected.some((item) => item.reason === 'webrtc_not_promoted'), true);
  assert.equal(node.advanced.find((gate) => gate.kind === 'webrtc').candidateReady, true);
  assert.equal(node.advanced.find((gate) => gate.kind === 'webtransport').candidateReady, true);
  assert.equal(node.advanced.find((gate) => gate.kind === 'mptcp').candidateReady, false);
});

test('fabric transport readiness maps fabric transport health into selector status', () => {
  assert.equal(statusFromHealth('online'), 'up');
  assert.equal(statusFromHealth('healthy'), 'up');
  assert.equal(statusFromHealth('offline'), 'down');
  assert.equal(statusFromHealth('warning'), 'degraded');

  const selectorTransport = toSelectorTransport({
    id: 'node-relay',
    nodeId: 'node',
    kind: 'relay',
    endpoint: 'relay://node',
    health: 'online',
    priority: 90,
    routeRole: 'data-plane',
    measurement: {
      status: 'ws_echo_pass',
      sampleCount: 3,
      successRate: 1,
      rttMs: { p95: 8 }
    }
  }, []);

  assert.equal(selectorTransport.status, 'up');
  assert.equal(selectorTransport.score, 55);
  assert.equal(selectorTransport.latencyMs, 8);
  assert.equal(selectorTransport.measurement.status, 'ws_echo_pass');
});

test('fabric transport readiness separates WebRTC promotion from adapter availability', () => {
  const registry = {
    nodes: [
      {
        id: 'aws-current-node',
        name: 'AWS Current Node',
        roles: ['node', 'relay-node'],
        status: 'online',
        preferredTransports: ['webrtc', 'relay']
      }
    ],
    relayNodes: [],
    projects: [],
    runtimes: [],
    transports: [
      {
        id: 'aws-current-node-webrtc',
        nodeId: 'aws-current-node',
        kind: 'webrtc',
        endpoint: 'http://control.example.com:9527',
        health: 'online',
        priority: 1,
        promotion: {
          remoteRequestReady: true,
          mode: 'direct',
          rttP95Ms: 201,
          rpcP95Ms: 205,
          promotedAt: 1000
        }
      },
      {
        id: 'aws-current-node-relay',
        nodeId: 'aws-current-node',
        kind: 'relay',
        endpoint: 'relay://aws-current-node',
        health: 'online',
        priority: 100,
        measurement: {
          status: 'ws_echo_pass',
          sampleCount: 20,
          successes: 20,
          failures: 0,
          successRate: 1
        }
      }
    ],
    networkMeasurements: []
  };

  const withoutAdapter = buildTransportReadinessReport(registry, { purpose: 'runtime' });
  assert.equal(withoutAdapter.summary.defaultTransport, 'relay');
  assert.equal(withoutAdapter.summary.promotionReady, false);
  assert.equal(withoutAdapter.summary.blockers.includes('webrtc:webrtc_adapter_not_available'), true);
  assert.equal(withoutAdapter.summary.blockers.includes('webrtc:turn_relay_gate_not_ready'), false);

  const withAdapter = buildTransportReadinessReport(registry, {
    purpose: 'runtime',
    availableAdapters: ['webrtc']
  });
  assert.equal(withAdapter.summary.defaultTransport, 'webrtc');
  assert.equal(withAdapter.summary.fallbackReady, true);
  assert.equal(withAdapter.summary.promotionReady, true);
  assert.deepEqual(withAdapter.summary.promotedTransports, ['webrtc']);
  assert.equal(withAdapter.summary.blockers.includes('webrtc:webrtc_adapter_not_available'), false);
  assert.equal(withAdapter.nodes[0].relayFallback.ready, true);
  assert.equal(withAdapter.nodes[0].relayFallback.measurementPass, true);
  assert.equal(withAdapter.nodes[0].relayFallback.selectedTransportId, 'aws-current-node-relay');
  assert.equal(withAdapter.nodes[0].advanced.find((gate) => gate.kind === 'webrtc').promotionReady, true);
});
