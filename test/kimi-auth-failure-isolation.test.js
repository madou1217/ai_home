'use strict';

// 覆盖原始投诉「kimi 401 阻塞其他账号」(gap-tracker §一 #5 / §6.2 B13)。
//
// 该条此前引用 provider-fallback-routing.test.js 作为证据，但那个用例的 fixture 里
// 只有一个 kimi 账号，验的是「kimi 不可用时跨 provider 回退到 agy」——并没有验
// 同为 kimi 的第二个账号是否仍可调度，而后者才是投诉本身。这里补上。

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAccountRuntime } = require('../lib/server/account-runtime-state');
const { markProxyAccountFailure, chooseServerAccount } = require('../lib/server/router');
const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');

function kimiAccount(id) {
  return normalizeAccountRuntime({
    id,
    provider: 'kimi',
    apiKeyMode: false,
    authType: 'oauth',
    schedulableStatus: 'schedulable'
  });
}

/** 按上游 401 的真实策略打标，避免测试自己编一套与线上不同的冷却参数。 */
function applyUpstreamAuthFailure(account) {
  const policy = classifyUpstreamFailure({
    provider: 'kimi',
    statusCode: 401,
    body: '{"error":{"message":"invalid access token"}}',
    detail: `upstream_401_account_${account.id}`,
    account
  });
  assert.equal(policy.kind, 'auth_invalid');
  assert.equal(policy.scope, 'account', '401 必须是账号级，不能是 provider 级');
  assert.equal(policy.shouldRetryAnotherAccount, true, '401 后必须允许换号重试');
  markProxyAccountFailure(account, policy.failureReason, policy.cooldownMs, policy.failureThreshold, {
    scope: policy.scope
  });
  return policy;
}

test('kimi 401 只冷却该账号，同池另一个 kimi 账号仍可调度', () => {
  const failed = kimiAccount('kimi-1');
  const healthy = kimiAccount('kimi-2');
  applyUpstreamAuthFailure(failed);

  assert.ok(failed.cooldownUntil > Date.now(), '失败账号应进入账号级冷却');
  assert.equal(healthy.cooldownUntil, 0, '同池其他账号不得被牵连');
  assert.equal(healthy.consecutiveFailures, 0);

  const picked = chooseServerAccount([failed, healthy], {}, 'kimi', { provider: 'kimi', model: 'kimi-k2' });
  assert.equal(picked && picked.id, 'kimi-2', '选号必须跳过 401 账号并落到健康账号');
});

test('两个 kimi 账号都 401 后才整体不可用，且不误伤其他 provider', () => {
  const first = kimiAccount('kimi-1');
  const second = kimiAccount('kimi-2');
  applyUpstreamAuthFailure(first);
  applyUpstreamAuthFailure(second);

  assert.equal(
    chooseServerAccount([first, second], {}, 'kimi', { provider: 'kimi', model: 'kimi-k2' }),
    null,
    '全部账号 401 时才应无可用账号'
  );

  const agy = normalizeAccountRuntime({
    id: 'agy-1', provider: 'agy', apiKeyMode: false, schedulableStatus: 'schedulable'
  });
  const picked = chooseServerAccount([agy], {}, 'agy', { provider: 'agy', model: 'gemini-3.5-flash-low' });
  assert.equal(picked && picked.id, 'agy-1', 'kimi 的认证失败不得影响其他 provider 的池子');
});

test('401 冷却是账号级硬冷却，allowModelCooled 不能把它拉回轮转', () => {
  const failed = kimiAccount('kimi-1');
  applyUpstreamAuthFailure(failed);

  // allowModelCooled 是给 429 之类的模型级软冷却兜底的，认证失效必须留在轮转之外，
  // 否则会对着一个已知无效的凭据反复打上游。
  const picked = chooseServerAccount([failed], {}, 'kimi', {
    provider: 'kimi',
    model: 'kimi-k2',
    allowModelCooled: true
  });
  assert.equal(picked, null);
});
