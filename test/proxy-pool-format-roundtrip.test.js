'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseSubscriptionContentDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const {
  compileSingBoxNodeOutbound,
  singBoxSectionOf
} = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const { validateProxyNodeInput } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { SAMPLE_NODES, assertRoundTrip } = require('./helpers/proxy-format-samples');

test('sample nodes are valid node-store input', () => {
  for (const node of SAMPLE_NODES) validateProxyNodeInput(node);
});

test('sing-box configs round-trip every protocol sing-box implements and skip non-proxy outbounds', () => {
  const ssr = SAMPLE_NODES.find((node) => node.protocol === 'shadowsocksr');
  assert.throws(() => compileSingBoxNodeOutbound(ssr, 'ssr'), { code: 'unsupported_proxy_protocol_shadowsocksr' });
  // Snell 出站是 1.14 才有的：基线内核整类跳过，1.14 也只收 v4 / v6（v5 的 QUIC 模式没实现）。
  const snell = SAMPLE_NODES.find((node) => node.protocol === 'snell');
  assert.throws(() => compileSingBoxNodeOutbound(snell, 'snell'), { code: 'requires_sing_box_1.14.0' });
  assert.throws(
    () => compileSingBoxNodeOutbound(snell, 'snell', { version: '1.14.0' }),
    { code: 'unsupported_sing_box_snell_version_3' }
  );
  const snellV4 = { ...snell, version: 4 };
  assert.deepEqual(
    compileSingBoxNodeOutbound(snellV4, 'snell', { version: '1.14.0' }),
    { type: 'snell', tag: 'snell', server: 'sn.example', server_port: 8000, version: 4, psk: 'p', obfs_mode: 'http', obfs_host: 'cdn.example' }
  );
  assert.throws(
    () => compileSingBoxNodeOutbound({ ...snellV4, obfs: 'tls' }, 'snell', { version: '1.14.0' }),
    { code: 'unsupported_sing_box_snell_obfs_tls' }
  );
  assert.deepEqual(
    compileSingBoxNodeOutbound({ ...snellV4, version: 6, obfs: undefined, obfsHost: undefined, mode: 'unshaped' }, 'snell', { version: '1.14.0' }),
    { type: 'snell', tag: 'snell', server: 'sn.example', server_port: 8000, version: 6, psk: 'p', mode: 'unshaped' }
  );

  const supported = [...SAMPLE_NODES.filter((node) => !['shadowsocksr', 'snell'].includes(node.protocol)), snellV4];
  const compiled = supported.map((node) => compileSingBoxNodeOutbound(node, node.name, { version: '1.14.0' }));
  const outbounds = compiled.filter((item) => singBoxSectionOf(item) === 'outbounds');
  // WireGuard 是 endpoint，写在 endpoints 段（读回时排在出站之后）。
  const endpoints = compiled.filter((item) => singBoxSectionOf(item) === 'endpoints');
  assert.deepEqual(endpoints.map((item) => item.tag), ['wg']);
  const config = {
    log: { level: 'info' },
    outbounds: [
      { type: 'selector', tag: 'proxy', outbounds: compiled.map((item) => item.tag) },
      ...outbounds,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' }
    ],
    endpoints
  };
  const sectionOrder = [...supported.filter((node) => node.protocol !== 'wireguard'), ...supported.filter((node) => node.protocol === 'wireguard')];
  assertRoundTrip('sing-box', JSON.stringify(config, null, 2), sectionOrder);
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

