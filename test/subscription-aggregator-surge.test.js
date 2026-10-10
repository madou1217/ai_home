'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compileSurgeFamilyLine } = require('../lib/cli/services/toolkit/proxy-pool/cores/surge/proxy-line');
const { parseSubscriptionContentDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { buildRenderContext, requestOrigin } = require('../lib/cli/services/toolkit/subscription-aggregator/render-context');
const { getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const {
  RuleSetConverter,
  formatRuleSet,
  parseRuleList
} = require('../lib/cli/services/toolkit/subscription-aggregator/rule-set-converter');
const { handleAggregatedSubscriptionRequest } = require('../lib/server/subscription-aggregator-public-route');
const { SAMPLE_NODES, assertRoundTrip } = require('./helpers/proxy-format-samples');

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
  const lines = [];
  const supported = [];
  const skipped = [];
  for (const node of SAMPLE_NODES) {
    try {
      lines.push(surge.compileNode({ node, name: node.name }));
      supported.push(node);
    } catch (error) {
      skipped.push([node.name, error.code]);
    }
  }
  assert.deepEqual(skipped, [
    ['vmess-grpc', 'unsupported_proxy_transport_grpc'],
    ['vless-reality', 'unsupported_proxy_protocol_vless'],
    ['hy2', 'unsupported_hysteria2_obfs']
  ]);
  assertRoundTrip('surge', `[Proxy]\n${lines.join('\n')}\n`, supported);
  assert.match(compileSurgeFamilyLine('surge', SAMPLE_NODES[0], 'a,b'), /^a,b = ss, ss\.example, 8388, encrypt-method=aes-256-gcm/);
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
