'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  remotePoolKey,
  beforeRemotePoolAttempt,
  beginRemotePoolRecovery,
  completeRemotePoolRecovery,
  __private
} = require('../lib/server/remote-pool-recovery');

const account = {
  provider: 'codex',
  apiKeyMode: true,
  openaiBaseUrl: 'http://54.178.88.80:9527/v1'
};

test.afterEach(() => __private.resetRemotePoolRecoveryForTests());

test('remote pool key is limited to custom API-key upstreams', () => {
  assert.equal(remotePoolKey(account, 'gpt-6.1-sol'), 'http://54.178.88.80:9527/v1\u0000gpt-6.1-sol');
  assert.equal(remotePoolKey({ ...account, openaiBaseUrl: 'https://api.openai.com/v1' }, 'gpt-6.1-sol'), '');
  assert.equal(remotePoolKey({ ...account, apiKeyMode: false }, 'gpt-6.1-sol'), '');
  assert.equal(remotePoolKey(account, ''), '');
});

test('remote pool recovery is single-flight and bounded', () => {
  const key = remotePoolKey(account, 'gpt-6.1-sol');
  const owner = {};
  assert.deepEqual(beforeRemotePoolAttempt(key, 1_000, owner), { allowed: true, retryAfterMs: 0 });
  const leader = beginRemotePoolRecovery(key, 60_000, 1_000, owner);
  assert.equal(leader.leader, true);
  assert.equal(leader.waitMs, __private.MAX_RECOVERY_WAIT_MS);
  assert.equal(beforeRemotePoolAttempt(key, 1_001, {} ).allowed, false);
  // The request that owns the probe may perform its bounded retry.
  assert.equal(beforeRemotePoolAttempt(key, 1_001, owner).allowed, true);
  completeRemotePoolRecovery(key, { available: false, retryAfterMs: 60_000 }, 1_002);
  assert.equal(beforeRemotePoolAttempt(key, 1_003, owner).allowed, false);
  completeRemotePoolRecovery(key, { available: true }, 1_004);
  assert.equal(beforeRemotePoolAttempt(key, 1_005, owner).allowed, true);
});
