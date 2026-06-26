'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const identity = require('../lib/account/account-identity');
const { buildOAuthIdentity, buildApiKeyIdentity } = require('../lib/account/transfer-core');

// --- a tiny on-disk sandbox shaped like the real profile layout -------------
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-identity-'));
  const getProfileDir = (provider, accountId) => path.join(root, 'profiles', provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => {
    const dir = { codex: '.codex', gemini: '.gemini', claude: '.claude', agy: '.gemini' }[provider] || `.${provider}`;
    return path.join(getProfileDir(provider, accountId), dir);
  };
  const write = (file, obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  return { root, getProfileDir, getToolConfigDir, write };
}

test('runtime key: provider:accountId, first-colon split round-trip', () => {
  assert.equal(identity.getRuntimeAccountKey('claude', '4'), 'claude:4');
  assert.equal(identity.getRuntimeAccountKey('codex', { id: '10' }), 'codex:10');
  assert.deepEqual(identity.parseRuntimeAccountKey('codex:10'), {
    provider: 'codex', accountId: '10', accountKey: 'codex:10'
  });
  // accountId may itself contain colons only in malformed input; split on first.
  assert.equal(identity.parseRuntimeAccountKey('claude:a:b').accountId, 'a:b');
});

test('oauth identity: codex email matches transfer-core dedup (the invariant)', () => {
  const sb = makeSandbox();
  sb.write(sb.getToolConfigDir('codex', '1') + '/auth.json', {
    tokens: { access_token: 'a', account_id: 'acct-1' },
    email: 'alice@example.com'
  });
  const result = identity.resolveAccountUniqueKey({
    fs, path, provider: 'codex', accountId: '1',
    getProfileDir: sb.getProfileDir, getToolConfigDir: sb.getToolConfigDir, identityKind: 'oauth'
  });
  const auth = JSON.parse(fs.readFileSync(sb.getToolConfigDir('codex', '1') + '/auth.json', 'utf8'));
  assert.equal(result.uniqueKey, buildOAuthIdentity('codex', auth));
  assert.equal(result.uniqueKey, 'oauth:codex:alice@example.com');
  assert.equal(result.degraded, false);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('oauth ladder: claude falls back to native uuid when email absent', () => {
  const sb = makeSandbox();
  sb.write(sb.getToolConfigDir('claude', '4') + '/.credentials.json', {
    claudeAiOauth: { accessToken: 'x', account: { uuid: '1fb09d73' } }
  });
  const result = identity.resolveAccountUniqueKey({
    fs, path, provider: 'claude', accountId: '4',
    getProfileDir: sb.getProfileDir, getToolConfigDir: sb.getToolConfigDir, identityKind: 'oauth'
  });
  assert.equal(result.uniqueKey, 'oauth:claude:uuid:1fb09d73');
  assert.equal(result.degraded, false);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('oauth degrades to legacy when neither email nor native id is known', () => {
  const sb = makeSandbox();
  sb.write(sb.getToolConfigDir('claude', '4') + '/.credentials.json', {
    claudeAiOauth: { accessToken: 'x' }
  });
  const result = identity.resolveAccountUniqueKey({
    fs, path, provider: 'claude', accountId: '4',
    getProfileDir: sb.getProfileDir, getToolConfigDir: sb.getToolConfigDir, identityKind: 'oauth'
  });
  assert.equal(result.uniqueKey, 'legacy:claude:4');
  assert.equal(result.degraded, true);
  assert.equal(identity.isDegradedUniqueKey(result.uniqueKey), true);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('opencode identity fingerprints configured credentials, not provider names only', () => {
  const sb = makeSandbox();
  const authPath1 = path.join(sb.getProfileDir('opencode', '1'), '.local', 'share', 'opencode', 'auth.json');
  const authPath2 = path.join(sb.getProfileDir('opencode', '2'), '.local', 'share', 'opencode', 'auth.json');
  sb.write(authPath1, {
    anthropic: { type: 'api', key: 'sk-ant-a' },
    openai: { type: 'api', key: 'sk-openai-a' },
    google: {}
  });
  sb.write(authPath2, {
    anthropic: { type: 'api', key: 'sk-ant-b' },
    openai: { type: 'api', key: 'sk-openai-b' },
    google: {}
  });

  const first = identity.resolveAccountUniqueKey({
    fs, path, provider: 'opencode', accountId: '1',
    getProfileDir: sb.getProfileDir, getToolConfigDir: sb.getToolConfigDir, identityKind: 'oauth'
  });
  const second = identity.resolveAccountUniqueKey({
    fs, path, provider: 'opencode', accountId: '2',
    getProfileDir: sb.getProfileDir, getToolConfigDir: sb.getToolConfigDir, identityKind: 'oauth'
  });

  assert.equal(first.degraded, false);
  assert.equal(second.degraded, false);
  assert.match(first.uniqueKey, /^oauth:opencode:auth:[a-f0-9]{16}$/);
  assert.notEqual(first.uniqueKey, second.uniqueKey);
  assert.equal(first.uniqueKey.includes('sk-ant-a'), false);
  assert.equal(first.uniqueKey.includes('google'), false);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('api-key identity is key-independent (provider:baseUrl, no secret) so rotation preserves settings', () => {
  const sb = makeSandbox();
  const secret = 'sk-super-secret-123456';
  sb.write(sb.getProfileDir('codex', '2') + '/.aih_env.json', {
    OPENAI_API_KEY: secret, OPENAI_BASE_URL: 'https://relay.example.com/v1'
  });
  const result = identity.resolveAccountUniqueKey({
    fs, path, provider: 'codex', accountId: '2',
    getProfileDir: sb.getProfileDir, getToolConfigDir: sb.getToolConfigDir, identityKind: 'api-key'
  });
  assert.equal(result.kind, 'api-key');
  assert.equal(result.degraded, false);
  assert.ok(!result.uniqueKey.includes(secret), 'secret must not appear in key');
  assert.equal(result.uniqueKey, 'api_key:codex:https://relay.example.com/v1');

  // Rotate the key (same baseUrl) -> SAME identity, so per-model settings survive.
  sb.write(sb.getProfileDir('codex', '2') + '/.aih_env.json', {
    OPENAI_API_KEY: 'sk-rotated-different-key', OPENAI_BASE_URL: 'https://relay.example.com/v1'
  });
  const afterRotation = identity.resolveAccountUniqueKey({
    fs, path, provider: 'codex', accountId: '2',
    getProfileDir: sb.getProfileDir, getToolConfigDir: sb.getToolConfigDir, identityKind: 'api-key'
  });
  assert.equal(afterRotation.uniqueKey, result.uniqueKey);

  // toPersistedUniqueKey drops the secret segment from the raw dedup identity.
  const raw = buildApiKeyIdentity('codex', { config: { OPENAI_API_KEY: secret, OPENAI_BASE_URL: 'https://relay.example.com/v1' } });
  assert.equal(identity.toPersistedUniqueKey(raw), result.uniqueKey);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('detectIdentityKind reads .aih_env.json', () => {
  const sb = makeSandbox();
  sb.write(sb.getProfileDir('codex', '2') + '/.aih_env.json', { OPENAI_API_KEY: 'k' });
  assert.equal(identity.detectIdentityKind({ fs, path, provider: 'codex', profileDir: sb.getProfileDir('codex', '2') }), 'api-key');
  sb.write(sb.getProfileDir('codex', '3') + '/.aih_env.json', {});
  assert.equal(identity.detectIdentityKind({ fs, path, provider: 'codex', profileDir: sb.getProfileDir('codex', '3') }), 'oauth');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('parseUniqueKey round-trips kind/provider/email/baseUrl/keyHash', () => {
  assert.deepEqual(identity.parseUniqueKey('oauth:claude:a@b.com'), {
    kind: 'oauth', provider: 'claude', email: 'a@b.com', baseUrl: null, keyHash: null, nativeId: null
  });
  const ak = identity.parseUniqueKey('api_key:codex:https://x.com/v1');
  assert.equal(ak.kind, 'api-key');
  assert.equal(ak.baseUrl, 'https://x.com/v1'); // baseUrl keeps its own colons; no secret/hash segment
  assert.equal(ak.keyHash, null);
  assert.equal(identity.parseUniqueKey('oauth:claude:uuid:1fb09d73').nativeId, '1fb09d73');
  assert.equal(identity.parseUniqueKey('legacy:claude:4').kind, 'legacy');
});
