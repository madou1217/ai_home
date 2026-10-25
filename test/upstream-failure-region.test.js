'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');

for (const provider of ['codex', 'claude']) {
  test(`${provider} HTTP 451 is a region policy block`, () => {
    const policy = classifyUpstreamFailure({
      provider,
      statusCode: 451,
      body: JSON.stringify({ error: { type: 'legal_restriction' } })
    });

    assert.equal(policy.kind, 'location_unsupported');
    assert.equal(policy.scope, 'account');
    assert.equal(policy.egressRegionDenied, true);
    assert.equal(policy.regionSignature, 'http_451');
  });

  test(`${provider} ordinary HTTP 403 is an account credential rejection`, () => {
    const policy = classifyUpstreamFailure({
      provider,
      statusCode: 403,
      body: provider === 'claude'
        ? JSON.stringify({ type: 'error', error: { type: 'permission_error' } })
        : JSON.stringify({ error: { type: 'forbidden' } })
    });

    assert.equal(policy.kind, 'auth_invalid');
    assert.equal(policy.scope, 'account');
    assert.equal(policy.shouldMarkFailure, true);
  });
}
