'use strict';

// 本地导入的两种格式：WireGuard 配置文件（.conf）与本系统的中立 JSON（订阅聚合 json 输出的往返）。

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseWireGuardConfDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers/wireguard-conf-parser');
const { parseAihJsonDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers/aih-json-parser');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const {
  buildProxyNodeConnectionKey,
  validateProxyNodeInput
} = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const jsonRenderer = require('../lib/cli/services/toolkit/subscription-aggregator/renderers/json');
const { SAMPLE_NODES } = require('./helpers/proxy-format-samples');

const WG_CONF = `
# 官方客户端导出
[Interface]
PrivateKey = cGFzc3dvcmRwYXNzd29yZHBhc3N3b3JkcGFzc3dvcmQ=
Address = 10.66.0.2/32
Address = fd42:42:42::2/128
DNS = 1.1.1.1
MTU = 1380

[Peer]
PublicKey = c2VydmVyc2VydmVyc2VydmVyc2VydmVyc2VydmVyMDA=
PresharedKey = cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHM=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = wg.example.com:51820
PersistentKeepalive = 25
`;

test('a WireGuard .conf becomes one node per peer', () => {
  const result = parseWireGuardConfDetailed(WG_CONF);
  assert.deepEqual(result.skippedNodes, []);
  assert.equal(result.nodes.length, 1);
  const [node] = result.nodes;
  assert.deepEqual(
    { protocol: node.protocol, name: node.name, server: node.server, port: node.port, ip: node.ip, ipv6: node.ipv6, mtu: node.mtu },
    { protocol: 'wireguard', name: 'WireGuard wg.example.com', server: 'wg.example.com', port: 51820, ip: '10.66.0.2', ipv6: 'fd42:42:42::2', mtu: 1380 }
  );
  assert.equal(node.presharedKey, 'cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHM=');
  validateProxyNodeInput(node);
  assert.equal(compileSingBoxNodeOutbound(node, 'wg').peers[0].address, 'wg.example.com');

  // 多个对端各成一个节点；IPv6 端点写在方括号里；缺端点的对端单独跳过。
  const multi = parseWireGuardConfDetailed(`${WG_CONF}\n[Peer]\nPublicKey = b3RoZXI=\nEndpoint = [2001:db8::1]:443\n\n[Peer]\nPublicKey = bm9lbmRwb2ludA==\n`, { name: '家里' });
  assert.deepEqual(multi.nodes.map((item) => [item.name, item.server, item.port]), [['家里 1', 'wg.example.com', 51820], ['家里 2', '2001:db8::1', 443]]);
  assert.deepEqual(multi.skippedNodes, [{ nodeId: null, name: '家里 3', reason: 'invalid_wireguard_endpoint' }]);

  assert.equal(parseWireGuardConfDetailed('[Interface]\nAddress = 10.0.0.1/24\n'), null, '没有私钥和对端不算 WireGuard 配置');
  assert.equal(parseWireGuardConfDetailed('proxies:\n  - name: a\n'), null);
});

test('the neutral JSON output imports back with the same connections', () => {
  const rendered = jsonRenderer.render(null, SAMPLE_NODES.map((node) => jsonRenderer.compileNode({ name: node.name, node })));
  const result = parseAihJsonDetailed(rendered);
  assert.deepEqual(result.skippedNodes, []);
  assert.deepEqual(result.nodes.map((node) => node.name), SAMPLE_NODES.map((node) => node.name));
  result.nodes.forEach((node, index) => {
    validateProxyNodeInput(node);
    assert.equal(buildProxyNodeConnectionKey(node), buildProxyNodeConnectionKey(SAMPLE_NODES[index]), node.name);
  });
  assert.equal(result.nodes.find((node) => node.name === 'https').protocol, 'https');

  const partial = parseAihJsonDetailed(JSON.stringify({ version: 1, nodes: [{ protocol: 'teleport', name: 'x' }, { protocol: 'socks5', name: 's', server: 's.example', port: 1080 }] }));
  assert.deepEqual(partial.skippedNodes, [{ nodeId: null, name: 'x', reason: 'unsupported_proxy_protocol_teleport' }]);
  assert.equal(partial.nodes.length, 1);

  assert.equal(parseAihJsonDetailed('{"version":2,"nodes":[{"protocol":"socks5"}]}'), null);
  assert.equal(parseAihJsonDetailed('{"outbounds":[]}'), null);
  assert.equal(parseAihJsonDetailed('not json'), null);
});

test('the detection chain reports which format it recognised', () => {
  const { parseSubscriptionContentDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
  const { assertRoundTrip } = require('./helpers/proxy-format-samples');
  const formatOf = (text) => parseSubscriptionContentDetailed(text).format;
  const trojan = 'trojan://p@tj.example:443#tj';
  assert.equal(formatOf('proxies:\n  - { name: a, type: socks5, server: s.example, port: 1080 }\n'), 'clash');
  assert.equal(formatOf('proxies:\n  - socks5: { name: a, server: s.example, port: 1080 }\n'), 'egern');
  assert.equal(formatOf(JSON.stringify({ outbounds: [{ type: 'socks', tag: 'a', server: 's.example', server_port: 1080 }] })), 'sing-box');
  assert.equal(formatOf(JSON.stringify({ outbounds: [{ protocol: 'socks', settings: { servers: [{ address: 's.example', port: 1080 }] } }] })), 'xray');
  assert.equal(formatOf(JSON.stringify({ version: 1, servers: [{ server: 's.example', server_port: 8388, method: 'aes-256-gcm', password: 'p' }] })), 'sip008');
  assert.equal(formatOf(JSON.stringify({ version: 1, nodes: [{ protocol: 'socks5', name: 'a', server: 's.example', port: 1080 }] })), 'aih-json');
  assert.equal(formatOf(WG_CONF), 'wireguard');
  assert.equal(formatOf('[Proxy]\na = socks5, s.example, 1080\n'), 'surge');
  assert.equal(formatOf('[server_local]\nshadowsocks=s.example:8388, method=aes-256-gcm, password=p, tag=a\n'), 'quantumult-x');
  assert.equal(formatOf(trojan), 'uri');
  assert.equal(formatOf(Buffer.from(trojan).toString('base64')), 'base64+uri');
  assert.equal(formatOf('只是一段说明文字'), '');
  assert.equal(formatOf(''), '');

  // 中立 JSON 经识别链也能完整往返。
  const rendered = jsonRenderer.render(null, SAMPLE_NODES.map((node) => jsonRenderer.compileNode({ name: node.name, node })));
  assertRoundTrip('aih-json', rendered);
});
