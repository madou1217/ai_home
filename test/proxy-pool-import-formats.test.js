'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  encodeProxyNode,
  parseProxyNode,
  parseSubscriptionContentDetailed
} = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const { compileMihomoProxy } = require('../lib/cli/services/toolkit/proxy-pool/cores/mihomo/proxy-compiler');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const { validateProxyNodeInput } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');

function vmessLink(fields) {
  return `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: 'n', add: 'a.example', port: 443, id: 'u', aid: 0, ...fields })).toString('base64')}`;
}

test('SS links accept SS2022 plaintext userinfo, passwords with @, IPv6 and ?plugin without a slash', () => {
  const ss2022 = parseProxyNode('ss://2022-blake3-aes-128-gcm:YWJjZGVmZ2hpamtsbW5vcA%3D%3D@1.2.3.4:443#SS2022');
  assert.equal(ss2022.cipher, '2022-blake3-aes-128-gcm');
  assert.equal(ss2022.password, 'YWJjZGVmZ2hpamtsbW5vcA==');
  // AEAD-2022 编码回明文 userinfo，再解析得到同一份凭据。
  assert.match(encodeProxyNode(ss2022), /^ss:\/\/2022-blake3-aes-128-gcm:YWJjZGVmZ2hpamtsbW5vcA%3D%3D@/);
  assert.equal(parseProxyNode(encodeProxyNode(ss2022)).password, ss2022.password);

  const v6 = parseProxyNode('ss://YWVzLTI1Ni1nY206cEBzcw@[2001:db8::1]:8388?plugin=obfs-local%3Bobfs%3Dhttp#v6');
  assert.deepEqual([v6.cipher, v6.password, v6.server, v6.port, v6.plugin, v6.pluginOpts], [
    'aes-256-gcm', 'p@ss', '2001:db8::1', 8388, 'obfs-local', 'obfs=http'
  ]);

  const legacy = parseProxyNode(`ss://${Buffer.from('aes-256-gcm:p@ss@legacy.example:9000').toString('base64')}#legacy`);
  assert.deepEqual([legacy.password, legacy.server, legacy.port], ['p@ss', 'legacy.example', 9000]);
  assert.equal(parseProxyNode('ss://not-a-link'), null);
});

test('VMess links read the grpc serviceName from path and tcp+http headers as the http transport', () => {
  const grpc = parseProxyNode(vmessLink({ net: 'grpc', path: 'svc', tls: 'tls' }));
  assert.equal(grpc.network, 'grpc');
  assert.equal(grpc.serviceName, 'svc');
  assert.equal(compileMihomoProxy(grpc, 'grpc')['grpc-opts']['grpc-service-name'], 'svc');
  assert.equal(parseProxyNode(encodeProxyNode(grpc)).serviceName, 'svc');

  const http = parseProxyNode(vmessLink({ net: 'tcp', type: 'http', path: '/x', host: 'h.example' }));
  assert.equal(http.network, 'http');
  validateProxyNodeInput(http);
  assert.equal(parseProxyNode(encodeProxyNode(http)).network, 'http');
});

test('h2, http and httpupgrade transports compile for mihomo and sing-box', () => {
  const base = { protocol: 'vmess', name: 't', server: 'a.example', port: 443, uuid: 'u', host: 'edge.example', path: '/p', tls: true };
  const h2 = compileMihomoProxy({ ...base, network: 'h2' }, 'h2');
  assert.deepEqual([h2.network, h2['h2-opts'].host, h2['h2-opts'].path], ['h2', ['edge.example'], '/p']);
  const http = compileMihomoProxy({ ...base, network: 'http' }, 'http');
  assert.deepEqual(http['http-opts'], { method: 'GET', path: ['/p'], headers: { Host: ['edge.example'] } });
  const upgrade = compileMihomoProxy({ ...base, network: 'httpupgrade' }, 'up');
  assert.equal(upgrade.network, 'ws');
  assert.equal(upgrade['ws-opts']['v2ray-http-upgrade'], true);

  assert.deepEqual(compileSingBoxNodeOutbound({ ...base, network: 'h2' }, 'h2').transport, {
    type: 'http', host: ['edge.example'], path: '/p'
  });
  assert.deepEqual(compileSingBoxNodeOutbound({ ...base, network: 'httpupgrade' }, 'up').transport, {
    type: 'httpupgrade', path: '/p', host: 'edge.example'
  });
});

