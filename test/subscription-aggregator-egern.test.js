'use strict';

// Egern 输出（实验性）：字段按官方文档 egernapp.com/docs/configuration 编写，本机没有 Egern 的离线校验工具，
// 这里用黄金值锁定每种协议的条目形状、策略组与规则写法，以及 Egern YAML 规则集。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const { formatRuleSet, parseRuleList } = require('../lib/cli/services/toolkit/subscription-aggregator/rule-set-converter');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { detectRendererByUserAgent, getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const { SAMPLE_NODES, UUID } = require('./helpers/proxy-format-samples');

const ORIGIN = 'https://aih.example';
const egern = getRenderer('egern');
const sample = (name) => SAMPLE_NODES.find((node) => node.name === name);
const compile = (node) => egern.compileNode({ node, name: node.name });

test('every protocol Egern documents compiles; SSR and Hysteria v1 are skipped', () => {
  const skipped = [];
  for (const node of SAMPLE_NODES) {
    try {
      compile(node);
    } catch (error) {
      skipped.push([node.name, error.code]);
    }
  }
  assert.deepEqual(skipped, [
    ['ssr', 'unsupported_proxy_protocol_shadowsocksr'],
    ['hy1', 'unsupported_proxy_protocol_hysteria']
  ]);
  assert.equal(detectRendererByUserAgent('Egern/1.18.0 CFNetwork/1568').id, 'egern');
});

test('Egern proxy entries use the documented keys for TLS, Reality and transports', () => {
  assert.deepEqual(compile(sample('ss-obfs')), {
    shadowsocks: {
      name: 'ss-obfs', server: 'ss2.example', port: 8389,
      method: 'chacha20-poly1305', password: 'p', obfs: 'http', obfs_host: 'cdn.example', obfs_uri: undefined, udp_relay: true
    }
  });
  assert.deepEqual(compile(sample('vmess-ws')).vmess, {
    name: 'vmess-ws', server: 'vm.example', port: 443, user_id: UUID, security: 'auto', legacy: undefined, udp_relay: true,
    transport: { wss: { path: '/ws', headers: { Host: 'cdn.example' }, sni: 'cdn.example', skip_tls_verify: undefined } }
  });
  assert.deepEqual(compile(sample('vmess-grpc')).vmess.transport, {
    grpc: { service_name: 'svc', sni: 'vg.example', skip_tls_verify: undefined, reality: undefined }
  });
  const vless = compile(sample('vless-reality')).vless;
  assert.equal(vless.flow, 'xtls-rprx-vision');
  assert.deepEqual(vless.transport, {
    tls: { sni: 'www.example.com', skip_tls_verify: undefined, reality: { public_key: 'PUBKEY', short_id: 'ab12' } }
  });
  const trojan = compile(sample('trojan')).trojan;
  assert.deepEqual([trojan.sni, trojan.skip_tls_verify, trojan.websocket], ['tj.example', true, undefined]);
  assert.deepEqual(compile({ ...sample('trojan'), network: 'ws', path: '/t', host: 'cdn.example' }).trojan.websocket, { path: '/t', host: 'cdn.example' });
  assert.throws(() => compile({ ...sample('trojan'), network: 'grpc' }), { code: 'unsupported_proxy_transport_grpc' });
  assert.deepEqual(compile(sample('hy2')).hysteria2, {
    name: 'hy2', server: 'hy.example', port: 443, auth: 'p', sni: 'hy.example', skip_tls_verify: undefined, obfs: 'salamander', obfs_password: 'o'
  });
  assert.deepEqual(compile(sample('tuic')).tuic.alpn, ['h3']);
  // AnyTLS 不写 skip_tls_verify 时 Egern 会跳过校验，所以总是显式写出。
  assert.equal(compile(sample('anytls')).anytls.skip_tls_verify, false);
  assert.deepEqual(Object.keys(compile(sample('https'))), ['https']);
  assert.deepEqual(Object.keys(compile(sample('http'))), ['http']);
});

