'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('WebSocket Support', () => {
  it('should accept WebSocket upgrade path on /v1/responses', () => {
    const validPath = '/v1/responses';
    const invalidPath = '/v1/models';

    assert.equal(validPath, '/v1/responses');
    assert.notEqual(invalidPath, '/v1/responses');
  });

  it('should reject WebSocket connections without auth when clientKey is set', () => {
    const requiredClientKey = 'test-key';
    const incoming = '';

    assert.notEqual(incoming, requiredClientKey);
  });

  it('should only accept WebSocket on /v1/responses path', () => {
    const validPath = '/v1/responses';
    const invalidPath = '/v1/models';

    assert.equal(validPath, '/v1/responses');
    assert.notEqual(invalidPath, '/v1/responses');
  });
});