test('wrapped base64 subscriptions and base64-wrapped Clash YAML are decoded before parsing', () => {
  const links = [
    'trojan://secret@a.example:443?sni=a.example#A',
    'ss://YWVzLTEyOC1nY206dGVzdA==@b.example:8388#B'
  ].join('\n');
  // MIME 风格：base64 每 20 列换一行（真实订阅常见 76 列）。
  const wrapped = Buffer.from(links).toString('base64').replace(/(.{20})/g, '$1\n');
  assert.deepEqual(parseSubscriptionContentDetailed(wrapped).nodes.map((node) => node.name), ['A', 'B']);

  const yaml = 'proxies:\n  - {name: Y, type: trojan, server: y.example, port: 443, password: p}\n';
  assert.deepEqual(parseSubscriptionContentDetailed(Buffer.from(yaml).toString('base64')).nodes.map((node) => node.name), ['Y']);
});

test('Clash import uses a real YAML parser, ignores unknown keys and maps every transport', () => {
  const yaml = `
anchors:
  base: &base {server: shared.example, port: 443, udp: true, smux: {enabled: true}}
proxies:
  - name: ws-upgrade
    <<: *base
    type: vless
    uuid: 11111111-2222-3333-4444-555555555555
    network: ws
    tls: true
    ws-opts: {path: /up, headers: {Host: edge.example}, v2ray-http-upgrade: true}
  - {name: h2, type: vmess, server: h2.example, port: 443, uuid: u, cipher: auto, network: h2, h2-opts: {host: [h2.example], path: /h2}}
  - {name: http, type: vmess, server: http.example, port: 80, uuid: u, network: http, http-opts: {path: [/a], headers: {Host: [http.example]}}}
  - {name: grpc, type: trojan, server: g.example, port: 443, password: p, network: grpc, grpc-opts: {grpc-service-name: svc}, client-fingerprint: chrome}
  - {name: future, type: kcptun, server: k.example, port: 1}
`;
  const { nodes, skippedNodes, warnings } = parseSubscriptionContentDetailed(yaml);
  assert.deepEqual(warnings, []);
  assert.deepEqual(nodes.map((node) => [node.name, node.network]), [
    ['ws-upgrade', 'httpupgrade'], ['h2', 'h2'], ['http', 'http'], ['grpc', 'grpc']
  ]);
  const [upgrade, h2, http, grpc] = nodes;
  assert.deepEqual([upgrade.server, upgrade.path, upgrade.host], ['shared.example', '/up', 'edge.example']);
  assert.equal(upgrade.udp, undefined, '未知键不进入节点模型');
  assert.deepEqual([h2.host, h2.path], ['h2.example', '/h2']);
  assert.deepEqual([http.host, http.path], ['http.example', '/a']);
  assert.deepEqual([grpc.serviceName, grpc.fingerprint, grpc.tls], ['svc', 'chrome', true]);
  for (const node of nodes) validateProxyNodeInput(node);
  assert.deepEqual(skippedNodes, [{ nodeId: null, name: 'future', reason: 'unsupported_proxy_protocol_kcptun' }]);

  assert.deepEqual(parseSubscriptionContentDetailed('proxies:\n  - [unclosed').warnings, ['invalid_clash_yaml']);
});

test('link lists report unknown schemes and malformed known links instead of dropping them silently', () => {
  const result = parseSubscriptionContentDetailed([
    'trojan://secret@a.example:443#ok',
    'vmess://not-base64-json',
    'mystery://whatever'
  ].join('\n'));
  assert.deepEqual(result.nodes.map((node) => node.name), ['ok']);
  assert.deepEqual(result.skippedNodes.map((item) => item.reason), [
    'invalid_proxy_link_vmess',
    'unsupported_proxy_protocol_mystery'
  ]);
});

