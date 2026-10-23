import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_MODEL_CATALOG_CHANGED_EVENT,
  notifyAccountModelCatalogChanged,
  onAccountModelCatalogChanged,
  setAccountModelCatalogEventTarget
} from './account-model-catalog-events';

// bun test 没有 DOM：用真实 EventTarget 当总线替身，行为与浏览器 window 一致。
function withBus(): EventTarget {
  const bus = new EventTarget();
  setAccountModelCatalogEventTarget(bus);
  return bus;
}

// 2026-10-23 用户反馈「手动新增的模型 chat 里不显示」：chat 按账号缓存模型列表，
// 账号模型页增删改后没有任何通知，切回 chat 时缓存不失效、列表停在旧值。
test('a catalog change notifies subscribers with the affected account ref', () => {
  withBus();
  const seen: string[] = [];
  const off = onAccountModelCatalogChanged((ref) => seen.push(ref));

  notifyAccountModelCatalogChanged('acct_0123456789abcdefabcd');
  off();

  assert.deepEqual(seen, ['acct_0123456789abcdefabcd']);
});

test('an empty account ref means every account may have changed', () => {
  withBus();
  const seen: string[] = [];
  const off = onAccountModelCatalogChanged((ref) => seen.push(ref));

  notifyAccountModelCatalogChanged();

  off();
  assert.deepEqual(seen, ['']);
});

test('unsubscribing stops delivery', () => {
  withBus();
  let calls = 0;
  const off = onAccountModelCatalogChanged(() => { calls += 1; });

  notifyAccountModelCatalogChanged('acct_aaaaaaaaaaaaaaaaaaaa');
  off();
  notifyAccountModelCatalogChanged('acct_aaaaaaaaaaaaaaaaaaaa');

  assert.equal(calls, 1);
});

test('the event name is namespaced so it cannot collide with other window events', () => {
  assert.match(ACCOUNT_MODEL_CATALOG_CHANGED_EVENT, /^aih:/);
});
