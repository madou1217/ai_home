'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- Provider Catalog ---
const { isKnownProvider, PROVIDER_IDS } = require('../lib/provider-catalog');

test('provider catalog includes grok and isKnownProvider returns true', () => {
  assert.ok(PROVIDER_IDS.includes('grok'), 'grok should be in PROVIDER_IDS');
  assert.equal(isKnownProvider('grok'), true);
  assert.equal(isKnownProvider('GROK'), true, 'case-insensitive');
});

// --- Provider Registry (CLI) ---
const { getAiCliConfig, listSupportedAiClis } = require('../lib/cli/services/ai-cli/provider-registry');

test('getAiCliConfig grok returns correct CLI configuration', () => {
  const config = getAiCliConfig('grok');
  assert.ok(config, 'grok config should exist');
  assert.equal(config.globalDir, '.grok');
  assert.equal(config.binaryName, 'grok');
  assert.equal(config.pkg, '');
  assert.deepEqual(config.envKeys, ['GROK_HOME', 'XAI_API_KEY']);
  assert.deepEqual(config.loginArgs, ['login', '--oauth']);
});

test('listSupportedAiClis includes grok', () => {
  const clis = listSupportedAiClis();
  assert.ok(clis.includes('grok'), 'grok should be in supported CLIs');
});

// --- Native Capability Registry ---
const { getProviderNativeCapability } = require('../lib/provider-native-capability-registry');

test('grok native capability declares MCP and sessions support', () => {
  const cap = getProviderNativeCapability('grok');
  assert.ok(cap, 'grok capability should exist');
  assert.equal(cap.provider, 'grok');
  assert.ok(cap.mcp, 'grok should declare MCP support');
  assert.ok(cap.sessions, 'grok should declare sessions support');
  assert.ok(cap.permissions, 'grok should declare permissions support');
});

// --- inferProviderFromModel (Chain of Responsibility) ---
const { inferProviderFromModel } = require('../lib/server/providers');

test('inferProviderFromModel routes grok-4.5 to grok provider', () => {
  assert.equal(inferProviderFromModel('grok-4.5'), 'grok');
  assert.equal(inferProviderFromModel('grok-4.3'), 'grok');
  assert.equal(inferProviderFromModel('grok-3'), 'grok');
  assert.equal(inferProviderFromModel('grok-3-mini'), 'grok');
  assert.equal(inferProviderFromModel('grok-4-fast-reasoning'), 'grok');
});

test('inferProviderFromModel does not route non-grok models to grok', () => {
  assert.equal(inferProviderFromModel('gpt-4o'), 'codex');
  assert.equal(inferProviderFromModel('claude-sonnet-4-20250514'), 'claude');
  assert.equal(inferProviderFromModel('gemini-2.5-pro'), 'gemini');
});

// --- Account Identity ---
// PROVIDER_API_KEY_ENV is internal; test via detectIdentityKind behavior
test('grok account with XAI_API_KEY is detected as api-key type', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createGrokFixture(t);
  const accountRef = register('grok', '1', { XAI_API_KEY: 'xai-test-key' });

  const { detectIdentityKind } = require('../lib/account/account-identity');
  const kind = detectIdentityKind({ fs, aiHomeDir, provider: 'grok', accountRef });
  assert.equal(kind, 'api-key');
});

// --- Transfer Core (credential extraction) ---
const {
  extractApiKeyConfig,
  normalizeImportProviderAlias,
  normalizeSub2ApiAccountRecord
} = require('../lib/account/transfer-core');

test('extractApiKeyConfig extracts XAI_API_KEY for grok provider', () => {
  const result = extractApiKeyConfig('grok', {
    XAI_API_KEY: 'xai-test-key-123'
  });
  assert.equal(result.apiKey, 'xai-test-key-123');
});

test('extractApiKeyConfig extracts XAI_BASE_URL for grok provider', () => {
  const result = extractApiKeyConfig('grok', {
    XAI_API_KEY: 'xai-test-key',
    XAI_BASE_URL: 'https://custom.x.ai/v1'
  });
  assert.equal(result.apiKey, 'xai-test-key');
  assert.equal(result.baseUrl, 'https://custom.x.ai/v1');
});

test('normalizeImportProviderAlias maps xai to grok', () => {
  assert.equal(normalizeImportProviderAlias('xai'), 'grok');
  assert.equal(normalizeImportProviderAlias('XAI'), 'grok');
  assert.equal(normalizeImportProviderAlias('grok'), 'grok');
});

test('normalizeSub2ApiAccountRecord handles grok platform', () => {
  const record = normalizeSub2ApiAccountRecord({
    platform: 'xai',
    type: 'apikey',
    credentials: {
      api_key: 'xai-import-key',
      base_url: 'https://api.x.ai/v1'
    }
  });
  assert.ok(record, 'record should not be null');
  assert.equal(record.provider, 'grok');
  assert.ok(record.config, 'config should exist');
  assert.equal(record.config.XAI_API_KEY, 'xai-import-key');
});

