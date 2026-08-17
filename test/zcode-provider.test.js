'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- Provider Catalog ---
const { isKnownProvider, PROVIDER_IDS } = require('../lib/provider-catalog');

test('provider catalog includes zcode and isKnownProvider returns true', () => {
  assert.ok(PROVIDER_IDS.includes('zcode'), 'zcode should be in PROVIDER_IDS');
  assert.equal(isKnownProvider('zcode'), true);
  assert.equal(isKnownProvider('ZCODE'), true, 'case-insensitive');
});

// --- Provider Registry (CLI) ---
const { getAiCliConfig, listSupportedAiClis } = require('../lib/cli/services/ai-cli/provider-registry');

test('getAiCliConfig zcode returns correct CLI configuration', () => {
  const config = getAiCliConfig('zcode');
  assert.ok(config, 'zcode config should exist');
  assert.equal(config.globalDir, '.zcode');
  assert.equal(config.binaryName, 'zcode');
  assert.equal(config.pkg, '');
  assert.deepEqual(config.loginArgs, ['login']);
});

test('listSupportedAiClis includes zcode', () => {
  const clis = listSupportedAiClis();
  assert.ok(clis.includes('zcode'), 'zcode should be in supported CLIs');
});

// --- Credential module (encryption envelope) ---
const {
  decryptZcodeCredentialValue,
  encryptZcodeCredentialValue,
  isEncryptedZcodeCredentialValue,
  readZcodeApiProviderConfig,
  readZcodeOAuthCredential
} = require('../lib/account/zcode-credential');

test('zcode credential values round-trip through the enc:v1 envelope', () => {
  const cipher = encryptZcodeCredentialValue('secret-token-value');
  assert.ok(isEncryptedZcodeCredentialValue(cipher));
  assert.equal(decryptZcodeCredentialValue(cipher), 'secret-token-value');
  assert.equal(decryptZcodeCredentialValue('plain-value'), 'plain-value');
});

test('readZcodeOAuthCredential decrypts shared credentials.json fields', () => {
  const userInfo = JSON.stringify({ user_id: 'u-123', email: 'user@example.com', name: 'User' });
  const nativeAuth = {
    credentials: {
      'oauth:active_provider': 'zai',
      'oauth:zai:access_token': encryptZcodeCredentialValue('zai-access-token'),
      'oauth:zai:user_info': encryptZcodeCredentialValue(userInfo),
      zcodejwttoken: encryptZcodeCredentialValue('jwt-token')
    }
  };
  const credential = readZcodeOAuthCredential(nativeAuth);
  assert.equal(credential.configured, true);
  assert.equal(credential.activeProvider, 'zai');
  assert.equal(credential.accessToken, 'zai-access-token');
  assert.equal(credential.jwtToken, 'jwt-token');
  assert.equal(credential.userInfo.user_id, 'u-123');
});

test('readZcodeOAuthCredential returns unconfigured for garbage ciphertext', () => {
  const credential = readZcodeOAuthCredential({
    credentials: { zcodejwttoken: 'enc:v1:broken.broken.broken' }
  });
  assert.equal(credential.configured, false);
});

test('readZcodeApiProviderConfig finds the first api-key provider entry', () => {
  const config = readZcodeApiProviderConfig({
    config: {
      provider: {
        'builtin:zai': { options: { apiKey: '', baseURL: 'https://api.z.ai/api/anthropic' } },
        'builtin:bigmodel': {
          options: { apiKey: 'bm-key', baseURL: 'https://open.bigmodel.cn/api/anthropic' }
        }
      }
    }
  });
  assert.equal(config.providerId, 'builtin:bigmodel');
  assert.equal(config.apiKey, 'bm-key');
  assert.equal(config.baseURL, 'https://open.bigmodel.cn/api/anthropic');
});

// --- Account Identity ---
const { buildZcodeIdentitySeed, detectIdentityKind } = require('../lib/account/account-identity');

