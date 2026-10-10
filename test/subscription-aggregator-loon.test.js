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

function compileAll(rendererId) {
  const renderer = getRenderer(rendererId);
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
  return { lines, supported, skipped };
}

test('Loon proxy lines round-trip every protocol Loon can express', () => {
  const { lines, supported, skipped } = compileAll('loon');
  assert.deepEqual(skipped, [
    ['vmess-grpc', 'unsupported_proxy_transport_grpc'],
    ['hy1', 'unsupported_proxy_protocol_hysteria'],
    ['tuic', 'unsupported_proxy_protocol_tuic'],
    ['anytls', 'unsupported_proxy_protocol_anytls'],
    ['wg', 'unsupported_proxy_protocol_wireguard'],
    ['snell', 'unsupported_proxy_protocol_snell']
  ]);
  assert.ok(lines.includes('ssr = ShadowsocksR, ssr.example, 8443, aes-256-cfb, "p", protocol=auth_aes128_md5, protocol-param=1234:abcd, obfs=tls1.2_ticket_auth, obfs-param=cdn.example, fast-open=false, udp=true'), lines.join('\n'));
  // 凭据作为带引号的位置参数写出。
  assert.ok(lines.includes('trojan = trojan, tj.example, 443, "p", transport=tcp, sni=tj.example, skip-cert-verify=true'), lines.join('\n'));
  assert.match(lines.find((line) => line.startsWith('vless-reality')), /= VLESS, vl\.example, 443, "11111111-2222-3333-4444-555555555555", transport=tcp, flow=xtls-rprx-vision, public-key="PUBKEY", short-id=ab12, over-tls=true, sni=www\.example\.com/);
  assert.match(lines.find((line) => line.startsWith('hy2')), /salamander-password="o"/);
  assertRoundTrip('loon', `[Proxy]\n${lines.join('\n')}\n`, supported);
});

test('the Loon renderer puts converted rule sets in [Remote Rule]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-loon-'));
  try {
    const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => 1 });
    const nodes = SAMPLE_NODES.filter((node) => ['ss', 'vless-reality'].includes(node.name));
    const service = new SubscriptionAggregatorService({
      store,
      now: () => 1,
      sources: {
        listSources: () => [{ id: 'sub_a', name: 'A', url: 'https://a.example', nodeCount: 2, lastSyncedAt: 1 }],
        listNodes: () => nodes.map((node) => ({ ...node, subscriptionId: 'sub_a' })),
        syncSource: async () => ({ ok: true })
      }
    });
    const profile = store.saveProfile({ name: 'loon', refreshHours: 0 });
    const text = service.preview(profile.id, 'loon', { origin: ORIGIN }).content;
    assert.match(text, /^\[Proxy\]\nss = Shadowsocks, ss\.example, 8388, aes-256-gcm, "secret"/m);
    assert.match(text, new RegExp(`^${ORIGIN}/sub/${profile.token}/rules/geosite-private\\?target=loon, policy=DIRECT, tag=geosite-private, enabled=true$`, 'm'));
    assert.match(text, /^\[Rule\]\nFINAL,🐟 漏网之鱼$/m);
    assert.doesNotMatch(text, /MANAGED-CONFIG|DOMAIN-SET/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
