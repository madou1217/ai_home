'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compiledLine } = require('../lib/cli/services/toolkit/proxy-pool/compile-result');
const { compileSurgeFamilyLine } = require('../lib/cli/services/toolkit/proxy-pool/cores/surge/proxy-line');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { buildRenderContext, requestOrigin } = require('../lib/cli/services/toolkit/subscription-aggregator/render-context');
const { userNameForNode } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/relay-users');
const { getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const {
  RuleSetConverter,
  formatRuleSet,
  parseRuleList
} = require('../lib/cli/services/toolkit/subscription-aggregator/rule-set-converter');
const { handleAggregatedSubscriptionRequest } = require('../lib/server/subscription-aggregator-public-route');
const { SAMPLE_NODES, UUID, assertRoundTrip } = require('./helpers/proxy-format-samples');

const TOKEN = 'tok_'.padEnd(43, 'x');
const ORIGIN = 'https://aih.example:9527';

function createService(nodes, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-surge-'));
  const now = () => 1000;
  const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now });
  const sources = [{ id: 'sub_a', name: '机场, A', url: 'https://a.example/sub', nodeCount: nodes.length, lastSyncedAt: 1000 }];
  const port = {
    listSources: () => sources.map((source) => ({ ...source })),
    listNodes: () => nodes.map((node) => ({ ...node, subscriptionId: 'sub_a' })),
    syncSource: async () => ({ ok: true })
  };
  const service = new SubscriptionAggregatorService({ sources: port, store, now, ...extra });
  const profile = store.saveProfile({ name: 'surge', refreshHours: 0, groups: { perSource: true } });
  return { dir, service, profile };
}

test('requestOrigin honours forwarded headers and rejects odd hosts', () => {
  assert.equal(requestOrigin({ headers: { host: 'aih.local:9527' } }), 'http://aih.local:9527');
  assert.equal(requestOrigin({ headers: { host: 'internal:1', 'x-forwarded-host': 'sub.example.com', 'x-forwarded-proto': 'https' } }), 'https://sub.example.com');
  assert.equal(requestOrigin({ headers: { host: '[::1]:9527' } }), 'http://[::1]:9527');
  assert.equal(requestOrigin({ headers: { host: 'evil.example/path' } }), '');
  const context = buildRenderContext({ origin: ORIGIN, token: TOKEN, renderer: getRenderer('surge'), profile: { refreshHours: 6 } });
  assert.equal(context.subscriptionUrl, `${ORIGIN}/sub/${TOKEN}?target=surge`);
  assert.equal(context.updateIntervalSeconds, 21600);
  assert.equal(context.ruleSetUrl({ tag: 'geosite-cn' }), `${ORIGIN}/sub/${TOKEN}/rules/geosite-cn?target=surge`);
  assert.equal(buildRenderContext({ renderer: getRenderer('surge') }).ruleSetUrl({ tag: 'x' }), '');
});

test('MetaCubeX lists convert to each client rule-set syntax', () => {
  const domains = parseRuleList('# comment\n+.github.com\napi.github.com\nnot a domain\n', 'geosite');
  assert.deepEqual(domains, [{ type: 'suffix', value: 'github.com' }, { type: 'domain', value: 'api.github.com' }]);
  const ips = parseRuleList('91.108.4.0/22\n2001:b28:f23d::/48\nbad\n', 'geoip');
  assert.equal(formatRuleSet(domains, 'geosite', 'domain-set'), '.github.com\napi.github.com\n');
  assert.equal(formatRuleSet(ips, 'geoip', 'domain-set'), 'IP-CIDR,91.108.4.0/22,no-resolve\nIP-CIDR6,2001:b28:f23d::/48,no-resolve\n');
  assert.equal(formatRuleSet(domains, 'geosite', 'rule-set'), 'DOMAIN-SUFFIX,github.com\nDOMAIN,api.github.com\n');
  assert.equal(formatRuleSet(domains, 'geosite', 'quantumult-x'), 'host-suffix, github.com, proxy\nhost, api.github.com, proxy\n');
  assert.equal(formatRuleSet(ips, 'geoip', 'quantumult-x'), 'ip-cidr, 91.108.4.0/22, proxy, no-resolve\nip6-cidr, 2001:b28:f23d::/48, proxy, no-resolve\n');
});

