'use strict';

const { describe, it, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- Phase 1: Provider registration & metadata ---

describe('kimi/kiro provider catalog', () => {
  it('provider-catalog-data includes kimi and kiro', () => {
    const catalog = require('../lib/provider-catalog-data.json');
    const ids = catalog.providers.map((p) => p.id);
    assert.ok(ids.includes('kimi'), 'kimi in catalog');
    assert.ok(ids.includes('kiro'), 'kiro in catalog');
    const kimi = catalog.providers.find((p) => p.id === 'kimi');
    assert.equal(kimi.label, 'Kimi');
    assert.equal(kimi.short, 'KM');
    const kiro = catalog.providers.find((p) => p.id === 'kiro');
    assert.equal(kiro.label, 'Kiro');
    assert.equal(kiro.short, 'KR');
  });

  it('provider-registry exposes kimi CLI config', () => {
    const { getAiCliConfig } = require('../lib/cli/services/ai-cli/provider-registry');
    const kimi = getAiCliConfig('kimi');
    assert.ok(kimi, 'kimi config exists');
    assert.equal(kimi.globalDir, '.kimi-code');
    assert.equal(kimi.pkg, '@moonshot-ai/kimi-code');
    assert.ok(kimi.envKeys.includes('MOONSHOT_API_KEY'));
    assert.ok(kimi.envKeys.includes('KIMI_CODE_HOME'));
  });

  it('provider-registry exposes kiro CLI config', () => {
    const { getAiCliConfig } = require('../lib/cli/services/ai-cli/provider-registry');
    const kiro = getAiCliConfig('kiro');
    assert.ok(kiro, 'kiro config exists');
    assert.equal(kiro.globalDir, '.kiro');
    assert.equal(kiro.binaryName, 'kiro-cli');
    assert.equal(kiro.pkg, '');
    assert.ok(kiro.envKeys.includes('KIRO_HOME'));
  });

  it('native capability registry includes kimi and kiro', () => {
    const { getProviderNativeCapability } = require('../lib/provider-native-capability-registry');
    const kimi = getProviderNativeCapability('kimi');
    assert.ok(kimi, 'kimi capability exists');
    assert.equal(kimi.provider, 'kimi');
    assert.ok(kimi.config.envHomeKeys.includes('KIMI_CODE_HOME'));
    const kiro = getProviderNativeCapability('kiro');
    assert.ok(kiro, 'kiro capability exists');
    assert.equal(kiro.provider, 'kiro');
    assert.ok(kiro.config.envHomeKeys.includes('KIRO_HOME'));
  });
});

// --- Phase 3: Gateway routing ---

describe('kimi/kiro model prefix routing', () => {
  it('inferProviderFromModel routes kimi-* to kimi', () => {
    const { inferProviderFromModel } = require('../lib/server/providers');
    assert.equal(inferProviderFromModel('kimi-k3'), 'kimi');
    assert.equal(inferProviderFromModel('kimi-k2.7-code'), 'kimi');
    assert.equal(inferProviderFromModel('kimi-k2.7-code-highspeed'), 'kimi');
  });

  it('inferProviderFromModel routes moonshot-* to kimi', () => {
    const { inferProviderFromModel } = require('../lib/server/providers');
    assert.equal(inferProviderFromModel('moonshot-v1-8k'), 'kimi');
    assert.equal(inferProviderFromModel('moonshot-v1-128k'), 'kimi');
  });

  it('inferProviderFromModel routes kiro/kr prefix to kiro', () => {
    const { inferProviderFromModel } = require('../lib/server/providers');
    assert.equal(inferProviderFromModel('kiro-auto'), 'kiro');
    assert.equal(inferProviderFromModel('kr/claude-sonnet-4.5'), 'kiro');
  });
});

// --- Phase 2: Account identity ---

describe('kimi/kiro identity detection', () => {
  const { detectIdentityKind } = require('../lib/account/account-identity');
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { writeAccountCredentials } = require('../lib/server/account-credential-store');

  let aiHomeDir;

  beforeEach(() => {
    aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-identity-'));
  });

  afterEach(() => {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  it('detectIdentityKind identifies kimi api-key via MOONSHOT_API_KEY', () => {
    const reg = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'kimi',
      cliAccountId: '1',
      identitySeed: 'test:kimi:1:apikey'
    });
    writeAccountCredentials(fs, aiHomeDir, reg.accountRef, { MOONSHOT_API_KEY: 'sk-test123' });
    const kind = detectIdentityKind({
      fs,
      aiHomeDir,
      provider: 'kimi',
      accountRef: reg.accountRef
    });
    assert.equal(kind, 'api-key');
  });

  it('detectIdentityKind returns oauth for kiro (no API key env)', () => {
    const reg = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'kiro',
      cliAccountId: '1',
      identitySeed: 'test:kiro:1:oauth'
    });
    const kind = detectIdentityKind({
      fs,
      aiHomeDir,
      provider: 'kiro',
      accountRef: reg.accountRef
    });
    assert.equal(kind, 'oauth');
  });
});

