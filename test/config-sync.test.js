'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AIH_CODEX_PROVIDER_BASE_URL,
  extractAccountOnlyConfig,
  filterHostConfig,
  getAihProviderKey,
  hoistModelProviderSections,
  mergeSharedProjectSections,
  mergeConfigs
} = require('../lib/cli/services/pty/codex-config-sync');
const {
  enableCodexHooksFeatureFlag,
  resolveCodexHooksFeatureFlag
} = require('../lib/cli/config/codex-feature-flags');

test('resolveCodexHooksFeatureFlag switches flag name by codex version', () => {
  assert.equal(resolveCodexHooksFeatureFlag({ codexVersion: '0.113.0' }).flagName, 'codex_hooks');
  assert.equal(resolveCodexHooksFeatureFlag({ codexVersion: '0.114.0' }).flagName, 'hooks');
  assert.equal(resolveCodexHooksFeatureFlag({ codexVersion: 'codex-cli 0.115.1' }).flagName, 'hooks');
});

test('enableCodexHooksFeatureFlag replaces deprecated hook flag in features section', () => {
  const patched = enableCodexHooksFeatureFlag('[features]\ncodex_hooks = true\nother = false\n', {
    codexVersion: '0.114.0'
  }).content;

  assert.match(patched, /^\[features\]$/m);
  assert.match(patched, /^hooks = true$/m);
  assert.match(patched, /^other = false$/m);
  assert.doesNotMatch(patched, /^codex_hooks\s*=/m);
});

test('filterHostConfig excludes bearer_token from model_providers section', () => {
  const hostConfig = `
[model_providers.aih]
name = "aih codex"
base_url = "${AIH_CODEX_PROVIDER_BASE_URL}"
bearer_token = "dummy"
wire_api = "responses"
`;

  const filtered = filterHostConfig(hostConfig, {
    excludeAccountOnly: false,
    excludeSensitive: true
  });

  assert.ok(!filtered.includes('bearer_token'));
  assert.ok(filtered.includes('name = "aih codex"'));
  assert.ok(filtered.includes(`base_url = "${AIH_CODEX_PROVIDER_BASE_URL}"`));
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
base_url = "${AIH_CODEX_PROVIDER_BASE_URL}"
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
base_url = "${AIH_CODEX_PROVIDER_BASE_URL}"
wire_api = "responses"

[features]
codex_hooks = true
`;
  const accountOnlyConfig = extractAccountOnlyConfig(`
preferred_auth_method = "apikey"
model_provider = "${providerKey}"

[model_providers.${providerKey}]
name = "aih codex"
base_url = "${AIH_CODEX_PROVIDER_BASE_URL}"
bearer_token = "dummy"
wire_api = "responses"
`);

  const merged = mergeConfigs(hostConfig, accountOnlyConfig, '10', {
    isApiKeyMode: true,
    openaiApiKey: 'dummy',
    codexVersion: '0.114.0'
  });

  const aihBlockMatches = merged.match(new RegExp(`\\[model_providers\\.${providerKey}\\]`, 'g')) || [];
  assert.equal(aihBlockMatches.length, 1);
  assert.match(merged, /preferred_auth_method = "apikey"/);
  assert.match(merged, new RegExp(`model_provider = "${providerKey}"`));
  assert.match(merged, new RegExp(`base_url = "${AIH_CODEX_PROVIDER_BASE_URL.replace(/\//g, '\\/')}"`));
  assert.match(merged, /bearer_token = "dummy"/);
  assert.match(merged, /^hooks = true$/m);
  assert.doesNotMatch(merged, /^codex_hooks\s*=/m);
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
  assert.doesNotMatch(merged, new RegExp(`base_url = "${AIH_CODEX_PROVIDER_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('mergeConfigs writes shared sqlite home once at root', () => {
  const merged = mergeConfigs('sqlite_home = "/old/.codex"\nmodel = "gpt-5.5"\n', {
    preferred_auth_method: null,
    model_provider: null,
    providers: [],
    model_providers: []
  }, '10', {
    sqliteHome: '/Users/model/.codex'
  });

  const matches = merged.match(/^sqlite_home = /gm) || [];
  assert.equal(matches.length, 1);
  assert.match(merged, /^sqlite_home = "\/Users\/model\/\.codex"$/m);
  assert.match(merged, /^model = "gpt-5\.5"$/m);
  assert.doesNotMatch(merged, /\/old\/\.codex/);
});

test('hoistModelProviderSections keeps codex providers before project sections', () => {
  const config = [
    'model_provider = "aih_10"',
    '',
    '[projects."/tmp/project"]',
    'trust_level = "trusted"',
    '',
    '[model_providers.aih_10014]',
    'name = "aih codex"',
    'base_url = "https://example.com/v1"',
    'bearer_token = "token"',
    'wire_api = "responses"',
    '',
    '[features]',
    'hooks = true'
  ].join('\n');

  const normalized = hoistModelProviderSections(config);
  assert.ok(
    normalized.indexOf('[model_providers.aih_10014]') < normalized.indexOf('[projects."/tmp/project"]')
  );
  assert.ok(
    normalized.indexOf('[model_providers.aih_10014]') < normalized.indexOf('[features]')
  );
});

test('mergeSharedProjectSections carries trusted projects without overriding account settings', () => {
  const accountConfig = [
    'model = "gpt-5.5"',
    'approval_policy = "never"',
    '',
    '[projects."/already/trusted"]',
    'trust_level = "trusted"',
    ''
  ].join('\n');
  const hostConfig = [
    'model = "host-model"',
    '',
    '[projects."/already/trusted"]',
    'trust_level = "trusted"',
    '',
    '[projects."/new/project"]',
    'trust_level = "trusted"',
    ''
  ].join('\n');

  const merged = mergeSharedProjectSections(accountConfig, hostConfig);
  assert.match(merged, /^model = "gpt-5\.5"$/m);
  assert.match(merged, /^approval_policy = "never"$/m);
  assert.doesNotMatch(merged, /^model = "host-model"$/m);
  assert.equal((merged.match(/\[projects\."\/already\/trusted"\]/g) || []).length, 1);
  assert.match(merged, /\[projects\."\/new\/project"\]\ntrust_level = "trusted"/);
});
