'use strict';

// G5：已划给 Go 的路由回落到 Node 时的按原因计数（/readyz 暴露）。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NODE_FALLBACK_REASONS,
  createNodeFallbackCounters
} = require('../lib/server/go-core-node-fallback-counters');

test('an idle counter reports every registered reason at zero', () => {
  const snapshot = createNodeFallbackCounters().snapshot();
  assert.equal(snapshot.total, 0);
  assert.deepEqual(Object.keys(snapshot.by_reason).sort(), [...NODE_FALLBACK_REASONS].sort());
  for (const reason of NODE_FALLBACK_REASONS) {
    assert.equal(snapshot.by_reason[reason], 0, reason);
  }
});

test('counts accumulate per reason and in total', () => {
  const counters = createNodeFallbackCounters();
  counters.record('model_not_routable');
  counters.record('model_not_routable');
  counters.record('decode_rejected');

  const snapshot = counters.snapshot();
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.by_reason.model_not_routable, 2);
  assert.equal(snapshot.by_reason.decode_rejected, 1);
  assert.equal(snapshot.by_reason.model_alias, 0);
});

test('an unregistered reason is still counted instead of being silently dropped', () => {
  // 判定模块新增原因、计数模块还没登记时，运维必须立刻看得见，而不是看到一份全 0 的表。
  const counters = createNodeFallbackCounters();
  counters.record('brand_new_reason');
  const snapshot = counters.snapshot();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.by_reason.brand_new_reason, 1);
});

test('a blank reason is bucketed as unknown rather than creating an empty key', () => {
  const counters = createNodeFallbackCounters();
  counters.record('');
  counters.record(undefined);
  const snapshot = counters.snapshot();
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.by_reason.unknown, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.by_reason, ''), false);
});

test('the registered reason list has no duplicates', () => {
  assert.equal(new Set(NODE_FALLBACK_REASONS).size, NODE_FALLBACK_REASONS.length);
});