// --- Phase 2: Transfer core ---

describe('kimi/kiro transfer-core', () => {
  it('normalizeImportProviderAlias maps moonshot to kimi', () => {
    const { normalizeImportProviderAlias } = require('../lib/account/transfer-core');
    assert.equal(normalizeImportProviderAlias('moonshot'), 'kimi');
    assert.equal(normalizeImportProviderAlias('kimi-code'), 'kimi');
    assert.equal(normalizeImportProviderAlias('moonshot-ai'), 'kimi');
    assert.equal(normalizeImportProviderAlias('kimi'), 'kimi');
    assert.equal(normalizeImportProviderAlias('kiro'), 'kiro');
  });

  it('extractApiKeyConfig extracts MOONSHOT_API_KEY for kimi', () => {
    const { extractApiKeyConfig } = require('../lib/account/transfer-core');
    const result = extractApiKeyConfig('kimi', {
      config: { MOONSHOT_API_KEY: 'sk-test-key', KIMI_BASE_URL: 'https://api.moonshot.ai/v1' }
    });
    assert.equal(result.apiKey, 'sk-test-key');
    assert.equal(result.baseUrl, 'https://api.moonshot.ai/v1');
    assert.equal(result.credentialType, 'api-key');
  });

  it('normalizeSub2ApiAccountRecord handles kimi provider', () => {
    const { normalizeSub2ApiAccountRecord } = require('../lib/account/transfer-core');
    const record = normalizeSub2ApiAccountRecord({
      platform: 'moonshot',
      type: 'apikey',
      credentials: { api_key: 'sk-kimi-test' }
    });
    assert.ok(record, 'record not null');
    assert.equal(record.provider, 'kimi');
  });
});

// --- Phase 3: Server accounts ---

describe('loadKimiServerAccounts', () => {
  const { loadKimiServerAccounts } = require('../lib/server/accounts');
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { writeAccountCredentials, writeAccountNativeAuth } = require('../lib/server/account-credential-store');
  const { createAccountStateIndex } = require('../lib/account/state-index');

  let aiHomeDir;
  let accountStateIndex;

  beforeEach(() => {
    aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-accounts-'));
    accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  });

  afterEach(() => {
    accountStateIndex.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  function deps() {
    return {
      fs,
      aiHomeDir,
      accountStateIndex,
      checkStatus: null,
      getProfileDir: () => ''
    };
  }

  it('loads kimi account with API key', () => {
    const reg = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'kimi', cliAccountId: '1', identitySeed: 'test:kimi:1:key'
    });
    writeAccountCredentials(fs, aiHomeDir, reg.accountRef, { MOONSHOT_API_KEY: 'sk-abc123' });
    const accounts = loadKimiServerAccounts(deps());
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].provider, 'kimi');
    assert.equal(accounts[0].accessToken, 'sk-abc123');
    assert.equal(accounts[0].authType, 'api-key');
    assert.equal(accounts[0].openaiBaseUrl, 'https://api.moonshot.cn/v1');
  });

  it('loads kimi account with custom base URL', () => {
    const reg = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'kimi', cliAccountId: '2', identitySeed: 'test:kimi:2:url'
    });
    writeAccountCredentials(fs, aiHomeDir, reg.accountRef, {
      MOONSHOT_API_KEY: 'sk-xyz', KIMI_BASE_URL: 'https://api.moonshot.ai/v1'
    });
    const accounts = loadKimiServerAccounts(deps());
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].openaiBaseUrl, 'https://api.moonshot.ai/v1');
  });

  it('skips kimi account with empty key', () => {
    const reg = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'kimi', cliAccountId: '3', identitySeed: 'test:kimi:3:empty'
    });
    writeAccountCredentials(fs, aiHomeDir, reg.accountRef, {});
    const accounts = loadKimiServerAccounts(deps());
    assert.equal(accounts.length, 0);
  });

  it('loads kimi account with OAuth token', () => {
    const reg = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'kimi', cliAccountId: '4', identitySeed: 'test:kimi:4:oauth'
    });
    writeAccountNativeAuth(fs, aiHomeDir, reg.accountRef, { auth: { access_token: 'oauth-tok-123' } });
    const accounts = loadKimiServerAccounts(deps());
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].authType, 'oauth');
    assert.equal(accounts[0].accessToken, 'oauth-tok-123');
  });
});

