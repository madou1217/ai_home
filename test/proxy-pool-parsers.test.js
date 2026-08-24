'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseProxyNode,
  encodeProxyNode,
  parseSubscriptionContent
} = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');

test('parseProxyNode parses Shadowsocks SIP002 link', () => {
  const link = 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmRAMTIz@198.51.100.1:8388#HongKong-01';
  const node = parseProxyNode(link);
  assert.ok(node, 'node parsed');
  assert.equal(node.protocol, 'shadowsocks');
  assert.equal(node.server, '198.51.100.1');
  assert.equal(node.port, 8388);
  assert.equal(node.cipher, 'aes-256-gcm');
  assert.equal(node.password, 'password@123');
  assert.equal(node.name, 'HongKong-01');
  assert.equal(node.countryCode, 'HK');

  const reencoded = encodeProxyNode(node);
  assert.ok(reencoded.startsWith('ss://'));
});

test('parseProxyNode parses VMess standard JSON link', () => {
  const jsonConfig = {
    v: '2',
    ps: 'Tokyo-VMess-01',
    add: 'tokyo.example.com',
    port: 443,
    id: 'e39b9866-51cf-4a41-b0e6-7ec9cf7bcfca',
    aid: 0,
    scy: 'auto',
    net: 'ws',
    type: 'none',
    host: 'tokyo.example.com',
    path: '/vmess',
    tls: 'tls',
    sni: 'tokyo.example.com'
  };
  const b64 = Buffer.from(JSON.stringify(jsonConfig)).toString('base64');
  const link = `vmess://${b64}`;

  const node = parseProxyNode(link);
  assert.ok(node);
  assert.equal(node.protocol, 'vmess');
  assert.equal(node.server, 'tokyo.example.com');
  assert.equal(node.port, 443);
  assert.equal(node.uuid, 'e39b9866-51cf-4a41-b0e6-7ec9cf7bcfca');
  assert.equal(node.network, 'ws');
  assert.equal(node.tls, true);
  assert.equal(node.countryCode, 'JP');

  const reencoded = encodeProxyNode(node);
  assert.ok(reencoded.startsWith('vmess://'));

  const withoutTls = parseProxyNode(`vmess://${Buffer.from(JSON.stringify({
    ...jsonConfig,
    ps: 'Tokyo-VMess-Plain',
    tls: 'none'
  })).toString('base64')}`);
  assert.equal(withoutTls.tls, false);
});

test('parseProxyNode parses VLESS reality/grpc link', () => {
  const link = 'vless://e39b9866-51cf-4a41-b0e6-7ec9cf7bcfca@us.example.com:443?type=grpc&security=reality&pbk=123456&sni=us.example.com#US-SiliconValley-01';
  const node = parseProxyNode(link);
  assert.ok(node);
  assert.equal(node.protocol, 'vless');
  assert.equal(node.server, 'us.example.com');
  assert.equal(node.port, 443);
  assert.equal(node.uuid, 'e39b9866-51cf-4a41-b0e6-7ec9cf7bcfca');
  assert.equal(node.security, 'reality');
  assert.equal(node.countryCode, 'US');
});

test('parseProxyNode parses Trojan and Hysteria2 links', () => {
  const trojanLink = 'trojan://trojanpassword@sg.example.com:443?sni=sg.example.com#SG-Singapore-01';
  const trojanNode = parseProxyNode(trojanLink);
  assert.ok(trojanNode);
  assert.equal(trojanNode.protocol, 'trojan');
  assert.equal(trojanNode.server, 'sg.example.com');
  assert.equal(trojanNode.countryCode, 'SG');

  const hy2Link = 'hy2://hy2password@de.example.com:443?sni=de.example.com&insecure=1#DE-Frankfurt-01';
  const hy2Node = parseProxyNode(hy2Link);
  assert.ok(hy2Node);
  assert.equal(hy2Node.protocol, 'hysteria2');
  assert.equal(hy2Node.server, 'de.example.com');
  assert.equal(hy2Node.countryCode, 'DE');

  const encodedPassword = encodeURIComponent('pa@ss:/?#%');
  const encodedTrojan = parseProxyNode(`trojan://${encodedPassword}@sg.example.com:443#Encoded`);
  const encodedHy2 = parseProxyNode(`hy2://${encodedPassword}@de.example.com:443#Encoded`);
  assert.equal(encodedTrojan.password, 'pa@ss:/?#%');
  assert.equal(encodedHy2.password, 'pa@ss:/?#%');
  assert.match(encodeProxyNode(encodedTrojan), new RegExp(`^trojan://${encodedPassword}@`));
  assert.match(encodeProxyNode(encodedHy2), new RegExp(`^hy2://${encodedPassword}@`));
});

