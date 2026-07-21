'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createProviderDriverRegistration,
  ProviderSessionDriverRegistry,
  createProviderDriverRegistry
} = require('../lib/server/chat-runtime/provider-driver-registry');

test('registry resolves one provider entry from explicit session/runtime context', () => {
  const received = [];
  const registry = new ProviderSessionDriverRegistry();
  registry.register(createProviderDriverRegistration({
    provider: 'codex',
    createEntry(context) {
      received.push(context);
      return {
        provider: 'codex',
        driver: { startTurn: async () => ({}) },
        capabilities: { nativeEvents: true }
      };
    }
  }));
  const context = { session: { sessionId: 'session-1' }, runtime: { generation: 4 } };

  const entry = registry.resolve(' CODEX ', context);

  assert.equal(entry.provider, 'codex');
  assert.equal(typeof entry.driver.startTurn, 'function');
  assert.deepEqual(received, [context]);
  assert.equal(registry.resolve('claude', context), null);
});

test('registry factory composes only explicit provider registrations', () => {
  const registration = createProviderDriverRegistration({
    provider: 'claude',
    createEntry: () => ({
      provider: 'claude',
      driver: { startTurn: async () => ({}) }
    })
  });
  const registry = createProviderDriverRegistry([registration]);

  assert.equal(Object.isFrozen(registration), true);
  assert.equal(registry.resolve('codex'), null);
  assert.equal(registry.resolve('claude').provider, 'claude');
});
