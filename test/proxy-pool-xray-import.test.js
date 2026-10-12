'use strict';

// Xray / V2Ray 配置导入：样本按 v2rayN、v2rayNG、Happ / Streisand 导出的形状手写（含各客户端会带上的
// 无关字段），断言映射出的节点字段，并确认节点库接受每个节点、sing-box 的识别不会认领这些配置。

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseSubscriptionContentDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const { parseSingBoxOutboundsDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers/sing-box-config-parser');
const { parseXrayConfigDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers/xray-config-parser');
const { validateProxyNodeInput } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { UUID } = require('./helpers/proxy-format-samples');

const REALITY_KEY = 'Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw';
const DIRECT = { tag: 'direct', protocol: 'freedom', settings: {} };
const BLOCK = { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } };

// v2rayN「导出客户端配置」：本地入站、代理 + 直连 + 阻断出站、路由，remarks 是节点名。
function v2rayNConfig(remarks, proxy) {
  const sniffing = { enabled: true, destOverride: ['http', 'tls'], routeOnly: false };
  return {
    log: { access: '', error: '', loglevel: 'warning' },
    inbounds: [
      { tag: 'socks', port: 10808, listen: '127.0.0.1', protocol: 'socks', sniffing, settings: { auth: 'noauth', udp: true, allowTransparent: false } },
      { tag: 'http', port: 10809, listen: '127.0.0.1', protocol: 'http', sniffing, settings: { auth: 'noauth', udp: true, allowTransparent: false } }
    ],
    outbounds: [{ tag: 'proxy', ...proxy, mux: { enabled: false, concurrency: -1 } }, DIRECT, BLOCK],
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', outboundTag: 'direct', domain: ['geosite:cn'] }, { type: 'field', outboundTag: 'proxy', port: '0-65535' }]
    },
    remarks
  };
}

// v2rayNG 的导出：出站带 level 8，SS / Trojan / SOCKS 共用的服务器结构里有 method / ota 等无关字段。
function v2rayNGConfig(remarks, proxy) {
  return {
    dns: { hosts: { 'domain:googleapis.cn': 'googleapis.com' }, servers: ['1.1.1.1'] },
    inbounds: [{ listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { auth: 'noauth', udp: true, userLevel: 8 }, tag: 'socks' }],
    log: { loglevel: 'warning' },
    outbounds: [{ mux: { concurrency: 8, enabled: false }, ...proxy, tag: 'proxy' }, DIRECT, BLOCK],
    remarks,
    routing: { domainStrategy: 'IPIfNonMatch', rules: [{ ip: ['1.1.1.1'], outboundTag: 'proxy', port: '53', type: 'field' }] }
  };
}

const VLESS_REALITY = v2rayNConfig('🇯🇵 东京 Reality', {
  protocol: 'vless',
  settings: {
    vnext: [{
      address: 'jp.example.com',
      port: 443,
      users: [{ id: UUID, alterId: 0, email: 't@t.tt', security: 'auto', encryption: 'none', flow: 'xtls-rprx-vision' }]
    }]
  },
  streamSettings: {
    network: 'tcp',
    security: 'reality',
    realitySettings: {
      serverName: 'www.microsoft.com', fingerprint: 'chrome', show: false, publicKey: REALITY_KEY, shortId: '6ba85179e30d4fc2', spiderX: ''
    }
  }
});

const VMESS_WS_TLS = v2rayNGConfig('US vmess ws', {
  protocol: 'vmess',
  settings: {
    vnext: [{ address: 'vm.example.com', port: 443, users: [{ alterId: 0, encryption: '', flow: '', id: UUID, level: 8, security: 'auto' }] }]
  },
  streamSettings: {
    network: 'ws',
    security: 'tls',
    tlsSettings: {
      allowInsecure: false, alpn: ['h2', 'http/1.1'], fingerprint: 'chrome', publicKey: '', serverName: 'cdn.example.com', shortId: '', show: false, spiderX: ''
    },
    wsSettings: { headers: { Host: 'cdn.example.com' }, path: '/vmess?ed=2048' }
  }
});