test('the rule-set converter caches each list and merges concurrent fetches', async () => {
  let now = 0;
  const fetched = [];
  const converter = new RuleSetConverter({
    now: () => now,
    fetcher: { fetch: async (url) => { fetched.push(url); return { content: '+.example.com\n' }; } }
  });
  const ruleSet = { tag: 'geosite-category-ai-not-cn', kind: 'geosite', name: 'category-ai-!cn' };
  const [first, second] = await Promise.all([converter.render(ruleSet, 'domain-set'), converter.render(ruleSet, 'rule-set')]);
  assert.equal(first, '.example.com\n');
  assert.equal(second, 'DOMAIN-SUFFIX,example.com\n');
  assert.deepEqual(fetched, ['https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/category-ai-!cn.list']);
  now += 12 * 60 * 60 * 1000;
  await converter.render(ruleSet, 'domain-set');
  assert.equal(fetched.length, 2, '12 小时后重新拉取');
});

test('Surge proxy lines round-trip every protocol Surge can express', () => {
  const surge = getRenderer('surge');
  const compiled = [];
  const supported = [];
  const skipped = [];
  for (const node of SAMPLE_NODES) {
    try {
      compiled.push(surge.compileNode({ node, name: node.name }));
      supported.push(node);
    } catch (error) {
      skipped.push([node.name, error.code]);
    }
  }
  const lines = compiled.map(compiledLine);
  assert.deepEqual(skipped, [
    ['vmess-grpc', 'unsupported_proxy_transport_grpc'],
    ['vless-reality', 'unsupported_proxy_protocol_vless'],
    ['hy2', 'unsupported_hysteria2_obfs'],
    ['ssr', 'unsupported_proxy_protocol_shadowsocksr'],
    ['hy1', 'unsupported_proxy_protocol_hysteria']
  ]);
  assert.ok(lines.includes(`tuic = tuic-v5, tu.example, 443, uuid=${UUID}, password=p, alpn=h3, sni=tu.example`), lines.join('\n'));
  assert.ok(lines.includes('snell = snell, sn.example, 8000, psk=p, version=3, obfs=http, obfs-host=cdn.example'), lines.join('\n'));
  assert.ok(lines.includes('anytls = anytls, at.example, 443, password=p, sni=at.example'), lines.join('\n'));
  // WireGuard 的代理行只引用段名，密钥与地址在同名 [WireGuard x] 段里；段名由渲染时按顺序编号。
  const nodes = surge.render(null, compiled, { view: 'nodes' });
  assert.ok(nodes.includes('wg = wireguard, section-name=wg1'), nodes);
  assertRoundTrip('surge', nodes, supported);
  assert.match(compileSurgeFamilyLine('surge', SAMPLE_NODES[0], 'a,b'), /^a,b = ss, ss\.example, 8388, encrypt-method=aes-256-gcm/);
});

test('Surfboard proxy lines round-trip every protocol Surfboard can express', () => {
  const surfboard = getRenderer('surfboard');
  const compiled = [];
  const supported = [];
  const skipped = [];
  for (const node of SAMPLE_NODES) {
    try {
      compiled.push(surfboard.compileNode({ node, name: node.name }));
      supported.push(node);
    } catch (error) {
      skipped.push([node.name, error.code]);
    }
  }
  const lines = compiled.map(compiledLine);
  assert.deepEqual(skipped, [
    ['vmess-grpc', 'unsupported_proxy_transport_grpc'],
    ['vless-reality', 'unsupported_proxy_protocol_vless'],
    ['hy2', 'unsupported_hysteria2_obfs'],
    ['ssr', 'unsupported_proxy_protocol_shadowsocksr'],
    ['hy1', 'unsupported_proxy_protocol_hysteria']
  ]);
  assert.ok(lines.includes('anytls = anytls, at.example, 443, password=p, sni=at.example'), lines.join('\n'));
  assert.ok(lines.includes('snell = snell, sn.example, 8000, psk=p, version=3, obfs=http, obfs-host=cdn.example'), lines.join('\n'));
  // Surfboard 与 Surge 同源：WireGuard 也走独立的 [WireGuard x] 段。
  const nodes = surfboard.render(null, compiled, { view: 'nodes' });
  assert.ok(nodes.includes('wg = wireguard, section-name=wg1'), nodes);
  assert.match(nodes, /^\[WireGuard wg1\]$/m);
  assertRoundTrip('surfboard', nodes, supported);
});