test('buildZcodeIdentitySeed prefers decrypted user_info id and stays stable', () => {
  const nativeAuth = {
    credentials: {
      'oauth:zai:user_info': encryptZcodeCredentialValue(JSON.stringify({ user_id: 'user-42', email: 'a@b.c' })),
      zcodejwttoken: encryptZcodeCredentialValue('jwt')
    }
  };
  const seed = buildZcodeIdentitySeed(nativeAuth.credentials);
  assert.ok(seed.startsWith('oauth:zcode:user:'), seed);
  assert.equal(seed, buildZcodeIdentitySeed(nativeAuth.credentials), 'seed must be stable');
});

test('zcode account with ZCODE_API_KEY is detected as api-key type', (t) => {
  const { aiHomeDir, register } = createZcodeFixture(t);
  const accountRef = register('zcode', '1', { ZCODE_API_KEY: 'zcode-test-key' });
  const kind = detectIdentityKind({ fs, aiHomeDir, provider: 'zcode', accountRef });
  assert.equal(kind, 'api-key');
});

// --- Storage policy ---
const {
  getProviderStoragePolicy,
  getProviderPrivateEntryNames,
  getProviderSharedEntries
} = require('../lib/runtime/provider-storage-policy');

test('zcode storage policy isolates v2 and shares cli/workspace', () => {
  const policy = getProviderStoragePolicy('zcode');
  assert.ok(policy, 'zcode policy should exist');
  assert.deepEqual(policy.nativeRoot, ['.zcode']);
  assert.deepEqual(getProviderSharedEntries('zcode'), ['cli', 'workspace']);
  assert.ok(getProviderPrivateEntryNames('zcode').includes('v2'), 'v2 must stay account-private');
});

// --- Model family inference ---
const { inferProviderFromModel } = require('../lib/server/providers');
const { __private: providerRoutingPrivate } = require('../lib/server/provider-routing');

test('inferProviderFromModel routes glm and zcode models to zcode', () => {
  assert.equal(inferProviderFromModel('GLM-5.3'), 'zcode');
  assert.equal(inferProviderFromModel('glm-5-turbo'), 'zcode');
  assert.equal(inferProviderFromModel('zcode-main'), 'zcode');
  assert.equal(inferProviderFromModel('gpt-4o'), 'codex', 'non-glm stays codex');
  assert.equal(providerRoutingPrivate.inferKnownProviderFamily('glm-5.2'), 'zcode');
});

// --- Protocol route (passthrough) ---
const {
  resolveDirectProviderProtocolRoute,
  resolveProviderProtocolRouteForClientRequest
} = require('../lib/server/provider-protocol-routing');

test('zcode has an anthropic_messages passthrough route', () => {
  const route = resolveDirectProviderProtocolRoute('anthropic_messages', 'zcode');
  assert.ok(route, 'route should exist');
  assert.equal(route.transport, 'provider_passthrough');
  assert.equal(route.upstreamProtocol, 'anthropic_messages');
  assert.equal(route.requestAdapter, null);
  assert.equal(route.responseAdapter, null);
  const bridged = resolveProviderProtocolRouteForClientRequest('openai_chat', 'zcode', { model: 'glm-5.3' });
  assert.ok(bridged, 'openai clients should bridge onto the anthropic route');
});

// --- Upstream base URL ---
const { resolveProviderApiBaseUrl, ZCODE_DEFAULT_BASE_URL } = require('../lib/account/provider-api-base-url');

