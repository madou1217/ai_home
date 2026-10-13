'use strict';

// ShadowTLS：中立键沿用 SIP003 的 host / password / version，三种写法（SIP003 / Clash / Loon）归一。
// mihomo 系写 shadow-tls 插件；sing-box 多输出一个带 §hide§ 的 shadowtls 出站并用 detour 指过去；
// Loon 写 shadow-tls-* 参数；表达不了的格式（Surge 系、QX、Egern）跳过并给出原因，不静默丢参数。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { extrasOf, compiledLine } = require('../lib/cli/services/toolkit/proxy-pool/compile-result');
const { HIDE_MARK, hiddenTag } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/shadow-tls');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const { parseSubscriptionContentDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const {
  canonicalShadowsocksPlugin,
  shadowsocksPluginIdentity
} = require('../lib/cli/services/toolkit/proxy-pool/shadowsocks-plugin');
const {
  buildProxyNodeConnectionKey,
  validateProxyNodeInput
} = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const { SHADOW_TLS_NODE, SAMPLE_NODES, assertRoundTrip } = require('./helpers/proxy-format-samples');

const PLAIN_SS = SAMPLE_NODES.find((node) => node.name === 'ss');
const SING_BOX_BIN = path.join(os.homedir(), '.ai_home', 'bin', 'sing-box');

test('ShadowTLS 的 SIP003 / Clash / Loon 三种写法归一到同一份中立参数与连接身份', () => {
  const canonical = { name: 'shadow-tls', host: 'www.example.com', password: 'st-pw', version: '3' };
  assert.deepEqual(canonicalShadowsocksPlugin(SHADOW_TLS_NODE), canonical);
  // Clash 的 plugin-opts 是对象，版本可能是数字。
  assert.deepEqual(
    canonicalShadowsocksPlugin({ ...SHADOW_TLS_NODE, pluginOpts: { host: 'www.example.com', password: 'st-pw', version: 3 } }),
    canonical
  );
  // 同一个连接在三种写法下身份一致；不带 ShadowTLS 的节点身份不受影响。
  assert.equal(
    buildProxyNodeConnectionKey({ ...SHADOW_TLS_NODE, pluginOpts: { host: 'www.example.com', password: 'st-pw', version: 3 } }),
    buildProxyNodeConnectionKey(SHADOW_TLS_NODE)
  );
  assert.equal(canonicalShadowsocksPlugin(PLAIN_SS), null);
  assert.equal(shadowsocksPluginIdentity(PLAIN_SS), null);
  validateProxyNodeInput(SHADOW_TLS_NODE);
});

test('mihomo 系把 ShadowTLS 写成 shadow-tls 插件，版本写成数字', () => {
  for (const id of ['mihomo', 'stash']) {
    const renderer = getRenderer(id);
    const proxy = renderer.compileNode({ node: SHADOW_TLS_NODE, name: SHADOW_TLS_NODE.name });
    assert.equal(proxy.plugin, 'shadow-tls', id);
    assert.deepEqual(proxy['plugin-opts'], { host: 'www.example.com', password: 'st-pw', version: 3 }, id);
    // Clash YAML 往返：plugin-opts 的键值回到中立表示后连接指纹不变。
    const compiled = [proxy];
    assertRoundTrip(id, renderer.render({ groups: [] }, compiled, { view: 'nodes' }), [SHADOW_TLS_NODE]);
  }
});

test('sing-box 给 ShadowTLS 节点多输出一个带 §hide§ 的 shadowtls 出站，ss 出站用 detour 指过去', () => {
  const outbound = compileSingBoxNodeOutbound(SHADOW_TLS_NODE, 'st');
  assert.deepEqual([outbound.type, outbound.detour], ['shadowsocks', hiddenTag('st')]);
  assert.ok(outbound.detour.includes(HIDE_MARK));
  const extras = extrasOf(outbound);
  assert.deepEqual(extras, [{
    type: 'shadowtls',
    tag: hiddenTag('st'),
    server: 'st.example',
    server_port: 443,
    version: 3,
    password: 'st-pw',
    tls: { enabled: true, server_name: 'www.example.com' }
  }]);
  // 附加输出挂在 Symbol 键上：序列化后的配置里看不见，不会污染出站本身。
  const serialized = JSON.parse(JSON.stringify(outbound));
  assert.deepEqual(Object.keys(serialized).sort(), ['detour', 'method', 'password', 'server', 'server_port', 'tag', 'type']);
  // 没有 ShadowTLS 的节点不会多出任何东西。
  assert.deepEqual(extrasOf(compileSingBoxNodeOutbound(PLAIN_SS, 'ss')), []);
});

test('sing-box 渲染把辅助出站拼进 outbounds，往返后连接指纹不变', () => {
  const renderer = getRenderer('sing-box');
  const compiled = [renderer.compileNode({ node: SHADOW_TLS_NODE, name: SHADOW_TLS_NODE.name })];
  const text = renderer.render({ groups: [] }, compiled, { view: 'nodes' });
  const config = JSON.parse(text);
  assert.deepEqual(config.outbounds.map((item) => item.tag), [SHADOW_TLS_NODE.name, hiddenTag(SHADOW_TLS_NODE.name)]);
  assert.equal(config.outbounds[0].detour, hiddenTag(SHADOW_TLS_NODE.name));
  assertRoundTrip('sing-box', text, [SHADOW_TLS_NODE]);
});

