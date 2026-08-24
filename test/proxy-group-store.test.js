'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ProxyNodeStore
} = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');

function createStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new ProxyNodeStore(path.join(root, 'proxy-pool.json'));
}

function addNode(store, input) {
  return store.upsertNode({
    protocol: 'vless',
    server: input.server,
    port: 443,
    uuid: input.uuid,
    network: 'tcp',
    security: 'reality',
    publicKey: `public-${input.uuid}`,
    shortId: 'abcd',
    fingerprint: 'chrome',
    sni: input.server,
    name: input.name,
    tags: input.tags || [],
    subscriptionId: input.subscriptionId || null,
    latencyMs: input.latencyMs ?? null,
    countryCode: input.countryCode,
    countryName: input.countryName,
    countryFlag: input.countryFlag
  });
}

test('ProxyNodeStore 同时列出系统、国家、订阅自动组和持久化手动组', (t) => {
  const store = createStore(t);
  const subscription = store.upsertSubscription({
    name: 'Saved Subscription',
    url: 'https://example.com/subscription'
  });
  const hk = addNode(store, {
    server: 'hk.example.com',
    uuid: '11111111-1111-4111-8111-111111111111',
    name: 'HK AI 01',
    tags: ['ai'],
    subscriptionId: subscription.id,
    countryCode: 'HK',
    countryName: '香港',
    countryFlag: '🇭🇰'
  });
  addNode(store, {
    server: 'us.example.com',
    uuid: '22222222-2222-4222-8222-222222222222',
    name: 'US 01',
    subscriptionId: subscription.id,
    countryCode: 'US',
    countryName: '美国',
    countryFlag: '🇺🇸'
  });

  const manual = store.upsertGroup({
    name: '分组 A',
    icon: 'A',
    nodeIds: [hk.id],
    strategy: 'round_robin',
    failoverStrategy: 'lowest_latency'
  });
  const groups = store.listGroups();

  assert.equal(groups.find((group) => group.id === 'all').kind, 'system');
  assert.equal(groups.find((group) => group.id === 'HK').kind, 'country');
  assert.equal(
    groups.find((group) => group.id === `subscription:${subscription.id}`).count,
    2
  );
  assert.deepEqual(groups.find((group) => group.id === manual.id), {
    ...manual,
    count: 1
  });
  assert.deepEqual(store.listNodes({ group: manual.id }).map((node) => node.id), [hk.id]);
});

test('ProxyNodeStore 手动组支持更新成员和策略，并拒绝不存在的节点', (t) => {
  const store = createStore(t);
  const first = addNode(store, {
    server: 'first.example.com',
    uuid: '33333333-3333-4333-8333-333333333333',
    name: 'First',
    countryCode: 'SG',
    countryName: '新加坡',
    countryFlag: '🇸🇬'
  });
  const second = addNode(store, {
    server: 'second.example.com',
    uuid: '44444444-4444-4444-8444-444444444444',
    name: 'Second',
    countryCode: 'JP',
    countryName: '日本',
    countryFlag: '🇯🇵'
  });
  const group = store.upsertGroup({ name: '手动组', nodeIds: [first.id] });

  const updated = store.upsertGroup({
    id: group.id,
    name: '手动组',
    nodeIds: [first.id, second.id],
    strategy: 'random',
    failoverStrategy: 'lowest_latency'
  });

  assert.deepEqual(updated.nodeIds, [first.id, second.id]);
  assert.equal(updated.strategy, 'random');
  assert.throws(
    () => store.upsertGroup({
      id: group.id,
      name: '手动组',
      nodeIds: ['node_missing'],
      strategy: 'random'
    }),
    /group_node_not_found/
  );
  assert.deepEqual(store.getGroup(group.id).nodeIds, [first.id, second.id]);
});

test('ProxyNodeStore 删除节点时清理手动组成员，删除手动组不影响节点', (t) => {
  const store = createStore(t);
  const node = addNode(store, {
    server: 'cleanup.example.com',
    uuid: '55555555-5555-4555-8555-555555555555',
    name: 'Cleanup',
    countryCode: 'DE',
    countryName: '德国',
    countryFlag: '🇩🇪'
  });
  const group = store.upsertGroup({ name: '待清理', nodeIds: [node.id] });

  store.deleteNode(node.id);
  assert.deepEqual(store.getGroup(group.id).nodeIds, []);

  const replacement = addNode(store, {
    server: 'replacement.example.com',
    uuid: '66666666-6666-4666-8666-666666666666',
    name: 'Replacement',
    countryCode: 'DE',
    countryName: '德国',
    countryFlag: '🇩🇪'
  });
  store.upsertGroup({ id: group.id, name: '待清理', nodeIds: [replacement.id] });
  assert.equal(store.deleteGroup(group.id), true);
  assert.equal(store.getGroup(group.id), null);
  assert.equal(store.getNode(replacement.id).id, replacement.id);
});

test('ProxyNodeStore 手动组拒绝保留名和未知策略', (t) => {
  const store = createStore(t);

  assert.throws(
    () => store.upsertGroup({ id: 'all', name: '覆盖系统组', nodeIds: [] }),
    /reserved_proxy_group_id/
  );
  assert.throws(
    () => store.upsertGroup({ name: '坏策略', nodeIds: [], strategy: 'fastest-magic' }),
    /invalid_proxy_group_strategy/
  );
});

