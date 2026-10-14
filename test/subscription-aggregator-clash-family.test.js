'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const YAML = require('yaml');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { detectRendererByUserAgent, getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const { SAMPLE_NODES, assertRoundTrip } = require('./helpers/proxy-format-samples');

function withService(nodes, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-clash-'));
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
    const profile = store.saveProfile({ name: 'clash', refreshHours: 0 });
    return run(service, profile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('mihomo, Clash classic and Stash share Clash YAML but differ in protocols and rule-set files', () => {
  withService(SAMPLE_NODES, (service, profile) => {
    const mihomo = service.preview(profile.id, 'mihomo');
    const classic = service.preview(profile.id, 'clash-classic');
    const stash = service.preview(profile.id, 'stash');

    const mihomoConfig = YAML.parse(mihomo.content);
    assert.equal(mihomoConfig['unified-delay'], true);
    assert.equal(mihomoConfig['rule-providers']['geosite-private'].format, 'mrs');
    assert.match(mihomoConfig['rule-providers']['geosite-private'].url, /@meta\/geo\/geosite\/private\.mrs$/);
    assert.equal(mihomoConfig['rule-providers']['geosite-private'].path, './rule-providers/geosite-private.mrs');
    // 除 HTTP 外的代理都开 UDP。
    for (const proxy of mihomoConfig.proxies) {
      assert.equal(proxy.udp, ['http', 'https'].includes(SAMPLE_NODES.find((node) => node.name === proxy.name).protocol) ? undefined : true, proxy.name);
    }

    const classicConfig = YAML.parse(classic.content);
    assert.equal(classicConfig['unified-delay'], undefined);
    assert.deepEqual(classicConfig['rule-providers']['geoip-private'], {
      type: 'http',
      behavior: 'ipcidr',
      url: 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geoip/private.yaml',
      path: './rule-providers/geoip-private.yaml',
      interval: 86400
    });
    // Clash 目标不再按协议挑节点：全部协议都输出（全协议需要 Meta 系内核，见渲染器的 note）。
    assert.deepEqual(classic.skippedNodes, []);
    assert.equal(classic.stats.nodes, SAMPLE_NODES.length);
    assert.deepEqual(classicConfig.proxies.map((proxy) => proxy.name).sort(), SAMPLE_NODES.map((node) => node.name).sort());
    // 唯一还按协议挑节点的 Clash 系目标是 Stash（没有 AnyTLS 出站）。
    assert.deepEqual(stash.skippedNodes.map((item) => [item.name, item.reason]), [['anytls', 'unsupported_proxy_protocol_anytls']]);
    assert.match(YAML.parse(stash.content)['rule-providers']['geosite-private'].url, /\.yaml$/);

    // 三种输出都能被 Clash 导入器读回同样的连接参数。
    const rendered = (result) => {
      const skipped = new Set(result.skippedNodes.map((item) => item.name));
      return SAMPLE_NODES.filter((node) => !skipped.has(node.name));
    };
    assertRoundTrip('mihomo', mihomo.content);
    assertRoundTrip('stash', stash.content, rendered(stash));
    assertRoundTrip('clash-classic', classic.content, rendered(classic));
  });
});

test('when every selected node is dropped by the target, the warning blames the format, not the filters', () => {
  const vlessOnly = SAMPLE_NODES.filter((node) => node.protocol === 'vless');
  withService(vlessOnly, (service, profile) => {
    // Surfboard 没有 VLESS 出站：这是「目标格式表达不了」的典型场景。
    const surfboard = service.preview(profile.id, 'surfboard');
    assert.equal(surfboard.stats.selected, vlessOnly.length);
    assert.equal(surfboard.stats.nodes, 0);
    assert.deepEqual(surfboard.warnings, ['aggregator_nodes_unsupported_by_target']);
    assert.deepEqual(surfboard.skippedNodes.map((item) => item.reason), vlessOnly.map(() => 'unsupported_proxy_protocol_vless'));

    // Clash 目标输出全部协议，不再丢 VLESS。
    const classic = service.preview(profile.id, 'clash-classic');
    assert.equal(classic.stats.nodes, vlessOnly.length);
    assert.deepEqual(classic.warnings, []);

    // mihomo 能表达 VLESS：正常输出，且不该出现这条警告。
    const mihomo = service.preview(profile.id, 'mihomo');
    assert.equal(mihomo.stats.nodes, vlessOnly.length);
    assert.deepEqual(mihomo.warnings, []);
  });
});

test('a genuinely empty selection still reports aggregator_no_nodes', () => {
  withService([], (service, profile) => {
    const result = service.preview(profile.id, 'clash-classic');
    assert.equal(result.stats.selected, 0);
    assert.equal(result.stats.skipped, 0);
    assert.deepEqual(result.warnings, ['aggregator_no_nodes']);
  });
});

test('URI and JSON outputs list the nodes without groups or rules', () => {
  withService(SAMPLE_NODES.slice(0, 2), (service, profile) => {
    const uri = service.preview(profile.id, 'uri').content;
    assert.equal(uri.split('\n').filter(Boolean).length, 2);
    assert.match(uri, /^ss:\/\//);
    assert.equal(service.preview(profile.id, 'shadowrocket').format, 'base64');

    const json = JSON.parse(service.preview(profile.id, 'json').content);
    assert.deepEqual(json.nodes[0], {
      name: 'ss', protocol: 'shadowsocks', server: 'ss.example', port: 8388, password: 'secret', cipher: 'aes-256-gcm'
    });
    assert.equal(json.nodes[1].pluginOpts, 'obfs=http;obfs-host=cdn.example');
  });
});

test('sing-box reality allows an empty short id and turns on uTLS like mihomo does', () => {
  const tls = compileSingBoxNodeOutbound({
    protocol: 'vless', server: 'r.example', port: 443, uuid: 'u', security: 'reality', tls: true, publicKey: 'PK', sni: 's.example'
  }, 'r').tls;
  assert.deepEqual(tls, {
    enabled: true,
    server_name: 's.example',
    reality: { enabled: true, public_key: 'PK' },
    utls: { enabled: true, fingerprint: 'chrome' }
  });
});

test('user agents pick the matching Clash flavour', () => {
  assert.equal(detectRendererByUserAgent('ClashX/1.118.0 (com.west2online.ClashX)').id, 'clash-classic');
  assert.equal(detectRendererByUserAgent('ClashforWindows/0.20.39').id, 'clash-classic');
  assert.equal(detectRendererByUserAgent('ClashX Meta/1.3.0').id, 'mihomo');
  assert.equal(detectRendererByUserAgent('Stash/2.6.0 Clash/1.11.0').id, 'stash');
  assert.equal(detectRendererByUserAgent('Surge iOS/3000').id, 'surge');
  assert.equal(detectRendererByUserAgent('Loon/3.2.0').id, 'loon');
  assert.equal(detectRendererByUserAgent('Quantumult%20X/1.4.1').id, 'quantumult-x');
  // 已发布的 ?target=clash 链接仍然得到 mihomo。
  assert.equal(getRenderer('clash').id, 'mihomo');
});
