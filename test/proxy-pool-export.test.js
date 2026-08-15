'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');

function createService(nodes) {
  const store = {
    listNodes() { return nodes; },
    getRoutingConfig() {
      return { mode: 'global', activeOutboundNodeId: 'node_ss', rules: [] };
    },
    getDedicatedPortsConfig() {
      return { enabled: true, maxPorts: 32, basePort: 10801, mappings: {} };
    }
  };
  const coreRuntime = {
    getStatus() {
      return { engine: 'mihomo', installed: false, running: false, dataPlaneReady: false };
    }
  };
  return new ProxyPoolService({ store, coreRuntime });
}

test('aggregate export returns an importable Mihomo config without a controller secret', () => {
  const service = createService([
    {
      id: 'node_ss',
      name: 'SS',
      protocol: 'shadowsocks',
      server: '198.51.100.9',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'secret'
    },
    {
      id: 'node_unsupported',
      name: 'WG',
      protocol: 'wireguard',
      server: '203.0.113.9',
      port: 51820
    }
  ]);

  const result = service.exportAggregateSubscription('clash');

  assert.equal(result.ok, true);
  assert.equal(result.format, 'mihomo');
  assert.equal(result.requestedNodeCount, 2);
  assert.equal(result.exportedNodeCount, 1);
  assert.equal(result.nodeCount, 1);
  assert.equal(result.skippedNodes[0].reason, 'unsupported_proxy_protocol_wireguard');
  assert.match(result.content, /allow-lan: false/);
  assert.match(result.content, /mixed-port: 10800/);
  assert.doesNotMatch(result.content, /external-controller|secret:/);
});

test('aggregate export explicitly rejects the retired sing-box format', () => {
  const service = createService([]);

  assert.deepEqual(service.exportAggregateSubscription('singbox'), {
    ok: false,
    error: 'unsupported_export_format',
    supportedFormats: ['mihomo', 'base64']
  });
});