const VLESS_GRPC = v2rayNConfig('SG vless grpc', {
  protocol: 'vless',
  settings: { vnext: [{ address: 'sg.example.com', port: 443, users: [{ id: UUID, alterId: 0, email: 't@t.tt', security: 'auto', encryption: 'none', flow: '' }] }] },
  streamSettings: {
    network: 'grpc',
    security: 'tls',
    tlsSettings: { allowInsecure: false, serverName: 'sg.example.com', alpn: ['h2'], fingerprint: 'firefox', show: false },
    grpcSettings: { serviceName: 'vless-grpc', multiMode: false, idle_timeout: 60, health_check_timeout: 20, permit_without_stream: false, initial_windows_size: 0 }
  }
});

const TROJAN_TLS = v2rayNGConfig('HK trojan', {
  protocol: 'trojan',
  settings: { servers: [{ address: 'hk.example.com', flow: '', level: 8, method: 'chacha20-poly1305', ota: false, password: 'trojan-secret', port: 443 }] },
  streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { allowInsecure: true, fingerprint: '', serverName: 'hk.example.com', show: false } }
});

const SHADOWSOCKS = v2rayNGConfig('TW ss', {
  protocol: 'shadowsocks',
  settings: { servers: [{ address: 'tw.example.com', level: 8, method: 'chacha20-poly1305', ota: false, password: 'ss-secret', port: 8388 }] },
  streamSettings: { network: 'tcp' }
});

// 没有 remarks：节点名取出站的 tag。
const SOCKS_WITH_USER = {
  outbounds: [{
    tag: 'office-socks',
    protocol: 'socks',
    settings: { servers: [{ address: 'so.example.com', port: 1080, users: [{ user: 'alice', pass: 'wonderland', level: 8 }] }] },
    streamSettings: { network: 'tcp' }
  }, DIRECT]
};

const HTTP_PROXY = v2rayNConfig('Office HTTP', {
  protocol: 'http',
  settings: { servers: [{ address: 'ht.example.com', port: 8080, users: [{ user: 'u', pass: 'p' }] }] }
});

const WIREGUARD = v2rayNGConfig('WARP', {
  protocol: 'wireguard',
  settings: {
    secretKey: 'cH/r6Hq9n3Sw1pMkn9BJ7I0g3H0eHCIBu7hc6Ui2rU0=',
    address: ['172.16.0.2/32', '2606:4700:110:8a36:df92:102a:9602:fa18/128'],
    peers: [{
      publicKey: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
      preSharedKey: 'cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHM=',
      endpoint: 'engage.cloudflareclient.com:2408',
      keepAlive: 0,
      allowedIPs: ['0.0.0.0/0', '::/0']
    }],
    reserved: [78, 135, 76],
    mtu: 1280,
    workers: 2,
    domainStrategy: 'ForceIP'
  }
});

const KCP = v2rayNConfig('kcp node', {
  protocol: 'vmess',
  settings: { vnext: [{ address: 'kcp.example.com', port: 2053, users: [{ id: UUID, alterId: 0, security: 'auto' }] }] },
  streamSettings: {
    network: 'kcp',
    security: 'none',
    kcpSettings: {
      mtu: 1350, tti: 50, uplinkCapacity: 12, downlinkCapacity: 100, congestion: false, readBufferSize: 1, writeBufferSize: 1,
      header: { type: 'wechat-video' }, seed: 'seed'
    }
  }
});

function withoutCountry(node) {
  const { countryCode: _code, countryName: _name, countryFlag: _flag, ...fields } = node;
  return fields;
}

/** 解析 → 断言没有跳过项、节点库接受每个节点、sing-box 不认领 → 去掉国家字段后的节点。 */
function importXray(config) {
  const text = JSON.stringify(config, null, 2);
  assert.equal(parseSingBoxOutboundsDetailed(text), null, 'sing-box 不应认领 Xray 配置');
  const result = parseSubscriptionContentDetailed(text);
  assert.deepEqual(result.skippedNodes, []);
  for (const node of result.nodes) validateProxyNodeInput(node);
  return result.nodes.map(withoutCountry);
}