test('proxy URI parsers store IPv6 hosts without brackets and restore brackets only when encoding', () => {
  const userinfo = Buffer.from('aes-256-gcm:secret').toString('base64');
  const links = [
    `ss://${userinfo}@[2001:4860:4860::8888]:8388#IPv6-SS`,
    'vless://e39b9866-51cf-4a41-b0e6-7ec9cf7bcfca@[2001:4860:4860::8888]:443?security=tls#IPv6-VLESS',
    'socks5://user:pass@[2001:4860:4860::8888]:1080#IPv6-SOCKS'
  ];
  const nodes = links.map((link, index) => ({ ...parseProxyNode(link), id: `ipv6-${index}` }));

  for (const node of nodes) {
    assert.equal(node.server, '2001:4860:4860::8888');
    assert.match(encodeProxyNode(node), /@\[2001:4860:4860::8888\]:/);
  }
});

test('parseSubscriptionContent parses mixed text and Clash YAML', () => {
  const clashYaml = `
proxies:
  - name: "HK-Node-01"
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-256-gcm
    password: "pass"
  - name: "US-Node-02"
    type: trojan
    server: 5.6.7.8
    port: 443
    password: "pass"
    sni: "us.com"
`;
  const nodes = parseSubscriptionContent(clashYaml);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].protocol, 'shadowsocks');
  assert.equal(nodes[0].name, 'HK-Node-01');
  assert.equal(nodes[1].protocol, 'trojan');
  assert.equal(nodes[1].name, 'US-Node-02');
});

test('parseSubscriptionContent parses quoted inline Clash maps and nested transport options', () => {
  const clashYaml = `
proxies:
  - { name: "HK: node #1", type: ss, server: 198.51.100.10, port: 8388, cipher: aes-256-gcm, password: "p:a#s", plugin: v2ray-plugin, plugin-opts: { mode: websocket, tls: true } }
  - name: "US WS"
    type: vless
    server: us.example.com
    port: 443
    uuid: e39b9866-51cf-4a41-b0e6-7ec9cf7bcfca
    network: ws
    tls: true
    ws-opts:
      path: "/proxy:v1"
      headers:
        Host: edge.example.com
`;

  const nodes = parseSubscriptionContent(clashYaml);

  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].name, 'HK: node #1');
  assert.equal(nodes[0].password, 'p:a#s');
  assert.deepEqual(nodes[0].pluginOpts, { mode: 'websocket', tls: true });
  assert.equal(nodes[1].network, 'ws');
  assert.equal(nodes[1].path, '/proxy:v1');
  assert.equal(nodes[1].host, 'edge.example.com');
});

test('clash YAML import keeps nodes that carry benign transport flags', () => {
  // 机场订阅普遍在每个节点上带 `udp: true`（还有 tfo / mptcp 之类）。这些开关不改变
  // 出站目标，早期的严格白名单却把它们判为 unsupported_proxy_field_udp，整份订阅被丢空，
  // 否则导入后会表现为节点目录为空。
  const yaml = [
    'proxies:',
    '  - {name: reality-01, type: vless, server: 198.51.100.7, port: 36699, uuid: 11111111-2222-3333-4444-555555555555, udp: true, tls: true, skip-cert-verify: false, flow: xtls-rprx-vision, client-fingerprint: chrome, servername: example.com, reality-opts: {public-key: PUBKEY, short-id: ab12}}',
    '  - {name: ss-01, type: ss, server: 198.51.100.8, port: 8388, cipher: aes-256-gcm, password: secret, udp: true, tfo: true, mptcp: false, ip-version: ipv4}'
  ].join('\n');

  const nodes = parseSubscriptionContent(yaml);
  assert.equal(nodes.length, 2, '带 udp/tfo 的节点不应被丢弃');

  const [reality, ss] = nodes;
  assert.equal(reality.protocol, 'vless');
  assert.equal(reality.security, 'reality');
  assert.equal(reality.publicKey, 'PUBKEY');
  assert.equal(ss.protocol, 'shadowsocks');
  assert.equal(ss.port, 8388);
  // 忽略的字段不应泄漏进节点模型，出口编译期只认标准化字段。
  assert.equal(reality.udp, undefined);
  assert.equal(ss.tfo, undefined);
});
