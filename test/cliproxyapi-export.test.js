const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCliproxyapiExportService } = require('../lib/cli/services/backup/cliproxyapi-export');
const {
  importStandardAccountRecords,
  parseStandardAccountRecordsFromJson
} = require('../lib/account/standard-transfer');
const {
  hasAccountCredentials,
  readAccountCredentials,
  readAccountNativeAuth,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { normalizeIdentitySeed } = require('../lib/account/account-identity');
const { buildApiKeyIdentity } = require('../lib/account/transfer-core');
const { resolveAccountRefByCliId } = require('../lib/server/account-ref-store');
const { readTransferMetadata } = require('../lib/account/transfer-metadata-store');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
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
  const identitySeed = normalizeIdentitySeed(buildApiKeyIdentity(provider, env));
  return registerTestAccount(aiHomeDir, provider, cliAccountId, identitySeed);
}

function resolveTestAccountRef(aiHomeDir, provider, cliAccountId) {
  const record = resolveAccountRefByCliId(fs, aiHomeDir, provider, cliAccountId);
  assert.ok(record, `missing ${provider} CLI account ${cliAccountId}`);
  return record.accountRef;
}

test('exportCliproxyapiData writes portable data without syncing host config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-data-export-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const outPath = path.join(root, 'cliproxyapi-data.json');
    const idToken = makeJwt({ email: 'worker@example.com', exp: 1773000000 });
    const accessToken = makeJwt({
      exp: 1774000000,
      'https://api.openai.com/profile': { email: 'worker@example.com' }
    });
    const codexAccountRef = registerOAuthAccount(aiHomeDir, 'codex', '1', 'worker@example.com');
    writeAccountNativeAuth(fs, aiHomeDir, codexAccountRef, { auth: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: 'rt_worker',
        account_id: 'acct-worker'
      },
      last_refresh: '2026-03-08T08:00:00.000Z'
    } });
    const geminiEnv = {
      GEMINI_API_KEY: 'sk-gemini',
      GEMINI_BASE_URL: 'https://gemini.example.com'
    };
    const geminiAccountRef = registerApiKeyAccount(aiHomeDir, 'gemini', '2', geminiEnv);
    writeAccountCredentials(fs, aiHomeDir, geminiAccountRef, geminiEnv);

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.exportCliproxyapiData({
      outPath,
      apiKeyProviders: ['codex', 'gemini']
    });
    const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const records = parseStandardAccountRecordsFromJson(payload);

    assert.equal(result.accounts, 2);
    assert.equal(result.oauthAccounts, 1);
    assert.equal(result.apiKeys, 1);
    assert.equal(payload.type, 'cliproxyapi-data');
    assert.equal(payload.accounts.some((account) => account.type === 'oauth' && account.email === 'worker@example.com'), true);
    assert.equal(payload.accounts.some((account) => account.type === 'api-key' && account.provider === 'gemini'), true);
    assert.equal(records.length, 2);

    const targetAiHomeDir = path.join(root, '.target_ai_home');
    const importResult = importStandardAccountRecords({
      fs,
      path,
      aiHomeDir: targetAiHomeDir,
      records,
    });
    assert.equal(importResult.imported, 2);
    assert.equal(importResult.invalid, 0);
    const importedCodexRef = resolveTestAccountRef(targetAiHomeDir, 'codex', '1');
    const importedGeminiRef = resolveTestAccountRef(targetAiHomeDir, 'gemini', '1');
    const importedCodexAuth = readAccountNativeAuth(fs, targetAiHomeDir, importedCodexRef).auth;
    const importedGeminiEnv = readAccountCredentials(fs, targetAiHomeDir, importedGeminiRef);
    assert.equal(importedCodexAuth.email, 'worker@example.com');
    assert.equal(importedCodexAuth.tokens.refresh_token, 'rt_worker');
    assert.equal(importedGeminiEnv.GEMINI_API_KEY, 'sk-gemini');
    assert.equal(importedGeminiEnv.GEMINI_BASE_URL, 'https://gemini.example.com');
    assert.equal(fs.existsSync(path.join(hostHomeDir, '.cli-proxy-api', 'config.yaml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths imports codex oauth auth files from local CLIProxyAPI auth-dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const authDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(authDir, { recursive: true });

    writeJson(path.join(authDir, 'worker@example.com.json'), {
      type: 'codex',
      email: 'worker@example.com',
      id_token: makeJwt({ email: 'worker@example.com', exp: 1773000000 }),
      access_token: makeJwt({ exp: 1774000000 }),
      refresh_token: 'rt_worker',
      account_id: 'acct-worker',
      last_refresh: '2026-03-08T08:00:00.000Z'
    });
    writeJson(path.join(authDir, 'dupe@example.com.json'), {
      type: 'codex',
      email: 'dupe@example.com',
      id_token: makeJwt({ email: 'dupe@example.com', exp: 1773000001 }),
      access_token: makeJwt({ exp: 1774000001 }),
      refresh_token: 'rt_dupe',
      account_id: 'acct-dupe',
      last_refresh: '2026-03-08T08:00:01.000Z'
    });
    const existingAccountRef = registerOAuthAccount(aiHomeDir, 'codex', '1', 'dupe@example.com');
    writeAccountNativeAuth(fs, aiHomeDir, existingAccountRef, { auth: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: makeJwt({ email: 'dupe@example.com', exp: 1773000001 }),
        access_token: makeJwt({ exp: 1774000001 }),
        refresh_token: 'rt_dupe',
        account_id: 'acct-dupe'
      },
      last_refresh: '2026-03-08T08:00:01.000Z'
    } });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.importCliproxyapiCodexAuths();

    assert.equal(result.scanned, 2);
    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.invalid, 0);
    const importedAccountRef = resolveTestAccountRef(aiHomeDir, 'codex', '2');
    assert.equal(readAccountNativeAuth(fs, aiHomeDir, importedAccountRef).auth.tokens.refresh_token, 'rt_worker');
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '2')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths skips same-email oauth account when incoming credential expires later', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const authDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(authDir, { recursive: true });

    writeJson(path.join(authDir, 'worker@example.com.json'), {
      type: 'codex',
      email: 'worker@example.com',
      id_token: makeJwt({ email: 'worker@example.com', exp: 1775000000 }),
      access_token: makeJwt({ exp: 1775500000 }),
      refresh_token: 'rt_worker_new',
      account_id: 'acct-worker-new',
      last_refresh: '2026-03-08T12:00:00.000Z',
      expired: new Date(1775500000 * 1000).toISOString()
    });

    const existingAccountRef = registerOAuthAccount(aiHomeDir, 'codex', '1', 'worker@example.com');
    writeAccountNativeAuth(fs, aiHomeDir, existingAccountRef, { auth: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: makeJwt({ email: 'worker@example.com', exp: 1772000000 }),
        access_token: makeJwt({ exp: 1772500000 }),
        refresh_token: 'rt_worker_old',
        account_id: 'acct-worker-old'
      },
      last_refresh: '2026-03-08T09:00:00.000Z'
    } });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.importCliproxyapiCodexAuths();

    assert.equal(result.imported, 0);
    assert.equal(result.duplicates, 1);
    assert.deepEqual(result.importedIds, []);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '2')), false);
    const updated = readAccountNativeAuth(fs, aiHomeDir, existingAccountRef).auth;
    assert.equal(updated.tokens.refresh_token, 'rt_worker_old');
    assert.equal(updated.tokens.account_id, 'acct-worker-old');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths stores first account without creating a provider root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const authDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(authDir, { recursive: true });

    writeJson(path.join(authDir, 'worker@example.com.json'), {
      type: 'codex',
      email: 'worker@example.com',
      id_token: makeJwt({ email: 'worker@example.com' }),
      access_token: makeJwt({ exp: 1778000000 }),
      refresh_token: 'rt_worker_token',
      account_id: 'acct-worker',
      last_refresh: '2026-03-08T12:00:00.000Z'
    });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });

    const result = service.importCliproxyapiCodexAuths();
    assert.equal(result.imported, 1);
    assert.equal(result.failed, 0);
    const importedAccountRef = resolveTestAccountRef(aiHomeDir, 'codex', '1');
    assert.equal(readAccountNativeAuth(fs, aiHomeDir, importedAccountRef).auth.tokens.refresh_token, 'rt_worker_token');
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths imports codex-api-key config entries into api-key accounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const configDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'auth-dir: "~/.cli-proxy-api"',
      'codex-api-key:',
      '  - api-key: "sk-import"',
      '    base-url: "https://clip.example.com/v1"',
      ''
    ].join('\n'));

    const hookEvents = [];
    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer,
      accountArtifactHooks: {
        snapshotAccountAuthArtifacts: (provider, accountRef) => ({ provider, accountRef, before: true }),
        notifyDefaultAccountAuthUpdatedIfChanged: (event) => hookEvents.push(event)
      }
    });
    const result = service.importCliproxyapiCodexAuths();

    assert.equal(result.scanned, 1);
    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 0);
    const accountRef = resolveTestAccountRef(aiHomeDir, 'codex', '1');
    const env = readAccountCredentials(fs, aiHomeDir, accountRef);
    assert.deepEqual(env, {
      OPENAI_API_KEY: 'sk-import',
      OPENAI_BASE_URL: 'https://clip.example.com/v1'
    });
    assert.deepEqual(readAccountNativeAuth(fs, aiHomeDir, accountRef), {});
    assert.equal(hookEvents.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths preserves CLIProxyAPI api-key routing metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-metadata-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const configDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'auth-dir: "~/.cli-proxy-api"',
      'gemini-api-key:',
      '  - api-key: "sk-gemini-meta"',
      '    prefix: "team-a"',
      '    disable-cooling: true',
      '    base-url: "https://gemini.example.com"',
      '    headers:',
      '      X-Custom-Header: "custom-value"',
      '    proxy-url: "direct"',
      '    models:',
      '      - name: "gemini-2.5-flash"',
      '        alias: "gemini-flash"',
      '    excluded-models:',
      '      - "gemini-2.5-pro"',
      ''
    ].join('\n'));

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.importCliproxyapiCodexAuths({
      apiKeyProviders: ['gemini']
    });

    assert.equal(result.imported, 1);
    const accountRef = resolveTestAccountRef(aiHomeDir, 'gemini', '1');
    const metadata = readTransferMetadata(fs, aiHomeDir, accountRef);
    assert.deepEqual(metadata.formats.cliproxyapi.gemini.apiKey, {
      prefix: 'team-a',
      'disable-cooling': true,
      headers: {
        'X-Custom-Header': 'custom-value'
      },
      'proxy-url': 'direct',
      models: [{
        name: 'gemini-2.5-flash',
        alias: 'gemini-flash'
      }],
      'excluded-models': ['gemini-2.5-pro']
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});



