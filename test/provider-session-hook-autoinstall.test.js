'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listProviderDefinitions } = require('../lib/provider-catalog');
const {
  resolveInstallProviders,
  SUPPORTED_PROVIDERS
} = require('../lib/server/provider-session-hook-autoinstall');

test('session hook installable providers come from the provider contract', () => {
  const contractProviders = listProviderDefinitions()
    .filter((definition) => definition.sessionSync
      && definition.sessionSync.mode === 'hook'
      && definition.sessionSync.adapter)
    .map((definition) => definition.id)
    .sort();

  assert.deepEqual([...SUPPORTED_PROVIDERS].sort(), contractProviders);
  assert.deepEqual(resolveInstallProviders({
    accounts: Object.fromEntries(listProviderDefinitions().map((definition) => [definition.id, [{}]]))
  }).sort(), contractProviders);
});
