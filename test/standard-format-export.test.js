const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildFlatAccountExportEntries,
  importStandardAccountRecords,
  parseStandardAccountRecordsFromJson
} = require('../lib/account/standard-transfer');
const {
  loadAgyServerAccounts,
  loadGeminiServerAccounts
} = require('../lib/server/accounts');
const { createStandardFormatExportService } = require('../lib/cli/services/backup/standard-format-export');
const {
  readAccountCredentials,
  readAccountNativeAuth,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  buildOpenCodeIdentitySeed,
  hashApiKeySecret,
  normalizeIdentitySeed
} = require('../lib/account/account-identity');
const { buildApiKeyIdentity } = require('../lib/account/transfer-core');
const { resolveAccountRefByCliId } = require('../lib/server/account-ref-store');
const {
  readTransferMetadata,
  writeTransferMetadata
} = require('../lib/account/transfer-metadata-store');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function registerTestAccount(aiHomeDir, provider, cliAccountId, identitySeed) {
  return registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed
  }).accountRef;
}

function registerOAuthAccount(aiHomeDir, provider, cliAccountId, email) {
  return registerTestAccount(aiHomeDir, provider, cliAccountId, `oauth:${provider}:${email}`);
}

function registerApiKeyAccount(aiHomeDir, provider, cliAccountId, env) {
  return registerTestAccount(
    aiHomeDir,
    provider,
    cliAccountId,
    normalizeIdentitySeed(buildApiKeyIdentity(provider, env))
  );
}

function resolveTestAccountRef(aiHomeDir, provider, cliAccountId) {
  const record = resolveAccountRefByCliId(fs, aiHomeDir, provider, cliAccountId);
  assert.ok(record, `missing ${provider} CLI account ${cliAccountId}`);
  return record.accountRef;
}