test('the Surge renderer puts WireGuard in its own section and never in the proxy line', () => {
  const surge = getRenderer('surge');
  const wireguard = SAMPLE_NODES.find((node) => node.protocol === 'wireguard');
  const compiled = [surge.compileNode({ node: wireguard, name: 'wg' })];
  const text = surge.render(null, compiled, { view: 'nodes' });
  assert.match(text, /^wg = wireguard, section-name=wg1$/m);
  assert.match(text, /^\[WireGuard wg1\]$/m);
  assert.match(text, /^private-key = PRIV$/m);
  assert.match(text, /^self-ip = 10\.0\.0\.2$/m);
  assert.match(text, /^self-ip-v6 = fd00::2$/m);
  assert.match(text, /^mtu = 1280$/m);
  assert.match(text, /^peer = \(public-key = PUB, allowed-ips = "0\.0\.0\.0\/0, ::\/0", endpoint = wg\.example:51820, client-id = 1\/2\/3\)$/m);
  // 段名带序号，节点名里的方括号不会进段头。
  const flagged = [surge.compileNode({ node: wireguard, name: '[JP] wg' })];
  assert.match(surge.render(null, flagged, { view: 'nodes' }), /^\[WireGuard wg1\]$/m);
});

test('the Surge renderer writes a managed config with converted rule sets', () => {
  const nodes = SAMPLE_NODES.filter((node) => ['ss', 'trojan', 'https'].includes(node.name));
  const { service, profile } = createService(nodes);
  const token = profile.token;
  const result = service.preview(profile.id, 'surge', { origin: ORIGIN });
  assert.equal(result.ok, true);
  const text = result.content;
  assert.match(text, new RegExp(`^#!MANAGED-CONFIG ${ORIGIN}/sub/${token}\\?target=surge interval=86400 strict=false`));
  assert.match(text, /^\[Proxy\]\nss = ss, ss\.example, 8388/m);
  assert.match(text, /^\[Proxy Group\]$/m);
  // 订阅源名里的逗号会破坏 Surge 行，渲染时清洗。
  assert.match(text, /^📦 机场 A = url-test, ss, trojan, https, url=https:\/\/www\.gstatic\.com\/generate_204, interval=300, tolerance=50$/m);
  assert.match(text, /^🚀 节点选择 = select, ♻️ 自动选择, 📦 机场 A, DIRECT, ss, trojan, https$/m);
  assert.match(text, new RegExp(`^DOMAIN-SET,${ORIGIN}/sub/${token}/rules/geosite-private\\?target=surge,DIRECT$`, 'm'));
  assert.match(text, new RegExp(`^RULE-SET,${ORIGIN}/sub/${token}/rules/geoip-private\\?target=surge,DIRECT,no-resolve$`, 'm'));
  assert.match(text, /^FINAL,🐟 漏网之鱼,dns-failed$/m);
  assert.deepEqual(result.skippedNodes, []);

  const surfboard = service.preview(profile.id, 'surfboard', { origin: ORIGIN }).content;
  assert.match(surfboard, /^FINAL,🐟 漏网之鱼$/m);
  assert.doesNotMatch(surfboard, /dns-failed|loglevel/);
});