describe('loadKiroServerAccounts', () => {
  const { loadKiroServerAccounts } = require('../lib/server/accounts');
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
  const { createAccountStateIndex } = require('../lib/account/state-index');

  let aiHomeDir;
  let accountStateIndex;

  beforeEach(() => {
    aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-accounts-'));
    accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  });

  afterEach(() => {
    accountStateIndex.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  function deps() {
    return {
      fs,
      aiHomeDir,
      accountStateIndex,
      checkStatus: null,
      getProfileDir: () => ''
    };
  }

  it('loads kiro account with OAuth token', () => {
    const reg = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'kiro', cliAccountId: '1', identitySeed: 'test:kiro:1:oauth'
    });
    writeAccountNativeAuth(fs, aiHomeDir, reg.accountRef, { auth: { access_token: 'aws-tok-abc' } });
    const accounts = loadKiroServerAccounts(deps());
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].provider, 'kiro');
    assert.equal(accounts[0].authType, 'oauth');
    assert.equal(accounts[0].accessToken, 'aws-tok-abc');
    assert.equal(accounts[0].experimental, true);
  });

  it('skips kiro account without OAuth token', () => {
    registerAccountIdentity(fs, aiHomeDir, {
      provider: 'kiro', cliAccountId: '2', identitySeed: 'test:kiro:2:empty'
    });
    const accounts = loadKiroServerAccounts(deps());
    assert.equal(accounts.length, 0);
  });
});

// --- Phase 3: Upstream endpoints ---

describe('kimi/kiro upstream routing', () => {
  const { __private } = require('../lib/server/upstream-endpoints');
  const { resolveProviderUpstream, resolveProviderPath } = __private;

  it('resolveProviderUpstream defaults kimi to api.moonshot.cn', () => {
    const result = resolveProviderUpstream({}, 'kimi', null);
    assert.equal(result, 'https://api.moonshot.cn/v1');
  });

  it('resolveProviderUpstream uses account baseUrl for kimi', () => {
    const result = resolveProviderUpstream({}, 'kimi', { openaiBaseUrl: 'https://api.moonshot.ai/v1' });
    assert.equal(result, 'https://api.moonshot.ai/v1');
  });

  it('resolveProviderUpstream defaults kiro to AWS endpoint', () => {
    const result = resolveProviderUpstream({}, 'kiro', null);
    assert.equal(result, 'https://q.us-east-1.amazonaws.com');
  });

  it('resolveProviderPath strips /v1/ prefix for kimi', () => {
    const result = resolveProviderPath('kimi', '/v1/chat/completions', 'https://api.moonshot.cn/v1');
    assert.equal(result, '/chat/completions');
  });

  it('resolveProviderPath strips /v1/ prefix for kiro', () => {
    const result = resolveProviderPath('kiro', '/v1/chat/completions', 'https://q.us-east-1.amazonaws.com');
    assert.equal(result, '/chat/completions');
  });
});

// --- Phase 5: Import/export ---

describe('kimi/kiro sub2api export', () => {
  it('buildSub2ApiPlatform maps kimi to moonshot', () => {
    const { buildSub2ApiPlatform } = require('../lib/account/standard-transfer');
    assert.equal(buildSub2ApiPlatform('kimi'), 'moonshot');
    assert.equal(buildSub2ApiPlatform('kiro'), 'kiro');
  });
});

// --- loadServerRuntimeAccounts includes kimi/kiro ---

describe('loadServerRuntimeAccounts includes kimi and kiro buckets', () => {
  it('runtime buckets expose kimi and kiro keys', () => {
    const { loadServerRuntimeAccounts } = require('../lib/server/accounts');
    const fakeFs = {
      existsSync: () => false,
      readFileSync: () => { throw new Error('not found'); },
      readdirSync: () => []
    };
    const accounts = loadServerRuntimeAccounts({
      fs: fakeFs,
      accountStateIndex: null,
      accountStateService: null,
      getProfileDir: () => '',
      checkStatus: null,
      aiHomeDir: '/tmp/aih-test',
      serverPort: 19876
    });
    const keys = Object.keys(accounts).sort();
    assert.ok(keys.includes('kimi'), 'kimi key present');
    assert.ok(keys.includes('kiro'), 'kiro key present');
  });
});
