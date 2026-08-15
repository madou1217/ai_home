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