test('v2rayN VLESS + REALITY + Vision keeps the flow and REALITY keys; direct and block outbounds are skipped', () => {
  assert.deepEqual(importXray(VLESS_REALITY), [{
    protocol: 'vless',
    name: '🇯🇵 东京 Reality',
    server: 'jp.example.com',
    port: 443,
    uuid: UUID,
    flow: 'xtls-rprx-vision',
    network: 'tcp',
    tls: true,
    security: 'reality',
    sni: 'www.microsoft.com',
    publicKey: REALITY_KEY,
    shortId: '6ba85179e30d4fc2',
    fingerprint: 'chrome'
  }]);
});

test('v2rayNG VMess + ws + TLS and VLESS + gRPC map the transport and TLS settings', () => {
  assert.deepEqual(importXray(VMESS_WS_TLS), [{
    protocol: 'vmess',
    name: 'US vmess ws',
    server: 'vm.example.com',
    port: 443,
    uuid: UUID,
    alterId: 0,
    cipher: 'auto',
    network: 'ws',
    path: '/vmess?ed=2048',
    host: 'cdn.example.com',
    tls: true,
    sni: 'cdn.example.com',
    alpn: ['h2', 'http/1.1'],
    fingerprint: 'chrome'
  }]);
  assert.deepEqual(importXray(VLESS_GRPC), [{
    protocol: 'vless',
    name: 'SG vless grpc',
    server: 'sg.example.com',
    port: 443,
    uuid: UUID,
    network: 'grpc',
    serviceName: 'vless-grpc',
    tls: true,
    sni: 'sg.example.com',
    alpn: ['h2'],
    fingerprint: 'firefox'
  }]);
});

test('Trojan and Shadowsocks read their credentials from servers[0]', () => {
  assert.deepEqual(importXray(TROJAN_TLS), [{
    protocol: 'trojan',
    name: 'HK trojan',
    server: 'hk.example.com',
    port: 443,
    password: 'trojan-secret',
    network: 'tcp',
    tls: true,
    sni: 'hk.example.com',
    allowInsecure: true
  }]);
  // Xray 的 chacha20-poly1305 即 IETF 版。
  assert.deepEqual(importXray(SHADOWSOCKS), [{
    protocol: 'shadowsocks',
    name: 'TW ss',
    server: 'tw.example.com',
    port: 8388,
    cipher: 'chacha20-ietf-poly1305',
    password: 'ss-secret'
  }]);
});

test('SOCKS and HTTP read users[0]; HTTP over TLS becomes HTTPS', () => {
  assert.deepEqual(importXray(SOCKS_WITH_USER), [{
    protocol: 'socks5', name: 'office-socks', server: 'so.example.com', port: 1080, username: 'alice', password: 'wonderland'
  }]);
  assert.deepEqual(importXray(HTTP_PROXY), [{
    protocol: 'http', name: 'Office HTTP', server: 'ht.example.com', port: 8080, username: 'u', password: 'p'
  }]);
  const https = structuredClone(HTTP_PROXY);
  https.outbounds[0].streamSettings = { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'ht.example.com', allowInsecure: false } };
  assert.deepEqual(importXray(https), [{
    protocol: 'https', name: 'Office HTTP', server: 'ht.example.com', port: 8080, username: 'u', password: 'p', tls: true, sni: 'ht.example.com'
  }]);
});