test('zcode api base url defaults to bigmodel and honours account override', () => {
  assert.equal(ZCODE_DEFAULT_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(resolveProviderApiBaseUrl('zcode', null), ZCODE_DEFAULT_BASE_URL);
  assert.equal(
    resolveProviderApiBaseUrl('zcode', { openaiBaseUrl: 'https://api.z.ai/api/anthropic' }),
    'https://api.z.ai/api/anthropic'
  );
});

// --- Server Accounts loader (api-key only gateway pool) ---
const { loadZcodeServerAccounts } = require('../lib/server/accounts');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { writeAccountCredentials, writeAccountNativeAuth } = require('../lib/server/account-credential-store');

function createZcodeFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-test-'));
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

test('loadZcodeServerAccounts returns api-key account with default bigmodel base url', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createZcodeFixture(t);
  register('zcode', '1', { ZCODE_API_KEY: 'zcode-key-abc' });

  const accounts = loadZcodeServerAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  const account = accounts[0];
  assert.equal(account.provider, 'zcode');
  assert.equal(account.authType, 'api-key');
  assert.equal(account.apiKeyMode, true);
  assert.equal(account.accessToken, 'zcode-key-abc');
  assert.equal(account.openaiBaseUrl, ZCODE_DEFAULT_BASE_URL);
});

test('loadZcodeServerAccounts honours account ZCODE_BASE_URL override', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createZcodeFixture(t);
  register('zcode', '1', {
    ZCODE_API_KEY: 'zcode-key-abc',
    ZCODE_BASE_URL: 'https://api.z.ai/api/anthropic'
  });

  const accounts = loadZcodeServerAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].openaiBaseUrl, 'https://api.z.ai/api/anthropic');
});

test('loadZcodeServerAccounts admits OAuth accounts as probe-only, non-schedulable pool members', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createZcodeFixture(t);
  register('zcode', '1', null, {
    credentials: {
      'oauth:zai:access_token': encryptZcodeCredentialValue('oauth-token'),
      zcodejwttoken: encryptZcodeCredentialValue('jwt-token')
    }
  });

  const accounts = loadZcodeServerAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1, 'OAuth plan accounts enter the pool for model catalog probing');
  const account = accounts[0];
  assert.equal(account.provider, 'zcode');
  assert.equal(account.authType, 'oauth');
  assert.equal(account.apiKeyMode, false);
  // 模型探测凭据是 zai accessToken（jwtToken 调 api.z.ai 实测 401）。
  assert.equal(account.accessToken, 'oauth-token');
  // 已实证免验证码的模型列表端点（base 以 /v4 结尾，探测走 <base>/models）。
  assert.equal(account.openaiBaseUrl, 'https://api.z.ai/api/coding/paas/v4');
  // 计划推理端点每请求强制阿里云验证码， relay 不可用前不参与推理调度。
  assert.equal(account.schedulableStatus, 'oauth_relay_unsupported');
  assert.equal(account.displayName, 'ZCode OAuth');
});

test('loadZcodeServerAccounts uses zai user_info email as OAuth display identity', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createZcodeFixture(t);
  register('zcode', '1', null, {
    credentials: {
      'oauth:zai:access_token': encryptZcodeCredentialValue('oauth-token'),
      'oauth:zai:user_info': encryptZcodeCredentialValue(JSON.stringify({
        user_id: 'u-123',
        email: '18997991630@phone.local'
      }))
    }
  });

  const accounts = loadZcodeServerAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].email, '18997991630@phone.local');
  assert.equal(accounts[0].displayName, '18997991630@phone.local');
});

test('loadZcodeServerAccounts skips OAuth accounts without a usable zai access token', (t) => {
  const { aiHomeDir, accountStateIndex, register } = createZcodeFixture(t);
  register('zcode', '1', null, {
    credentials: {
      zcodejwttoken: encryptZcodeCredentialValue('jwt-token')
    }
  });

  const accounts = loadZcodeServerAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 0, 'jwtToken-only accounts cannot probe models and stay out of the pool');
});

// --- Launch strategy ---
const { zcodeStrategy } = require('../lib/cli/services/ai-cli/launch-profile/zcode-strategy');

