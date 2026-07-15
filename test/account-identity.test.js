'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const identity = require('../lib/account/account-identity');
const { buildOAuthIdentity, buildApiKeyIdentity } = require('../lib/account/transfer-core');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { buildCodexSnapshotAccount } = require('../lib/account/codex-auth-metadata');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-identity-'));
  return { root };
}

function registerAccount(sb, provider, cliAccountId, identitySeed) {
  return registerAccountIdentity(fs, sb.root, { provider, cliAccountId, identitySeed }).accountRef;
}

test('oauth identity: codex email matches transfer-core dedup (the invariant)', () => {
  const auth = {
    tokens: { access_token: 'a', account_id: 'acct-1' },
    email: 'alice@example.com'
  };
  const identitySeed = buildOAuthIdentity('codex', auth);
  const result = identity.resolveNativeAuthIdentitySeed('codex', { auth });
  assert.equal(result.identitySeed, identitySeed);
  assert.equal(result.identitySeed, 'oauth:codex:alice@example.com');
  assert.equal(result.degraded, false);
});

test('oauth ladder: claude falls back to native uuid when email absent', () => {
  const result = identity.resolveNativeAuthIdentitySeed('claude', { credentials: {
    claudeAiOauth: { accessToken: 'x', account: { uuid: '1fb09d73' } }
  } });
  assert.equal(result.identitySeed, 'oauth:claude:uuid:1fb09d73');
  assert.equal(result.degraded, false);
});

test('oauth identity rejects CLI-id fallback when no stable identity exists', () => {
  const result = identity.resolveNativeAuthIdentitySeed('claude', { credentials: {
    claudeAiOauth: { accessToken: 'x' }
  } });
  assert.equal(result.identitySeed, '');
  assert.equal(result.degraded, true);
});

test('codex upstream account id is metadata and cannot derive accountRef', () => {
  const result = identity.resolveNativeAuthIdentitySeed('codex', {
    auth: {
      tokens: {
        access_token: 'opaque-access-token',
        refresh_token: 'refresh-token',
        account_id: 'upstream-account-id'
      }
    }
  });
  assert.equal(result.identitySeed, '');
  assert.equal(result.degraded, true);
});

test('codex snapshots accept only the normalized upstreamAccountId field internally', () => {
  assert.equal(buildCodexSnapshotAccount({ account_id: 'legacy-local-id' }, null), null);
  assert.deepEqual(buildCodexSnapshotAccount({
    upstreamAccountId: 'upstream-account-id'
  }, null), {
    planType: '',
    email: '',
    upstreamAccountId: 'upstream-account-id',
    organizationId: ''
  });
});

test('opencode identity fingerprints configured credentials, not provider names only', () => {
  const first = identity.resolveNativeAuthIdentitySeed('opencode', { auth: {
    anthropic: { type: 'api', key: 'sk-ant-a' },
    openai: { type: 'api', key: 'sk-openai-a' },
    google: {}
  } });
  const second = identity.resolveNativeAuthIdentitySeed('opencode', { auth: {
    anthropic: { type: 'api', key: 'sk-ant-b' },
    openai: { type: 'api', key: 'sk-openai-b' },
    google: {}
  } });

  assert.equal(first.degraded, false);
  assert.equal(second.degraded, false);
  assert.match(first.identitySeed, /^oauth:opencode:auth:[a-f0-9]{16}$/);
  assert.notEqual(first.identitySeed, second.identitySeed);
  assert.equal(first.identitySeed.includes('sk-ant-a'), false);
  assert.equal(first.identitySeed.includes('google'), false);
});

test('opencode OAuth identity hashes refresh credentials and ignores rotating access data', () => {
  const first = identity.resolveNativeAuthIdentitySeed('opencode', { auth: {
    anthropic: { type: 'oauth', access: 'access-a', refresh: 'refresh-stable', expires: 100 }
  } });
  const second = identity.resolveNativeAuthIdentitySeed('opencode', { auth: {
    anthropic: { type: 'oauth', access: 'access-b', refresh: 'refresh-stable', expires: 200 }
  } });
  const differentAccount = identity.resolveNativeAuthIdentitySeed('opencode', { auth: {
    anthropic: { type: 'oauth', access: 'access-c', refresh: 'refresh-other', expires: 300 }
  } });

  assert.equal(first.identitySeed, second.identitySeed);
  assert.notEqual(first.identitySeed, differentAccount.identitySeed);
  assert.equal(first.identitySeed.includes('refresh-stable'), false);
  assert.equal(first.degraded, false);
});

test('api-key identity uses a key hash to distinguish accounts at one endpoint', () => {
  const secret = 'sk-super-secret-123456';
  const raw = buildApiKeyIdentity('codex', { config: {
    OPENAI_API_KEY: secret, OPENAI_BASE_URL: 'https://relay.example.com/v1'
  } });
  const identitySeed = identity.normalizeIdentitySeed(raw);
  assert.ok(!identitySeed.includes(secret), 'secret must not appear in identity seed');
  assert.equal(identitySeed, `api_key:codex:https://relay.example.com/v1:${identity.hashApiKeySecret(secret)}`);
});

test('api-key identity hashes the complete secret when it contains colons', () => {
  const secret = 'tenant:private:key';
  const raw = buildApiKeyIdentity('codex', { config: {
    OPENAI_API_KEY: secret,
    OPENAI_BASE_URL: 'http://[::1]:8317/v1'
  } });
  const identitySeed = identity.normalizeIdentitySeed(raw);

  assert.equal(identitySeed.includes(secret), false);
  assert.equal(
    identitySeed,
    `api_key:codex:http://[::1]:8317/v1:${identity.hashApiKeySecret(secret)}`
  );
});

test('detectIdentityKind reads DB credentials', () => {
  const sb = makeSandbox();
  const apiKeyRef = registerAccount(sb, 'codex', '2', 'api_key:codex:default:seed');
  const oauthRef = registerAccount(sb, 'codex', '3', 'oauth:codex:user@example.com');
  writeAccountCredentials(fs, sb.root, apiKeyRef, { OPENAI_API_KEY: 'k' });
  assert.equal(identity.detectIdentityKind({ fs, aiHomeDir: sb.root, provider: 'codex', accountRef: apiKeyRef }), 'api-key');
  assert.equal(identity.detectIdentityKind({ fs, aiHomeDir: sb.root, provider: 'codex', accountRef: oauthRef }), 'oauth');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('account object identity seed is derived only before registration', () => {
  const result = identity.resolveIdentitySeedFromAccount({
    provider: 'gemini',
    apiKeyMode: true,
    accessToken: 'gemini-secret-key',
    baseUrl: 'https://generativelanguage.googleapis.com'
  });
  assert.equal(result.kind, 'api-key');
  assert.equal(result.identitySeed.includes('gemini-secret-key'), false);
  assert.equal(
    result.identitySeed,
    `api_key:gemini:https://generativelanguage.googleapis.com:${identity.hashApiKeySecret('gemini-secret-key')}`
  );
});
