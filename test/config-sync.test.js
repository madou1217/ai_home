'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AIH_CODEX_PROVIDER_BASE_URL,
  extractAccountOnlyConfig,
  filterHostConfig,
  getAihProviderKey,
  mergeConfigs
} = require('../lib/cli/services/pty/codex-config-sync');

test('filterHostConfig excludes bearer_token from model_providers section', () => {
  const hostConfig = `
[model_providers.aih]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
bearer_token = "dummy"
wire_api = "responses"
`;

  const filtered = filterHostConfig(hostConfig, {
    excludeAccountOnly: false,
    excludeSensitive: true
  });

  assert.ok(!filtered.includes('bearer_token'));
  assert.ok(filtered.includes('name = "aih codex"'));
  assert.ok(filtered.includes('base_url = "http://127.0.0.1:8317/v1"'));
  assert.ok(filtered.includes('wire_api = "responses"'));
});

test('filterHostConfig excludes preferred_auth_method and model_provider', () => {
  const hostConfig = `
preferred_auth_method = "apikey"
model_provider = "aih"
model = "gpt-5.4"
`;

  const filtered = filterHostConfig(hostConfig, {
    excludeAccountOnly: true,
    excludeSensitive: false
  });

  assert.ok(!filtered.includes('preferred_auth_method'));
  assert.ok(!filtered.includes('model_provider'));
  assert.ok(filtered.includes('model = "gpt-5.4"'));
});

test('extractAccountOnlyConfig preserves model_providers sections', () => {
  const providerKey = getAihProviderKey('10');
  const accountConfig = `
preferred_auth_method = "apikey"
model_provider = "${providerKey}"
model = "gpt-5.4"

[model_providers.${providerKey}]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
bearer_token = "dummy"
wire_api = "responses"

[[providers]]
name = "local"
base_url = "http://localhost:9000/v1"
`;

  const extracted = extractAccountOnlyConfig(accountConfig);

  assert.equal(extracted.preferred_auth_method, 'preferred_auth_method = "apikey"');
  assert.equal(extracted.model_provider, `model_provider = "${providerKey}"`);
  assert.equal(extracted.model_providers.length, 1);
  assert.match(extracted.model_providers[0], new RegExp(`\\[model_providers\\.${providerKey}\\]`));
  assert.match(extracted.model_providers[0], /bearer_token = "dummy"/);
  assert.equal(extracted.providers.length, 1);
});

test('mergeConfigs keeps account-managed aih provider block during host sync', () => {
  const providerKey = getAihProviderKey('10');
  const hostConfig = `
model = "gpt-5.4"

[model_providers.${providerKey}]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"

[features]
codex_hooks = true
`;
  const accountOnlyConfig = extractAccountOnlyConfig(`
preferred_auth_method = "apikey"
model_provider = "${providerKey}"

[model_providers.${providerKey}]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
bearer_token = "dummy"
wire_api = "responses"
`);

  const merged = mergeConfigs(hostConfig, accountOnlyConfig, '10', {
    isApiKeyMode: true,
    openaiApiKey: 'dummy'
  });

  const aihBlockMatches = merged.match(new RegExp(`\\[model_providers\\.${providerKey}\\]`, 'g')) || [];
  assert.equal(aihBlockMatches.length, 1);
  assert.match(merged, /preferred_auth_method = "apikey"/);
  assert.match(merged, new RegExp(`model_provider = "${providerKey}"`));
  assert.match(merged, new RegExp(`base_url = "${AIH_CODEX_PROVIDER_BASE_URL.replace(/\//g, '\\/')}"`));
  assert.match(merged, /bearer_token = "dummy"/);
});

test('mergeConfigs assigns aih provider defaults for api key mode without explicit base url', () => {
  const providerKey = getAihProviderKey('10');
  const merged = mergeConfigs('', {
    preferred_auth_method: null,
    model_provider: null,
    providers: [],
    model_providers: []
  }, '10', {
    isApiKeyMode: true,
    openaiApiKey: 'dummy'
  });

  assert.match(merged, /preferred_auth_method = "apikey"/);
  assert.match(merged, /model_provider = "openai"/);
  assert.doesNotMatch(merged, new RegExp(`\\[model_providers\\.${providerKey}\\]`));
  assert.doesNotMatch(merged, /base_url = "http:\/\/127\.0\.0\.1:8317\/v1"/);
});
