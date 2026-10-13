'use strict';

// 客户端识别表与按客户端渲染：UA 样例来自各客户端源码 / 官方文档（2026-10-12 调研），
// 冲突样例（FlClash 带 clash-verge、Hiddify 带 v2ray / sing-box、Karing 多片段）必须按表的优先级认出。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const { clientById, describeClients, detectClient } = require('../lib/cli/services/toolkit/subscription-aggregator/client-profiles');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const { extrasOf } = require('../lib/cli/services/toolkit/proxy-pool/compile-result');
const { SAMPLE_NODES } = require('./helpers/proxy-format-samples');

const UA_SAMPLES = [
  ['clash-verge/v2.5.8', 'clash-verge', 'mihomo'],
  ['FlClash/v0.8.99 clash-verge Platform/android', 'flclash', 'mihomo'],
  ['ClashMetaForAndroid/2.11.35.Meta', 'clash-meta-android', 'mihomo'],
  ['mihomo.party/v2.0.3 (clash.meta)', 'clash-party', 'mihomo'],
  ['clash-nyanpasu/v2.0.0-rc.1', 'clash-nyanpasu', 'mihomo'],
  ['ClashX%20Meta/1.4.46 (com.metacubex.ClashX.meta; build:146; macOS 15.5.0) Alamofire/5.9.1', 'clashx-meta', 'mihomo'],
  ['ClashX/1.118.0 (com.west2online.ClashX; build:1.118.0; macOS 14.4.0) Alamofire/5.8.0', 'clash-premium', 'clash-classic'],
  ['ClashforWindows/0.20.39', 'clash-premium', 'clash-classic'],
  ['ClashForAndroid/2.5.12', 'clash-premium', 'clash-classic'],
  ['clash.meta/1.19.20', 'clash-generic', 'mihomo'],
  ['Stash/2.7.4 Clash/1.9.0', 'stash', 'stash'],
  ['HiddifyNext/4.1.1 (android) like ClashMeta v2ray sing-box', 'hiddify', 'sing-box'],
  ['HiddifyNextX/4.1.1 (android) like ClashMeta v2ray sing-box', 'hiddify-xray', 'base64'],
  ['HiddifyNext/2.5.7 (windows) like ClashMeta v2ray sing-box', 'hiddify', 'base64'],
  ['Karing/1.2.26.2907 platform/tvos sing-box 1.14.0', 'karing', 'sing-box'],
  ['Karing/1.2.26 clash-verge FLClash mihomo/1.19.28', 'karing', 'sing-box'],
  ['NekoBox/Android/1.4.2 (Prefer ClashMeta Format)', 'nekobox', 'mihomo'],
  ['husi/0.12.4 (sing-box 1.13.2)', 'husi', 'sing-box'],
  ['SFA (sing-box 1.14.3; language zh_CN)', 'sing-box', 'sing-box'],
  ['SFI (sing-box 1.11.4; language en)', 'sing-box', 'sing-box'],
  ['Surge iOS/3388', 'surge', 'surge'],
  ['Surge Mac/2850', 'surge', 'surge'],
  ['Surfboard/2.24.1', 'surfboard', 'surfboard'],
  ['Loon/905 CFNetwork/1568.100.1 Darwin/24.0.0', 'loon', 'loon'],
  ['Quantumult%20X/1.5.2', 'quantumult-x', 'quantumult-x'],
  ['Egern/2.20.0', 'egern', 'egern'],
  ['Shadowrocket/3131 CFNetwork/3860.500.112 Darwin/25.4.0 iPhone16,2', 'shadowrocket', 'base64'],
  ['v2rayNG/1.10.25', 'v2rayng', 'base64'],
  ['v2rayN/7.15.4', 'v2rayn', 'base64'],
  ['v2rayA/2.2.7 WebRequestHelper', 'v2raya', 'base64'],
  ['Streisand/1 CFNetwork/1568.100.1 Darwin/24.0.0', 'streisand', 'base64'],
  ['Happ/3.1.2', 'happ', 'base64'],
  // 爬虫名里的 meta 不算 Clash；认不出的客户端仍给 mihomo（已发出的链接行为不变）。
  ['meta-externalagent/1.1', 'unknown', 'mihomo'],
  ['curl/8.7.1', 'unknown', 'mihomo'],
  ['', 'unknown', 'mihomo']
];

test('the client table recognises each app by its own User-Agent, specific names first', () => {
  for (const [ua, id, target] of UA_SAMPLES) {
    const client = detectClient(ua);
    assert.deepEqual([client.id, client.target], [id, target], ua);
  }
  assert.deepEqual(detectClient('HiddifyNext/4.1.1 (android) like ClashMeta v2ray sing-box').options, { view: 'nodes', singBoxVersion: '1.13.0' });
  assert.deepEqual(detectClient('SFA (sing-box 1.14.3; language zh_CN)').options, { singBoxVersion: '1.14.3', officialApp: true });
  assert.deepEqual(detectClient('Karing/1.2.26 clash-verge FLClash mihomo/1.19.28').options, { view: 'nodes' });
  // 预览按 id 模拟客户端时没有 UA：Hiddify 取 4.x 的默认表现。
  assert.deepEqual(clientById('hiddify'), {
    id: 'hiddify', name: 'Hiddify', target: 'sing-box', options: { view: 'nodes', singBoxVersion: '1.13.0' }
  });
  assert.equal(clientById('nope'), null);
  const listed = describeClients().map((client) => client.id);
  assert.ok(['clash-verge', 'flclash', 'hiddify', 'stash', 'surge', 'v2rayn'].every((id) => listed.includes(id)));
  assert.ok(!listed.includes('clash-generic') && !listed.includes('sing-box-generic'));
});

