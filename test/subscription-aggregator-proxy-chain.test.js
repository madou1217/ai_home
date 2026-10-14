'use strict';

// 链式代理（内部前置代理）：节点级多级链的解析、成环 / 前置缺失的检出，
// 以及各输出目标写链的字段（mihomo 系 dialer-proxy、sing-box detour、Surge underlying-proxy、JSON 引用）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const YAML = require('yaml');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const {
  MAX_CHAIN_DEPTH,
  chainIdsOf,
  orderEntriesByChain,
  resolveProxyChains,
  validateChainRef
} = require('../lib/cli/services/toolkit/subscription-aggregator/proxy-chain');
const { getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const { detectClient } = require('../lib/cli/services/toolkit/subscription-aggregator/client-profiles');

function trojan(id, name, chain = '') {
  return {
    id,
    protocol: 'trojan',
    name,
    server: `${name.toLowerCase()}.example`,
    port: 443,
    password: 'p',
    tls: true,
    sni: `${name.toLowerCase()}.example`,
    ...(chain ? { chain } : {})
  };
}

function entriesOf(nodes) {
  return nodes.map((node) => ({ node, name: node.name, sourceName: 'A', region: null }));
}

function withService(nodes, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-chain-'));
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
    const profile = store.saveProfile({ name: 'chain', refreshHours: 0 });
    return run(service, profile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a multi-level chain resolves upstream targets and compiles the upstream first', () => {
  const entries = entriesOf([trojan('n_c', 'C', 'n_b'), trojan('n_b', 'B', 'n_a'), trojan('n_a', 'A')]);
  const { targets, errors } = resolveProxyChains(entries);
  assert.equal(errors.size, 0);
  assert.equal(targets.get(entries[0]).name, 'B');
  assert.equal(targets.get(entries[1]).name, 'A');
  assert.equal(targets.has(entries[2]), false);
  // C 要等 B 编出来，B 要等 A：输出顺序是 A → B → C，与配置文件里的写法无关。
  assert.deepEqual(orderEntriesByChain(entries, targets).map((entry) => entry.name), ['A', 'B', 'C']);
  // 整条链（含自己）用于界面展示。
  const byId = new Map(entries.map((entry) => [entry.node.id, entry.node]));
  assert.deepEqual(chainIdsOf('n_c', byId), ['n_c', 'n_b', 'n_a']);
});

test('cycles, missing upstreams and over-long chains are reported per node, never thrown', () => {
  const cyclic = entriesOf([trojan('n_a', 'A', 'n_b'), trojan('n_b', 'B', 'n_a')]);
  const cycle = resolveProxyChains(cyclic);
  assert.equal(cycle.targets.size, 0);
  assert.deepEqual([...cycle.errors.values()], ['invalid_proxy_chain_cycle', 'invalid_proxy_chain_cycle']);

  const missing = resolveProxyChains(entriesOf([trojan('n_a', 'A', 'n_gone')]));
  assert.deepEqual([...missing.errors.values()], ['invalid_proxy_chain_missing']);

  const deep = Array.from({ length: MAX_CHAIN_DEPTH + 2 }, (_unused, index) => trojan(`d${index}`, `d${index}`, index ? `d${index - 1}` : ''));
  const tooDeep = resolveProxyChains(entriesOf(deep));
  assert.deepEqual([...tooDeep.errors.values()], ['invalid_proxy_chain_too_deep']);
});

test('validateChainRef catches the mistakes that only show up at render time', () => {
  const nodes = [{ id: 'a', chain: '' }, { id: 'b', chain: 'a' }, { id: 'c', chain: '' }];
  assert.equal(validateChainRef(nodes, 'a', ''), '');
  assert.equal(validateChainRef(nodes, 'a', 'c'), '');
  // c → b → a 是合法链：三段都还在同一个方向上。
  assert.equal(validateChainRef(nodes, 'c', 'b'), '');
  // b 已经经由 a：让 a 认 b 当上游就把 a 接进了自己的下游。
  assert.equal(validateChainRef(nodes, 'a', 'b'), 'invalid_proxy_chain_cycle');
  assert.equal(validateChainRef(nodes, 'c', 'c'), 'invalid_proxy_chain_cycle');
  assert.equal(validateChainRef(nodes, 'a', 'gone'), 'invalid_proxy_chain_missing');

  const deep = Array.from({ length: MAX_CHAIN_DEPTH + 1 }, (_unused, index) => ({ id: `d${index}`, chain: index ? `d${index - 1}` : '' }));
  assert.equal(validateChainRef(deep, 'new', `d${MAX_CHAIN_DEPTH}`), 'invalid_proxy_chain_too_deep');
});

test('Clash-family targets write dialer-proxy, sing-box writes detour, Surge writes underlying-proxy', () => {
  const nodes = [trojan('n_a', 'A'), trojan('n_b', 'B', 'n_a')];
  withService(nodes, (service, profile) => {
    const mihomo = YAML.parse(service.preview(profile.id, 'mihomo').content);
    assert.deepEqual(mihomo.proxies.map((proxy) => [proxy.name, proxy['dialer-proxy']]), [['A', undefined], ['B', 'A']]);

    const classic = YAML.parse(service.preview(profile.id, 'clash-classic').content);
    assert.deepEqual(classic.proxies.map((proxy) => [proxy.name, proxy['dialer-proxy']]), [['A', undefined], ['B', 'A']]);

    const stash = YAML.parse(service.preview(profile.id, 'stash').content);
    assert.deepEqual(stash.proxies.map((proxy) => [proxy.name, proxy['dialer-proxy']]), [['A', undefined], ['B', 'A']]);

    const singBox = JSON.parse(service.preview(profile.id, 'sing-box').content);
    const outbound = (tag) => singBox.outbounds.find((item) => item.tag === tag);
    assert.equal(outbound('B').detour, 'A');
    assert.equal(outbound('A').detour, undefined);

    const surge = service.preview(profile.id, 'surge').content;
    assert.match(surge, /^A = trojan, a\.example, 443, password=p(?:,.*)?$/m);
    assert.match(surge, /^B = trojan, b\.example, 443, password=p.*underlying-proxy=A.*$/m);

    // JSON 是中立节点数据：原样带上前置引用，不丢配置。
    const json = JSON.parse(service.preview(profile.id, 'json').content);
    assert.deepEqual(json.nodes.map((node) => [node.name, node.chain]), [['A', undefined], ['B', 'n_a']]);
  });
});

test('a node whose upstream cannot be compiled is skipped too, instead of leaking a direct connection', () => {
  const nodes = [trojan('n_a', 'A'), { ...trojan('n_b', 'B', 'n_a'), protocol: 'anytls' }];
  withService(nodes, (service, profile) => {
    // Stash 没有 AnyTLS 出站：B 编不出来，依赖它的 C 也一起跳过（不然 C 会从出口节点直连）。
    const stash = service.preview(profile.id, 'stash');
    assert.deepEqual(stash.skippedNodes.map((item) => [item.name, item.reason]), [['B', 'unsupported_proxy_protocol_anytls']]);
    assert.deepEqual(YAML.parse(stash.content).proxies.map((proxy) => proxy.name), ['A']);
  });
});

test('chained nodes and formats without chain syntax blame the chain, not the filters', () => {
  const nodes = [trojan('n_a', 'A'), trojan('n_b', 'B', 'n_a')];
  withService(nodes, (service, profile) => {
    // base64 只有分享链接，表达不了「经由谁建连」。
    const base64 = service.preview(profile.id, 'base64');
    assert.equal(base64.stats.nodes, 1);
    assert.deepEqual(base64.skippedNodes.map((item) => [item.name, item.reason]), [['B', 'unsupported_proxy_chain_base64']]);
    assert.deepEqual(base64.warnings, []);
  });

  // 整份配置全是链式问题：警告指向链式配置，而不是「换个输出格式」。
  withService([trojan('n_b', 'B', 'n_gone')], (service, profile) => {
    const result = service.preview(profile.id, 'mihomo');
    assert.equal(result.stats.nodes, 0);
    assert.deepEqual(result.skippedNodes.map((item) => item.reason), ['invalid_proxy_chain_missing']);
    assert.deepEqual(result.warnings, ['aggregator_nodes_chain_blocked']);
  });
});

test('every chain-capable target declares the syntax it uses', () => {
  assert.equal(getRenderer('mihomo').capabilities.proxyChain, 'dialer-proxy');
  assert.equal(getRenderer('clash-classic').capabilities.proxyChain, 'dialer-proxy');
  assert.equal(getRenderer('stash').capabilities.proxyChain, 'dialer-proxy');
  assert.equal(getRenderer('sing-box').capabilities.proxyChain, 'detour');
  assert.equal(getRenderer('surge').capabilities.proxyChain, 'underlying-proxy');
  assert.equal(getRenderer('json').capabilities.proxyChain, 'reference');
  // 表达不了的格式不声明：配了前置的节点会被跳过，而不是静默直连。
  for (const id of ['base64', 'uri', 'surfboard', 'loon', 'quantumult-x', 'egern']) {
    assert.equal(getRenderer(id).capabilities.proxyChain, undefined, id);
  }
});

test('a Premium-core client is warned when the config carries protocols its core cannot read', () => {
  const client = detectClient('ClashforWindows/0.20.39');
  assert.equal(client.id, 'clash-premium');
  assert.equal(client.target, 'clash-classic');
  assert.ok(client.options.classicProtocols.includes('vmess'));

  const nodes = [
    trojan('n_a', 'A'),
    { id: 'n_v', protocol: 'vless', name: 'V', server: 'v.example', port: 443, uuid: '11111111-2222-3333-4444-555555555555', tls: true }
  ];
  withService(nodes, (service, profile) => {
    // 全协议格式照常输出 VLESS，但要提醒这个内核读不了。
    const warned = service.preview(profile.id, 'clash-classic', { client: 'clash-premium' });
    assert.equal(warned.stats.nodes, 2);
    assert.deepEqual(warned.warnings, ['aggregator_client_core_protocols:vless']);
    // Meta 系客户端拿同样的格式：没有这条提醒。
    const meta = service.preview(profile.id, 'mihomo', { client: 'clash-verge' });
    assert.deepEqual(meta.warnings, []);
  });
});
