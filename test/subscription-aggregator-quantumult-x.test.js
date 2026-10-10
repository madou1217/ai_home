'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const { SAMPLE_NODES, assertRoundTrip } = require('./helpers/proxy-format-samples');

const ORIGIN = 'https://aih.example';

test('Quantumult X server lines round-trip every protocol QX can express', () => {
  const renderer = getRenderer('quantumult-x');
  const lines = [];
  const supported = [];
  const skipped = [];
  for (const node of SAMPLE_NODES) {
    try {
      lines.push(renderer.compileNode({ node, name: node.name }));
      supported.push(node);
    } catch (error) {
      skipped.push([node.name, error.code]);
    }
  }
  assert.deepEqual(skipped, [
    ['vmess-grpc', 'unsupported_proxy_transport_grpc'],
    ['hy2', 'unsupported_proxy_protocol_hysteria2'],
    ['hy1', 'unsupported_proxy_protocol_hysteria'],
    ['tuic', 'unsupported_proxy_protocol_tuic'],
    ['anytls', 'unsupported_proxy_protocol_anytls'],
    ['wg', 'unsupported_proxy_protocol_wireguard'],
    ['snell', 'unsupported_proxy_protocol_snell']
  ]);
  // SSR 写成带 ssr-protocol 的 shadowsocks 行，导入时据此认回 SSR。
  assert.ok(lines.includes('shadowsocks=ssr.example:8443, method=aes-256-cfb, password=p, ssr-protocol=auth_aes128_md5, ssr-protocol-param=1234:abcd, obfs=tls1.2_ticket_auth, obfs-host=cdn.example, fast-open=false, udp-relay=false, tag=ssr'), lines.join('\n'));
  assert.ok(lines.includes('vmess=vm.example:443, method=chacha20-poly1305, password=11111111-2222-3333-4444-555555555555, obfs=wss, obfs-host=cdn.example, obfs-uri=/ws, fast-open=false, udp-relay=false, tag=vmess-ws'), lines.join('\n'));
  assert.ok(lines.includes('trojan=tj.example:443, password=p, over-tls=true, tls-host=tj.example, tls-verification=false, fast-open=false, udp-relay=false, tag=trojan'));
  assert.match(lines.find((line) => line.startsWith('vless=')), /reality-base64-pubkey=PUBKEY, reality-hex-shortid=ab12, vless-flow=xtls-rprx-vision/);
  assertRoundTrip('quantumult-x', `[server_local]\n${lines.join('\n')}\n`, supported);
});

test('the Quantumult X renderer writes policies, remote filters and a final rule', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-qx-'));
  try {
    const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => 1 });
    const nodes = SAMPLE_NODES.filter((node) => ['ss', 'trojan'].includes(node.name));
    const service = new SubscriptionAggregatorService({
      store,
      now: () => 1,
      sources: {
        listSources: () => [{ id: 'sub_a', name: 'A', url: 'https://a.example', nodeCount: 2, lastSyncedAt: 1 }],
        listNodes: () => nodes.map((node) => ({ ...node, subscriptionId: 'sub_a' })),
        syncSource: async () => ({ ok: true })
      }
    });
    const profile = store.saveProfile({ name: 'qx', refreshHours: 0 });
    const text = service.preview(profile.id, 'quantumult-x', { origin: ORIGIN }).content;
    assert.match(text, /^static=🚀 节点选择, ♻️ 自动选择, direct, ss, trojan$/m);
    assert.match(text, /^url-latency-benchmark=♻️ 自动选择, ss, trojan, check-interval=300, tolerance=50, alive-checking=false$/m);
    assert.match(text, new RegExp(`^${ORIGIN}/sub/${profile.token}/rules/geosite-private\\?target=quantumult-x, tag=geosite-private, force-policy=direct, update-interval=86400, opt-parser=false, enabled=true$`, 'm'));
    assert.match(text, /^\[server_local\]\nshadowsocks=ss\.example:8388, method=aes-256-gcm, password=secret/m);
    assert.match(text, /^final, 🐟 漏网之鱼$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
