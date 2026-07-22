'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listProviderIds } = require('../lib/provider-catalog');

/**
 * Mirror of web/src/pages/Accounts.tsx PROVIDER_AUTH_OPTIONS keys.
 * Keep in sync: every catalog provider must have auth modes so the add-account
 * modal never does undefined.map(...) when a provider is selected.
 */
const PROVIDER_AUTH_OPTIONS = {
  codex: ['oauth-browser', 'oauth-device', 'api-key'],
  claude: ['oauth-browser', 'api-key', 'auth-token'],
  gemini: ['oauth-browser', 'api-key'],
  agy: ['oauth-browser'],
  opencode: ['oauth-browser'],
  grok: ['api-key', 'oauth-browser'],
  qoder: ['oauth-browser', 'api-key'],
  qodercn: ['oauth-browser', 'api-key'],
  kimi: ['api-key', 'oauth-browser'],
  kiro: ['oauth-browser']
};

function resolveProviderAuthOptions(provider) {
  return PROVIDER_AUTH_OPTIONS[provider] || [];
}

test('every catalog provider has non-empty auth options (Accounts add modal)', () => {
  const catalogIds = listProviderIds();
  assert.ok(catalogIds.includes('qoder'));
  assert.ok(catalogIds.includes('qodercn'));

  const missing = [];
  for (const id of catalogIds) {
    const modes = resolveProviderAuthOptions(id);
    if (!Array.isArray(modes) || modes.length === 0) missing.push(id);
  }
  assert.deepEqual(missing, [], `missing PROVIDER_AUTH_OPTIONS for: ${missing.join(', ')}`);
});

test('selecting qoder/qodercn never yields undefined for .map', () => {
  for (const provider of ['qoder', 'qodercn']) {
    const options = resolveProviderAuthOptions(provider);
    assert.equal(Array.isArray(options), true);
    // This is the exact pattern that crashed in Accounts.tsx:
    // PROVIDER_AUTH_OPTIONS[selectedProvider].map(...)
    assert.doesNotThrow(() => options.map((mode) => mode));
    assert.ok(options.includes('oauth-browser'));
  }
});

test('Type Provider union and catalog stay aligned for new providers', () => {
  // If catalog gains a provider without auth options, the WebUI add form will
  // crash. This test is the CI guard until auth options are generated from a
  // shared registry.
  const catalogIds = new Set(listProviderIds());
  const optionIds = new Set(Object.keys(PROVIDER_AUTH_OPTIONS));
  for (const id of catalogIds) {
    assert.ok(optionIds.has(id), `catalog provider "${id}" missing from PROVIDER_AUTH_OPTIONS mirror`);
  }
});
