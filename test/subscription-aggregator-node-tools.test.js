'use strict';

// 节点工具：订阅源的节点表格（含分享链接）、按节点测延迟、把分享链接解析成表单字段、协议表单描述。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ProxyNodeStore } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { ProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');
const { createProxyPoolSourcePort } = require('../lib/cli/services/toolkit/subscription-aggregator/proxy-pool-source-port');
const { NodeToolsService } = require('../lib/cli/services/toolkit/subscription-aggregator/node-tools');

const TROJAN = 'trojan://secret@tj.example:443?sni=tj.example#🇯🇵 日本 TJ';
const VLESS = 'vless://11111111-2222-3333-4444-555555555555@vl.example:8443?security=reality&pbk=PUB&sid=ab&sni=www.microsoft.com&flow=xtls-rprx-vision#vl';

async function setup(t, latency) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pool = new ProxyPoolService({ store: new ProxyNodeStore(path.join(dir, 'pool.json')) });
  const sources = createProxyPoolSourcePort(pool);
  const saved = await sources.saveSource({ name: '自建', kind: 'local', content: `${TROJAN}\n${VLESS}` });
  await sources.syncSource(saved.subscription.id);
  return { tools: new NodeToolsService({ sources, latency }), sourceId: saved.subscription.id };
}

test('a source lists its nodes with share links and per-node latency', async (t) => {
  const measured = [];
  const latency = {
    async measure(targets, options) {
      measured.push({ targets, options });
      return Object.fromEntries(targets.map((target) => [target.key, { ms: 42, fakeIp: false, measuredAt: 1 }]));
    }
  };
  const { tools, sourceId } = await setup(t, latency);
  const listed = tools.sourceNodes(sourceId);
  assert.deepEqual(listed.nodes.map((node) => [node.name, node.protocol, node.server, node.port, node.flag]), [
    ['🇯🇵 日本 TJ', 'trojan', 'tj.example', 443, '🇯🇵'],
    ['vl', 'vless', 'vl.example', 8443, '🌐']
  ]);
  assert.match(listed.nodes[0].link, /^trojan:\/\/secret@tj\.example:443/);
  assert.deepEqual(tools.sourceNodes('sub_missing'), { ok: false, error: 'subscription_not_found' });

  const result = await tools.measureLatency(sourceId, { fresh: true });
  assert.deepEqual(Object.values(result.results).map((item) => item.ms), [42, 42]);
  assert.deepEqual(measured[0].targets.map((target) => `${target.server}:${target.port}`), ['tj.example:443', 'vl.example:8443']);
  assert.deepEqual(measured[0].options, { fresh: true });
});

test('share links parse into full form fields and every protocol has a form', async (t) => {
  const { tools } = await setup(t);
  const parsed = tools.parseNodes({ content: VLESS });
  assert.deepEqual(parsed.nodes[0], {
    protocol: 'vless', name: 'vl', server: 'vl.example', port: 8443, uuid: '11111111-2222-3333-4444-555555555555',
    flow: 'xtls-rprx-vision', security: 'reality', publicKey: 'PUB', shortId: 'ab', network: 'tcp', tls: true, sni: 'www.microsoft.com'
  });
  assert.deepEqual(tools.parseNodes({ content: ' ' }), { ok: false, error: 'invalid_subscription_content' });
  assert.equal(tools.parseNodes({ content: 'vless://broken' }).skippedNodes[0].reason, 'invalid_proxy_link_vless');

  const forms = tools.protocolForms();
  assert.ok(forms.length >= 14);
  const https = forms.find((form) => form.protocol === 'https');
  assert.ok(https.fields.some((field) => field.key === 'sni' && field.section === 'tls'));
  const wireguard = forms.find((form) => form.protocol === 'wireguard');
  assert.deepEqual(wireguard.fields.filter((field) => field.required).map((field) => field.key), ['privateKey', 'publicKey']);
  assert.equal(wireguard.fields.find((field) => field.key === 'privateKey').control, 'secret');
});

test('chain upstreams are set per node and validated before they are written', async (t) => {
  const { tools, sourceId } = await setup(t);
  const [trojanNode, vlessNode] = tools.sourceNodes(sourceId).nodes;
  // 全部节点（含手动节点）只给选前置用：不带凭据与分享链接。
  assert.deepEqual(tools.allNodes().nodes.map((node) => [node.id, node.name, node.chain]), [
    [trojanNode.id, '🇯🇵 日本 TJ', ''],
    [vlessNode.id, 'vl', '']
  ]);

  // 让 vless 经由 trojan 出去，再让 trojan 经由 vless —— 后者会成环，保存时就该被拦下。
  assert.deepEqual(tools.setNodeChain(vlessNode.id, trojanNode.id), {
    ok: true,
    node: { id: vlessNode.id, name: 'vl', chain: trojanNode.id }
  });
  assert.equal(tools.setNodeChain(trojanNode.id, vlessNode.id).error, 'invalid_proxy_chain_cycle');
  assert.equal(tools.setNodeChain(trojanNode.id, trojanNode.id).error, 'invalid_proxy_chain_cycle');
  assert.equal(tools.setNodeChain(trojanNode.id, 'n_missing').error, 'invalid_proxy_chain_missing');
  assert.equal(tools.setNodeChain('n_missing', trojanNode.id).error, 'proxy_node_not_found');

  // 清空前置 = 恢复直连；同步订阅不会把用户配的前置冲掉。
  assert.deepEqual(tools.setNodeChain(vlessNode.id, ''), {
    ok: true,
    node: { id: vlessNode.id, name: 'vl', chain: '' }
  });
  tools.setNodeChain(vlessNode.id, trojanNode.id);
  await tools.sources.syncSource(sourceId);
  const listed = tools.sourceNodes(sourceId).nodes;
  assert.equal(listed.find((node) => node.id === vlessNode.id).chain, trojanNode.id);
  assert.equal(listed.find((node) => node.id === trojanNode.id).chain, '');
});
