import assert from 'node:assert/strict';
import test from 'node:test';

import type { ManagementAccountActivity } from '@/types';
import { isAccountConsuming, selectAccountDrops } from './usage-activity.ts';

const ACCOUNT = 'acct_0123456789abcdef0123';

function activity(inFlight: number): ManagementAccountActivity {
  return {
    provider: 'claude',
    accountRef: ACCOUNT,
    inFlight,
    rate: 0,
    lastActivityAt: 0,
    updatedAt: 0
  };
}

function drop(id: string, accountRef = ACCOUNT) {
  return {
    id,
    provider: 'claude',
    accountRef,
    deltaTokens: 900,
    deltaCostUsd: 0.01,
    occurredAt: 1
  };
}

test('a live request counts as consuming', () => {
  assert.equal(isAccountConsuming(activity(1), []), true);
});

test('a request short enough to fall between two polls still counts', () => {
  // inFlight 轮询 2s 一次；几百毫秒的请求两次轮询都抓不到，但消耗事件照样会到。
  // 只看 inFlight 的话，伤害数字飘出来了、进度条却从没烧过——燃烧就时有时无。
  assert.equal(isAccountConsuming(activity(0), [drop('a')]), true);
  assert.equal(isAccountConsuming(null, [drop('a')]), true);
});

test('an idle account with nothing dropping is not consuming', () => {
  assert.equal(isAccountConsuming(activity(0), []), false);
  assert.equal(isAccountConsuming(null, []), false);
});

test('another account dropping does not light this one up', () => {
  const drops = [drop('a', 'acct_ffffffffffffffffffff')];
  assert.deepEqual(selectAccountDrops(drops, ACCOUNT), []);
  assert.equal(isAccountConsuming(null, selectAccountDrops(drops, ACCOUNT)), false);
});

test('drops are selected by account', () => {
  const mine = drop('mine');
  const theirs = drop('theirs', 'acct_ffffffffffffffffffff');
  assert.deepEqual(selectAccountDrops([mine, theirs], ACCOUNT), [mine]);
  assert.deepEqual(selectAccountDrops(null, ACCOUNT), []);
  assert.deepEqual(selectAccountDrops([mine], ''), []);
});
