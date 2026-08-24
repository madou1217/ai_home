'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRATEGY_LOWEST_LATENCY,
  STRATEGY_RANDOM,
  STRATEGY_ROUND_ROBIN,
  STRATEGY_STICKY,
  selectZcodeEgressNode
} = require('../lib/server/zcode-egress-scheduler');

function node(id, latencyMs) {
  return { id, name: id, latencyMs };
}

test('最低延迟策略排除不可用节点和其他运行实例已租用节点', () => {
  const result = selectZcodeEgressNode({
    ownerId: 'desktop:account-b',
    group: { id: 'group-a', strategy: STRATEGY_LOWEST_LATENCY },
    nodes: [node('a-1', 20), node('a-2', 10), node('a-3', -1)],
    leases: [{ ownerId: 'desktop:account-a', nodeId: 'a-2' }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'a-1');
  assert.equal(result.reused, false);
  assert.equal(result.sticky, false);
});

test('已有实例在节点仍健康时保持 sticky，不因更低延迟节点出现而漂移', () => {
  const result = selectZcodeEgressNode({
    ownerId: 'desktop:account-a',
    currentNodeId: 'a-2',
    group: { id: 'group-a', strategy: STRATEGY_LOWEST_LATENCY },
    nodes: [node('a-1', 5), node('a-2', 30)],
    leases: [{ ownerId: 'desktop:account-a', nodeId: 'a-2' }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'a-2');
  assert.equal(result.sticky, true);
});

test('sticky 节点失败后按 failoverStrategy 切到剩余最低延迟节点', () => {
  const result = selectZcodeEgressNode({
    ownerId: 'desktop:account-a',
    currentNodeId: 'a-2',
    failedNodeIds: ['a-2'],
    group: {
      id: 'group-a',
      strategy: STRATEGY_ROUND_ROBIN,
      failoverStrategy: STRATEGY_LOWEST_LATENCY
    },
    nodes: [node('a-1', 40), node('a-2', 10), node('a-3', 18)],
    leases: [{ ownerId: 'desktop:account-a', nodeId: 'a-2' }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'a-3');
  assert.equal(result.strategy, STRATEGY_LOWEST_LATENCY);
  assert.equal(result.failover, true);
});

test('轮询策略从上次命中节点的下一个可用节点继续', () => {
  const result = selectZcodeEgressNode({
    ownerId: 'desktop:account-c',
    lastSelectedNodeId: 'a-2',
    group: { id: 'group-a', strategy: STRATEGY_ROUND_ROBIN },
    nodes: [node('a-1', 30), node('a-2', 20), node('a-3', 10)],
    leases: []
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'a-3');
  assert.equal(result.strategy, STRATEGY_ROUND_ROBIN);
});

test('轮询故障切换在当前节点被排除后仍保留原环位置', () => {
  const result = selectZcodeEgressNode({
    ownerId: 'desktop:account-a',
    currentNodeId: 'a-2',
    failedNodeIds: ['a-2'],
    lastSelectedNodeId: 'a-2',
    group: {
      id: 'group-a',
      strategy: STRATEGY_ROUND_ROBIN,
      failoverStrategy: STRATEGY_ROUND_ROBIN
    },
    nodes: [node('a-1', 30), node('a-2', 20), node('a-3', 10)],
    leases: []
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'a-3');
  assert.equal(result.strategy, STRATEGY_ROUND_ROBIN);
  assert.equal(result.failover, true);
});

test('随机策略使用可注入随机源，便于稳定验证', () => {
  const result = selectZcodeEgressNode({
    ownerId: 'desktop:account-c',
    group: { id: 'group-a', strategy: STRATEGY_RANDOM },
    nodes: [node('a-1', 30), node('a-2', 20), node('a-3', 10)],
    leases: [],
    random: () => 0.5
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'a-2');
  assert.equal(result.strategy, STRATEGY_RANDOM);
});

test('存在已知健康节点时轮询不让未知延迟节点抢占，全部未知时仍允许冷启动', () => {
  const preferred = selectZcodeEgressNode({
    ownerId: 'desktop:account-c',
    lastSelectedNodeId: 'healthy',
    group: { id: 'group-a', strategy: STRATEGY_ROUND_ROBIN },
    nodes: [node('unknown', null), node('healthy', 30)],
    leases: []
  });
  assert.equal(preferred.nodeId, 'healthy');

  const coldStart = selectZcodeEgressNode({
    ownerId: 'desktop:account-c',
    group: { id: 'group-a', strategy: STRATEGY_LOWEST_LATENCY },
    nodes: [node('unknown-b', null), node('unknown-a', undefined)],
    leases: []
  });
  assert.equal(coldStart.ok, true);
  assert.equal(coldStart.nodeId, 'unknown-a');
});

test('sticky 策略优先恢复该组上次健康节点，缺失时回退最低延迟', () => {
  const restored = selectZcodeEgressNode({
    ownerId: 'desktop:account-c',
    lastSelectedNodeId: 'a-1',
    group: { id: 'group-a', strategy: STRATEGY_STICKY },
    nodes: [node('a-1', 30), node('a-2', 10)],
    leases: []
  });
  assert.equal(restored.nodeId, 'a-1');
  assert.equal(restored.strategy, STRATEGY_STICKY);

  const fallback = selectZcodeEgressNode({
    ownerId: 'desktop:account-c',
    lastSelectedNodeId: 'missing',
    group: { id: 'group-a', strategy: STRATEGY_STICKY },
    nodes: [node('a-1', 30), node('a-2', 10)],
    leases: []
  });
  assert.equal(fallback.nodeId, 'a-2');
});

test('所有健康节点都被其它实例占用时允许受控复用并显式标记', () => {
  const result = selectZcodeEgressNode({
    ownerId: 'desktop:account-c',
    group: { id: 'group-a', strategy: STRATEGY_LOWEST_LATENCY },
    nodes: [node('a-1', 30), node('a-2', 10)],
    leases: [
      { ownerId: 'desktop:account-a', nodeId: 'a-1' },
      { ownerId: 'desktop:account-b', nodeId: 'a-2' }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'a-2');
  assert.equal(result.reused, true);
});

test('没有健康节点时如实失败，不返回已知不可用节点', () => {
  const result = selectZcodeEgressNode({
    ownerId: 'desktop:account-a',
    group: { id: 'group-a', strategy: STRATEGY_LOWEST_LATENCY },
    nodes: [node('a-1', -1), node('a-2', -1)],
    leases: []
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'no_available_proxy_node',
    groupId: 'group-a'
  });
});
