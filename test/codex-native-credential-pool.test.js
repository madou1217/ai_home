'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth, readAccountCredentialRecord } = require('../lib/server/account-credential-store');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');
const { loadServerRuntimeAccounts } = require('../lib/server/accounts');
const { createCodexNativeCredentialSync } = require('../lib/account/codex-native-credential-sync');
const { deriveAccountRuntimeStatus } = require('../lib/server/account-runtime-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-pool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih'), hostHomeDir = path.join(root, 'home');
  const now = Date.now(), email = 'pool@example.invalid', userId = 'pool-user';
  const jwt = value => `test.${Buffer.from(JSON.stringify(value)).toString('base64url')}.test-signature`;
  // codex 身份来自 ID Token 的稳定 user_id，邮箱只做展示
  // （docs/architecture/codex-oauth-identity-vector-adr.md）。
  const auth = generation => ({ auth_mode: 'chatgpt', last_refresh: new Date(now - 100000 + generation * 1000).toISOString(),
    tokens: { access_token: jwt({ iat: Math.floor(now / 1000) - 100 + generation, exp: Math.floor(now / 1000) + 7200,
      'https://api.openai.com/profile': { email } }), refresh_token: `test-pool-refresh-${generation}`,
      id_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_user_id: userId } }) } });
  const ref = registerAccountIdentity(fs, aiHomeDir, { provider: 'codex', identitySeed: `oauth:codex:${userId}` }).accountRef;
  writeAccountNativeAuth(fs, aiHomeDir, ref, { auth: auth(1) });
  const accountStateIndex = createAccountStateIndex({ fs, aiHomeDir });
  const accountStateService = createAccountStateService({ fs, accountStateIndex });
  const deps = { fs, aiHomeDir, hostHomeDir, accountStateIndex, accountStateService, checkStatus: () => ({ configured: true }),
    getProfileDir: () => '', serverPort: 19527 };
  return { ...deps, deps, ref, auth, now };
}

test('real pool reload adopts the new generation and permits retry without dropping model quota', async t => {
  const f = fixture(t);
  const failureAt = readAccountCredentialRecord(fs, f.aiHomeDir, f.ref).nativeAuthUpdatedAt + 1;
  f.accountStateIndex.upsertRuntimeState(f.ref, 'codex', {
    authInvalidUntil: f.now + 100000, cooldownUntil: f.now + 100000,
    lastFailureAt: failureAt, lastFailureKind: 'auth_invalid', lastError: 'test-old-auth-rejection',
    modelCooldowns: { 'test-limited-model': f.now + 200000 }
  }, { configured: true, status: 'up', apiKeyMode: false, authMode: 'oauth' });
  assert.equal(deriveAccountRuntimeStatus(loadServerRuntimeAccounts(f.deps).codex[0]).status, 'auth_invalid');
  await new Promise(resolve => setTimeout(resolve, 20));
  const authPath = path.join(f.hostHomeDir, '.codex', 'auth.json'); fs.mkdirSync(path.dirname(authPath), { recursive: true });
  const fresh = f.auth(2); fs.writeFileSync(authPath, JSON.stringify(fresh));
  assert.equal(createCodexNativeCredentialSync(f.deps).scan().updated.length, 1);
  const account = loadServerRuntimeAccounts(f.deps).codex[0];
  assert.equal(account.accessToken, fresh.tokens.access_token);
  assert.equal(account.authInvalidUntil, 0);
  assert.equal(account.modelCooldowns['test-limited-model'], f.now + 200000);
});

test('unchanged credentials do not release an authentication failure or manually disabled account', t => {
  const f = fixture(t);
  f.accountStateIndex.upsertRuntimeState(f.ref, 'codex', {
    authInvalidUntil: f.now + 100000, cooldownUntil: f.now + 100000,
    lastFailureAt: Date.now() + 1, lastFailureKind: 'auth_invalid'
  }, { configured: true, status: 'up', apiKeyMode: false, authMode: 'oauth' });
  assert.equal(deriveAccountRuntimeStatus(loadServerRuntimeAccounts(f.deps).codex[0]).status, 'auth_invalid');
  f.accountStateService.setOperationalStatus(f.ref, 'codex', 'down');
  assert.equal(loadServerRuntimeAccounts(f.deps).codex.length, 0);
});