test('full Surge and QX configs with URLs inside are still read by their sections', () => {
  const surge = [
    '#!MANAGED-CONFIG https://sub.example/surge interval=86400 strict=false',
    '[General]',
    'proxy-test-url = http://www.gstatic.com/generate_204',
    '[Proxy]',
    'tj = trojan, tj.example, 443, password=p, sni=tj.example',
    '[Proxy Group]',
    'Proxy = select, tj',
    '[Rule]',
    'RULE-SET,https://rules.example/ai.list,Proxy',
    'FINAL,DIRECT'
  ].join('\n');
  assert.deepEqual(parseSubscriptionContentDetailed(surge).nodes.map((node) => `${node.protocol}:${node.name}`), ['trojan:tj']);

  // [server_remote] / [filter_remote] 的资源链接不是 HTTPS 代理。
  const quantumultX = [
    '[server_remote]',
    'https://sub.example/qx, tag=机场',
    '[filter_remote]',
    'https://rules.example/ai.list, tag=AI, force-policy=proxy, enabled=true',
    '[server_local]',
    'trojan=tj.example:443, password=p, over-tls=true, tls-host=tj.example, tag=tj'
  ].join('\n');
  const parsed = parseSubscriptionContentDetailed(quantumultX);
  assert.deepEqual(parsed.nodes.map((node) => `${node.protocol}:${node.name}`), ['trojan:tj']);
  assert.deepEqual(parsed.skippedNodes, []);

  // 逐行链接里混进订阅地址：报为无效链接，不当成代理。
  const list = parseSubscriptionContentDetailed('trojan://p@tj.example:443#tj\nhttps://sub.example/link?token=x\nhttps://u:p@hs.example:443#hs');
  assert.deepEqual(list.nodes.map((node) => `${node.protocol}:${node.name}`), ['trojan:tj', 'https:hs']);
  assert.deepEqual(list.skippedNodes.map((item) => item.reason), ['invalid_proxy_link_https']);
});

test('SIP008 online configs import Shadowsocks servers with their SIP003 plugins', () => {
  const sip008 = JSON.stringify({
    version: 1,
    servers: [
      {
        id: '27b8a625-4f4b-4428-9f0f-8a2317db7c79', remarks: '🇭🇰 香港 01', server: 'hk.example', server_port: 8388,
        password: 'p', method: 'chacha20-ietf-poly1305', plugin: 'obfs-local', plugin_opts: 'obfs=http;obfs-host=cdn.example'
      },
      { server: 'jp.example', server_port: 443, password: 'q', method: '2022-blake3-aes-128-gcm' },
      'not-a-server'
    ],
    bytes_used: 1024,
    bytes_remaining: 4096
  });
  const { nodes, skippedNodes } = parseSubscriptionContentDetailed(sip008);
  assert.deepEqual(
    nodes.map((node) => [node.protocol, node.name, node.server, node.port, node.cipher, node.plugin || null, node.countryCode]),
    [
      ['shadowsocks', '🇭🇰 香港 01', 'hk.example', 8388, 'chacha20-ietf-poly1305', 'obfs-local', 'HK'],
      ['shadowsocks', 'jp.example:443', 'jp.example', 443, '2022-blake3-aes-128-gcm', null, 'JP']
    ]
  );
  nodes.forEach((node) => validateProxyNodeInput(node));
  assert.deepEqual(skippedNodes.map((item) => item.reason), ['invalid_sip008_server']);
  assert.deepEqual(compileMihomoProxy(nodes[0], 'hk')['plugin-opts'], { mode: 'http', host: 'cdn.example' });
  // 只有 servers 而不是 SIP008 条目的 JSON 不当成 SIP008。
  assert.deepEqual(parseSubscriptionContentDetailed('{"servers":[{"name":"x"}]}').nodes, []);
});
