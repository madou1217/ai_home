'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createImageGenerationStrategyRegistry
} = require('../lib/server/image-generation-strategy-registry');

function fakeStrategy(provider, options = {}) {
  return {
    provider,
    kind: options.kind || 'native',
    supportsModel() {
      return true;
    },
    async generate() {
      return { images: [{ b64_json: 'x' }] };
    }
  };
}

test('registry resolves by provider for OAuth accounts', () => {
  const registry = createImageGenerationStrategyRegistry({
    agy: fakeStrategy('agy'),
    codex: fakeStrategy('codex')
  });
  assert.equal(registry.resolve('agy', { accountRef: 'acct_a' }).provider, 'agy');
  assert.equal(registry.resolve('codex', { accountRef: 'acct_c' }).provider, 'codex');
  assert.equal(registry.resolve('AGY', { accountRef: 'acct_a' }).provider, 'agy');
});

test('registry routes api-key accounts to passthrough regardless of provider', () => {
  const registry = createImageGenerationStrategyRegistry({
    agy: fakeStrategy('agy'),
    passthrough: fakeStrategy('passthrough', { kind: 'passthrough' })
  });
  const apiKeyAccount = { accountRef: 'acct_k', apiKeyMode: true, accessToken: 'sk-x' };
  assert.equal(registry.resolve('agy', apiKeyAccount).provider, 'passthrough');
  const authTypeAccount = { accountRef: 'acct_t', authType: 'api-key' };
  assert.equal(registry.resolve('codex', authTypeAccount).provider, 'passthrough');
});

test('registry returns null for unknown providers and OAuth accounts', () => {
  const registry = createImageGenerationStrategyRegistry({
    agy: fakeStrategy('agy')
  });
  assert.equal(registry.resolve('claude', { accountRef: 'acct_c' }), null);
  assert.equal(registry.resolve('', { accountRef: 'acct_x' }), null);
});

test('registry ignores non-strategy entries and reports providers', () => {
  const registry = createImageGenerationStrategyRegistry({
    agy: fakeStrategy('agy'),
    broken: { provider: 'broken' }
  });
  assert.deepEqual(registry.providers().sort(), ['agy']);
  assert.equal(registry.has('agy'), true);
  assert.equal(registry.has('broken'), false);
});

test('api-key detection handles apiKeyMode and authType forms', () => {
  const { __private: { isApiKeyAccount } } = require('../lib/server/image-generation-strategy-registry');
  assert.equal(isApiKeyAccount({ apiKeyMode: true }), true);
  assert.equal(isApiKeyAccount({ authType: 'api-key' }), true);
  assert.equal(isApiKeyAccount({ apiKeyMode: false }), false);
  assert.equal(isApiKeyAccount({}), false);
  assert.equal(isApiKeyAccount(null), false);
});