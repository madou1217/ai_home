'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectHostAccounts } = require('../lib/account/host-account-detectors');
const { createGenericHostAccountSync } = require('../lib/account/host-account-sync/generic-host-account-sync');
const { createSelfWriteGuard } = require('../lib/account/host-self-write-guard');
const { parseDotenv } = require('../lib/account/host-api-key-scan');
const { deleteAccountRef } = require('../lib/server/account-ref-store');
const store = require('../lib/server/account-credential-store');

const CLAUDE_UUID = '11111111-2222-4333-8444-555555555555';
const CLIENT_KEY = 'aih-client-key-0123456789';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-generic-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(hostHomeDir, { recursive: true });
  const write = (relative, content) => {
    const file = path.join(hostHomeDir, ...relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const readServerConfig = () => ({ host: '127.0.0.1', port: 9527, apiKey: CLIENT_KEY });
  const detect = () => detectHostAccounts({ fs, aiHomeDir, hostHomeDir, readServerConfig });
  const records = provider => store.listAccountCredentialRecords(fs, aiHomeDir, provider);
  return { root, aiHomeDir, hostHomeDir, write, detect, records, readServerConfig };
}

function claudeCredentials(accessToken = 'at-1') {
  return {
    claudeAiOauth: {
      accessToken,
      refreshToken: `rt-${accessToken}`,
      expiresAt: Date.now() + 3600e3,
      account: { uuid: CLAUDE_UUID, email_address: 'user@example.com' }
    }
  };
}

const CLAUDE_OAUTH = ['.claude', '.credentials.json'];
const CLAUDE_SETTINGS = ['.claude', 'settings.json'];
const CODEX_AUTH = ['.codex', 'auth.json'];

test('host OAuth login is imported once and a repeated scan is idempotent', t => {
  const f = fixture(t);
  f.write(CLAUDE_OAUTH, claudeCredentials());
  const first = f.detect();
  assert.equal(first.ok, true);
  const claude = first.registered.filter(item => item.provider === 'claude');
  assert.equal(claude.length, 1);
  assert.equal(claude[0].created, true);
  assert.equal(first.accounts.claude, 1);
  const stored = f.records('claude')[0];
  assert.equal(stored.nativeAuth.credentials.claudeAiOauth.account.uuid, CLAUDE_UUID);

  const second = f.detect();
  assert.equal(second.registered.filter(item => item.provider === 'claude').length, 0);
  assert.equal(f.records('claude').length, 1);
  // 临时物化目录必须清理干净。
  const loginDir = path.join(f.aiHomeDir, 'run', 'login', 'claude');
  assert.deepEqual(fs.existsSync(loginDir) ? fs.readdirSync(loginDir) : [], []);
});

test('provider-specific host API key slots become API-key accounts', t => {
  const f = fixture(t);
  f.write(CODEX_AUTH, { OPENAI_API_KEY: 'sk-host-codex-key-1' });
  f.write(['.gemini', '.env'], '# comment\nGEMINI_API_KEY="AIza-host-gemini-key"\n');
  f.write(CLAUDE_SETTINGS, { env: { ANTHROPIC_AUTH_TOKEN: 'tok-host-claude', ANTHROPIC_BASE_URL: 'https://relay.example.com' } });
  const result = f.detect();
  assert.equal(result.ok, true);
  assert.deepEqual(store.readAccountCredentials(fs, f.aiHomeDir, f.records('codex')[0].accountRef),
    { OPENAI_API_KEY: 'sk-host-codex-key-1' });
  assert.equal(store.readAccountCredentials(fs, f.aiHomeDir, f.records('gemini')[0].accountRef).GEMINI_API_KEY,
    'AIza-host-gemini-key');
  const claudeEnv = store.readAccountCredentials(fs, f.aiHomeDir, f.records('claude')[0].accountRef);
  assert.equal(claudeEnv.ANTHROPIC_AUTH_TOKEN, 'tok-host-claude');
  assert.equal(claudeEnv.ANTHROPIC_BASE_URL, 'https://relay.example.com');
  // 同一把 key 再扫不会出第二个账号。
  f.detect();
  assert.equal(f.records('codex').length, 1);
  assert.equal(f.records('gemini').length, 1);
  assert.equal(f.records('claude').length, 1);
});

// `aih codex set-default <中转站 key 账号>` 只把 OPENAI_API_KEY 写进宿主 auth.json（基础地址在
// config.toml），扫描不能因为身份里少了基础地址就把它登记成一个指向默认官方地址的新账号。
test('a host API key already stored under a custom base URL is not imported again', t => {
  const f = fixture(t);
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { buildApiKeyIdentity } = require('../lib/account/transfer-core');
  const { normalizeIdentitySeed } = require('../lib/account/account-identity');
  const { getProviderCredentialFacts } = require('../lib/provider-catalog');
  const facts = getProviderCredentialFacts('codex');
  const env = { [facts.apiKeyEnv[0]]: 'sk-relay-key-1', [facts.baseUrlEnv[0]]: 'https://relay.example.com/v1' };
  const registration = registerAccountIdentity(fs, f.aiHomeDir, {
    provider: 'codex',
    identitySeed: normalizeIdentitySeed(buildApiKeyIdentity('codex', { config: env }))
  });
  store.writeAccountCredentials(fs, f.aiHomeDir, registration.accountRef, env);

  f.write(CODEX_AUTH, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-relay-key-1', tokens: null });
  const result = f.detect();
  assert.equal(result.ok, true);
  assert.equal(result.registered.filter(item => item.provider === 'codex' && item.created).length, 0);
  assert.equal(f.records('codex').length, 1);
  assert.equal(f.records('codex')[0].accountRef, registration.accountRef);
});

test('a claude auth-token account is matched by key even when the host writes it as an API key', t => {
  const f = fixture(t);
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { buildApiKeyIdentity } = require('../lib/account/transfer-core');
  const { normalizeIdentitySeed } = require('../lib/account/account-identity');
  const { getProviderCredentialStrategy } = require('../lib/account/provider-credentials');
  // aih 里存的是 auth-token 形态（ANTHROPIC_AUTH_TOKEN），基础地址带路径。
  const env = getProviderCredentialStrategy('claude').importApiKeyEnv({
    apiKey: 'tok-relay-claude-1',
    baseUrl: 'https://relay.example.com/anthropic',
    credentialType: 'auth-token'
  });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-relay-claude-1');
  const registration = registerAccountIdentity(fs, f.aiHomeDir, {
    provider: 'claude',
    identitySeed: normalizeIdentitySeed(buildApiKeyIdentity('claude', { config: env }))
  });
  store.writeAccountCredentials(fs, f.aiHomeDir, registration.accountRef, env);

  // 宿主手写成 ANTHROPIC_API_KEY、基础地址不带路径：身份不同，但密钥相同。
  f.write(CLAUDE_SETTINGS, { env: { ANTHROPIC_API_KEY: 'tok-relay-claude-1', ANTHROPIC_BASE_URL: 'https://relay.example.com' } });
  const result = f.detect();
  assert.equal(result.ok, true);
  assert.equal(result.registered.filter(item => item.provider === 'claude' && item.created).length, 0);
  assert.equal(f.records('claude').length, 1);
  assert.equal(f.records('claude')[0].accountRef, registration.accountRef);
});

test('a deleted relay API key is not re-imported against the default base URL', t => {
  const f = fixture(t);
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { buildApiKeyIdentity } = require('../lib/account/transfer-core');
  const { normalizeIdentitySeed } = require('../lib/account/account-identity');
  const { getProviderCredentialFacts } = require('../lib/provider-catalog');
  const { readJsonValue } = require('../lib/server/app-state-store');
  const { buildApiKeyTombstoneKey } = require('../lib/account/api-key-tombstone');
  const facts = getProviderCredentialFacts('codex');
  const env = { [facts.apiKeyEnv[0]]: 'sk-relay-deleted-1', [facts.baseUrlEnv[0]]: 'https://relay.example.com/v1' };
  const registration = registerAccountIdentity(fs, f.aiHomeDir, {
    provider: 'codex',
    identitySeed: normalizeIdentitySeed(buildApiKeyIdentity('codex', { config: env }))
  });
  store.writeAccountCredentials(fs, f.aiHomeDir, registration.accountRef, env);
  // 真实删号顺序：凭据随 account_refs 级联删除，deleteAccountRef 时凭据还在。
  deleteAccountRef(fs, f.aiHomeDir, registration.accountRef);
  assert.equal(f.records('codex').length, 0);
  // 墓碑只存哈希，不落明文密钥。
  const tombstoneKey = buildApiKeyTombstoneKey('codex', 'sk-relay-deleted-1');
  assert.ok(!tombstoneKey.includes('sk-relay-deleted-1'));
  assert.ok(readJsonValue(fs, f.aiHomeDir, tombstoneKey).deletedAt > 0);

  // 宿主 auth.json 仍是那把中转 key，但没有基础地址：身份会落到默认官方地址。
  f.write(CODEX_AUTH, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-relay-deleted-1', tokens: null });
  const result = f.detect();
  assert.ok(result.skipped.some(item => item.provider === 'codex' && item.reason === 'account_deleted_by_user'));
  assert.equal(f.records('codex').length, 0);

  // 另一把从没删过的 key 照常入库。
  f.write(CODEX_AUTH, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fresh-codex-2', tokens: null });
  f.detect();
  assert.equal(f.records('codex').length, 1);
});

test('API key env names cover every credential type the strategy can write', () => {
  const { listProviderApiKeyEnvNames } = require('../lib/account/api-key-tombstone');
  const claude = listProviderApiKeyEnvNames('claude');
  assert.ok(claude.includes('ANTHROPIC_API_KEY'));
  assert.ok(claude.includes('ANTHROPIC_AUTH_TOKEN'));
  assert.ok(!claude.includes('ANTHROPIC_BASE_URL'));
  assert.deepEqual(listProviderApiKeyEnvNames(''), []);
});

test('a codex OAuth auth.json is never mistaken for an API key account', t => {
  const f = fixture(t);
  f.write(CODEX_AUTH, { OPENAI_API_KEY: 'sk-should-not-import', tokens: { refresh_token: 'rt', access_token: 'at' } });
  const result = f.detect();
  assert.equal(result.registered.filter(item => item.provider === 'codex' && item.created).length, 0);
  for (const record of f.records('codex')) {
    assert.notEqual(store.readAccountCredentials(fs, f.aiHomeDir, record.accountRef).OPENAI_API_KEY, 'sk-should-not-import');
  }
});

test('aih self-written host config is rejected (gateway URL, pin header, client key)', t => {
  const f = fixture(t);
  f.write(CLAUDE_SETTINGS, { env: { ANTHROPIC_AUTH_TOKEN: 'gw-token', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527' } });
  let result = f.detect();
  assert.ok(result.skipped.some(item => item.provider === 'claude' && item.reason === 'aih_gateway_host_config'));
  assert.equal(f.records('claude').length, 0);

  f.write(CLAUDE_SETTINGS, {
    env: {
      ANTHROPIC_AUTH_TOKEN: 'relay-token',
      ANTHROPIC_BASE_URL: 'https://relay.example.com',
      ANTHROPIC_CUSTOM_HEADERS: 'x-account-ref: acct_0000000000000000000a'
    }
  });
  result = f.detect();
  assert.ok(result.skipped.some(item => item.provider === 'claude' && item.reason === 'aih_managed_host_config'));
  assert.equal(f.records('claude').length, 0);

  f.write(CODEX_AUTH, { OPENAI_API_KEY: CLIENT_KEY });
  result = f.detect();
  assert.ok(result.skipped.some(item => item.provider === 'codex' && item.reason === 'aih_client_key_host_config'));
  assert.equal(f.records('codex').length, 0);

  // aih 私有目录（含 run/claude-launch-settings）下的文件一律拒绝。
  const guard = createSelfWriteGuard({ fs, aiHomeDir: f.aiHomeDir, readServerConfig: f.readServerConfig });
  assert.equal(guard.rejectsPath(path.join(f.aiHomeDir, 'run', 'claude-launch-settings', 'a.json')), 'aih_private_runtime_file');
  assert.equal(guard.rejectsPath(path.join(f.hostHomeDir, '.claude', 'settings.json')), '');
});

test('a deleted account is not resurrected by the scan (tombstone)', t => {
  const f = fixture(t);
  f.write(CLAUDE_OAUTH, claudeCredentials());
  f.detect();
  const accountRef = f.records('claude')[0].accountRef;
  store.deleteAccountCredentials(fs, f.aiHomeDir, accountRef);
  deleteAccountRef(fs, f.aiHomeDir, accountRef);
  const result = f.detect();
  assert.ok(result.skipped.some(item => item.provider === 'claude' && item.reason === 'account_deleted_by_user'));
  assert.equal(f.records('claude').length, 0);

  f.write(CODEX_AUTH, { OPENAI_API_KEY: 'sk-host-codex-key-2' });
  f.detect();
  const apiKeyRef = f.records('codex')[0].accountRef;
  store.deleteAccountCredentials(fs, f.aiHomeDir, apiKeyRef);
  deleteAccountRef(fs, f.aiHomeDir, apiKeyRef);
  const again = f.detect();
  assert.ok(again.skipped.some(item => item.provider === 'codex' && item.reason === 'account_deleted_by_user'));
  assert.equal(f.records('codex').length, 0);
});

test('an account deleted before its provider had a host observer is not resurrected', t => {
  const { deleteJsonValue, openAppStateDatabase, readJsonValue } = require('../lib/server/app-state-store');
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const f = fixture(t);
  f.write(CLAUDE_OAUTH, claudeCredentials());
  f.detect();
  const accountRef = f.records('claude')[0].accountRef;
  store.deleteAccountCredentials(fs, f.aiHomeDir, accountRef);
  deleteAccountRef(fs, f.aiHomeDir, accountRef);
  // 模拟升级前的删除：那时 claude 不在宿主观察集合里，只留下了 account:retired:<ref>，
  // 没有任何 account:deleted:* 墓碑。
  const db = openAppStateDatabase(fs, f.aiHomeDir);
  const deletedKeys = db.prepare("SELECT key FROM app_kv WHERE key LIKE 'account:deleted:%'").all().map(row => row.key);
  db.close();
  for (const key of deletedKeys) deleteJsonValue(fs, f.aiHomeDir, key);
  assert.ok(readJsonValue(fs, f.aiHomeDir, `account:retired:${accountRef}`));

  const result = f.detect();
  assert.ok(result.skipped.some(item => item.provider === 'claude' && item.reason === 'account_deleted_by_user'));
  assert.equal(f.records('claude').length, 0);

  // 用户显式登记仍然可以恢复它（只有自动观察受退役记录约束）。
  const restored = registerAccountIdentity(fs, f.aiHomeDir, {
    provider: 'claude',
    identitySeed: `oauth:claude:${CLAUDE_UUID}`
  });
  assert.equal(typeof restored.accountRef, 'string');
});

test('an older host credential never overwrites the stored generation', t => {
  const f = fixture(t);
  f.write(CLAUDE_OAUTH, claudeCredentials('at-old'));
  f.detect();
  const accountRef = f.records('claude')[0].accountRef;
  // 沙箱续期后库内是更新的一代；宿主那份仍停在旧 token。
  const current = store.readAccountCredentialRecord(fs, f.aiHomeDir, accountRef).nativeAuth;
  store.writeAccountNativeAuth(fs, f.aiHomeDir, accountRef, {
    ...current,
    credentials: claudeCredentials('at-newer')
  });
  f.write(CLAUDE_OAUTH, claudeCredentials('at-old'));
  f.detect();
  const after = store.readAccountCredentialRecord(fs, f.aiHomeDir, accountRef).nativeAuth;
  assert.equal(after.credentials.claudeAiOauth.accessToken, 'at-newer');
});

test('a corrupt host file is skipped with a reason while other providers still import', t => {
  const f = fixture(t);
  f.write(['.grok', 'auth.json'], '{ not json');
  f.write(['.gemini', '.env'], 'GEMINI_API_KEY=AIza-still-imported\n');
  f.write(CLAUDE_OAUTH, claudeCredentials());
  const result = f.detect();
  assert.equal(result.ok, true);
  assert.ok(result.skipped.some(item => item.provider === 'grok' && item.reason === 'host_credential_file_corrupt'));
  assert.equal(f.records('grok').length, 0);
  assert.equal(f.records('gemini').length, 1);
  assert.equal(f.records('claude').length, 1);
});

test('the background observer imports new host logins and is stamp-gated', t => {
  const f = fixture(t);
  const timers = [];
  const sync = createGenericHostAccountSync({
    fs,
    aiHomeDir: f.aiHomeDir,
    hostHomeDir: f.hostHomeDir,
    readServerConfig: f.readServerConfig,
    setInterval: (fn) => { timers.push(fn); return { unref() {} }; },
    clearInterval: () => {}
  });
  const updates = [];
  sync.start({ onUpdated: events => updates.push(events) });
  assert.equal(updates.length, 0);
  assert.equal(sync.scan({ gated: true }).unchanged, true, '文件未变时不重扫');

  f.write(CLAUDE_OAUTH, claudeCredentials());
  timers[0]();
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0].provider, 'claude');
  assert.equal(f.records('claude').length, 1);
  assert.equal(sync.getStats().pending, 0);
  sync.stop();
});

test('dotenv parsing handles quotes, export and comments', () => {
  assert.deepEqual(parseDotenv('export A=1\nB="two words"\n# c\nC=3 # tail\nbad line\n'),
    { A: '1', B: 'two words', C: '3' });
});