test('serveRuleSet only serves rule sets the subscription uses, in the target syntax', async () => {
  const rendered = [];
  const { service, profile } = createService(SAMPLE_NODES.slice(0, 1), {
    ruleSets: { render: async (ruleSet, format) => { rendered.push([ruleSet.tag, format]); return `${ruleSet.name}\n`; } }
  });
  const ok = await service.serveRuleSet(profile.token, 'geosite-private', { target: 'surge' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'private\n');
  assert.deepEqual(rendered, [['geosite-private', 'domain-set']]);
  assert.equal((await service.serveRuleSet(profile.token, 'geosite-not-used', { target: 'surge' })).status, 404);
  assert.equal((await service.serveRuleSet(profile.token, 'geosite-private', { target: 'mihomo' })).status, 400);
  assert.equal((await service.serveRuleSet('unknown'.padEnd(20, 'x'), 'geosite-private', { target: 'surge' })).status, 404);
});

test('the public route serves converted rule sets and passes the request origin', async () => {
  const calls = [];
  const service = {
    serveRuleSet: async (token, tag, request) => {
      calls.push(['rules', token, tag, request.target, request.origin]);
      return { ok: true, status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'rules' };
    },
    serveSubscription: async (token, request) => {
      calls.push(['sub', token, request.origin]);
      return { ok: true, status: 200, headers: {}, body: 'sub' };
    }
  };
  const response = () => {
    const res = { status: 0, body: '', writeHead(status) { res.status = status; }, end(body) { res.body = body; } };
    return res;
  };
  const req = { headers: { host: 'aih.example', 'x-forwarded-proto': 'https' } };
  const rulesRes = response();
  await handleAggregatedSubscriptionRequest({
    req, res: rulesRes, method: 'GET',
    pathname: `/sub/${TOKEN}/rules/geosite-category-ai-not-cn`,
    url: new URL(`https://aih.example/sub/${TOKEN}/rules/geosite-category-ai-not-cn?target=loon`),
    service
  });
  assert.deepEqual([rulesRes.status, rulesRes.body], [200, 'rules']);
  const subRes = response();
  await handleAggregatedSubscriptionRequest({
    req, res: subRes, method: 'GET', pathname: `/sub/${TOKEN}`, url: new URL(`https://aih.example/sub/${TOKEN}`), service
  });
  assert.deepEqual(calls, [
    ['rules', TOKEN, 'geosite-category-ai-not-cn', 'loon', 'https://aih.example'],
    ['sub', TOKEN, 'https://aih.example']
  ]);
  const bad = response();
  await handleAggregatedSubscriptionRequest({
    req, res: bad, method: 'GET', pathname: `/sub/${TOKEN}/rules/../etc`, url: new URL(`https://aih.example/sub/${TOKEN}`), service
  });
  assert.equal(bad.status, 404);
});

// ============================================================
// 本机中转：Surge 没有 VLESS 这一档，同机跑 AIH 时由 sing-box 边车代拨
// ============================================================

const RELAY_NODES = Object.freeze([
  { id: 'n_vless', protocol: 'vless', name: 'vless', server: 'v.example', port: 443, uuid: UUID, tls: true, sni: 'v.example' },
  { id: 'n_ss', protocol: 'shadowsocks', name: 'ss', server: 'ss.example', port: 8388, cipher: 'aes-256-gcm', password: 'secret' }
]);

function fakeRelay({ available = true, endpoints = new Map(), listenHost = '' } = {}) {
  const calls = { ensure: [] };
  return {
    calls,
    availability: () => (available
      ? {
        available: true, binary: '/opt/sing-box', source: 'explicit', version: '1.13.19',
        running: endpoints.size > 0, nodes: endpoints.size, basePort: 23100, maxPort: 23655,
        portRange: '23100-23655', listenHost, kernels: []
      }
      : { available: false, error: 'relay_binary_not_found' }),
    activeEndpoints: () => new Map(endpoints),
    activeListenHost: () => (endpoints.size ? listenHost : ''),
    ensure: async (nodes, options = {}) => {
      calls.ensure.push({
        ids: nodes.map((node) => node.id),
        onlyIds: options.onlyIds ? [...options.onlyIds] : null,
        remote: options.remote === true
      });
      return { ok: true, endpoints: new Map(endpoints), skipped: [] };
    }
  };
}

test('the Surge relay entry is a loopback socks5 line that only opens udp-relay when the sidecar can', () => {
  const surge = getRenderer('surge');
  const node = RELAY_NODES[0];
  const context = { relay: { endpoints: new Map([['n_vless', { host: '127.0.0.1', port: 23101, udp: true }]]) } };
  assert.equal(compiledLine(surge.compileNode({ node, name: 'vless' }, context)), 'vless = socks5, 127.0.0.1, 23101, udp-relay=true');
  // 名字保留原样（策略组与分流规则引用的就是它）；UDP 不能转时不写 udp-relay（Surge 默认关）。
  const tcpOnly = { relay: { endpoints: new Map([['n_vless', { host: '127.0.0.1', port: 23102, udp: false }]]) } };
  assert.equal(compiledLine(surge.compileNode({ node, name: 'vless' }, tcpOnly)), 'vless = socks5, 127.0.0.1, 23102');
  // 链式关系在边车配置里（出站 detour）：本地入口这一行不能带 underlying-proxy，
  // 否则前置会去连「本机的 127.0.0.1:<port>」，远端前置只会连到它自己的回环地址。
  assert.equal(compiledLine(surge.compileNode({ node, name: 'vless' }, { ...tcpOnly, chain: '上游' })), 'vless = socks5, 127.0.0.1, 23102');
});

test('a running local relay gives Surge the VLESS nodes it cannot dial itself', () => {
  const relay = fakeRelay({ endpoints: new Map([['n_vless', { host: '127.0.0.1', port: 23101, udp: true }]]) });
  const { service, profile } = createService(RELAY_NODES, { relay });
  const result = service.preview(profile.id, 'surge', { remoteAddress: '127.0.0.1' });
  assert.equal(result.ok, true);
  // 只有格式表达不了的那个节点需要中转。
  assert.deepEqual([result.relay.candidates, result.relay.nodes, result.relay.active], [1, 1, true]);
  assert.deepEqual(result.skippedNodes, []);
  assert.equal(result.stats.nodes, 2);
  assert.match(result.content, /^vless = socks5, 127\.0\.0\.1, 23101, udp-relay=true$/m);
  // 策略组照旧引用节点名，Surge 本来就认的协议保持直连。
  assert.match(result.content, /^🚀 节点选择 = .*\bvless\b.*$/m);
  assert.match(result.content, /^ss = ss, ss\.example, 8388, encrypt-method=aes-256-gcm, password=secret, udp-relay=true$/m);
  assert.deepEqual(result.warnings, []);
  // 预览不拉进程：读的是已经在跑的那一份。
  assert.equal(relay.calls.ensure.length, 0);
});

test('a loopback Surge pull starts the sidecar by default and ships the local entry in the managed config', async () => {
  const relay = fakeRelay({ endpoints: new Map([['n_vless', { host: '127.0.0.1', port: 23101, udp: true }]]) });
  const { service, profile } = createService(RELAY_NODES, { relay });
  const pulled = await service.serveSubscription(profile.token, {
    userAgent: 'Surge/5.20.0', remoteAddress: '127.0.0.1', origin: 'http://127.0.0.1:9527'
  });
  assert.equal(pulled.status, 200);
  assert.deepEqual(relay.calls.ensure, [{ ids: ['n_vless'], onlyIds: ['n_vless'], remote: false }]);
  assert.match(pulled.body, /^#!MANAGED-CONFIG http:\/\/127\.0\.0\.1:9527\/sub\/.*\?target=surge/m);
  assert.match(pulled.body, /^vless = socks5, 127\.0\.0\.1, 23101, udp-relay=true$/m);
  const pull = service.getOverview().profiles[0].recentPulls[0];
  assert.deepEqual([pull.format, pull.relayNodes, pull.relayError], ['surge', 1, '']);
});

test('without the sidecar a loopback Surge preview points at the local relay instead of blaming the format', () => {
  const relay = fakeRelay({ endpoints: new Map() });
  const { service, profile } = createService([RELAY_NODES[0]], { relay });
  const local = service.preview(profile.id, 'surge', { remoteAddress: '127.0.0.1' });
  assert.equal(local.stats.nodes, 0);
  // 可照做的下一步是「启动本机中转」，不是「换个输出格式」。
  assert.deepEqual(local.warnings, ['aggregator_relay_unavailable:relay_not_running']);
  assert.deepEqual(local.skippedNodes.map((item) => item.reason), ['unsupported_proxy_protocol_vless']);
  // 远端拉取给不出本地入口（127.0.0.1 对那边没有意义）：这时才说换个格式。
  const remote = service.preview(profile.id, 'surge', { remoteAddress: '203.0.113.8' });
  assert.deepEqual(remote.warnings, ['aggregator_nodes_unsupported_by_target']);
  assert.equal(remote.relay.active, false);
});

test('server port mode renders every node on the AIH port itself, one username per node', () => {
  const relay = {
    calls: { ensure: [] },
    availability: () => ({
      available: true, binary: '/opt/sing-box', source: 'explicit', version: '1.13.19',
      running: true, nodes: 1, basePort: 23100, maxPort: 23355, portRange: '23100-23655',
      listenHost: '127.0.0.1', kernels: []
    }),
    activeEndpoints: () => new Map([['n_vless', { host: '127.0.0.1', port: 23107, udp: true }]]),
    activeListenHost: () => '127.0.0.1',
    portMode: () => 'server',
    serverPortMode: () => true,
    credentials: () => ({ username: 'aih-relay', password: 'mux-pass' }),
    ensure: async () => ({ ok: true, endpoints: new Map([['n_vless', { host: '127.0.0.1', port: 23107, udp: true }]]), skipped: [] })
  };
  const { service, profile } = createService([RELAY_NODES[0]], { relay });
  const result = service.preview(profile.id, 'surge', { remoteAddress: '203.0.113.8', origin: 'http://aih.example:9527' });
  const user = userNameForNode('n_vless');
  // 入口就是 AIH 自己的 host:port，节点靠用户名区分；这条通路是 TCP，所以没有 udp-relay。
  assert.match(result.content, new RegExp(`^vless = socks5, aih\\.example, 9527, ${user}, mux-pass$`, 'm'));
  assert.equal(result.relay.portMode, 'server');
  assert.equal(result.relay.authRequired, true);
  // 没有「要放行端口段」的提醒 —— server 模式不额外开任何端口。
  assert.deepEqual(result.warnings, []);
  // 本机请求也走同一个端口（Host 就是它自己用的那个）。
  const local = service.preview(profile.id, 'surge', { remoteAddress: '127.0.0.1', origin: 'http://127.0.0.1:9527' });
  assert.match(local.content, new RegExp(`^vless = socks5, 127\\.0\\.0\\.1, 9527, ${user}, mux-pass$`, 'm'));
});

test('Surfboard gets the same remote relay entries: the phone dials the AIH host, not its own loopback', () => {
  const relay = fakeRelay({
    endpoints: new Map([['n_vless', { host: '0.0.0.0', port: 23101, udp: true, username: 'aih-relay', password: 'secret' }]]),
    listenHost: '0.0.0.0'
  });
  const { service, profile } = createService([RELAY_NODES[0]], { relay });
  const result = service.preview(profile.id, 'surfboard', { remoteAddress: '203.0.113.8', origin: 'http://aih.example:9527' });
  assert.equal(result.relay.candidates, 1);
  assert.deepEqual(result.skippedNodes, []);
  // 入口是 AIH 那台机器的地址 + 认证（手机上的 127.0.0.1 没有意义）。
  assert.match(result.content, /^vless = socks5, aih\.example, 23101, aih-relay, secret, udp-relay=true$/m);
  assert.deepEqual(result.warnings, ['aggregator_relay_remote:aih.example:23100-23655']);
});

