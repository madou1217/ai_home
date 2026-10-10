'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseSubscriptionContentDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const { validateProxyNodeInput } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { SAMPLE_NODES, assertRoundTrip } = require('./helpers/proxy-format-samples');

test('sample nodes are valid node-store input', () => {
  for (const node of SAMPLE_NODES) validateProxyNodeInput(node);
});

test('sing-box configs round-trip every protocol and skip non-proxy outbounds', () => {
  const outbounds = SAMPLE_NODES.map((node) => compileSingBoxNodeOutbound(node, node.name));
  const config = {
    log: { level: 'info' },
    outbounds: [
      { type: 'selector', tag: 'proxy', outbounds: outbounds.map((item) => item.tag) },
      ...outbounds,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' }
    ]
  };
  assertRoundTrip('sing-box', JSON.stringify(config, null, 2));
});

test('sing-box import tolerates comments and reports unsupported outbounds', () => {
  const config = `{
    // 注释与尾逗号也能读
    "outbounds": [
      { "type": "trojan", "tag": "ok", "server": "a.example", "server_port": 443, "password": "p", "tls": { "enabled": true } },
      { "type": "tor", "tag": "onion", "server": "t.example", "server_port": 9050 },
      { "type": "vmess", "tag": "quic", "server": "q.example", "server_port": 443, "uuid": "u", "transport": { "type": "quic" } },
    ]
  }`;
  const { nodes, skippedNodes } = parseSubscriptionContentDetailed(config);
  assert.deepEqual(nodes.map((node) => node.name), ['ok', 'quic']);
  assert.deepEqual(skippedNodes, [{ nodeId: null, name: 'onion', reason: 'unsupported_proxy_protocol_tor' }]);
  // quic 传输由节点库按白名单拒绝（导入只负责如实映射）。
  assert.throws(() => validateProxyNodeInput(nodes[1]), /unsupported_proxy_transport_quic/);
});

test('JSON-formatted Clash configs are read by the Clash importer', () => {
  const clashJson = JSON.stringify({ proxies: [{ name: 'j', type: 'trojan', server: 'j.example', port: 443, password: 'p' }] });
  assert.deepEqual(parseSubscriptionContentDetailed(clashJson).nodes.map((node) => node.protocol), ['trojan']);
});