// --- Server Accounts (Strategy + Template Method) ---
const {
  loadGrokServerAccounts,
  loadServerRuntimeAccounts
} = require('../lib/server/accounts');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');

function createGrokFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-test-'));
  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });

  t.after(() => {
    accountStateIndex.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  function register(provider, cliAccountId, env, nativeAuth) {
    const identitySeed = `test:${provider}:${cliAccountId}:account`;
    const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
      provider,
      cliAccountId,
      identitySeed
    });
    if (env) writeAccountCredentials(fs, aiHomeDir, accountRef, env);
    if (nativeAuth) writeAccountNativeAuth(fs, aiHomeDir, accountRef, nativeAuth);
    return accountRef;
  }

  return { aiHomeDir, accountStateIndex, register };
}

test('loadGrokServerAccounts returns api-key account with XAI_API_KEY', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createGrokFixture(t);
  register('grok', '1', { XAI_API_KEY: 'xai-test-key-abc' });

  const accounts = loadGrokServerAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  const account = accounts[0];
  assert.equal(account.provider, 'grok');
  assert.equal(account.authType, 'api-key');
  assert.equal(account.apiKeyMode, true);
  assert.equal(account.accessToken, 'xai-test-key-abc');
  assert.equal(account.openaiBaseUrl, 'https://api.x.ai/v1');
});

test('loadGrokServerAccounts respects custom XAI_BASE_URL', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createGrokFixture(t);
  register('grok', '1', {
    XAI_API_KEY: 'xai-key',
    XAI_BASE_URL: 'https://custom.x.ai/v1'
  });

  const accounts = loadGrokServerAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].openaiBaseUrl, 'https://custom.x.ai/v1');
});

test('loadGrokServerAccounts returns oauth account for grok-build auth', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createGrokFixture(t);
  register('grok', '1', {}, {
    auth: { access_token: 'oauth-token-xyz' }
  });

  const accounts = loadGrokServerAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  const account = accounts[0];
  assert.equal(account.authType, 'oauth');
  assert.equal(account.apiKeyMode, false);
  assert.equal(account.accessToken, 'oauth-token-xyz');
});

test('loadGrokServerAccounts reads official mapped Grok OAuth auth', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createGrokFixture(t);
  register('grok', '1', {}, {
    auth: { 'https://auth.x.ai::client-id': { key: 'mapped-token', email: 'grok@example.com' } }
  });
  const accounts = loadGrokServerAccounts({ fs, aiHomeDir, accountStateIndex, checkStatus: () => ({ configured: true }) });
  assert.equal(accounts[0].accessToken, 'mapped-token');
  assert.equal(accounts[0].email, 'grok@example.com');
});

test('loadGrokServerAccounts skips account without credentials', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createGrokFixture(t);
  register('grok', '1', {});

  const accounts = loadGrokServerAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 0);
});

test('loadServerRuntimeAccounts includes grok accounts', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createGrokFixture(t);
  register('grok', '1', { XAI_API_KEY: 'xai-key' });

  const runtime = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true }),
    getProfileDir: () => ''
  });

  assert.ok(runtime.grok, 'runtime should have grok field');
  assert.equal(runtime.grok.length, 1);
  assert.equal(runtime.grok[0].provider, 'grok');
});

// --- Standard Transfer (sub2api export) ---
const { buildSub2ApiExportPayload } = require('../lib/account/standard-transfer');

test('sub2api export includes grok accounts with platform xai', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createGrokFixture(t);
  register('grok', '1', { XAI_API_KEY: 'xai-export-key' });

  const payload = buildSub2ApiExportPayload({
    fs,
    path,
    aiHomeDir,
    providers: ['grok']
  });

  assert.ok(payload.accounts.length >= 1, 'should export at least one grok account');
  const grokAccount = payload.accounts.find((a) => a.platform === 'xai');
  assert.ok(grokAccount, 'grok account should have platform xai');
  assert.equal(grokAccount.type, 'apikey');
  assert.ok(grokAccount.credentials.api_key, 'should have api_key credential');
});

// --- Upstream Endpoint Routing ---
const { __private: upstreamPrivate } = require('../lib/server/upstream-endpoints');
const { resolveProviderUpstream, resolveProviderPath } = upstreamPrivate;

test('resolveProviderUpstream returns grok base URL from account', () => {
  const account = { openaiBaseUrl: 'https://api.x.ai/v1' };
  const result = resolveProviderUpstream({}, 'grok', account);
  assert.equal(result, 'https://api.x.ai/v1');
});

test('resolveProviderUpstream falls back to default grok URL', () => {
  const result = resolveProviderUpstream({}, 'grok', {});
  assert.equal(result, 'https://api.x.ai/v1');
});

test('resolveProviderPath strips /v1/ prefix for grok', () => {
  const result = resolveProviderPath('grok', '/v1/chat/completions', 'https://api.x.ai/v1');
  assert.equal(result, '/chat/completions');
});
