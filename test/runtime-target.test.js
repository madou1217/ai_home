'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GATEWAY_RUNTIME_SCOPE,
  resolveRuntimeTarget,
  serializeRuntimeTarget
} = require('../lib/account/runtime-target');

test('runtime target keeps accountRef only for registered account targets', () => {
  const accountRef = 'acct_11111111111111111111';
  const target = resolveRuntimeTarget({ accountRef });

  assert.deepEqual(target, {
    gateway: false,
    accountRef,
    runtimeScope: accountRef
  });
  assert.deepEqual(serializeRuntimeTarget(target), { accountRef });
  assert.equal(resolveRuntimeTarget({ accountRef: '7' }), null);
});

test('gateway runtime target uses an explicit scope without a synthetic accountRef', () => {
  const target = resolveRuntimeTarget({ gateway: true });

  assert.equal(target.runtimeScope, GATEWAY_RUNTIME_SCOPE);
  assert.equal(target.accountRef, '');
  assert.deepEqual(serializeRuntimeTarget(target), { gateway: true });
});
