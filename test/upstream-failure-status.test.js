'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');

test('custom Codex relay keeps remote pool exhaustion out of local account health', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    account: {
      provider: 'codex',
      apiKeyMode: true,
      openaiBaseUrl: 'http://54.178.88.80:9527/v1'
    },
    statusCode: 503,
    headers: new Map([['retry-after', '60']]),
    body: JSON.stringify({
      error: {
        code: 'no_available_account',
        message: 'No available Codex account'
      }
    })
  });
  assert.equal(policy.kind, 'remote_pool_unavailable');
  assert.equal(policy.failureReason, 'remote_pool_unavailable');
  assert.equal(policy.shouldMarkFailure, false);
  assert.equal(policy.shouldRetryAnotherAccount, false);
  assert.equal(policy.scope, 'none');
  assert.equal(policy.retryHintMs, 60_000);
});

test('official Codex endpoint does not use remote pool exhaustion semantics', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    account: {
      provider: 'codex',
      apiKeyMode: true,
      openaiBaseUrl: 'https://api.openai.com/v1'
    },
    statusCode: 503,
    body: JSON.stringify({ error: { code: 'no_available_account' } })
  });
  assert.notEqual(policy.kind, 'remote_pool_unavailable');
  assert.equal(policy.shouldMarkFailure, true);
});

for (const provider of ['codex', 'claude']) {
  test(`${provider} deactivated_workspace requires HTTP 402`, () => {
    const detail = JSON.stringify({ error: { code: 'deactivated_workspace' } });
    for (const statusCode of [200, 400, 401, 403, 500]) {
      const policy = classifyUpstreamFailure({ provider, statusCode, body: detail });
      assert.notEqual(policy.failureReason, 'deactivated_workspace', `status ${statusCode}`);
    }

    const policy = classifyUpstreamFailure({ provider, statusCode: 402, body: detail });
    assert.equal(policy.failureReason, 'deactivated_workspace');
    assert.equal(policy.scope, 'account');
  });

  test(`${provider} ordinary HTTP 402 is request scoped`, () => {
    const policy = classifyUpstreamFailure({
      provider,
      statusCode: 402,
      body: JSON.stringify({ error: { code: 'insufficient_credits' } })
    });
    assert.equal(policy.kind, 'payment_required');
    assert.equal(policy.shouldMarkFailure, false);
    assert.equal(policy.shouldRetryAnotherAccount, false);
    assert.equal(policy.cooldownMs, 0);
    assert.equal(policy.scope, 'none');
    assert.equal(policy.shouldPassthroughToClient, true);
  });
}