test('辅助出站与真实节点重名时改名，渲染结果里不会出现重复 tag', () => {
  const renderer = getRenderer('sing-box');
  const colliding = { ...PLAIN_SS, name: hiddenTag('st') };
  const compiled = [
    renderer.compileNode({ node: SHADOW_TLS_NODE, name: 'st' }),
    renderer.compileNode({ node: colliding, name: colliding.name })
  ];
  const config = JSON.parse(renderer.render({ groups: [] }, compiled, { view: 'nodes' }));
  const tags = config.outbounds.map((item) => item.tag);
  assert.equal(new Set(tags).size, tags.length, `tag 重复：${tags.join(', ')}`);
  const detour = config.outbounds.find((item) => item.tag === 'st').detour;
  assert.notEqual(detour, hiddenTag('st'));
  assert.ok(tags.includes(detour), `${detour} 不在 ${tags.join(', ')}`);
});

test('表达不了 ShadowTLS 的格式跳过节点并给出原因', () => {
  // Surge 系与 QX / Egern 的 ss 插件只到 obfs；Clash 经典版（Premium）的插件表里也没有 shadow-tls。
  for (const id of ['surge', 'surfboard', 'quantumult-x', 'egern', 'clash-classic']) {
    assert.throws(
      () => getRenderer(id).compileNode({ node: SHADOW_TLS_NODE, name: SHADOW_TLS_NODE.name }),
      { code: 'unsupported_shadowsocks_plugin_shadow-tls' },
      id
    );
  }
});

test('Loon 把 ShadowTLS 写在代理行上，往返后连接指纹不变', () => {
  const renderer = getRenderer('loon');
  const compiled = [renderer.compileNode({ node: SHADOW_TLS_NODE, name: SHADOW_TLS_NODE.name })];
  assert.equal(
    compiledLine(compiled[0]),
    'ss-shadowtls = Shadowsocks, st.example, 443, aes-256-gcm, "ss-pw", shadow-tls-password="st-pw", shadow-tls-sni=www.example.com, shadow-tls-version=3, fast-open=false, udp=true'
  );
  assertRoundTrip('loon', renderer.render({ groups: [] }, compiled, { view: 'nodes' }), [SHADOW_TLS_NODE]);
});

test('Surge 的 Snell 行带 shadow-tls-* 时跳过并说明原因，不再静默丢参数', () => {
  const text = [
    '[Proxy]',
    'sn = snell, sn.example, 8000, psk=p, version=4, shadow-tls-password=st, shadow-tls-sni=www.example.com, shadow-tls-version=3',
    'ok = snell, ok.example, 8000, psk=p, version=4'
  ].join('\n');
  const { nodes, skippedNodes } = parseSubscriptionContentDetailed(text);
  assert.deepEqual(nodes.map((node) => node.name), ['ok']);
  assert.deepEqual(skippedNodes, [{ nodeId: null, name: 'sn', reason: 'unsupported_surge_snell_shadow_tls' }]);
});

test('sing-box 导入按 tag 找回 shadowtls 出站合并进节点，辅助出站本身不成为节点', () => {
  const config = JSON.stringify({
    outbounds: [
      { type: 'shadowsocks', tag: 'ss', server: 'st.example', server_port: 443, method: 'aes-256-gcm', password: 'ss-pw', detour: 'st-out' },
      { type: 'shadowtls', tag: 'st-out', server: 'st.example', server_port: 443, version: 3, password: 'st-pw', tls: { enabled: true, server_name: 'www.example.com' } },
      { type: 'direct', tag: 'direct' }
    ]
  }, null, 2);
  const { nodes, skippedNodes } = parseSubscriptionContentDetailed(config);
  assert.deepEqual(skippedNodes, []);
  assert.deepEqual(nodes.map((node) => node.name), ['ss']);
  assert.deepEqual([nodes[0].plugin, nodes[0].pluginOpts], ['shadow-tls', 'host=www.example.com;password=st-pw;version=3']);
  assert.equal(buildProxyNodeConnectionKey(nodes[0]), buildProxyNodeConnectionKey(SHADOW_TLS_NODE));
});

test('本机 sing-box 能通过含 ShadowTLS 的完整配置检查', { skip: !fs.existsSync(SING_BOX_BIN) }, () => {
  const renderer = getRenderer('sing-box');
  const compiled = [
    renderer.compileNode({ node: SHADOW_TLS_NODE, name: 'st' }),
    renderer.compileNode({ node: PLAIN_SS, name: PLAIN_SS.name })
  ];
  const plan = {
    groups: [{ name: 'proxy', type: 'select', members: [{ kind: 'node', name: 'st' }, { kind: 'node', name: PLAIN_SS.name }] }],
    rules: [],
    ruleSets: [],
    final: { kind: 'node', name: 'st' }
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aih-shadowtls-')), 'config.json');
  try {
    fs.writeFileSync(file, renderer.render(plan, compiled, {}));
    const result = spawnSync(SING_BOX_BIN, ['check', '-c', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
