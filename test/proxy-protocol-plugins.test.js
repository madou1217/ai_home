'use strict';

// SSR / Hysteria v1 / TUIC v5 / AnyTLS / WireGuard / Snell 各插件的细节：分享链接、Clash 条目的
// 各种写法、各输出目标的字段与限制。跨格式往返见 proxy-pool-format-roundtrip 与各渲染器测试。

const assert = require('node:assert/strict');
const test = require('node:test');
const YAML = require('yaml');

const { compileMihomoProxy } = require('../lib/cli/services/toolkit/proxy-pool/cores/mihomo/proxy-compiler');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const {
  encodeProxyNode,
  parseProxyNode,
  parseSubscriptionContentDetailed
} = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const { normalizeProtocol, supportsUdpRelay } = require('../lib/cli/services/toolkit/proxy-pool/protocols');
const {
  buildProxyNodeConnectionKey,
  validateProxyNodeInput
} = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const { SAMPLE_NODES } = require('./helpers/proxy-format-samples');

const sample = (name) => SAMPLE_NODES.find((node) => node.name === name);
const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');

function fields(node) {
  const { countryCode, countryName, countryFlag, rawUri, ...rest } = node;
  return rest;
}

test('share links of the added protocols round-trip through their plugins', () => {
  for (const name of ['ssr', 'hy1', 'tuic', 'anytls', 'wg']) {
    const node = sample(name);
    const parsed = parseProxyNode(encodeProxyNode(node));
    assert.ok(parsed, name);
    validateProxyNodeInput(parsed);
    assert.equal(parsed.name, name);
    assert.equal(buildProxyNodeConnectionKey(parsed), buildProxyNodeConnectionKey(node), `${name}: ${JSON.stringify(parsed)}`);
  }
  // Snell 没有分享链接格式；hysteria1 / ssr / wg 是协议别名。
  assert.equal(encodeProxyNode(sample('snell')), '');
  assert.deepEqual(['hysteria1', 'ssr', 'wg', 'tuic-v5'].map(normalizeProtocol), ['hysteria', 'shadowsocksr', 'wireguard', 'tuic']);
});

test('SSR links decode base64url bodies, bare IPv6 servers and base64 parameters', () => {
  const body = `2001:db8::1:8443:auth_chain_a:chacha20-ietf:tls1.2_ticket_auth:${b64url('pa:ss')}`
    + `/?obfsparam=${b64url('cdn.example')}&protoparam=&remarks=${b64url('香港 01')}&group=${b64url('机场')}`;
  const node = parseProxyNode(`ssr://${b64url(body)}`);
  assert.deepEqual(fields(node), {
    protocol: 'shadowsocksr',
    name: '香港 01',
    server: '2001:db8::1',
    port: 8443,
    cipher: 'chacha20-ietf',
    password: 'pa:ss',
    ssrProtocol: 'auth_chain_a',
    ssrProtocolParam: undefined,
    ssrObfs: 'tls1.2_ticket_auth',
    ssrObfsParam: 'cdn.example'
  });
  assert.equal(node.countryCode, 'HK');
  assert.equal(parseProxyNode(`ssr://${b64url('not-a-node')}`), null);
  // 缺省的协议与混淆按 origin / plain 输出。
  const proxy = compileMihomoProxy({ ...node, ssrProtocol: undefined, ssrObfs: undefined }, 'x');
  assert.deepEqual([proxy.type, proxy.protocol, proxy.obfs, proxy['obfs-param']], ['ssr', 'origin', 'plain', 'cdn.example']);
});

test('WireGuard links accept the wg:// alias and compile reserved bytes for both cores', () => {
  const node = parseProxyNode('wg://PRIV@[2001:db8::2]:2408?public_key=PUB&address=172.16.0.2/32,fd01::2/128&reserved=1,2,3&mtu=1280#warp');
  assert.deepEqual(
    [node.protocol, node.server, node.port, node.ip, node.ipv6, node.reserved, node.mtu],
    ['wireguard', '2001:db8::2', 2408, '172.16.0.2', 'fd01::2', '1,2,3', 1280]
  );
  const proxy = compileMihomoProxy(node, 'warp');
  assert.deepEqual([proxy['private-key'], proxy['public-key'], proxy.ip, proxy.ipv6, proxy.reserved], ['PRIV', 'PUB', '172.16.0.2', 'fd01::2', [1, 2, 3]]);
  // sing-box 里是 endpoint：对端放进 peers。
  const endpoint = compileSingBoxNodeOutbound(node, 'warp');
  assert.deepEqual(endpoint, {
    type: 'wireguard',
    tag: 'warp',
    address: ['172.16.0.2/32', 'fd01::2/128'],
    private_key: 'PRIV',
    peers: [{ address: '2001:db8::2', port: 2408, public_key: 'PUB', allowed_ips: ['0.0.0.0/0', '::/0'], reserved: [1, 2, 3] }],
    mtu: 1280
  });
  assert.equal(compileSingBoxNodeOutbound({ ...node, ip: '10.8.0.2/24' }, 'warp').address[0], '10.8.0.2/24');
  // base64 写法的 reserved 原样输出；没有本机地址编不出出站。
  assert.equal(compileMihomoProxy({ ...node, reserved: 'U4An' }, 'warp').reserved, 'U4An');
  assert.throws(() => compileMihomoProxy({ ...node, ip: undefined, ipv6: undefined }, 'warp'), /missing_required_proxy_field_ip/);
});

