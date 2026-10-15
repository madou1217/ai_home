'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GATEWAY_RUNTIME_SCOPE,
  isGatewayRuntimeScope,
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

test('gateway runtime scope accepts the provider-suffixed form and rejects account refs', () => {
  // 会话列（execution_account_ref）里存的就是这个字符串：裸 scope 与 gateway:<provider>
  // 都算网关作用域；真实 accountRef 绝不能被误判成作用域。
  assert.equal(isGatewayRuntimeScope('gateway'), true);
  assert.equal(isGatewayRuntimeScope('gateway:opencode'), true);
  assert.equal(isGatewayRuntimeScope(' GATEWAY:Codex '), true);
  assert.equal(isGatewayRuntimeScope('acct_11111111111111111111'), false);
  assert.equal(isGatewayRuntimeScope('gateway:'), false);
  assert.equal(isGatewayRuntimeScope('gatewayopencode'), false);
  assert.equal(isGatewayRuntimeScope(''), false);
  assert.equal(isGatewayRuntimeScope(undefined), false);
});

test('gateway scope strings resolve to a colon-free per-provider runtime scope', () => {
  // 冒号在 tmux 会话名与文件名里非法，必须压成 '-'；provider 后缀要保留，
  // 否则两个 provider 的网关会话会共用同一个常驻 app-server。
  assert.deepEqual(resolveRuntimeTarget({ accountRef: 'gateway:opencode' }), {
    gateway: true, accountRef: '', runtimeScope: 'gateway-opencode',
  });
  assert.deepEqual(resolveRuntimeTarget({ accountRef: 'gateway' }), {
    gateway: true, accountRef: '', runtimeScope: 'gateway',
  });
  assert.deepEqual(serializeRuntimeTarget(resolveRuntimeTarget({ accountRef: 'gateway:codex' })), { gateway: true });
});