test('zcode launch strategy points ZCODE_DATA_BASE_DIR at the sandbox .zcode dir', () => {
  const ctx = {
    sandboxDir: 'C:\\proj\\.aih\\accounts\\z-1',
    path,
    baseEnv: {},
    isLogin: false
  };
  const patch = zcodeStrategy.buildEnvPatch(ctx);
  assert.equal(patch.set.ZCODE_DATA_BASE_DIR, path.join(ctx.sandboxDir, '.zcode'));
  assert.deepEqual(patch.unset, []);
});

test('zcode launch strategy prepare creates the data dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-strategy-'));
  try {
    const dataDir = path.join(root, '.zcode');
    zcodeStrategy.prepare({ fs, zcodeDataBaseDir: dataDir });
    assert.ok(fs.statSync(dataDir).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Artifact hook registration ---
const { createDefaultProviderArtifactHookRegistry } = require('../lib/account/artifact-hooks/registry');

test('zcode artifact hook strategy is registered with credential paths', () => {
  const registry = createDefaultProviderArtifactHookRegistry({});
  const strategy = registry.get('zcode');
  assert.ok(strategy, 'zcode strategy should be registered');
  assert.deepEqual(strategy.getAuthArtifactRelativePaths(), [
    '.zcode/v2/credentials.json',
    '.zcode/v2/config.json'
  ]);
});

// --- Session store (SQLite) ---
const {
  readZcodeProjects,
  readZcodeSessionMessages,
  readZcodeSessionModel
} = require('../lib/sessions/zcode-session-store');

function createZcodeSessionDb(dir) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return '';
  }
  const dbPath = path.join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, path TEXT,'
    + ' title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT);'
    + 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,'
    + ' sequence INTEGER, data TEXT);'
    + 'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,'
    + ' sequence INTEGER, data TEXT);'
  );
  db.prepare(
    'INSERT INTO session (id, parent_id, directory, path, title, time_created, time_updated, task_type)'
    + " VALUES ('sess_main', NULL, ?, ?, '主会话', 1000, 2000, 'interactive')"
  ).run(dir, dir);
  db.prepare(
    'INSERT INTO session (id, parent_id, directory, path, title, time_created, time_updated, task_type)'
    + " VALUES ('sess_child', 'sess_main', ?, ?, '子会话', 1500, 1600, 'subagent_child')"
  ).run(dir, dir);
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, sequence, data) VALUES (?, ?, ?, ?, ?)'
  ).run('msg-1', 'sess_main', 1100, 0, JSON.stringify({ role: 'user' }));
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, sequence, data) VALUES (?, ?, ?, ?, ?)'
  ).run('msg-2', 'sess_main', 1200, 1, JSON.stringify({ role: 'assistant', model: 'GLM-5.3' }));
  db.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
    .run('part-1', 'msg-1', 'sess_main', 0, JSON.stringify({ type: 'text', text: '你好' }));
  db.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
    .run('part-2', 'msg-2', 'sess_main', 0, JSON.stringify({ type: 'text', text: '世界' }));
  db.close();
  return dbPath;
}

test('zcode session store reads projects, hides subagents, and parses messages', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = createZcodeSessionDb(dir);
  if (!dbPath) return; // node without node:sqlite skips silently

  const projects = readZcodeProjects(dbPath);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].provider, 'zcode');
  assert.equal(projects[0].sessions.length, 1, 'subagent sessions stay hidden');
  assert.equal(projects[0].sessions[0].id, 'sess_main');
  assert.equal(projects[0].sessions[0].title, '主会话');

  const messages = readZcodeSessionMessages(dbPath, 'sess_main');
  assert.deepEqual(messages, [
    { role: 'user', content: '你好', timestamp: 1100, model: undefined },
    { role: 'assistant', content: '世界', timestamp: 1200, model: 'GLM-5.3' }
  ]);
  assert.equal(readZcodeSessionModel(dbPath, 'sess_main'), 'GLM-5.3');
});
