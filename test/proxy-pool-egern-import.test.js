'use strict';

// Egern 配置导入：Egern 渲染器的完整配置、节点视图与裸列表都能读回同样的连接参数；
// 手写条目覆盖样本之外的传输写法；Egern 的识别不会抢走普通 Clash YAML。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const { parseSubscriptionContentDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const { parseEgernProxiesDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers/egern-config-parser');
const { validateProxyNodeInput } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { SAMPLE_NODES, UUID, assertRoundTrip } = require('./helpers/proxy-format-samples');

// Egern 没有 SSR 与 Hysteria v1，渲染时跳过。
const EGERN_NODES = SAMPLE_NODES.filter((node) => !['shadowsocksr', 'hysteria'].includes(node.protocol));

function withService(nodes, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-egern-import-'));
  try {
    const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => 1 });
    const service = new SubscriptionAggregatorService({
      store,
      now: () => 1,
      sources: {
        listSources: () => [{ id: 'sub_a', name: 'A', url: 'https://a.example', nodeCount: nodes.length, lastSyncedAt: 1 }],
        listNodes: () => nodes.map((node) => ({ ...node, subscriptionId: 'sub_a' })),
        syncSource: async () => ({ ok: true })
      }
    });
    const profile = store.saveProfile({ name: 'egern', refreshHours: 0 });
    return run(service, profile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseOne(yaml) {
  const result = parseSubscriptionContentDetailed(yaml);
  assert.deepEqual(result.skippedNodes, []);
  assert.equal(result.nodes.length, 1);
  validateProxyNodeInput(result.nodes[0]);
  return result.nodes[0];
}

test('the Egern full config, nodes view and a bare list round-trip every protocol Egern supports', () => {
  withService(SAMPLE_NODES, (service, profile) => {
    const full = service.preview(profile.id, 'egern');
    assert.deepEqual(full.skippedNodes.map((item) => item.name), ['ssr', 'hy1']);
    // 完整配置里还有策略组与规则（同样是单键映射），只读 proxies。
    const config = YAML.parse(full.content);
    assert.ok(config.policy_groups.length > 0 && config.rules.length > 0);
    assertRoundTrip('egern', full.content, EGERN_NODES);

    const nodesView = service.preview(profile.id, 'egern', { view: 'nodes' }).content;
    assert.deepEqual(Object.keys(YAML.parse(nodesView)), ['proxies']);
    assertRoundTrip('egern nodes view', nodesView, EGERN_NODES);

    // 只有列表本身的导出（换一个 YAML 输出器，引号与缩进风格都不同）。
    assertRoundTrip('egern bare list', YAML.stringify(YAML.parse(nodesView).proxies), EGERN_NODES);
  });
});

test('Egern transports outside the samples map back to the node transports', () => {
  const ws = parseOne(`proxies:
  - vless:
      name: ws
      server: ws.example
      port: 80
      user_id: ${UUID}
      transport:
        ws:
          path: /ray
          headers:
            Host: cdn.example
`);
  assert.deepEqual([ws.network, ws.path, ws.host, ws.tls], ['ws', '/ray', 'cdn.example', undefined]);

  const http1 = parseOne(`- vmess: {name: h1, server: h1.example, port: 80, user_id: ${UUID}, security: auto, legacy: true,
    transport: {http1: {method: GET, path: /p, headers: {Host: h.example}}}}
`);
  assert.deepEqual([http1.network, http1.path, http1.host, http1.alterId], ['http', '/p', 'h.example', 1]);

  const http2 = parseOne(`- vmess: {name: h2, server: h2.example, port: 443, user_id: ${UUID}, security: zero,
    transport: {http2: {path: /h2, headers: {Host: h2.example}, sni: h2.example, skip_tls_verify: true}}}
`);
  assert.deepEqual(
    [http2.network, http2.path, http2.host, http2.tls, http2.sni, http2.allowInsecure, http2.cipher, http2.alterId],
    ['h2', '/h2', 'h2.example', true, 'h2.example', true, 'zero', 0]
  );

  const grpcReality = parseOne(`- vless: {name: g, server: g.example, port: 443, user_id: ${UUID},
    transport: {grpc: {service_name: svc, sni: www.example.com, reality: {public_key: PK, short_id: ab}}}}
`);
  assert.deepEqual(
    [grpcReality.network, grpcReality.serviceName, grpcReality.security, grpcReality.publicKey, grpcReality.shortId],
    ['grpc', 'svc', 'reality', 'PK', 'ab']
  );

  const trojanWs = parseOne('- trojan: {name: t, server: t.example, port: 443, password: p, sni: t.example, websocket: {path: /t, host: cdn.example}}\n');
  assert.deepEqual([trojanWs.network, trojanWs.path, trojanWs.host, trojanWs.tls], ['ws', '/t', 'cdn.example', true]);

  // Egern 的 AnyTLS 不写 skip_tls_verify 时就不校验证书。
  assert.equal(parseOne('- anytls: {name: a, server: a.example, port: 443, password: p}\n').allowInsecure, true);
  assert.equal(parseOne('- anytls: {name: a, server: a.example, port: 443, password: p, skip_tls_verify: false}\n').allowInsecure, undefined);

  const ss = parseOne('- shadowsocks: {name: s, server: s.example, port: 8388, method: chacha20-poly1305, password: p, obfs: tls, obfs_host: h.example}\n');
  assert.deepEqual([ss.cipher, ss.plugin, ss.pluginOpts], ['chacha20-ietf-poly1305', 'obfs-local', 'obfs=tls;obfs-host=h.example']);
});

test('Egern policy groups are skipped silently and unsupported proxy types are reported', () => {
  const result = parseSubscriptionContentDetailed(`proxies:
  - select:
      name: Proxy
      policies: [ok]
  - auto_test:
      name: Auto
      policies: [ok]
  - socks5:
      name: ok
      server: s.example
      port: 1080
  - ssh:
      name: jump
      server: j.example
      port: 22
      username: root
  - socks5_tls:
      name: secure
      server: st.example
      port: 443
  - naive:
      name: future
      server: n.example
      port: 443
`);
  assert.deepEqual(result.nodes.map((node) => [node.name, node.protocol]), [['ok', 'socks5']]);
  assert.deepEqual(result.skippedNodes, [
    { nodeId: null, name: 'jump', reason: 'unsupported_proxy_protocol_ssh' },
    { nodeId: null, name: 'secure', reason: 'unsupported_proxy_protocol_socks5_tls' },
    { nodeId: null, name: 'future', reason: 'unsupported_proxy_protocol_naive' }
  ]);
  // 不支持的传输写法也是跳过项，不会落成错的节点。
  const quic = parseSubscriptionContentDetailed(`- vmess: {name: q, server: q.example, port: 443, user_id: ${UUID}, security: auto, transport: {quic: {}}}\n`);
  assert.deepEqual(quic.skippedNodes, [{ nodeId: null, name: 'q', reason: 'unsupported_proxy_transport_quic' }]);
  // ShadowTLS 包装在导入时跳过；AnyTLS 的 REALITY 如实带出，由节点库拒绝。
  const wrapped = parseSubscriptionContentDetailed(
    '- shadowsocks: {name: stls, server: s.example, port: 443, method: aes-128-gcm, password: p, shadow_tls: {password: x, sni: www.example.com}}\n'
  );
  assert.deepEqual(wrapped.skippedNodes, [{ nodeId: null, name: 'stls', reason: 'unsupported_proxy_field_shadow_tls' }]);
  const [anytlsReality] = parseSubscriptionContentDetailed('- anytls: {name: ar, server: a.example, port: 443, password: p, reality: {public_key: PK}}\n').nodes;
  assert.throws(() => validateProxyNodeInput(anytlsReality), /unsupported_proxy_field_security/);
});

test('a regular Clash YAML is still read by the Clash importer', () => {
  const clash = `mixed-port: 7890
dns:
  enable: true
  nameserver:
    - https://doh.pub/dns-query
    - tls://dot.pub
proxies:
  - name: vless
    type: vless
    server: v.example
    port: 443
    uuid: ${UUID}
    tls: true
    servername: v.example
  - {name: http, type: http, server: h.example, port: 8080}
  - name: broken
    type: tor
    server: t.example
    port: 9050
proxy-groups:
  - name: Proxy
    type: select
    proxies:
      - vless
      - http
rules:
  - MATCH,Proxy
`;
  assert.equal(parseEgernProxiesDetailed(clash), null);
  const result = parseSubscriptionContentDetailed(clash);
  assert.deepEqual(result.nodes.map((node) => [node.name, node.protocol, node.server]), [
    ['vless', 'vless', 'v.example'],
    ['http', 'http', 'h.example']
  ]);
  assert.deepEqual(result.skippedNodes, [{ nodeId: null, name: 'broken', reason: 'unsupported_proxy_protocol_tor' }]);

  // 只有部分条目是单键映射时也不算 Egern。
  const mixed = `proxies:\n  - vless: {name: e, server: e.example, port: 443, user_id: ${UUID}}\n  - {name: c, type: socks5, server: c.example, port: 1080}\n`;
  assert.equal(parseEgernProxiesDetailed(mixed), null);
  assert.deepEqual(parseSubscriptionContentDetailed(mixed).nodes.map((node) => node.name), ['c']);
});
