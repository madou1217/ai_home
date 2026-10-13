'use strict';

// 订阅格式往返测试共用的样本节点与断言（各格式「编译 → 导入」后连接指纹必须不变）。

const assert = require('node:assert/strict');

const { parseSubscriptionContentDetailed } = require('../../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const {
  buildProxyNodeConnectionKey,
  validateProxyNodeInput
} = require('../../lib/cli/services/toolkit/proxy-pool/proxy-node-store');

const UUID = '11111111-2222-3333-4444-555555555555';

// 覆盖全部受支持协议与常见传输；各格式的「编译 → 导入」往返都必须保持连接指纹不变。
const SAMPLE_NODES = Object.freeze([
  { protocol: 'shadowsocks', name: 'ss', server: 'ss.example', port: 8388, cipher: 'aes-256-gcm', password: 'secret' },
  {
    protocol: 'shadowsocks', name: 'ss-obfs', server: 'ss2.example', port: 8389,
    cipher: 'chacha20-ietf-poly1305', password: 'p', plugin: 'obfs-local', pluginOpts: 'obfs=http;obfs-host=cdn.example'
  },
  {
    protocol: 'vmess', name: 'vmess-ws', server: 'vm.example', port: 443, uuid: UUID, alterId: 0, cipher: 'auto',
    network: 'ws', path: '/ws', host: 'cdn.example', tls: true, sni: 'cdn.example'
  },
  {
    protocol: 'vmess', name: 'vmess-grpc', server: 'vg.example', port: 443, uuid: UUID, alterId: 0, cipher: 'auto',
    network: 'grpc', serviceName: 'svc', tls: true, sni: 'vg.example'
  },
  {
    protocol: 'vless', name: 'vless-reality', server: 'vl.example', port: 443, uuid: UUID, flow: 'xtls-rprx-vision',
    security: 'reality', tls: true, publicKey: 'PUBKEY', shortId: 'ab12', sni: 'www.example.com', fingerprint: 'chrome'
  },
  {
    protocol: 'trojan', name: 'trojan', server: 'tj.example', port: 443, password: 'p', tls: true,
    sni: 'tj.example', allowInsecure: true
  },
  {
    protocol: 'hysteria2', name: 'hy2', server: 'hy.example', port: 443, password: 'p', tls: true, sni: 'hy.example',
    obfs: 'salamander', obfsPassword: 'o', upMbps: 50, downMbps: 200
  },
  {
    protocol: 'shadowsocksr', name: 'ssr', server: 'ssr.example', port: 8443, cipher: 'aes-256-cfb', password: 'p',
    ssrProtocol: 'auth_aes128_md5', ssrProtocolParam: '1234:abcd', ssrObfs: 'tls1.2_ticket_auth', ssrObfsParam: 'cdn.example'
  },
  {
    protocol: 'hysteria', name: 'hy1', server: 'h1.example', port: 443, authStr: 'p', tls: true, sni: 'h1.example',
    alpn: ['h3'], obfs: 'o', upMbps: 50, downMbps: 200
  },
  {
    protocol: 'tuic', name: 'tuic', server: 'tu.example', port: 443, uuid: UUID, password: 'p', tls: true, sni: 'tu.example',
    alpn: ['h3'], congestionControl: 'bbr', udpRelayMode: 'native'
  },
  { protocol: 'anytls', name: 'anytls', server: 'at.example', port: 443, password: 'p', tls: true, sni: 'at.example' },
  {
    protocol: 'wireguard', name: 'wg', server: 'wg.example', port: 51820, privateKey: 'PRIV', publicKey: 'PUB',
    ip: '10.0.0.2', ipv6: 'fd00::2', mtu: 1280, reserved: '1,2,3'
  },
  { protocol: 'snell', name: 'snell', server: 'sn.example', port: 8000, psk: 'p', version: 3, obfs: 'http', obfsHost: 'cdn.example' },
  { protocol: 'socks5', name: 'socks', server: 'so.example', port: 1080, username: 'u', password: 'p' },
  { protocol: 'http', name: 'http', server: 'ht.example', port: 8080, username: 'u', password: 'p' },
  { protocol: 'https', name: 'https', server: 'hs.example', port: 443, username: 'u', password: 'p', tls: true, sni: 'hs.example' }
]);

// 端口跳跃的 Hysteria2 节点：port 取端口列表里的第一个端口（sing-box 有 server_ports 时
// 不能写 server_port，只能靠这个约定让往返后的连接指纹保持一致）。hopInterval 是客户端调优项，
// 不参与连接指纹，所以只有声明了该字段的格式才写得出来。
const HY2_PORT_HOPPING_NODE = Object.freeze({
  protocol: 'hysteria2', name: 'hy2-hop', server: 'hy.example', port: 1000, password: 'p',
  tls: true, sni: 'hy.example', ports: '1000-2000,3000', hopInterval: 30
});

// XHTTP 传输的 VLESS 节点（旧名 splithttp）：mihomo / Stash 与分享链接能表达，其余格式跳过。
const VLESS_XHTTP_NODE = Object.freeze({
  protocol: 'vless', name: 'vless-xhttp', server: 'xh.example', port: 443, uuid: UUID,
  network: 'xhttp', path: '/xh', host: 'cdn.example', mode: 'packet-up', tls: true, sni: 'cdn.example'
});

// 套了 ShadowTLS 的 Shadowsocks 节点：中立键沿用 SIP003 的 host / password / version。
// mihomo / Stash / Clash 经典、sing-box（detour + 辅助出站）与 Loon 能表达；Surge 系与 QX 跳过。
const SHADOW_TLS_NODE = Object.freeze({
  protocol: 'shadowsocks', name: 'ss-shadowtls', server: 'st.example', port: 443,
  cipher: 'aes-256-gcm', password: 'ss-pw',
  plugin: 'shadow-tls', pluginOpts: 'host=www.example.com;password=st-pw;version=3'
});

function assertRoundTrip(format, rendered, originals = SAMPLE_NODES) {
  const parsed = parseSubscriptionContentDetailed(rendered);
  assert.deepEqual(parsed.skippedNodes, [], `${format} 导入不应跳过节点`);
  assert.deepEqual(parsed.nodes.map((node) => node.name), originals.map((node) => node.name), format);
  parsed.nodes.forEach((node, index) => {
    validateProxyNodeInput(node);
    assert.equal(
      buildProxyNodeConnectionKey(node),
      buildProxyNodeConnectionKey(originals[index]),
      `${format}: ${node.name} 往返后连接参数变了：${JSON.stringify(node)}`
    );
  });
}

module.exports = { HY2_PORT_HOPPING_NODE, SAMPLE_NODES, SHADOW_TLS_NODE, UUID, VLESS_XHTTP_NODE, assertRoundTrip };
