import assert from 'node:assert/strict';
import test from 'node:test';

import {
  failureKindLabel,
  filterNodes,
  formatAgo,
  formatDuration,
  nodeHealth,
  sortNodes,
  successRate
} from './egress-pool-presentation.ts';

function node(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    label: `🇺🇸 ${name}`,
    server: `${name}.example.com`,
    uses: 0,
    successes: 0,
    failures: 0,
    cooling: false,
    cooldownKind: '',
    cooldownRemainingMs: 0,
    lastFailureKind: '',
    lastUsedAt: 0,
    probe: null,
    ...extra
  } as never;
}

test('durations and relative times read naturally', () => {
  assert.equal(formatDuration(45_000), '45 秒');
  assert.equal(formatDuration(125_000), '2 分 05 秒');
  assert.equal(formatDuration(3_780_000), '1 小时 3 分');
  assert.equal(formatAgo(0, 1000), '从未');
  assert.equal(formatAgo(995_000, 1_000_000), '刚刚');
  assert.equal(formatAgo(1_000_000 - 3 * 60_000, 1_000_000), '3 分钟前');
});

test('health status prefers cooldown, then probe failure, then the active marker', () => {
  assert.deepEqual(nodeHealth(node('node-0', { cooling: true, cooldownKind: 'free_limit' }), 'node-0'), {
    tone: 'warning', label: '冷却 · 额度受限'
  });
  assert.equal(nodeHealth(node('node-1', { probe: { ok: false, latencyMs: 0 } }), 'node-0').tone, 'danger');
  assert.equal(nodeHealth(node('node-0'), 'node-0').label, '当前出口');
  assert.equal(nodeHealth(node('node-2', { probe: { ok: true, latencyMs: 80 } }), 'node-0').label, '可用');
  assert.equal(nodeHealth(node('node-3'), 'node-0').label, '未探测');
  assert.equal(failureKindLabel('gate'), '免费档门禁');
});

test('success rate is null without requests', () => {
  assert.equal(successRate({ uses: 0, successes: 0 }), null);
  assert.equal(successRate({ uses: 4, successes: 3 }), 75);
});

test('filter and sort put the active exit first and the soonest-thawing cooldown next', () => {
  const nodes = [
    node('node-0', { lastUsedAt: 10 }),
    node('node-1', { cooling: true, cooldownRemainingMs: 90_000 }),
    node('node-2', { cooling: true, cooldownRemainingMs: 30_000 }),
    node('node-3', { uses: 2, successes: 2, lastUsedAt: 50 })
  ];
  assert.deepEqual(sortNodes(nodes, 'node-3').map((n: { name: string }) => n.name), ['node-3', 'node-2', 'node-1', 'node-0']);
  assert.deepEqual(filterNodes(nodes, 'cooling', '').map((n: { name: string }) => n.name), ['node-1', 'node-2']);
  assert.deepEqual(filterNodes(nodes, 'used', '').map((n: { name: string }) => n.name), ['node-3']);
  assert.deepEqual(filterNodes(nodes, 'all', 'node-2.example').map((n: { name: string }) => n.name), ['node-2']);
});