test('exportSub2ApiData writes sub2api-data JSON with OAuth and api-key accounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-standard-export-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const oauthAccountRef = registerOAuthAccount(aiHomeDir, 'codex', '1', 'worker@example.com');
    writeAccountNativeAuth(fs, aiHomeDir, oauthAccountRef, { auth: {
      email: 'worker@example.com',
      tokens: {
        access_token: 'access',
        refresh_token: 'rt_worker',
        id_token: 'id',
        account_id: 'acct-worker'
      }
    } });
    const apiKeyEnv = {
      OPENAI_API_KEY: 'sk-worker',
      OPENAI_BASE_URL: 'https://api.example.com/v1/'
    };
    const apiKeyAccountRef = registerApiKeyAccount(aiHomeDir, 'codex', '2', apiKeyEnv);
    writeAccountCredentials(fs, aiHomeDir, apiKeyAccountRef, apiKeyEnv);

    const service = createStandardFormatExportService({ fs, path, aiHomeDir });
    const outPath = path.join(root, 'sub2api.json');
    const result = service.exportSub2ApiData({ outPath, providers: ['codex'] });
    const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));

    assert.equal(result.accounts, 2);
    assert.equal(payload.type, 'sub2api-data');
    assert.equal(payload.version, 1);
    assert.deepEqual(payload.proxies, []);
    assert.equal(payload.accounts[0].platform, 'openai');
    assert.equal(payload.accounts[0].type, 'oauth');
    assert.equal(payload.accounts[0].credentials.refresh_token, 'rt_worker');
    assert.equal(payload.accounts[1].platform, 'openai');
    assert.equal(payload.accounts[1].type, 'apikey');
    assert.equal(payload.accounts[1].credentials.api_key, 'sk-worker');
    assert.equal(payload.accounts[1].credentials.base_url, 'https://api.example.com/v1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildFlatAccountExportEntries names oauth by email and api-key by url plus ref suffix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-flat-export-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const codexOne = registerOAuthAccount(aiHomeDir, 'codex', '1', 'worker@example.com');
    writeAccountNativeAuth(fs, aiHomeDir, codexOne, { auth: {
      email: 'worker@example.com',
      tokens: {
        access_token: 'access',
        refresh_token: 'rt_worker',
        id_token: 'id',
        account_id: 'provider-account'
      }
    } });
    const firstApiKeyEnv = {
      OPENAI_API_KEY: 'sk-worker-a',
      OPENAI_BASE_URL: 'https://same.example.com/v1/'
    };
    const codexTwo = registerApiKeyAccount(aiHomeDir, 'codex', '2', firstApiKeyEnv);
    writeAccountCredentials(fs, aiHomeDir, codexTwo, firstApiKeyEnv);
    const secondApiKeyEnv = {
      OPENAI_API_KEY: 'sk-worker-b',
      OPENAI_BASE_URL: 'https://same.example.com/v1/'
    };
    const codexThree = registerApiKeyAccount(aiHomeDir, 'codex', '3', secondApiKeyEnv);
    writeAccountCredentials(fs, aiHomeDir, codexThree, secondApiKeyEnv);

    const result = buildFlatAccountExportEntries({
      fs,
      path,
      aiHomeDir,
      accounts: [
        { provider: 'codex', accountRef: codexOne },
        { provider: 'codex', accountRef: codexTwo },
        { provider: 'codex', accountRef: codexThree }
      ]
    });
    const names = result.entries.map((entry) => entry.fileName).sort();
    const apiNames = names.filter((name) => /^codex_same\.example\.com_v1_[a-f0-9]{20}\.json$/.test(name));

    assert.deepEqual(result.skipped, []);
    assert.equal(names.includes('codex_worker@example.com.json'), true);
    assert.equal(apiNames.length, 2);
    assert.notEqual(apiNames[0], apiNames[1]);
    result.entries.forEach((entry) => {
      assert.equal(Object.prototype.hasOwnProperty.call(entry.payload, 'accountId'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(entry.payload, 'account_id'), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildFlatAccountExportEntries exports opencode auth with stable public identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-flat-export-opencode-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const auth = {
      openai: {
        type: 'api',
        key: 'sk-opencode-openai'
      },
      anthropic: {
        type: 'api',
        key: 'sk-opencode-anthropic'
      }
    };
    const accountRef = registerTestAccount(
      aiHomeDir,
      'opencode',
      '1',
      buildOpenCodeIdentitySeed(auth)
    );
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { auth });

    const result = buildFlatAccountExportEntries({
      fs,
      path,
      aiHomeDir,
      accounts: [
        { provider: 'opencode', accountRef }
      ]
    });

    assert.deepEqual(result.skipped, []);
    assert.equal(result.entries.length, 1);
    assert.match(result.entries[0].fileName, /^opencode_auth_[a-f0-9]{20}\.json$/);
    assert.equal(result.entries[0].payload.platform, 'opencode');
    assert.equal(result.entries[0].payload.type, 'oauth');
    assert.deepEqual(Object.keys(result.entries[0].payload.credentials).sort(), ['anthropic', 'openai']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importStandardAccountRecords stores sub2api metadata without overwriting duplicate accounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-standard-import-sub2api-meta-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const records = parseStandardAccountRecordsFromJson({
      exported_at: '2026-06-08T00:00:00Z',
      proxies: [
        {
          proxy_key: 'proxy-main',
          name: 'Main proxy',
          protocol: 'http',
          host: 'proxy.local',
          port: 8080,
          status: 'active',
          fallback_mode: false,
          expiry_warn_days: 0
        },
        {
          proxy_key: 'proxy-backup',
          name: 'Backup proxy',
          protocol: 'socks5',
          host: 'backup.local',
          port: 1080,
          status: 'inactive'
        }
      ],
      accounts: [{
        name: 'Codex key from sub2api',
        notes: 'kept for round trip',
        platform: 'openai',
        type: 'apikey',
        credentials: {
          api_key: 'sk-sub2api-meta',
          base_url: 'https://meta.example.com/v1/'
        },
        extra: {
          owner: 'ops'
        },
        proxy_key: 'proxy-main',
        concurrency: 0,
        priority: 9,
        rate_multiplier: 1.25,
        expires_at: 1893456000,
        auto_pause_on_expired: false
      }]
    });

    const result = importStandardAccountRecords({
      fs,
      path,
      aiHomeDir,
      records,
    });
    const accountRef = resolveTestAccountRef(aiHomeDir, 'codex', '1');
    const metadata = readTransferMetadata(fs, aiHomeDir, accountRef).formats.sub2api;

    assert.equal(result.imported, 1);
    assert.equal(metadata.name, 'Codex key from sub2api');
    assert.equal(metadata.notes, 'kept for round trip');
    assert.deepEqual(metadata.extra, { owner: 'ops' });
    assert.equal(metadata.proxy_key, 'proxy-main');
    assert.equal(metadata.concurrency, 0);
    assert.equal(metadata.priority, 9);
    assert.equal(metadata.rate_multiplier, 1.25);
    assert.equal(metadata.expires_at, 1893456000);
    assert.equal(metadata.auto_pause_on_expired, false);
    assert.equal(metadata.proxies.length, 2);
    assert.equal(metadata.proxies[0].fallback_mode, false);
    assert.equal(metadata.proxies[0].expiry_warn_days, 0);

    const duplicateRecords = parseStandardAccountRecordsFromJson({
      exported_at: '2026-06-08T00:00:00Z',
      proxies: [],
      accounts: [{
        name: 'Changed duplicate name',
        notes: 'must not replace old metadata',
        platform: 'openai',
        type: 'apikey',
        credentials: {
          api_key: 'sk-sub2api-meta',
          base_url: 'https://meta.example.com/v1/'
        }
      }]
    });
    const duplicateResult = importStandardAccountRecords({
      fs,
      path,
      aiHomeDir,
      records: duplicateRecords,
    });
    const metadataAfterDuplicate = readTransferMetadata(fs, aiHomeDir, accountRef).formats.sub2api;

    assert.equal(duplicateResult.imported, 0);
    assert.equal(duplicateResult.duplicates, 1);
    assert.equal(metadataAfterDuplicate.name, 'Codex key from sub2api');
    assert.equal(metadataAfterDuplicate.notes, 'kept for round trip');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importStandardAccountRecords writes opencode auth and deduplicates by auth digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-standard-import-opencode-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const records = parseStandardAccountRecordsFromJson({
      platform: 'opencode',
      type: 'oauth',
      credentials: {
        openai: {
          type: 'api',
          key: 'sk-opencode-openai'
        },
        anthropic: {
          type: 'api',
          key: 'sk-opencode-anthropic'
        }
      }
    });

    const first = importStandardAccountRecords({
      fs,
      path,
      aiHomeDir,
      records,
    });
    const second = importStandardAccountRecords({
      fs,
      path,
      aiHomeDir,
      records,
    });
    const accountRef = resolveTestAccountRef(aiHomeDir, 'opencode', '1');
    const auth = readAccountNativeAuth(fs, aiHomeDir, accountRef).auth;

    assert.equal(first.imported, 1);
    assert.equal(first.failed, 0);
    assert.equal(second.imported, 0);
    assert.equal(second.duplicates, 1);
    assert.deepEqual(Object.keys(auth).sort(), ['anthropic', 'openai']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportSub2ApiData restores sub2api account metadata and deduplicates proxies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-standard-export-sub2api-meta-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const env = {
      OPENAI_API_KEY: 'sk-export-meta',
      OPENAI_BASE_URL: 'https://export.example.com/v1/'
    };
    const accountRef = registerApiKeyAccount(aiHomeDir, 'codex', '1', env);
    writeAccountCredentials(fs, aiHomeDir, accountRef, env);
    writeTransferMetadata(fs, aiHomeDir, accountRef, {
      version: 1,
      formats: {
        sub2api: {
          name: 'Restored sub2api name',
          notes: 'export note',
          extra: {
            owner: 'ops',
            ai_home_provider: 'codex',
            ai_home_account_id: '1',
            profileDir: '/Users/model/.ai_home/profiles/codex/1',
            configDir: '/Users/model/.ai_home/profiles/codex/1/.codex'
          },
          proxy_key: 'proxy-main',
          concurrency: 0,
          priority: 7,
          rate_multiplier: 1.5,
          expires_at: 1893456000,
          auto_pause_on_expired: false,
          proxies: [
            {
              proxy_key: 'proxy-main',
              name: 'Main proxy',
              protocol: 'http',
              host: 'proxy.local',
              port: 8080,
              status: 'active',
              fallback_mode: false,
              expiry_warn_days: 0
            },
            {
              proxy_key: 'proxy-main',
              name: 'Duplicate proxy'
            },
            {
              proxy_key: 'proxy-backup',
              name: 'Backup proxy',
              protocol: 'socks5',
              host: 'backup.local',
              port: 1080,
              status: 'inactive'
            }
          ]
        }
      }
    });

    const service = createStandardFormatExportService({ fs, path, aiHomeDir });
    const outPath = path.join(root, 'sub2api.json');
    const result = service.exportSub2ApiData({ outPath, providers: ['codex'] });
    const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const account = payload.accounts[0];

    assert.equal(result.accounts, 1);
    assert.equal(result.proxies, 2);
    assert.equal(account.name, 'Restored sub2api name');
    assert.equal(account.notes, 'export note');
    assert.equal(account.proxy_key, 'proxy-main');
    assert.equal(account.concurrency, 0);
    assert.equal(account.priority, 7);
    assert.equal(account.rate_multiplier, 1.5);
    assert.equal(account.expires_at, 1893456000);
    assert.equal(account.auto_pause_on_expired, false);
    assert.deepEqual(account.extra, { owner: 'ops' });
    assert.deepEqual(payload.proxies.map((proxy) => proxy.proxy_key), ['proxy-main', 'proxy-backup']);
    assert.equal(payload.proxies[0].fallback_mode, 'none');
    assert.equal(payload.proxies[0].expiry_warn_days, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportAntigravityManagerAccounts writes Antigravity-Manager accounts JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-standard-export-agy-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const accountRef = registerOAuthAccount(aiHomeDir, 'agy', '7', 'agy@example.com');
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { oauthToken: {
      auth_method: 'oauth',
      token: {
        access_token: 'agy-access',
        refresh_token: 'agy-refresh'
      }
    }, email: 'agy@example.com' });

    const service = createStandardFormatExportService({ fs, path, aiHomeDir });
    const outPath = path.join(root, 'antigravity.json');
    const result = service.exportAntigravityManagerAccounts({ outPath });
    const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));

    assert.equal(result.accounts, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'variant'), false);
    assert.deepEqual(payload, {
      accounts: [
        {
          email: 'agy@example.com',
          refresh_token: 'agy-refresh'
        }
      ]
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportAntigravityManagerAccounts keeps refresh-token accounts without email cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-standard-export-agy-no-email-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const accountRef = registerTestAccount(
      aiHomeDir,
      'agy',
      '8',
      `oauth:agy:refresh:${hashApiKeySecret('agy-refresh-only')}`
    );
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { oauthToken: {
      auth_method: 'oauth',
      token: {
        refresh_token: 'agy-refresh-only'
      }
    } });

    const service = createStandardFormatExportService({ fs, path, aiHomeDir });
    const outPath = path.join(root, 'antigravity.json');
    const result = service.exportAntigravityManagerAccounts({ outPath });
    const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));

    assert.equal(result.accounts, 1);
    assert.deepEqual(payload, {
      accounts: [
        {
          email: '',
          refresh_token: 'agy-refresh-only'
        }
      ]
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importStandardAccountRecords rejects Antigravity api-key records from sub2api data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-standard-import-agy-key-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const records = parseStandardAccountRecordsFromJson({
      exported_at: '2026-06-08T00:00:00Z',
      proxies: [],
      accounts: [{
        name: 'agy key',
        platform: 'antigravity',
        type: 'apikey',
        credentials: {
          api_key: 'sk-agy-unsupported',
          base_url: 'https://agy.example.com'
        }
      }]
    });
    const result = importStandardAccountRecords({
      fs,
      path,
      aiHomeDir,
      records,
    });

    assert.equal(records.length, 1);
    assert.equal(result.imported, 0);
    assert.equal(result.invalid, 1);
    assert.deepEqual(result.accounts, [{
      provider: 'agy',
      accountRef: '',
      status: 'invalid',
      reason: 'unsupported_api_key_provider'
    }]);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'agy', '1')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importStandardAccountRecords stores flat Gemini OAuth records in native credential layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-standard-import-gemini-flat-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const records = parseStandardAccountRecordsFromJson({
      platform: 'gemini',
      type: 'oauth',
      credentials: {
        email: 'gemini-flat@example.com',
        access_token: 'gemini-access',
        refresh_token: 'gemini-refresh',
        id_token: 'gemini-id',
        client_id: 'gemini-client',
        expires_at: 1893456000000
      }
    });

    const result = importStandardAccountRecords({
      fs,
      path,
      aiHomeDir,
      records,
    });
    const accountRef = resolveTestAccountRef(aiHomeDir, 'gemini', '1');
    const oauth = readAccountNativeAuth(fs, aiHomeDir, accountRef).oauthCreds;
    const runtimeAccounts = loadGeminiServerAccounts({
      fs,
      aiHomeDir,
      checkStatus: (_provider, candidateRef) => ({
        configured: candidateRef === accountRef,
        accountName: 'gemini-flat@example.com'
      })
    });

    assert.equal(result.imported, 1);
    assert.equal(oauth.access_token, 'gemini-access');
    assert.equal(oauth.refresh_token, 'gemini-refresh');
    assert.equal(oauth.id_token, 'gemini-id');
    assert.equal(oauth.client_id, 'gemini-client');
    assert.equal(oauth.email, 'gemini-flat@example.com');
    assert.equal(Object.prototype.hasOwnProperty.call(oauth, 'credentials'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(oauth, 'platform'), false);
    assert.equal(runtimeAccounts.length, 1);
    assert.equal(runtimeAccounts[0].accessToken, 'gemini-access');
    assert.equal(runtimeAccounts[0].email, 'gemini-flat@example.com');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importStandardAccountRecords stores flat Antigravity OAuth records in native credential layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-standard-import-agy-flat-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const records = parseStandardAccountRecordsFromJson({
      platform: 'antigravity',
      type: 'oauth',
      credentials: {
        email: 'agy-flat@example.com',
        access_token: 'agy-access',
        refresh_token: 'agy-refresh',
        expires_at: '2030-01-01T00:00:00.000Z'
      }
    });

    const result = importStandardAccountRecords({
      fs,
      path,
      aiHomeDir,
      records,
    });
    const accountRef = resolveTestAccountRef(aiHomeDir, 'agy', '1');
    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
    const auth = nativeAuth.oauthToken;
    const email = nativeAuth.email;
    const runtimeAccounts = loadAgyServerAccounts({
      fs,
      aiHomeDir,
      checkStatus: (_provider, candidateRef) => ({
        configured: candidateRef === accountRef,
        accountName: 'agy-flat@example.com'
      })
    });

    assert.equal(result.imported, 1);
    assert.equal(auth.auth_method, 'consumer');
    assert.equal(auth.token.access_token, 'agy-access');
    assert.equal(auth.token.refresh_token, 'agy-refresh');
    assert.equal(auth.token.expiry, '2030-01-01T00:00:00.000Z');
    assert.equal(email, 'agy-flat@example.com');
    assert.equal(Object.prototype.hasOwnProperty.call(auth, 'credentials'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(auth, 'platform'), false);
    assert.equal(runtimeAccounts.length, 1);
    assert.equal(runtimeAccounts[0].accessToken, 'agy-access');
    assert.equal(runtimeAccounts[0].refreshToken, 'agy-refresh');
    assert.equal(runtimeAccounts[0].email, 'agy-flat@example.com');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