test('WireGuard takes the server from the peer endpoint and the keys, addresses and reserved bytes from settings', () => {
  assert.deepEqual(importXray(WIREGUARD), [{
    protocol: 'wireguard',
    name: 'WARP',
    server: 'engage.cloudflareclient.com',
    port: 2408,
    privateKey: 'cH/r6Hq9n3Sw1pMkn9BJ7I0g3H0eHCIBu7hc6Ui2rU0=',
    publicKey: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
    presharedKey: 'cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHM=',
    ip: '172.16.0.2',
    ipv6: '2606:4700:110:8a36:df92:102a:9602:fa18',
    mtu: 1280,
    reserved: '78,135,76'
  }]);
  const ipv6 = structuredClone(WIREGUARD);
  ipv6.outbounds[0].settings.peers[0].endpoint = '[2606:4700:d0::a29f:c001]:2408';
  assert.deepEqual(importXray(ipv6).map((node) => [node.server, node.port]), [['2606:4700:d0::a29f:c001', 2408]]);
  const broken = structuredClone(WIREGUARD);
  broken.outbounds[0].settings.peers[0].endpoint = 'no-port.example';
  assert.deepEqual(parseSubscriptionContentDetailed(JSON.stringify(broken)).skippedNodes, [
    { nodeId: null, name: 'WARP', reason: 'invalid_wireguard_endpoint' }
  ]);
});

test('an array of configs (Happ / Streisand subscriptions) imports one node per config', () => {
  const happ = [
    { remarks: '🇩🇪 Germany', outbounds: [{ tag: 'proxy', ...VLESS_REALITY.outbounds[0] }, DIRECT, BLOCK] },
    { remarks: '🇳🇱 Netherlands', outbounds: [VMESS_WS_TLS.outbounds[0], DIRECT, BLOCK] }
  ];
  assert.deepEqual(importXray(happ).map((node) => [node.name, node.protocol, node.server]), [
    ['🇩🇪 Germany', 'vless', 'jp.example.com'],
    ['🇳🇱 Netherlands', 'vmess', 'vm.example.com']
  ]);
});

test('non-proxy outbounds are skipped silently and unsupported transports are reported', () => {
  const config = {
    remarks: 'mixed',
    outbounds: [
      DIRECT,
      BLOCK,
      { tag: 'dns-out', protocol: 'dns', settings: {} },
      { tag: 'loop', protocol: 'loopback', settings: { inboundTag: 'socks' } },
      { tag: 'fragment', protocol: 'freedom', settings: { fragment: { packets: 'tlshello', length: '100-200', interval: '10-20' } } }
    ]
  };
  // 直接问 Xray 解析器：认得这份配置（不是 null），只是没有代理出站。
  assert.deepEqual(parseXrayConfigDetailed(JSON.stringify(config)), { nodes: [], skippedNodes: [], warnings: [] });

  assert.deepEqual(parseSubscriptionContentDetailed(JSON.stringify(KCP, null, 2)), {
    nodes: [],
    skippedNodes: [{ nodeId: null, name: 'kcp node', reason: 'unsupported_proxy_transport_kcp' }],
    warnings: [],
    format: 'xray'
  });
  for (const network of ['quic', 'xhttp', 'splithttp']) {
    const other = structuredClone(KCP);
    other.outbounds[0].streamSettings = { network, security: 'tls' };
    assert.deepEqual(parseSubscriptionContentDetailed(JSON.stringify(other)).skippedNodes.map((item) => item.reason), [
      `unsupported_proxy_transport_${network}`
    ]);
  }
  const hysteria = { outbounds: [{ tag: 'hy', protocol: 'hysteria', settings: { address: 'hy.example', port: 443 } }] };
  assert.deepEqual(parseSubscriptionContentDetailed(JSON.stringify(hysteria)).skippedNodes, [
    { nodeId: null, name: 'hy', reason: 'unsupported_proxy_protocol_hysteria' }
  ]);
});

