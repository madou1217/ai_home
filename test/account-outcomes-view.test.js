'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAccountOutcomesView, DAY_COUNT, HOUR_COUNT } = require('../lib/server/account-outcomes-view');

test('account outcomes view maps Go refs back to every linked Node account', () => {
  const nowMs = new Date(2026, 8, 28, 17, 45).getTime();
  const today = new Date(2026, 8, 28).getTime();
  const thisHour = new Date(2026, 8, 28, 17).getTime();
  const view = buildAccountOutcomesView({
    nowMs,
    dayRows: [
      { account_ref: 'acct_go_relay', bucket_start_ms: today, outcome: 'success', count: 5 },
      { account_ref: 'acct_go_relay', bucket_start_ms: today, outcome: 'quota_exhausted', count: 2 },
      { account_ref: 'acct_go_relay', bucket_start_ms: today - 200 * 86400000, outcome: 'success', count: 9 },
      { account_ref: 'acct_go_oauth', bucket_start_ms: today, outcome: 'success', count: 1 }
    ],
    hourRows: [
      { account_ref: 'acct_go_relay', bucket_start_ms: thisHour, outcome: 'rate_limited', count: 1 }
    ],
    nodeAccountRefs: ['acct_node_relay_a', 'acct_node_relay_b', 'acct_node_idle'],
    goAccountRefFor: (ref) => ({ acct_node_relay_a: 'acct_go_relay', acct_node_relay_b: 'acct_go_relay', acct_node_idle: 'acct_go_idle' })[ref]
  });
  assert.equal(view.dayStarts.length, DAY_COUNT);
  assert.equal(view.hourStarts.length, HOUR_COUNT);
  assert.equal(view.dayStarts[DAY_COUNT - 1], today, 'last day bucket is today (local midnight)');
  assert.equal(view.hourStarts[HOUR_COUNT - 1], thisHour);
  assert.deepEqual(view.accounts.map((account) => account.accountRef), ['acct_node_relay_a', 'acct_node_relay_b'],
    'merged Node accounts share the Go counts; accounts without data are omitted; unlinked Go refs are dropped');
test('account outcomes view merges Node-served traffic with the Go buckets', () => {
  const nowMs = new Date(2026, 8, 28, 17, 45).getTime();
  const today = new Date(2026, 8, 28).getTime();
  const thisHour = new Date(2026, 8, 28, 17).getTime();
  const view = buildAccountOutcomesView({
    nowMs,
    // Go 只记它自己承接的那部分流量。
    dayRows: [
      { account_ref: 'acct_go_relay', bucket_start_ms: today, outcome: 'success', count: 5 }
    ],
    hourRows: [
      { account_ref: 'acct_go_relay', bucket_start_ms: thisHour, outcome: 'success', count: 5 }
    ],
    // 交还 Node 期间的流量（自定义错误协议 / Go 重启窗口）由 Node 侧结果桶补上。
    nodeDayRows: [
      { account_ref: 'acct_node_relay', bucket_start_ms: today, outcome: 'success', count: 2 },
      { account_ref: 'acct_node_relay', bucket_start_ms: today, outcome: 'rate_limited', count: 1 },
      { account_ref: 'acct_node_unsynced', bucket_start_ms: today, outcome: 'success', count: 1 }
    ],
    nodeHourRows: [
      { account_ref: 'acct_node_relay', bucket_start_ms: thisHour, outcome: 'success', count: 2 }
    ],
    nodeAccountRefs: ['acct_node_relay', 'acct_node_unsynced', 'acct_node_idle'],
    goAccountRefFor: (ref) => ({ acct_node_relay: 'acct_go_relay', acct_node_unsynced: '', acct_node_idle: 'acct_go_idle' })[ref]
  });
  assert.deepEqual(view.accounts.map((account) => account.accountRef), ['acct_node_relay', 'acct_node_unsynced'],
    'Go and Node buckets merge for the linked account; a Node-only account still shows its own traffic');
  assert.deepEqual(view.accounts[0].days, [
    { startMs: today, success: 7, failures: { rate_limited: 1 } }
  ], 'success counts add up across both sources');
  assert.deepEqual(view.accounts[0].hours, [{ startMs: thisHour, success: 7, failures: {} }]);
  assert.deepEqual(view.accounts[1].days, [
    { startMs: today, success: 1, failures: {} }
  ], 'an account without a Go link keeps its Node-served buckets');
  assert.deepEqual(view.accounts[1].hours, [], 'hour buckets stay empty when Node served it in another hour');
});

  assert.deepEqual(view.accounts[0].days, [{ startMs: today, success: 5, failures: { quota_exhausted: 2 } }],
    'rows older than the 90-day window are ignored');
  assert.deepEqual(view.accounts[0].hours, [{ startMs: thisHour, success: 0, failures: { rate_limited: 1 } }]);
});
