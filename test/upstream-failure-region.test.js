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
}
