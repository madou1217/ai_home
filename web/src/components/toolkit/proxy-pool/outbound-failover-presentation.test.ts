import assert from 'node:assert/strict';
import test from 'node:test';

import { describeFailoverCheck, describeFailoverEvent, formatFailoverTime } from './outbound-failover-presentation';

const event = {
  at: 0,
  reason: 'unreachable',
  failures: 3,
  from: { nodeId: 'a', name: 'JP08' },
  to: { nodeId: 'b', name: 'JP09', latencyMs: 13 },
  applied: true
};

test('最近一次检测按结果给出说明与色调', () => {
  assert.deepEqual(describeFailoverCheck(null), { text: '尚未检测', tone: 'default' });
  assert.equal(describeFailoverCheck({ at: 0, action: 'healthy', latencyMs: 12 }).tone, 'success');
  assert.match(describeFailoverCheck({ at: 0, action: 'degraded', failures: 2 }).text, /连续 2 次/);
  assert.match(describeFailoverCheck({ at: 0, action: 'switched', event }).text, /JP08 → JP09/);
  assert.equal(describeFailoverCheck({ at: 0, action: 'no_candidate' }).tone, 'error');
  assert.equal(describeFailoverCheck({ at: 0, action: 'skipped', reason: 'core_not_running' }).text, '内核未运行，未检测');
  assert.match(describeFailoverCheck({ at: 0, action: 'skipped', reason: 'weird' }).text, /weird/);
});

test('切换记录与时间格式', () => {
  assert.equal(describeFailoverEvent(event), 'JP08 → JP09（13 ms，连续不通）');
  assert.equal(describeFailoverEvent({ ...event, reason: 'node_missing' }), 'JP08 → JP09（13 ms，节点已被删除）');
  assert.equal(formatFailoverTime(1_000, 31_000), '30 秒前');
  assert.equal(formatFailoverTime(0, 600_000), '10 分钟前');
});
