'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');

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
}