test('Clash entries of the added protocols import, including peers lists and Stash spellings', () => {
  const yaml = `proxies:
  - { name: ssr, type: ssr, server: s.example, port: 443, cipher: chacha20-ietf, password: p, protocol: auth_aes128_sha1, protocol-param: "1:x", obfs: http_simple, obfs-param: cdn.example }
  - { name: hy1, type: hysteria, server: h.example, port: 443, auth: ${Buffer.from('secret').toString('base64')}, up-speed: 30, down-speed: 100, obfs-protocol: wechat-video, sni: h.example }
  - { name: tuic, type: tuic, server: t.example, port: 443, uuid: u, password: p, congestion-controller: bbr, udp-relay-mode: native, alpn: [h3], sni: t.example }
  - { name: tuic-v4, type: tuic, server: t4.example, port: 443, token: tok }
  - { name: anytls, type: anytls, server: a.example, port: 443, password: p, sni: a.example, client-fingerprint: chrome }
  - name: wg
    type: wireguard
    private-key: PRIV
    ip: 172.16.0.2
    udp: true
    peers:
      - { server: peer.example, port: 2408, public-key: PUB, pre-shared-key: PSK, reserved: [1, 2, 3], allowed-ips: ['0.0.0.0/0'] }
  - { name: snell, type: snell, server: n.example, port: 8000, psk: k, version: 2, obfs-opts: { mode: tls, host: cdn.example } }
`;
  const { nodes, skippedNodes } = parseSubscriptionContentDetailed(yaml);
  assert.deepEqual(skippedNodes.map((item) => [item.name, item.reason]), [['tuic-v4', 'unsupported_proxy_protocol_tuic-v4']]);
  nodes.forEach((node) => validateProxyNodeInput(node));
  const byName = Object.fromEntries(nodes.map((node) => [node.name, fields(node)]));
  assert.deepEqual(
    [byName.ssr.ssrProtocol, byName.ssr.ssrProtocolParam, byName.ssr.ssrObfs, byName.ssr.ssrObfsParam],
    ['auth_aes128_sha1', '1:x', 'http_simple', 'cdn.example']
  );
  assert.deepEqual(
    [byName.hy1.authStr, byName.hy1.upMbps, byName.hy1.downMbps, byName.hy1.hysteriaProtocol, byName.hy1.tls],
    ['secret', 30, 100, 'wechat-video', true]
  );
  assert.deepEqual([byName.tuic.congestionControl, byName.tuic.udpRelayMode, byName.tuic.alpn], ['bbr', 'native', ['h3']]);
  assert.deepEqual([byName.anytls.sni, byName.anytls.fingerprint, byName.anytls.tls], ['a.example', 'chrome', true]);
  assert.deepEqual(
    [byName.wg.server, byName.wg.port, byName.wg.publicKey, byName.wg.presharedKey, byName.wg.reserved],
    ['peer.example', 2408, 'PUB', 'PSK', '1,2,3']
  );
  assert.deepEqual([byName.snell.psk, byName.snell.version, byName.snell.obfs, byName.snell.obfsHost], ['k', 2, 'tls', 'cdn.example']);
});

test('Snell v1/v2 never get UDP and versions beyond 3 only reach Surge', () => {
  const v2 = { ...sample('snell'), version: 2 };
  const v4 = { ...sample('snell'), name: 'snell-v4', version: 4 };
  assert.equal(supportsUdpRelay(v2), false);
  assert.equal(supportsUdpRelay(sample('snell')), true);
  assert.equal(supportsUdpRelay(sample('http')), false);
  const mihomo = getRenderer('mihomo');
  assert.equal(mihomo.compileNode({ node: v2, name: 'snell' }).udp, undefined);
  assert.equal(mihomo.compileNode({ node: sample('snell'), name: 'snell' }).udp, true);
  assert.throws(() => mihomo.compileNode({ node: v4, name: 'snell-v4' }), { code: 'unsupported_snell_version_4' });
  assert.equal(getRenderer('surge').compileNode({ node: v4, name: 'snell-v4' }), 'snell-v4 = snell, sn.example, 8000, psk=p, version=4, obfs=http, obfs-host=cdn.example');
});

