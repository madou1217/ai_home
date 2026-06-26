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
  mergeConfigs,
  scopeAccountOnlyConfig
} = require('../lib/cli/services/pty/codex-config-sync');
const {
  enableCodexHooksFeatureFlag,
  getCodexHooksFeatureFlagState,
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

test('getCodexHooksFeatureFlagState treats absent flag as enabled and explicit false as disabled', () => {
  const absent = getCodexHooksFeatureFlagState('', { codexVersion: '0.137.0' });
  const disabled = getCodexHooksFeatureFlagState('[features]\nhooks = false # disabled by user\n', {
    codexVersion: '0.137.0'
  });

  assert.equal(absent.explicit, false);
  assert.equal(absent.enabled, true);
  assert.equal(disabled.explicit, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.activeFlagName, 'hooks');
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
  assert.match(merged, new RegExp(`model_provider = "${providerKey}"`));
  assert.match(merged, new RegExp(`\\[model_providers\\.${providerKey}\\]`));
  assert.match(merged, new RegExp(`base_url = "${AIH_CODEX_PROVIDER_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(merged, /^bearer_token = "dummy"$/m);
});

test('mergeConfigs switches to oauth mode without rewriting host provider blocks', () => {
  const merged = mergeConfigs([
    'model = "gpt-5.5"',
    '',
    '[features]',
    'hooks = true'
  ].join('\n'), {
    preferred_auth_method: 'preferred_auth_method = "oauth"',
    model_provider: 'model_provider = "openai"',
    providers: ['[[providers]]\nname = "local"\nbase_url = "http://localhost:9000/v1"'],
    model_providers: []
  }, '10', {
    isApiKeyMode: false
  });

  assert.match(merged, /^preferred_auth_method = "oauth"$/m);
  assert.match(merged, /^model_provider = "openai"$/m);
  assert.match(merged, /^model = "gpt-5\.5"$/m);
  assert.match(merged, /^\[features\]$/m);
  assert.match(merged, /^hooks = true$/m);
  assert.doesNotMatch(merged, /\[\[providers\]\]/);
  assert.doesNotMatch(merged, /\[model_providers\./);
});

test('mergeConfigs replaces aih provider section without leaving duplicate keys behind', () => {
  const providerKey = getAihProviderKey('1');
  const hostConfig = [
    'preferred_auth_method = "apikey"',
    'model_provider = "aih_1"',
    '',
    `[model_providers.${providerKey}]`,
    'name = "aih codex"',
    'base_url = "https://www.yeslaoban.com/llm/api/v1"',
    'bearer_token = "yesboss-madoudou"',
    'wire_api = "responses"',
    '',
    '[features]',
    'hooks = true'
  ].join('\n');
  const merged = mergeConfigs(hostConfig, {
    preferred_auth_method: 'preferred_auth_method = "apikey"',
    model_provider: `model_provider = "${providerKey}"`,
    providers: [],
    model_providers: []
  }, '1', {
    isApiKeyMode: true,
    openaiBaseUrl: 'http://127.0.0.1:8317/v1',
    openaiApiKey: 'dummy'
  });

  const providerSection = merged.match(new RegExp(`\\[model_providers\\.${providerKey}\\][\\s\\S]*?(?=\\n\\[|(?![\\s\\S]))`));
  assert.ok(providerSection, 'expected provider section to exist');
  assert.equal((providerSection[0].match(/^name = /gm) || []).length, 1);
  assert.equal((providerSection[0].match(/^base_url = /gm) || []).length, 1);
  assert.equal((providerSection[0].match(/^bearer_token = /gm) || []).length, 1);
  assert.equal((providerSection[0].match(/^wire_api = /gm) || []).length, 1);
  assert.doesNotMatch(providerSection[0], /yesboss-madoudou/);
  assert.match(merged, /^preferred_auth_method = "apikey"$/m);
  assert.match(merged, new RegExp(`^model_provider = "${providerKey}"$`, 'm'));
  assert.match(merged, new RegExp(`^base_url = "http:\/\/127\.0\.0\.1:8317\/v1"$`, 'm'));
  assert.match(merged, /^bearer_token = "dummy"$/m);
});

test('mergeConfigs can route a server profile through the host aih provider key', () => {
  const hostProviderKey = getAihProviderKey('1');
  const serverProfileProviderKey = getAihProviderKey('.aih-server');
  const hostConfig = [
    'preferred_auth_method = "apikey"',
    `model_provider = "${hostProviderKey}"`,
    '',
    `[model_providers.${hostProviderKey}]`,
    'name = "aih codex"',
    'base_url = "https://upstream.example.com/v1"',
    'bearer_token = "host-token"',
    'wire_api = "responses"'
  ].join('\n');

  const merged = mergeConfigs(hostConfig, {
    preferred_auth_method: 'preferred_auth_method = "apikey"',
    model_provider: `model_provider = "${serverProfileProviderKey}"`,
    providers: [],
    model_providers: []
  }, '.aih-server', {
    isApiKeyMode: true,
    openaiBaseUrl: 'http://127.0.0.1:8317/v1',
    openaiApiKey: 'server-key',
    providerKeyOverride: hostProviderKey
  });

  assert.match(merged, new RegExp(`^model_provider = "${hostProviderKey}"$`, 'm'));
  assert.doesNotMatch(merged, new RegExp(`^model_provider = "${serverProfileProviderKey}"$`, 'm'));
  assert.doesNotMatch(merged, new RegExp(`^\\[model_providers\\.${serverProfileProviderKey}\\]$`, 'm'));
  assert.match(merged, new RegExp(`^\\[model_providers\\.${hostProviderKey}\\]$`, 'm'));
  assert.match(merged, /^base_url = "http:\/\/127\.0\.0\.1:8317\/v1"$/m);
  assert.match(merged, /^bearer_token = "server-key"$/m);
});

test('scopeAccountOnlyConfig keeps only current account managed provider from stale account config', () => {
  const currentProvider = getAihProviderKey('1');
  const staleProvider = getAihProviderKey('5');
  const scoped = scopeAccountOnlyConfig(extractAccountOnlyConfig([
    'preferred_auth_method = "apikey"',
    `model_provider = "${currentProvider}"`,
    '',
    '[model_providers.yesboss]',
    'name = "yesboss"',
    'base_url = "https://example.com/v1"',
    'wire_api = "responses"',
    '',
    `[model_providers.${staleProvider}]`,
    'name = "stale"',
    'base_url = "http://127.0.0.1:8317/v1"',
    'wire_api = "responses"',
    '',
    `[model_providers.${currentProvider}]`,
    'name = "aih codex"',
    'base_url = "https://account.example.com/v1"',
    'bearer_token = "account-token"',
    'wire_api = "responses"'
  ].join('\n')), '1', {
    forceAihProvider: true
  });

  assert.equal(scoped.model_provider, `model_provider = "${currentProvider}"`);
  assert.equal(scoped.model_providers.length, 1);
  assert.match(scoped.model_providers[0], new RegExp(`^\\[model_providers\\.${currentProvider}\\]`, 'm'));
  assert.doesNotMatch(scoped.model_providers[0], /yesboss|stale/);
});

test('mergeConfigs can force account-scoped aih provider from host template without api key', () => {
  const providerKey = getAihProviderKey('42');
  const merged = mergeConfigs('model = "gpt-5.5"\n', {
    preferred_auth_method: null,
    model_provider: null,
    providers: [],
    model_providers: []
  }, '42', {
    forceAihProvider: true
  });

  assert.match(merged, /^preferred_auth_method = "apikey"$/m);
  assert.match(merged, new RegExp(`^model_provider = "${providerKey}"$`, 'm'));
  assert.match(merged, new RegExp(`^\\[model_providers\\.${providerKey}\\]$`, 'm'));
  assert.match(merged, /^bearer_token = "dummy"$/m);
  assert.match(merged, /^model = "gpt-5\.5"$/m);
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

test('mergeConfigs normalizes Windows sqlite home before writing TOML', () => {
  const merged = mergeConfigs('model = "gpt-5.5"\n', {
    preferred_auth_method: null,
    model_provider: null,
    providers: [],
    model_providers: []
  }, '10', {
    sqliteHome: 'C:\\Users\\madou\\.codex'
  });

  assert.match(merged, /^sqlite_home = "C:\/Users\/madou\/\.codex"$/m);
  assert.doesNotMatch(merged, /^sqlite_home = "C:\\\\Users\\\\madou\\\\\.codex"$/m);
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