function setup(t, nodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-clients-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => 1000 });
  const sources = [{ id: 'sub_a', name: '机场 A', url: 'https://a.example/sub', nodeCount: nodes.length, lastSyncedAt: 1000 }];
  const service = new SubscriptionAggregatorService({
    store,
    now: () => 1000,
    sources: {
      listSources: () => sources,
      listNodes: () => nodes.map((node) => ({ ...node, subscriptionId: 'sub_a' })),
      syncSource: async () => ({ ok: true })
    }
  });
  const profile = store.saveProfile({ name: '聚合', refreshHours: 0 });
  return { service, profile };
}

test('client pulls render per client: Hiddify gets sing-box nodes, old sing-box cores skip newer protocols', async (t) => {
  const nodes = SAMPLE_NODES.filter((node) => ['trojan', 'anytls', 'wg', 'vless-reality'].includes(node.name));
  const { service, profile } = setup(t, nodes);

  const hiddify = await service.serveSubscription(profile.token, { userAgent: 'HiddifyNext/4.1.1 (android) like ClashMeta v2ray sing-box' });
  const nodesOnly = JSON.parse(hiddify.body);
  assert.deepEqual(Object.keys(nodesOnly), ['outbounds', 'endpoints']);
  assert.deepEqual(nodesOnly.outbounds.map((item) => item.type), ['vless', 'trojan', 'anytls']);
  assert.deepEqual(nodesOnly.endpoints.map((item) => item.tag), ['wg']);

  // SFI 1.11 的内核没有 AnyTLS：跳过这个节点，其余照常（一个不认识的出站会让整份配置被拒）。
  const oldCore = await service.serveSubscription(profile.token, { userAgent: 'SFI (sing-box 1.11.4; language en)' });
  const full = JSON.parse(oldCore.body);
  assert.ok(full.route && full.dns, '官方 App 拿到完整配置');
  assert.ok(!full.outbounds.some((item) => item.type === 'anytls'));
  assert.equal(oldCore.stats.skipped, 1);

  // 链接里写了 ?target 时仍按识别出的客户端选项渲染（内核版本、视图）。
  const explicit = await service.serveSubscription(profile.token, { target: 'sing-box', userAgent: 'SFI (sing-box 1.11.4; language en)' });
  assert.equal(explicit.stats.skipped, 1);

  const clash = await service.serveSubscription(profile.token, { userAgent: 'FlClash/v0.8.99 clash-verge Platform/android' });
  assert.equal(YAML.parse(clash.body).proxies.length, 4);

  const [latest, , oldest] = service.getOverview().profiles[0].recentPulls;
  assert.deepEqual(latest, { at: 1000, clientId: 'flclash', clientName: 'FlClash', format: 'mihomo', view: 'full', nodes: 4 });
  assert.deepEqual([oldest.clientId, oldest.format, oldest.view, oldest.nodes], ['sing-box', 'sing-box', 'full', 3]);
  assert.equal(service.getOverview().profiles[0].recentPulls.length, 4);
  assert.ok(service.getOverview().catalog.clients.some((client) => client.id === 'hiddify'));
});

test('preview can play a client so the WebUI shows exactly what that client receives', (t) => {
  const { service, profile } = setup(t, SAMPLE_NODES.filter((node) => ['trojan', 'wg'].includes(node.name)));
  const asHiddify = service.preview(profile.id, '', { client: 'hiddify' });
  assert.deepEqual([asHiddify.ok, asHiddify.format, asHiddify.view, asHiddify.client.id], [true, 'sing-box', 'nodes', 'hiddify']);
  assert.deepEqual(Object.keys(JSON.parse(asHiddify.content)), ['outbounds', 'endpoints']);
  // 明确的格式优先于客户端的默认格式。
  assert.equal(service.preview(profile.id, 'mihomo', { client: 'hiddify' }).format, 'mihomo');
  assert.deepEqual(service.preview(profile.id, '', { client: 'nope' }), { ok: false, error: 'unsupported_aggregator_client' });
  // 预览不计入拉取记录。
  assert.deepEqual(service.getOverview().profiles[0].recentPulls, []);
});

test('sing-box turns a Shadowsocks ShadowTLS plugin into a detour plus a hidden shadowtls outbound', () => {
  const node = {
    protocol: 'shadowsocks', name: 'st', server: 'st.example', port: 443, cipher: 'aes-128-gcm', password: 'p',
    plugin: 'shadow-tls', pluginOpts: { host: 'cloud.tencent.com', password: 'x', version: 3 }
  };
  const outbound = compileSingBoxNodeOutbound(node, 'st');
  assert.equal(outbound.type, 'shadowsocks');
  assert.equal(outbound.detour, 'st§hide§');
  assert.deepEqual(extrasOf(outbound), [{
    type: 'shadowtls',
    tag: 'st§hide§',
    server: 'st.example',
    server_port: 443,
    version: 3,
    password: 'x',
    tls: { enabled: true, server_name: 'cloud.tencent.com' }
  }]);
  // 没实现的插件仍然跳过，不让整份配置被拒。
  assert.throws(() => compileSingBoxNodeOutbound({ ...node, plugin: 'kcptun' }, 'st'), { code: 'unsupported_shadowsocks_plugin_kcptun' });
  assert.equal(compileSingBoxNodeOutbound({ ...node, plugin: 'obfs-local', pluginOpts: 'obfs=http' }, 'st').plugin, 'obfs-local');
});
