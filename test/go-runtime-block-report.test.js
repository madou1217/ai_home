'use strict';

// Node 的 runtime_state → Go runtime-block 上报口径。
// 只映射 Go 认识的 FailureKind；缺时间/未知类型时不产生上报。

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveRuntimeBlockReport } = require('../lib/server/go-runtime-block-report');

test('auth_invalid maps to reauthentication_required', () => {
  const report = deriveRuntimeBlockReport('acct_aaaaaaaaaaaaaaaaaaaa', {
    lastFailureKind: 'auth_invalid',
    lastFailureAt: 1000,
    authInvalidUntil: 31000,
    lastFailureReason: 'token expired'
  });
  assert.deepEqual(report, {
    accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa',
    kind: 'reauthentication_required',
    scope: 'account',
    reason: 'token expired',
    observed_at: '1000',
    until: '31000'
  });
});

test('routingBlock kinds are reported with their own until', () => {
  const report = deriveRuntimeBlockReport('acct_aaaaaaaaaaaaaaaaaaaa', {
    routingBlock: { kind: 'permission_denied', reason: 'region', observedAt: 1000, until: 31000 },
    lastFailureAt: 1000
  });
  assert.equal(report.kind, 'permission_denied');
  assert.equal(report.until, '31000');
});

test('rate_limited uses rateLimitUntil before cooldownUntil', () => {
  const report = deriveRuntimeBlockReport('acct_aaaaaaaaaaaaaaaaaaaa', {
    lastFailureKind: 'rate_limited',
    lastFailureAt: 1000,
    rateLimitUntil: 2000,
    cooldownUntil: 3000
  });
  assert.equal(report.kind, 'rate_limited');
  assert.equal(report.until, '2000');
});

test('unmapped or incomplete states produce no report', () => {
  assert.equal(deriveRuntimeBlockReport('acct_aaaaaaaaaaaaaaaaaaaa', { lastFailureKind: 'timeout', lastFailureAt: 1000, cooldownUntil: 2000 }), null);
  assert.equal(deriveRuntimeBlockReport('acct_aaaaaaaaaaaaaaaaaaaa', { lastFailureKind: 'auth_invalid' }), null);
  assert.equal(deriveRuntimeBlockReport('acct_aaaaaaaaaaaaaaaaaaaa', { lastFailureKind: 'auth_invalid', lastFailureAt: 1000, authInvalidUntil: 1000 }), null);
  assert.equal(deriveRuntimeBlockReport('', { lastFailureKind: 'auth_invalid', lastFailureAt: 1, authInvalidUntil: 2 }), null);
});