test('newer Xray writing (flat settings, raw, method, REALITY password) and the other transports are understood', () => {
  const flat = {
    remarks: 'flat',
    outbounds: [{
      protocol: 'vless',
      settings: { address: 'flat.example', port: 443, id: UUID, encryption: 'none', flow: 'xtls-rprx-vision' },
      // 新字段名 password；旧字段名留空时不能盖过它。
      streamSettings: { method: 'raw', security: 'reality', realitySettings: { serverName: 'www.example.com', publicKey: '', password: REALITY_KEY, shortId: 'ab' } }
    }, DIRECT]
  };
  assert.deepEqual(importXray(flat), [{
    protocol: 'vless', name: 'flat', server: 'flat.example', port: 443, uuid: UUID, flow: 'xtls-rprx-vision',
    network: 'tcp', tls: true, security: 'reality', sni: 'www.example.com', publicKey: REALITY_KEY, shortId: 'ab'
  }]);
  const flatSocks = { outbounds: [{ tag: 'fs', protocol: 'socks', settings: { address: 'fs.example', port: 1080, user: 'u', pass: 'p' } }] };
  assert.deepEqual(importXray(flatSocks).map((node) => [node.server, node.username, node.password]), [['fs.example', 'u', 'p']]);

  const transport = (streamSettings) => importXray({
    outbounds: [{ tag: 't', protocol: 'vmess', settings: { vnext: [{ address: 't.example', port: 443, users: [{ id: UUID }] }] }, streamSettings }]
  })[0];
  const http1 = transport({
    network: 'tcp',
    tcpSettings: { header: { type: 'http', request: { version: '1.1', method: 'GET', path: ['/obfs'], headers: { Host: ['obfs.example'] } } } }
  });
  assert.deepEqual([http1.network, http1.path, http1.host], ['http', '/obfs', 'obfs.example']);
  const h2 = transport({ network: 'h2', security: 'tls', httpSettings: { host: ['h2.example'], path: '/h2' } });
  assert.deepEqual([h2.network, h2.path, h2.host, h2.tls], ['h2', '/h2', 'h2.example', true]);
  const upgrade = transport({ network: 'httpupgrade', httpupgradeSettings: { path: '/up', host: 'up.example' } });
  assert.deepEqual([upgrade.network, upgrade.path, upgrade.host], ['httpupgrade', '/up', 'up.example']);
  const ws = transport({ network: 'websocket', wsSettings: { path: '/ws', host: 'ws.example' } });
  assert.deepEqual([ws.network, ws.path, ws.host], ['ws', '/ws', 'ws.example']);
});

test('node names fall back to a meaningful tag, then address:port; shared configs keep names distinct', () => {
  const trojan = (tag, address) => ({
    tag, protocol: 'trojan', settings: { servers: [{ address, port: 443, password: 'p' }] }, streamSettings: { security: 'tls' }
  });
  assert.deepEqual(importXray({ outbounds: [trojan('proxy', '2001:db8::1')] }).map((node) => node.name), ['[2001:db8::1]:443']);
  assert.deepEqual(importXray({ remarks: 'Balancer', outbounds: [trojan('proxy-1', 'a.example'), trojan('de-fra', 'b.example'), DIRECT] })
    .map((node) => node.name), ['Balancer a.example:443', 'Balancer de-fra']);
});

test('settings the node model cannot express are reported instead of imported wrongly', () => {
  const reasons = (outbound) => parseSubscriptionContentDetailed(JSON.stringify({ outbounds: [{ tag: 'x', ...outbound }] }))
    .skippedNodes.map((item) => item.reason);
  // VLESS Encryption（ML-KEM）。
  assert.deepEqual(reasons({
    protocol: 'vless', settings: { vnext: [{ address: 'e.example', port: 443, users: [{ id: UUID, encryption: 'mlkem768x25519plus.native.0rtt.key' }] }] }
  }), ['unsupported_vless_encryption']);
  // Shadowsocks / SOCKS 节点没有传输层与 TLS 字段。
  assert.deepEqual(reasons({
    protocol: 'shadowsocks', settings: { servers: [{ address: 's.example', port: 443, method: 'aes-128-gcm', password: 'p' }] },
    streamSettings: { network: 'ws', wsSettings: { path: '/' } }
  }), ['unsupported_proxy_transport_ws']);
  assert.deepEqual(reasons({
    protocol: 'socks', settings: { servers: [{ address: 's.example', port: 443 }] }, streamSettings: { security: 'tls' }
  }), ['unsupported_proxy_security_tls']);
  assert.deepEqual(reasons({
    protocol: 'vmess', settings: { vnext: [{ address: 'x.example', port: 443, users: [{ id: UUID }] }] }, streamSettings: { security: 'xtls' }
  }), ['unsupported_proxy_security_xtls']);
});