test('ProxyNodeStore 自动组可独立保存策略，默认采用 sticky + 最低延迟故障切换', (t) => {
  const store = createStore(t);
  const subscription = store.upsertSubscription({
    name: 'Policy Subscription',
    url: 'https://example.com/policy-subscription'
  });
  addNode(store, {
    server: 'policy.example.com',
    uuid: '77777777-7777-4777-8777-777777777777',
    name: 'US Policy',
    subscriptionId: subscription.id,
    countryCode: 'US',
    countryName: '美国',
    countryFlag: '🇺🇸'
  });

  const subscriptionGroupId = `subscription:${subscription.id}`;
  const defaults = store.getGroup(subscriptionGroupId);
  assert.equal(defaults.strategy, 'sticky');
  assert.equal(defaults.failoverStrategy, 'lowest_latency');

  const updated = store.updateGroupPolicy(subscriptionGroupId, {
    strategy: 'round_robin',
    failoverStrategy: 'random'
  });
  assert.equal(updated.strategy, 'round_robin');
  assert.equal(updated.failoverStrategy, 'random');
  assert.equal(store.getGroup(subscriptionGroupId).strategy, 'round_robin');

  const country = store.updateGroupPolicy('US', {
    strategy: 'lowest_latency',
    failoverStrategy: 'sticky'
  });
  assert.equal(country.failoverStrategy, 'sticky');
  assert.throws(
    () => store.updateGroupPolicy('missing-group', { strategy: 'random' }),
    /proxy_group_not_found/
  );
});

test('ProxyNodeStore 手动组接受 sticky，更新时未提交的策略保持不变', (t) => {
  const store = createStore(t);
  const node = addNode(store, {
    server: 'sticky.example.com',
    uuid: '88888888-8888-4888-8888-888888888888',
    name: 'Sticky',
    countryCode: 'JP',
    countryName: '日本',
    countryFlag: '🇯🇵'
  });
  const created = store.upsertGroup({
    name: 'Sticky Group',
    nodeIds: [node.id],
    strategy: 'sticky',
    failoverStrategy: 'random'
  });
  const renamed = store.upsertGroup({
    id: created.id,
    name: 'Sticky Group Renamed',
    nodeIds: [node.id]
  });

  assert.equal(renamed.strategy, 'sticky');
  assert.equal(renamed.failoverStrategy, 'random');
});

test('订阅节点仅重命名时保留稳定 ID、延迟、端口和手动组成员', (t) => {
  const store = createStore(t);
  const subscription = store.upsertSubscription({
    name: 'Rename Subscription',
    url: 'https://example.com/rename-subscription'
  });
  const original = addNode(store, {
    server: 'rename.example.com',
    uuid: '99999999-9999-4999-8999-999999999999',
    name: 'Old Name',
    subscriptionId: subscription.id,
    latencyMs: 42,
    countryCode: 'HK',
    countryName: '香港',
    countryFlag: '🇭🇰'
  });
  store.updateNodeLatency(original.id, 42);
  const checkedAt = store.getNode(original.id).lastChecked;
  const group = store.upsertGroup({ name: 'Pinned', nodeIds: [original.id] });
  store.assignDedicatedPort(original.id, 10888);

  const replacement = store.replaceSubscriptionNodesWithSnapshot(subscription.id, [{
    protocol: 'vless',
    server: 'rename.example.com',
    port: 443,
    uuid: '99999999-9999-4999-8999-999999999999',
    network: 'tcp',
    security: 'reality',
    publicKey: 'public-99999999-9999-4999-8999-999999999999',
    shortId: 'abcd',
    fingerprint: 'chrome',
    sni: 'rename.example.com',
    name: 'New Name',
    tags: [],
    countryCode: 'HK',
    countryName: '香港',
    countryFlag: '🇭🇰'
  }]);
  const renamed = replacement.nodes[0];

  assert.equal(renamed.id, original.id);
  assert.equal(renamed.name, 'New Name');
  assert.equal(renamed.latencyMs, 42);
  assert.equal(renamed.lastChecked, checkedAt);
  assert.equal(store.getNode(original.id).dedicatedPort, 10888);
  assert.deepEqual(store.getGroup(group.id).nodeIds, [original.id]);
  assert.deepEqual(store.listNodes({ group: group.id }).map((node) => node.name), ['New Name']);
});

test('批量延迟更新在一次事务内写入，并统一记录检查时间', (t) => {
  const store = createStore(t);
  const first = addNode(store, { name: 'First', server: 'first.example.com' });
  const second = addNode(store, { name: 'Second', server: 'second.example.com' });

  const result = store.updateNodeLatencies([
    { nodeId: first.id, latencyMs: 18 },
    { nodeId: second.id, latencyMs: -1 },
    { nodeId: 'missing', latencyMs: 99 }
  ], 123456);

  assert.deepEqual(result, { updated: 2, missing: 1 });
  assert.equal(store.getNode(first.id).latencyMs, 18);
  assert.equal(store.getNode(first.id).lastChecked, 123456);
  assert.equal(store.getNode(second.id).latencyMs, -1);
  assert.equal(store.getNode(second.id).lastChecked, 123456);
});