test('Hysteria v1 needs declared bandwidth and Stash also gets its own key spellings', () => {
  const node = { ...sample('hy1'), hysteriaProtocol: 'faketcp' };
  const proxy = getRenderer('mihomo').compileNode({ node, name: 'hy1' });
  assert.deepEqual([proxy.up, proxy.down, proxy.protocol, proxy['up-speed']], ['50 Mbps', '200 Mbps', 'faketcp', undefined]);
  const stash = getRenderer('stash').compileNode({ node, name: 'hy1' });
  assert.deepEqual([stash['up-speed'], stash['down-speed'], stash['obfs-protocol']], [50, 200, 'faketcp']);
  assert.equal(getRenderer('stash').compileNode({ node: sample('tuic'), name: 'tuic' }).version, 5);
  // sing-box 只实现 UDP 传输的 Hysteria；带宽缺失时两个内核都不编。
  assert.throws(() => compileSingBoxNodeOutbound(node, 'hy1'), { code: 'unsupported_hysteria_protocol_faketcp' });
  assert.throws(() => compileMihomoProxy({ ...node, upMbps: undefined }, 'hy1'), /missing_required_proxy_field_upMbps/);
  const outbound = compileSingBoxNodeOutbound(sample('hy1'), 'hy1');
  assert.deepEqual([outbound.up_mbps, outbound.down_mbps, outbound.auth_str, outbound.obfs, outbound.tls.alpn], [50, 200, 'p', 'o', ['h3']]);
});

test('Surge, Loon and QX lines of the added protocols import back through their plugins', () => {
  const text = [
    '[Proxy]',
    'tuic = tuic-v5, tu.example, 443, uuid=u, password=p, alpn=h3, sni=tu.example, skip-cert-verify=true',
    'snell = snell, sn.example, 8000, psk=k, version=4',
    'ssr = ShadowsocksR, ssr.example, 443, aes-256-cfb, "p,w", protocol=auth_aes128_md5, obfs=http_simple, obfs-param=cdn.example'
  ].join('\n');
  const { nodes, skippedNodes } = parseSubscriptionContentDetailed(text);
  assert.deepEqual(skippedNodes, []);
  assert.deepEqual(nodes.map((node) => node.protocol), ['tuic', 'snell', 'shadowsocksr']);
  assert.deepEqual([nodes[0].allowInsecure, nodes[0].tls, nodes[1].version, nodes[2].password], [true, true, 4, 'p,w']);

  const qx = 'shadowsocks=ssr.example:443, method=chacha20, password=p, ssr-protocol=auth_chain_b, ssr-protocol-param=def, obfs=tls1.2_ticket_fastauth, obfs-host=bing.com, tag=ssr-qx';
  const [ssr] = parseSubscriptionContentDetailed(qx).nodes;
  assert.deepEqual(
    [ssr.protocol, ssr.name, ssr.cipher, ssr.ssrProtocol, ssr.ssrProtocolParam, ssr.ssrObfs, ssr.ssrObfsParam],
    ['shadowsocksr', 'ssr-qx', 'chacha20', 'auth_chain_b', 'def', 'tls1.2_ticket_fastauth', 'bing.com']
  );
});

test('the mihomo output of every added protocol is valid Clash YAML', () => {
  const mihomo = getRenderer('mihomo');
  const proxies = ['ssr', 'hy1', 'tuic', 'anytls', 'wg', 'snell']
    .map((name) => mihomo.compileNode({ node: sample(name), name }));
  const parsed = YAML.parse(require('../lib/cli/services/toolkit/proxy-pool/cores/mihomo/proxy-compiler').emitYaml({ proxies })).proxies;
  assert.deepEqual(parsed.map((proxy) => proxy.type), ['ssr', 'hysteria', 'tuic', 'anytls', 'wireguard', 'snell']);
  assert.deepEqual(parsed[3], {
    name: 'anytls', type: 'anytls', server: 'at.example', port: 443, password: 'p', sni: 'at.example', udp: true
  });
  assert.deepEqual(parsed[5]['obfs-opts'], { mode: 'http', host: 'cdn.example' });
});