test('WireGuard reserved bytes, Snell UDP and VMess legacy follow the Egern rules', () => {
  const wg = compile(sample('wg')).wireguard;
  assert.deepEqual(
    [wg.private_key, wg.peer_public_key, wg.reserved, wg.local_ipv4, wg.local_ipv6, wg.mtu],
    ['PRIV', 'PUB', [1, 2, 3], '10.0.0.2', 'fd00::2', 1280]
  );
  assert.deepEqual(compile({ ...sample('wg'), reserved: 'AQID' }).wireguard.reserved, [1, 2, 3]);
  assert.throws(() => compile({ ...sample('wg'), reserved: 'AQIDBA==' }), { code: 'invalid_proxy_field_reserved' });
  assert.equal(compile(sample('snell')).snell.udp_relay, true);
  assert.equal(compile({ ...sample('snell'), version: 2 }).snell.udp_relay, undefined);
  assert.equal(compile({ ...sample('vmess-ws'), alterId: 64, cipher: 'aes-128-cfb' }).vmess.legacy, true);
  assert.equal(compile({ ...sample('vmess-ws'), cipher: 'aes-128-cfb' }).vmess.security, 'auto');
});

test('the Egern renderer writes auto_update, policy groups and rules with converted rule sets', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-egern-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nodes = SAMPLE_NODES.filter((node) => ['ss', 'trojan', 'ssr'].includes(node.name));
  const sources = [{ id: 'sub_a', name: '机场 A', url: 'https://a.example/sub', nodeCount: nodes.length, lastSyncedAt: 1000 }];
  const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => 1000 });
  const service = new SubscriptionAggregatorService({
    store,
    now: () => 1000,
    sources: {
      listSources: () => sources,
      listNodes: () => nodes.map((node) => ({ ...node, subscriptionId: 'sub_a' })),
      syncSource: async () => ({ ok: true })
    }
  });
  const profile = store.saveProfile({
    name: 'egern',
    refreshHours: 0,
    rules: { custom: [{ type: 'IP-CIDR', value: '2001:db8::/32', policy: 'direct' }] }
  });
  const result = service.preview(profile.id, 'egern', { origin: ORIGIN });
  assert.equal(result.ok, true);
  assert.deepEqual(result.skippedNodes, [{ name: 'ssr', reason: 'unsupported_proxy_protocol_shadowsocksr' }]);
  const config = YAML.parse(result.content);
  assert.deepEqual(config.auto_update, { url: `${ORIGIN}/sub/${profile.token}?target=egern`, interval: 86400 });
  assert.equal(config.proxy_latency_test_url, 'https://www.gstatic.com/generate_204');
  assert.deepEqual(config.proxies.map((proxy) => Object.keys(proxy)[0]), ['shadowsocks', 'trojan']);

  const auto = config.policy_groups.find((group) => group.auto_test);
  assert.deepEqual(Object.keys(auto.auto_test), ['name', 'policies', 'interval', 'tolerance', 'latency_test_url']);
  const proxyGroup = config.policy_groups.find((group) => group.select?.name === '🚀 节点选择');
  assert.ok(proxyGroup.select.policies.includes('DIRECT'));

  assert.deepEqual(config.rules.find((rule) => rule.rule_set?.match.includes('geosite-private')), {
    rule_set: { match: `${ORIGIN}/sub/${profile.token}/rules/geosite-private?target=egern`, policy: 'DIRECT', update_interval: 86400 }
  });
  assert.deepEqual(config.rules.find((rule) => rule.ip_cidr6), {
    ip_cidr6: { match: '2001:db8::/32', policy: 'DIRECT', no_resolve: true }
  });
  assert.deepEqual(Object.keys(config.rules.at(-1)), ['default']);
});

test('rule sets convert to Egern YAML with *_set lists', () => {
  const domains = parseRuleList('+.github.com\napi.github.com\n', 'geosite');
  assert.deepEqual(YAML.parse(formatRuleSet(domains, 'geosite', 'egern')), {
    domain_suffix_set: ['github.com'],
    domain_set: ['api.github.com']
  });
  const ips = parseRuleList('91.108.4.0/22\n2001:b28:f23d::/48\n', 'geoip');
  assert.deepEqual(YAML.parse(formatRuleSet(ips, 'geoip', 'egern')), {
    no_resolve: true,
    ip_cidr_set: ['91.108.4.0/22'],
    ip_cidr6_set: ['2001:b28:f23d::/48']
  });
  assert.equal(egern.capabilities.ruleSetFormat, 'egern');
});