test('importCliproxyapiCodexAuths imports gemini and claude api-key config entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const configDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'auth-dir: "~/.cli-proxy-api"',
      'gemini-api-key:',
      '  - api-key: "sk-gemini-import"',
      '    base-url: "https://gemini.example.com"',
      'claude-api-key:',
      '  - api-key: "sk-claude-import"',
      '    base-url: "https://claude.example.com"',
      ''
    ].join('\n'));

    const hookEvents = [];
    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer,
      accountArtifactHooks: {
        snapshotAccountAuthArtifacts: (provider, accountRef) => ({ provider, accountRef, before: true }),
        notifyDefaultAccountAuthUpdatedIfChanged: (event) => hookEvents.push(event)
      }
    });
    const result = service.importCliproxyapiCodexAuths({
      apiKeyProviders: ['gemini', 'claude']
    });

    assert.equal(result.scanned, 2);
    assert.equal(result.imported, 2);
    assert.deepEqual(result.providers, ['claude', 'gemini']);
    const geminiAccountRef = resolveTestAccountRef(aiHomeDir, 'gemini', '1');
    const claudeAccountRef = resolveTestAccountRef(aiHomeDir, 'claude', '1');
    assert.deepEqual(
      readAccountCredentials(fs, aiHomeDir, geminiAccountRef),
      {
        GEMINI_API_KEY: 'sk-gemini-import',
        GEMINI_BASE_URL: 'https://gemini.example.com'
      }
    );
    assert.deepEqual(
      readAccountCredentials(fs, aiHomeDir, claudeAccountRef),
      {
        ANTHROPIC_API_KEY: 'sk-claude-import',
        ANTHROPIC_BASE_URL: 'https://claude.example.com'
      }
    );
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'gemini', '1', '.gemini', 'auth.json')), false);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'claude', '1', '.claude', 'auth.json')), false);
    assert.equal(hookEvents.length, 2);
    assert.deepEqual(hookEvents.map((item) => item.provider).sort(), ['claude', 'gemini']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths honors provider-scoped api-key imports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const configDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'gemini-api-key:',
      '  - api-key: "sk-gemini-only"',
      'claude-api-key:',
      '  - api-key: "sk-claude-skip"',
      ''
    ].join('\n'));

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.importCliproxyapiCodexAuths({
      apiKeyProviders: ['gemini']
    });

    assert.equal(result.imported, 1);
    assert.deepEqual(result.providers, ['gemini']);
    const geminiAccountRef = resolveTestAccountRef(aiHomeDir, 'gemini', '1');
    assert.equal(hasAccountCredentials(fs, aiHomeDir, geminiAccountRef), true);
    assert.equal(resolveAccountRefByCliId(fs, aiHomeDir, 'claude', '1'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths skips duplicate codex-api-key config entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const configDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'codex-api-key:',
      '  - api-key: "sk-same"',
      '    base-url: "https://clip.example.com/v1/"',
      ''
    ].join('\n'));
    const existingEnv = {
      OPENAI_API_KEY: 'sk-same',
      OPENAI_BASE_URL: 'https://clip.example.com/v1'
    };
    const existingAccountRef = registerApiKeyAccount(aiHomeDir, 'codex', '1', existingEnv);
    writeAccountCredentials(fs, aiHomeDir, existingAccountRef, existingEnv);

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.importCliproxyapiCodexAuths();

    assert.equal(result.imported, 0);
    assert.equal(result.duplicates, 1);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '2')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths imports openai-compatibility api-key entries with routing metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-compat-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const configDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'auth-dir: "~/.cli-proxy-api"',
      'openai-compatibility:',
      '  - name: "deepseek"',
      '    prefix: "ds"',
      '    disabled: false',
      '    disable-cooling: true',
      '    base-url: "https://deepseek.example.com/v1"',
      '    headers:',
      '      X-Test: "1"',
      '    api-key-entries:',
      '      - api-key: "sk-compat"',
      '        proxy-url: "socks5://proxy.example.com:1080"',
      '    models:',
      '      - name: "deepseek-chat"',
      '        alias: "gpt-compat"',
      ''
    ].join('\n'));

    const hookEvents = [];
    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer,
      accountArtifactHooks: {
        snapshotAccountAuthArtifacts: (provider, accountRef) => ({ provider, accountRef, before: true }),
        notifyDefaultAccountAuthUpdatedIfChanged: (event) => hookEvents.push(event)
      }
    });
    const result = service.importCliproxyapiCodexAuths();

    assert.equal(result.scanned, 1);
    assert.equal(result.imported, 1);
    assert.deepEqual(result.providers, ['openai-compatibility']);
    const accountRef = resolveTestAccountRef(aiHomeDir, 'codex', '1');
    const env = readAccountCredentials(fs, aiHomeDir, accountRef);
    const metadata = readTransferMetadata(fs, aiHomeDir, accountRef);
    assert.deepEqual(env, {
      OPENAI_API_KEY: 'sk-compat',
      OPENAI_BASE_URL: 'https://deepseek.example.com/v1'
    });
    assert.deepEqual(readAccountNativeAuth(fs, aiHomeDir, accountRef), {});
    assert.deepEqual(metadata.formats.cliproxyapi.openAICompatibility.apiKey, {
      name: 'deepseek',
      prefix: 'ds',
      disabled: false,
      'disable-cooling': true,
      'base-url': 'https://deepseek.example.com/v1',
      headers: {
        'X-Test': '1'
      },
      models: [{
        name: 'deepseek-chat',
        alias: 'gpt-compat'
      }],
      'proxy-url': 'socks5://proxy.example.com:1080'
    });
    assert.equal(hookEvents.length, 1);
    assert.equal(hookEvents[0].provider, 'codex');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths skips duplicate openai-compatibility api-key entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-compat-dupe-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const configDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'openai-compatibility:',
      '  - name: "deepseek"',
      '    base-url: "https://deepseek.example.com/v1/"',
      '    api-key-entries:',
      '      - api-key: "sk-same-compat"',
      ''
    ].join('\n'));
    const existingEnv = {
      OPENAI_API_KEY: 'sk-same-compat',
      OPENAI_BASE_URL: 'https://deepseek.example.com/v1'
    };
    const existingAccountRef = registerApiKeyAccount(aiHomeDir, 'codex', '1', existingEnv);
    writeAccountCredentials(fs, aiHomeDir, existingAccountRef, existingEnv);

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.importCliproxyapiCodexAuths();

    assert.equal(result.imported, 0);
    assert.equal(result.duplicates, 1);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '2')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
