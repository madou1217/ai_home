'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProviderSessionCorrelationRegistry
} = require('../lib/server/provider-session-correlation-registry');

test('provider session correlation registry binds exact CLI launches to sessions', () => {
  let now = 100;
  const registry = createProviderSessionCorrelationRegistry({ ttlMs: 1000, now: () => now });
  assert.equal(registry.bind('run-1', {
    provider: 'Claude',
    sessionId: 'session-1',
    projectPath: '/repo'
  }), true);
  assert.deepEqual(registry.resolve('run-1'), {
    provider: 'claude',
    sessionId: 'session-1',
    projectDirName: '',
    projectPath: '/repo'
  });

  now = 1200;
  assert.equal(registry.resolve('run-1'), null);
});
