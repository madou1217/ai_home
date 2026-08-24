'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EGRESS_MODE_GROUP,
  EGRESS_MODE_NODE,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL
} = require('../lib/account/zcode-egress-binding-store');
const resolver = require('../lib/server/zcode-egress-resolver');

test('resolver 暴露协议无关的 ZCode target 解析入口', () => {
  assert.equal(typeof resolver.resolveZcodeEgressTarget, 'function');
});

test('system 模式只读系统代理并按 HTTPS、HTTP、SOCKS 优先级选择', async () => {
  const calls = [];
  const result = await resolver.resolveZcodeEgressTarget({
    binding: { mode: EGRESS_MODE_SYSTEM },
    platform: 'darwin',
    detectSystemProxy: () => {
      calls.push('detect');
      return {
        enabled: true,
        probeStatus: 'available',
        httpsProxy: 'http://127.0.0.1:9443',
        httpProxy: 'http://127.0.0.1:9080',
        socksProxy: 'socks5://127.0.0.1:1080'
      };
    }
  });

  assert.deepEqual(calls, ['detect']);
  assert.deepEqual(result, {
    ok: true,
    source: EGRESS_MODE_SYSTEM,
    target: {
      kind: 'proxy-url',
      proxyUrl: 'http://127.0.0.1:9443'
    }
  });
});

test('system 模式在系统代理未配置或探测失败时拒绝静默直连', async () => {
  for (const status of [
    { enabled: false, probeStatus: 'unset' },
    { enabled: false, probeStatus: 'error' }
  ]) {
    const result = await resolver.resolveZcodeEgressTarget({
      binding: { mode: EGRESS_MODE_SYSTEM },
      platform: 'darwin',
      detectSystemProxy: () => status
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'system_proxy_unavailable');
  }
});

test('tun 模式只接受已激活的外部 TUN，inactive 与 unknown 均 fail-closed', async () => {
  for (const state of ['inactive', 'unknown']) {
    const result = await resolver.resolveZcodeEgressTarget({
      binding: { mode: EGRESS_MODE_TUN },
      platform: 'darwin',
      detectTun: () => ({ state })
    });

    assert.equal(result.ok, false, state);
    assert.equal(result.error, state === 'unknown' ? 'tun_state_unknown' : 'tun_inactive');
  }

  const active = await resolver.resolveZcodeEgressTarget({
    binding: { mode: EGRESS_MODE_TUN },
    platform: 'darwin',
    detectTun: () => ({ state: 'active', owner: 'clash-verge' })
  });
  assert.deepEqual(active, {
    ok: true,
    source: EGRESS_MODE_TUN,
    target: { kind: 'direct' },
    tun: { state: 'active', owner: 'clash-verge' }
  });
});

test('url 模式生成中立 proxy-url target，不直接交给 ZCode 远端地址', async () => {
  const result = await resolver.resolveZcodeEgressTarget({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'socks4a://proxy.example:1080' },
    platform: 'darwin'
  });

  assert.deepEqual(result, {
    ok: true,
    source: EGRESS_MODE_URL,
    target: {
      kind: 'proxy-url',
      proxyUrl: 'socks4a://proxy.example:1080'
    }
  });
});

test('node 模式从协议无关节点仓读取节点，不调用 Mihomo 专用端口', async () => {
  const node = {
    id: 'node-a',
    protocol: 'vless',
    server: 'edge.example',
    port: 443,
    uuid: '00000000-0000-4000-8000-000000000001'
  };
  const result = await resolver.resolveZcodeEgressTarget({
    binding: { mode: EGRESS_MODE_NODE, nodeId: node.id },
    platform: 'darwin',
    nodeStore: {
      getNode(nodeId) {
        assert.equal(nodeId, node.id);
        return node;
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, EGRESS_MODE_NODE);
  assert.deepEqual(result.target, { kind: 'node', node });
  assert.deepEqual(result.candidateNodes, [node]);
});

test('group 模式复用调度器并避开其他 ZCode 实例已租用节点', async () => {
  const nodes = [
    { id: 'node-a', latencyMs: 20 },
    { id: 'node-b', latencyMs: 40 }
  ];
  const result = await resolver.resolveZcodeEgressTarget({
    binding: { mode: EGRESS_MODE_GROUP, groupId: 'group-fast' },
    platform: 'darwin',
    ownerId: 'desktop:acct_current',
    nodeStore: {
      getGroup(groupId) {
        assert.equal(groupId, 'group-fast');
        return {
          id: groupId,
          strategy: 'lowest_latency',
          failoverStrategy: 'lowest_latency'
        };
      },
      listNodes(filter) {
        assert.deepEqual(filter, { group: 'group-fast' });
        return nodes;
      }
    },
    leaseStore: {
      listActive() {
        return [{ ownerId: 'desktop:acct_other', nodeId: 'node-a', releasedAt: null }];
      },
      getLastSelectedNodeId() {
        return '';
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, EGRESS_MODE_GROUP);
  assert.equal(result.selectedNodeId, 'node-b');
  assert.deepEqual(result.target, { kind: 'node', node: nodes[1] });
  assert.deepEqual(result.candidateNodes, nodes);
  assert.equal(result.selection.reused, false);
});

test('group 模式在分组不存在或没有健康节点时返回稳定错误', async () => {
  const missing = await resolver.resolveZcodeEgressTarget({
    binding: { mode: EGRESS_MODE_GROUP, groupId: 'missing' },
    platform: 'darwin',
    nodeStore: {
      getGroup: () => null,
      listNodes: () => []
    }
  });
  assert.equal(missing.error, 'proxy_group_not_found');

  const empty = await resolver.resolveZcodeEgressTarget({
    binding: { mode: EGRESS_MODE_GROUP, groupId: 'empty' },
    platform: 'darwin',
    nodeStore: {
      getGroup: () => ({ id: 'empty' }),
      listNodes: () => []
    },
    leaseStore: {
      listActive: () => [],
      getLastSelectedNodeId: () => ''
    }
  });
  assert.equal(empty.error, 'no_available_proxy_node');
});

test('ZCode target resolver 与节点存储不依赖 Mihomo 运行时模块', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const resolverSource = fs.readFileSync(path.join(root, 'lib/server/zcode-egress-resolver.js'), 'utf8');
  const storeSource = fs.readFileSync(
    path.join(root, 'lib/cli/services/toolkit/proxy-pool/proxy-node-store.js'),
    'utf8'
  );

  assert.doesNotMatch(resolverSource, /mihomo|ProxyPoolService|startDedicatedPort/i);
  assert.doesNotMatch(storeSource, /mihomo-config-compiler/);
});
